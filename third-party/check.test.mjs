// Tests for the third-party allowlist checker.
// node --test third-party/            -- no test framework, no dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parsePackageJson,
  parseComposerJson,
  parsePyproject,
  parseCargoToml,
  pyRequirementName,
  ownerOf,
  classify,
  checkRepo,
  gateStatus,
  loadAllowlist,
  freshnessOf,
  remoteRepoName,
  SCHEMA_VERSION,
} from './check.mjs';
// Namespace import for the inheritance helpers, so a missing export fails only
// the tests that use it instead of taking the whole module down at link time.
import * as checker from './check.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REAL_ALLOWLIST = path.join(HERE, 'allowlist.json');

const NOW = Date.parse('2026-08-19T00:00:00Z');
const DAY = 86_400_000;

// A tiny allowlist that exercises every approval route without depending on
// what the real one happens to contain today.
const FIXTURE = {
  schemaVersion: SCHEMA_VERSION,
  policy: { freshnessDays: 92 },
  firstParty: { npm: ['@particle-academy'], composer: ['particle-academy'], pypi: ['fancy-flow'] },
  ecosystems: {
    npm: {
      identity: 'scope',
      authors: { '@types': { reason: 'DefinitelyTyped; declarations only.' } },
      packages: { react: { reason: 'The framework.' } },
    },
    composer: {
      identity: 'vendor',
      authors: { laravel: { reason: 'The framework vendor.' } },
      packages: { 'pestphp/pest': { reason: 'Our PHP test runner.' } },
    },
    pypi: { identity: 'none', authors: {}, packages: { pytest: { reason: 'Our Python test runner.' } } },
  },
  packageGrants: {
    '@particle-academy/fancy-echarts': {
      npm: { echarts: { reason: 'The library this package exists to wrap.' } },
    },
  },
};

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  }
  return dir;
}

// Freshness lookups are stubbed in tests. A unit test that reaches the network
// tests the network.
const alwaysFresh = () => Promise.resolve(NOW - 5 * DAY);
const noNetwork = () => Promise.reject(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'));
const NO_CACHE = { cacheFile: null, cacheTtlMs: 0 };

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

test('package.json: every direct field is read, local specs are not', () => {
  const parsed = parsePackageJson({
    name: '@particle-academy/thing',
    dependencies: { clsx: '^2.1.0' },
    devDependencies: { vitest: '^3.0.0' },
    peerDependencies: { react: '^19.0.0' },
    optionalDependencies: { fsevents: '^2.0.0' },
    // A workspace/link spec is our own source, not something from a registry.
    resolutions: { nope: '1.0.0' },
  });
  assert.equal(parsed.name, '@particle-academy/thing');
  assert.deepEqual(parsed.deps.map((d) => d.name).sort(), ['clsx', 'fsevents', 'react', 'vitest']);
  assert.deepEqual(
    parsed.deps.find((d) => d.name === 'react'),
    { name: 'react', field: 'peerDependencies', spec: '^19.0.0' }
  );
});

test('package.json: file:/link:/workspace: specs are local source, not dependencies', () => {
  const parsed = parsePackageJson({ dependencies: { a: 'file:../a', b: 'workspace:*', c: 'link:../c', d: '^1.0.0' } });
  assert.deepEqual(parsed.deps.map((d) => d.name), ['d']);
});

test('composer.json: platform requirements are not third-party code', () => {
  const parsed = parseComposerJson({
    name: 'particle-academy/holy-sheet',
    require: { php: '^8.4', 'ext-zip': '*', 'ext-dom': '*', 'illuminate/support': '^13.0' },
    'require-dev': { 'pestphp/pest': '^4.0' },
  });
  assert.deepEqual(parsed.deps.map((d) => d.name).sort(), ['illuminate/support', 'pestphp/pest']);
  assert.equal(parsed.name, 'particle-academy/holy-sheet');
});

test('pyproject.toml: dependencies, optional groups and dependency-groups all count', () => {
  const parsed = parsePyproject(`
[project]
name = "fancy-catalog"
dependencies = [
  "httpx>=0.27",
]

[project.optional-dependencies]
stripe = ["stripe>=11,<16"]

[dependency-groups]
test = ["pytest>=8.0"]
lint = ["ruff>=0.16"]
dev = [{include-group = "test"}, {include-group = "lint"}]
`);
  assert.equal(parsed.name, 'fancy-catalog');
  assert.deepEqual(parsed.deps.map((d) => d.name).sort(), ['httpx', 'pytest', 'ruff', 'stripe']);
  // The include-group refs name groups in this same file. Treating them as
  // distributions would send the checker looking for a PyPI package called
  // "lint", which is how a checker invents a failure that is not real.
  assert.equal(parsed.deps.some((d) => d.name === 'lint'), false);
  assert.equal(parsed.deps.find((d) => d.name === 'stripe').field, 'optional-dependencies.stripe');
});

test('PEP 508 names are normalised the way PyPI normalises them', () => {
  assert.equal(pyRequirementName('Fancy_Flow[extra]>=1.0'), 'fancy-flow');
  assert.equal(pyRequirementName('ruff >= 0.16 ; python_version < "3.12"'), 'ruff');
});

// ---------------------------------------------------------------------------
// Registry identity -- these three are NOT the same concept
// ---------------------------------------------------------------------------

test('npm owner identity is the scope, and unscoped packages have none', () => {
  assert.equal(ownerOf('npm', '@tanstack/react-query'), '@tanstack');
  assert.equal(ownerOf('npm', 'echarts'), null);
});

test('composer owner identity is the vendor prefix', () => {
  assert.equal(ownerOf('composer', 'laravel/framework'), 'laravel');
});

test('pypi has no namespace, so no author identity is checkable', () => {
  assert.equal(ownerOf('pypi', 'stripe'), null);
});

test('an unscoped npm package can never be approved by author', () => {
  const v = classify(FIXTURE, 'npm', 'left-pad', '@particle-academy/whatever');
  assert.equal(v.allowed, false);
});

// ---------------------------------------------------------------------------
// Approval routes
// ---------------------------------------------------------------------------

test('author allow covers a scope', () => {
  const v = classify(FIXTURE, 'npm', '@types/react', '@particle-academy/x');
  assert.equal(v.allowed, true);
  assert.equal(v.via, 'author');
});

test('package allow covers one named package', () => {
  assert.equal(classify(FIXTURE, 'npm', 'react', '@particle-academy/x').via, 'package');
  assert.equal(classify(FIXTURE, 'composer', 'pestphp/pest', 'particle-academy/x').via, 'package');
  assert.equal(classify(FIXTURE, 'pypi', 'pytest', 'fancy-flow').via, 'package');
});

test('first-party code is not a dependency question', () => {
  assert.equal(classify(FIXTURE, 'npm', '@particle-academy/react-fancy', '@particle-academy/x').via, 'first-party');
  assert.equal(classify(FIXTURE, 'composer', 'particle-academy/holy-sheet', 'particle-academy/x').via, 'first-party');
});

// THE WRAPPER GRANT, both directions. This pair is the whole point of the design.

test('a wrapper grant passes for the package it was granted to', () => {
  const v = classify(FIXTURE, 'npm', 'echarts', '@particle-academy/fancy-echarts');
  assert.equal(v.allowed, true, 'fancy-echarts exists to wrap echarts');
  assert.equal(v.via, 'grant');
});

test('a wrapper grant does NOT leak to another package', () => {
  const v = classify(FIXTURE, 'npm', 'echarts', '@particle-academy/fancy-trading');
  assert.equal(v.allowed, false, 'echarts is approved FOR fancy-echarts, not approved outright');
  assert.match(v.reason, /@particle-academy\/fancy-echarts/);
  assert.match(v.reason, /scoped to the package/);
});

test('a grant does not leak across ecosystems either', () => {
  assert.equal(classify(FIXTURE, 'composer', 'echarts', '@particle-academy/fancy-echarts').allowed, false);
});

// ---------------------------------------------------------------------------
// End to end -- the case that must FAIL
// ---------------------------------------------------------------------------

test('a deliberately unapproved package fails the check', async () => {
  const dir = tmpRepo({
    'package.json': { name: '@particle-academy/fancy-thing', dependencies: { react: '^19.0.0', 'left-pad': '^1.3.0' } },
  });
  const result = await checkRepo(dir, FIXTURE, { now: NOW, fetcher: alwaysFresh, ...NO_CACHE });
  const errors = result.findings.filter((f) => f.level === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'unapproved');
  assert.equal(errors[0].name, 'left-pad');
});

test('an approved tree passes', async () => {
  const dir = tmpRepo({
    'package.json': {
      name: '@particle-academy/fancy-echarts',
      dependencies: { react: '^19.0.0' },
      peerDependencies: { echarts: '^6.1.0' },
      devDependencies: { '@types/react': '^19.0.0' },
    },
  });
  const result = await checkRepo(dir, FIXTURE, { now: NOW, fetcher: alwaysFresh, ...NO_CACHE });
  assert.deepEqual(result.findings, []);
  assert.equal(result.checked.length, 3);
});

test('the same dependency in a different package fails end to end', async () => {
  const dir = tmpRepo({
    'package.json': { name: '@particle-academy/fancy-trading', peerDependencies: { echarts: '^6.1.0' } },
  });
  const result = await checkRepo(dir, FIXTURE, { now: NOW, fetcher: alwaysFresh, ...NO_CACHE });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, 'unapproved');
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('a project with no activity for more than three months fails', async () => {
  const dir = tmpRepo({ 'package.json': { name: '@particle-academy/x', dependencies: { react: '^19.0.0' } } });
  const stale = () => Promise.resolve(NOW - 400 * DAY);
  const result = await checkRepo(dir, FIXTURE, { now: NOW, fetcher: stale, ...NO_CACHE });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, 'stale');
  assert.match(result.findings[0].message, /400 days ago/);
});

test('a failed registry lookup FAILS -- it is not evidence of freshness', async () => {
  const dir = tmpRepo({ 'package.json': { name: '@particle-academy/x', dependencies: { react: '^19.0.0' } } });
  const result = await checkRepo(dir, FIXTURE, { now: NOW, fetcher: noNetwork, ...NO_CACHE });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, 'lookup-failed');
  assert.equal(result.findings[0].level, 'error');
});

test('--freshness warn downgrades freshness findings but never membership', async () => {
  const dir = tmpRepo({
    'package.json': { name: '@particle-academy/x', dependencies: { react: '^19.0.0', 'left-pad': '^1.0.0' } },
  });
  const result = await checkRepo(dir, FIXTURE, { now: NOW, freshness: 'warn', fetcher: noNetwork, ...NO_CACHE });
  const byKind = Object.fromEntries(result.findings.map((f) => [f.kind, f.level]));
  assert.equal(byKind['lookup-failed'], 'warn');
  assert.equal(byKind['unapproved'], 'error', 'membership is offline and deterministic; it never degrades');
});

test('--freshness off does no network work at all', async () => {
  const dir = tmpRepo({ 'package.json': { name: '@particle-academy/x', dependencies: { react: '^19.0.0' } } });
  const exploded = () => { throw new Error('the checker must not have called this'); };
  const result = await checkRepo(dir, FIXTURE, { now: NOW, freshness: 'off', fetcher: exploded, ...NO_CACHE });
  assert.deepEqual(result.findings, []);
});

test('first-party packages are never freshness-checked', async () => {
  const dir = tmpRepo({
    'package.json': { name: '@particle-academy/x', dependencies: { '@particle-academy/react-fancy': '>=5 <6' } },
  });
  const exploded = () => { throw new Error('ours is not a registry-freshness question'); };
  const result = await checkRepo(dir, FIXTURE, { now: NOW, fetcher: exploded, ...NO_CACHE });
  assert.deepEqual(result.findings, []);
});

test('a freshness override with an expiry in the future suppresses the lookup', async () => {
  const allowlist = structuredClone(FIXTURE);
  allowlist.ecosystems.npm.packages['sleepy-lib'] = {
    reason: 'Feature-complete; still maintained on git.',
    freshness: { mode: 'git', evidence: 'https://example.invalid/commit/abc', verifiedOn: '2026-08-19', expires: '2026-11-19' },
  };
  const dir = tmpRepo({ 'package.json': { name: '@particle-academy/x', dependencies: { 'sleepy-lib': '^1.0.0' } } });
  const exploded = () => { throw new Error('an override means we already looked'); };
  const result = await checkRepo(dir, allowlist, { now: NOW, fetcher: exploded, ...NO_CACHE });
  assert.deepEqual(result.findings, []);
});

test('an expired freshness override fails -- an exception that never expires is a hole', async () => {
  const allowlist = structuredClone(FIXTURE);
  allowlist.ecosystems.npm.packages['sleepy-lib'] = {
    reason: 'Feature-complete.',
    freshness: { mode: 'git', evidence: 'x', verifiedOn: '2025-01-01', expires: '2025-04-01' },
  };
  const dir = tmpRepo({ 'package.json': { name: '@particle-academy/x', dependencies: { 'sleepy-lib': '^1.0.0' } } });
  const result = await checkRepo(dir, allowlist, { now: NOW, fetcher: () => Promise.resolve(NOW), ...NO_CACHE });
  assert.equal(result.findings[0].kind, 'expired-override');
  assert.equal(result.findings[0].level, 'error');
});

test('an override with no expiry date is rejected outright', async () => {
  const allowlist = structuredClone(FIXTURE);
  allowlist.ecosystems.npm.packages['sleepy-lib'] = { reason: 'x', freshness: { mode: 'git', evidence: 'x' } };
  const dir = tmpRepo({ 'package.json': { name: '@particle-academy/x', dependencies: { 'sleepy-lib': '^1.0.0' } } });
  const result = await checkRepo(dir, allowlist, { now: NOW, fetcher: () => Promise.resolve(NOW), ...NO_CACHE });
  assert.equal(result.findings[0].kind, 'bad-override');
});

test('--offline with no cached data is a failure, not a pass', async () => {
  const cache = {};
  const r = await freshnessOf('npm', 'anything', {
    cache, cacheFile: null, cacheTtlMs: DAY, offline: true, now: NOW, fetcher: alwaysFresh,
  });
  assert.match(r.error, /no cached freshness data/);
});

test('a cache hit inside the TTL is reused instead of refetching', async () => {
  const cache = { 'npm:react': { at: NOW - 1000, value: { lastActivity: '2026-08-01T00:00:00.000Z' } } };
  const r = await freshnessOf('npm', 'react', {
    cache, cacheFile: null, cacheTtlMs: DAY, offline: false, now: NOW,
    fetcher: () => { throw new Error('should have used the cache'); },
  });
  assert.equal(r.cached, true);
  assert.equal(r.lastActivity, '2026-08-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Distribution: the gate has to actually be wired to something
// ---------------------------------------------------------------------------

// Rewritten 2026-09-21 when the rule changed, NOT loosened to pass. The old
// version asserted the old contract: `ci.yml` was reported as missing a gate
// because its FILENAME was on a hardcoded list, even though it only ran
// `npm test` and installs nothing. That is the defect, encoded as an
// expectation. The new contract is per-job and behavioural.
test('gateStatus reports which JOBS install without the gate having passed', () => {
  const gateStep = '      - run: node .allowlist/third-party/check.mjs --repo .\n';
  const dir = tmpRepo({
    // Gate before the install, same job -- blocked.
    '.github/workflows/publish.yml':
      'jobs:\n  publish:\n    steps:\n' + gateStep + '      - run: npm ci\n',
    // Installs nothing, so it is not asked to carry a gate. Under the old
    // filename rule this was reported as ungated.
    '.github/workflows/ci.yml': 'jobs:\n  t:\n    steps:\n      - run: npm test\n',
    // Installs with the gate in a PARALLEL job -- a report, not a gate. The old
    // rule saw check.mjs in the file and called the whole file gated.
    '.github/workflows/build.yml':
      'jobs:\n  allowlist:\n    steps:\n' + gateStep +
      '  app:\n    steps:\n      - run: composer install\n',
    '.github/workflows/no-mcp-secrets.yml': 'jobs:\n  s:\n    steps:\n      - run: true\n',
  });
  const status = gateStatus(dir);
  assert.deepEqual(status.present, ['publish.yml']);
  assert.deepEqual(status.missing, ['build.yml:app']);
});

test('a repo with no workflows is reported, not silently passed', () => {
  const dir = tmpRepo({ 'package.json': { name: 'x' } });
  assert.equal(gateStatus(dir).hasWorkflows, false);
});

// ---------------------------------------------------------------------------
// The real allowlist has to be loadable and internally coherent
// ---------------------------------------------------------------------------

test('the shipped allowlist parses and matches the checker schema version', () => {
  const allowlist = loadAllowlist(REAL_ALLOWLIST);
  assert.equal(allowlist.schemaVersion, SCHEMA_VERSION);
  assert.ok(allowlist.policy.freshnessDays >= 1);
});

test('a mismatched schemaVersion refuses to load rather than misreading', () => {
  const dir = tmpRepo({ 'allowlist.json': { schemaVersion: 999 } });
  assert.throws(() => loadAllowlist(path.join(dir, 'allowlist.json')), /schemaVersion/);
});

test('every allowlist entry carries a reason', () => {
  const allowlist = loadAllowlist(REAL_ALLOWLIST);
  const missing = [];
  for (const [eco, block] of Object.entries(allowlist.ecosystems)) {
    for (const kind of ['authors', 'packages']) {
      for (const [name, entry] of Object.entries(block[kind] || {})) {
        if (!entry.reason) missing.push(`${eco}.${kind}.${name}`);
      }
    }
  }
  for (const [pkg, byEco] of Object.entries(allowlist.packageGrants || {})) {
    if (pkg.startsWith('_')) continue;
    for (const [eco, entries] of Object.entries(byEco)) {
      if (eco.startsWith('_')) continue;
      for (const [name, entry] of Object.entries(entries)) {
        if (!entry.reason) missing.push(`packageGrants.${pkg}.${eco}.${name}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'an entry with no reason is a decision nobody can review later');
});

test('no allowlist entry carries a freshness override without an expiry', () => {
  const allowlist = loadAllowlist(REAL_ALLOWLIST);
  const bad = [];
  const visit = (label, entry) => {
    if (entry?.freshness && !Date.parse(entry.freshness.expires || '')) bad.push(label);
  };
  for (const [eco, block] of Object.entries(allowlist.ecosystems)) {
    for (const kind of ['authors', 'packages']) {
      for (const [name, entry] of Object.entries(block[kind] || {})) visit(`${eco}.${kind}.${name}`, entry);
    }
  }
  for (const [pkg, byEco] of Object.entries(allowlist.packageGrants || {})) {
    if (pkg.startsWith('_')) continue;
    for (const [eco, entries] of Object.entries(byEco)) {
      if (eco.startsWith('_')) continue;
      for (const [name, entry] of Object.entries(entries)) visit(`${pkg}.${eco}.${name}`, entry);
    }
  }
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------
// Grant identity: manifest name OR repo directory
// ---------------------------------------------------------------------------

test('a grant matches either the manifest name or the repo directory name', () => {
  const allowlist = structuredClone(FIXTURE);
  allowlist.packageGrants['px-ui-sandbox'] = { composer: { 'stripe/stripe-php': { reason: 'Showcase checkout.' } } };
  // px-ui-sandbox's composer.json is literally named `laravel/laravel` -- the
  // scaffold's name, which every Laravel app on earth shares. Keying a grant on
  // that would hand the grant to any app that ran `laravel new`.
  const v = classify(allowlist, 'composer', 'stripe/stripe-php', ['laravel/laravel', 'px-ui-sandbox']);
  assert.equal(v.allowed, true);
  assert.equal(v.grantedTo, 'px-ui-sandbox');
});

test('the directory fallback does not hand a grant to a different repo', () => {
  const allowlist = structuredClone(FIXTURE);
  allowlist.packageGrants['px-ui-sandbox'] = { composer: { 'stripe/stripe-php': { reason: 'Showcase checkout.' } } };
  const v = classify(allowlist, 'composer', 'stripe/stripe-php', ['laravel/laravel', 'some-other-app']);
  assert.equal(v.allowed, false);
});

test('the repo identity comes from the git remote, not only the directory', () => {
  // px-ui-sandbox lives at repos/px-ui-sandbox but its remote is
  // Particle-Academy/pa-ux-sandbox, so Actions checks it out into a directory
  // called pa-ux-sandbox. A grant keyed on either name has to hold in both.
  const dir = tmpRepo({
    'package.json': { dependencies: { echarts: '^6.1.0' } },
    '.git/config': '[remote "origin"]\n\turl = git@github.com:Particle-Academy/pa-ux-sandbox.git\n',
  });
  assert.equal(remoteRepoName(dir), 'pa-ux-sandbox');
});

test('a submodule .git pointer file still yields the remote name', () => {
  const dir = tmpRepo({ 'realgit/config': '[remote "origin"]\n\turl = https://github.com/Particle-Academy/react-fancy.git\n' });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(dir, 'realgit')}\n`);
  assert.equal(remoteRepoName(dir), 'react-fancy');
});

test('a grant keyed on the remote name applies even when the directory differs', async () => {
  const allowlist = structuredClone(FIXTURE);
  allowlist.packageGrants['pa-ux-sandbox'] = { npm: { echarts: { reason: 'Peer of fancy-echarts, which the showcase demonstrates.' } } };
  const dir = tmpRepo({
    'package.json': { dependencies: { echarts: '^6.1.0' } },
    '.git/config': '[remote "origin"]\n\turl = git@github.com:Particle-Academy/pa-ux-sandbox.git\n',
  });
  const result = await checkRepo(dir, allowlist, { now: NOW, fetcher: alwaysFresh, ...NO_CACHE });
  assert.deepEqual(result.findings, []);
});

test('a repo with no remote is still checked, just with one identity fewer', () => {
  const dir = tmpRepo({ 'package.json': { name: 'x' } });
  assert.equal(remoteRepoName(dir), null);
});

// ---------------------------------------------------------------------------
// Cargo
//
// Added when the suite gained its first Rust packages. Before this the checker
// spoke npm, Composer and PyPI, so a Rust repo passed the gate by being
// invisible to it -- which is the same outcome as having no gate.
// ---------------------------------------------------------------------------

test('parseCargoToml reads every dependency block', () => {
  const parsed = parseCargoToml(`
[package]
name = "my-crate"
version = "0.1.0"

[dependencies]
serde_json = "1.0"

[dev-dependencies]
proptest = "1"

[build-dependencies]
cc = "1"
`);

  assert.equal(parsed.ecosystem, 'crates');
  assert.equal(parsed.name, 'my-crate');
  assert.deepEqual(
    parsed.deps.map((d) => [d.name, d.field]),
    [['serde_json', 'dependencies'], ['proptest', 'dev-dependencies'], ['cc', 'build-dependencies']],
  );
});

test('parseCargoToml reports the REGISTRY name of a renamed crate', () => {
  // `renamed = { version = "1", package = "tokio" }` installs tokio. A grant is
  // about what is installed, not what the author chose to call it -- reading the
  // key would let any dependency be smuggled past the allowlist by renaming it.
  const parsed = parseCargoToml(`
[package]
name = "my-crate"

[dependencies]
renamed = { version = "1", package = "tokio" }
`);
  assert.deepEqual(parsed.deps.map((d) => d.name), ['tokio']);
});

test('parseCargoToml marks git and path dependencies by source', () => {
  // Neither is a registry dependency: `path` is local and `git` fetches code no
  // registry ever saw. They are reported rather than skipped, so an unapproved
  // one is refused by name instead of slipping through a hole shaped exactly
  // like the thing the gate exists to catch.
  const parsed = parseCargoToml(`
[package]
name = "my-crate"

[dependencies]
fancy-json = { version = "0.1", git = "https://github.com/Particle-Academy/fancy-json-rs" }
local = { path = "../local" }
plain = "1.0"
`);
  assert.deepEqual(
    parsed.deps.map((d) => [d.name, d.source]),
    [['fancy-json', 'git'], ['local', 'path'], ['plain', 'registry']],
  );
});

test('parseCargoToml handles target-conditional dependency tables', () => {
  const parsed = parseCargoToml(`
[package]
name = "my-crate"

[target.'cfg(unix)'.dependencies]
libc = "0.2"
`);
  assert.deepEqual(parsed.deps.map((d) => [d.name, d.field]), [['libc', 'dependencies']]);
});

test('parseCargoToml ignores comments and non-dependency tables', () => {
  const parsed = parseCargoToml(`
[package]
name = "my-crate"

# [dependencies]
# commented_out = "1"

[features]
default = ["std"]
std = []

[lints.clippy]
pedantic = "warn"
`);
  assert.equal(parsed.name, 'my-crate');
  assert.deepEqual(parsed.deps, []);
});

test('crates has no checkable owner, so every crate is listed individually', () => {
  // Same shape as PyPI. There is no namespace in a crate name, so an
  // author-level allow would be approving a string, not a person.
  assert.equal(ownerOf('crates', 'serde_json'), null);
  assert.equal(ownerOf('crates', 'fancy-json'), null);
});

test('an unapproved crate is refused and a first-party one is not', () => {
  const allowlist = loadAllowlist(path.join(import.meta.dirname, 'allowlist.json'));

  const refused = classify(allowlist, 'crates', 'serde_json', 'fancy-flow');
  assert.equal(refused.allowed, false, 'serde_json is not on the allowlist');

  const ours = classify(allowlist, 'crates', 'fancy-json', 'fancy-flow');
  assert.equal(ours.allowed, true);
  assert.equal(ours.via, 'first-party');
});

// ---------------------------------------------------------------------------
// Inheritance: a DIRECT listing that an approved direct dependency also requires
//
// Owner's ruling, 2026-10-31: "dependencies of our whitelisted dependencies
// inherit their status from what we use" -- applied to a package that is BOTH
// listed directly and required by an approved direct dependency. The edge is
// proven from the repo's LOCKFILE, never inferred and never fetched.
//
// The motivating case, reproduced exactly: a Laravel app lists
// nunomaduro/collision in require-dev, collision's last activity is
// 2026-08-04, and pestphp/pest (approved through the `pestphp` author entry)
// requires `nunomaduro/collision ^8.9.4` in composer.lock.
// ---------------------------------------------------------------------------

// A date after collision crosses the 92-day bar (2026-08-04 + 92 = 2026-11-04).
const INHERIT_NOW = Date.parse('2026-11-10T00:00:00Z');

const INHERIT_ALLOWLIST = {
  schemaVersion: SCHEMA_VERSION,
  policy: { freshnessDays: 92 },
  firstParty: { npm: ['@particle-academy'], composer: ['particle-academy'] },
  ecosystems: {
    npm: {
      identity: 'scope',
      authors: { '@vitest': { reason: 'Vitest.' } },
      packages: { vitest: { reason: 'The TS test runner.' } },
    },
    composer: {
      identity: 'vendor',
      authors: {
        pestphp: { reason: 'Pest.' },
        laravel: { reason: 'The framework vendor.' },
      },
      packages: {},
    },
  },
  packageGrants: {},
};

// Real last-activity dates: collision from the Packagist lookup on 2026-10-31.
const ACTIVITY = {
  'composer:nunomaduro/collision': Date.parse('2026-08-04T15:19:57Z'),
  'composer:pestphp/pest': Date.parse('2026-10-28T00:00:00Z'),
  'composer:laravel/framework': Date.parse('2026-10-28T00:00:00Z'),
  'composer:acme/stale-parent': Date.parse('2026-01-01T00:00:00Z'),
  'npm:vitest': Date.parse('2026-10-28T00:00:00Z'),
  'npm:tinyspy': Date.parse('2026-06-01T00:00:00Z'),
  'npm:loupe': Date.parse('2026-06-01T00:00:00Z'),
};
const byActivity = (eco, name) => {
  const t = ACTIVITY[`${eco}:${name}`];
  return t === undefined ? Promise.reject(new Error(`no fixture date for ${eco}:${name}`)) : Promise.resolve(t);
};

// composer.lock exactly as Composer writes the relevant entries (trimmed).
function composerLock({ pestRequiresCollision = true, extra = [] } = {}) {
  const pestRequire = {
    'brianium/paratest': '^7.20.0',
    'nunomaduro/termwind': '^2.4.0',
    php: '^8.3.0',
    'phpunit/phpunit': '^12.5.29',
  };
  if (pestRequiresCollision) pestRequire['nunomaduro/collision'] = '^8.9.4';
  return {
    packages: [],
    'packages-dev': [
      {
        name: 'nunomaduro/collision',
        version: 'v8.9.4',
        require: { 'filp/whoops': '^2.18.4', 'nunomaduro/termwind': '^2.4.0', php: '^8.2.0' },
      },
      { name: 'pestphp/pest', version: 'v4.7.3', require: pestRequire },
      ...extra,
    ],
  };
}

const LARAVEL_APP = {
  name: 'laravel/laravel',
  require: { php: '^8.4', 'laravel/framework': '^13.0' },
  'require-dev': { 'nunomaduro/collision': '^8.6', 'pestphp/pest': '^4.0' },
};

const inheritOpts = (extra = {}) => ({ now: INHERIT_NOW, fetcher: byActivity, ...NO_CACHE, ...extra });
const errorsFor = (result, name) => result.findings.filter((f) => f.level === 'error' && f.name === name);
const inheritedFor = (result, name) => result.findings.filter((f) => f.kind === 'inherited' && f.name === name);

// The control. Without this the inheritance tests below could pass against a
// fixture in which collision was never failing in the first place.
test('control: collision fails freshness when nothing approved requires it', async () => {
  const dir = tmpRepo({
    'composer.json': { ...LARAVEL_APP, 'require-dev': { 'nunomaduro/collision': '^8.6' } },
  });
  const allowlist = structuredClone(INHERIT_ALLOWLIST);
  allowlist.ecosystems.composer.packages['nunomaduro/collision'] = { reason: 'CLI error reporting.' };
  const result = await checkRepo(dir, allowlist, inheritOpts());
  assert.deepEqual(errorsFor(result, 'nunomaduro/collision').map((f) => f.kind), ['stale']);
});

test('MUST FIRE: a direct listing inherits an approved parent via composer.lock', async () => {
  const dir = tmpRepo({ 'composer.json': LARAVEL_APP, 'composer.lock': composerLock() });
  const allowlist = structuredClone(INHERIT_ALLOWLIST);
  allowlist.ecosystems.composer.packages['nunomaduro/collision'] = { reason: 'CLI error reporting.' };
  const result = await checkRepo(dir, allowlist, inheritOpts());
  assert.deepEqual(errorsFor(result, 'nunomaduro/collision'), [], 'pest requires it, so it inherits pest');
  const inh = inheritedFor(result, 'nunomaduro/collision');
  assert.equal(inh.length, 1);
  assert.equal(inh[0].parent, 'pestphp/pest');
  assert.equal(inh[0].lockfile, 'composer.lock');
  assert.deepEqual(inh[0].waived.map((w) => w.kind), ['stale'], 'what it would have failed on is kept, not dropped');
});

test('MUST FIRE: inheritance covers APPROVAL too, not only freshness', async () => {
  // collision is not on this allowlist at all. Pest requires it, so it inherits.
  const dir = tmpRepo({ 'composer.json': LARAVEL_APP, 'composer.lock': composerLock() });
  const result = await checkRepo(dir, INHERIT_ALLOWLIST, inheritOpts());
  assert.deepEqual(errorsFor(result, 'nunomaduro/collision'), []);
  const inh = inheritedFor(result, 'nunomaduro/collision');
  assert.equal(inh.length, 1);
  assert.deepEqual(inh[0].waived.map((w) => w.kind), ['unapproved']);
});

test('MUST FIRE: a direct listing inherits an approved parent via package-lock.json', async () => {
  const dir = tmpRepo({
    'package.json': { name: '@particle-academy/x', devDependencies: { vitest: '^4.0.0', tinyspy: '^4.0.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { name: '@particle-academy/x', devDependencies: { vitest: '^4.0.0', tinyspy: '^4.0.0' } },
        'node_modules/vitest': { version: '4.0.0', dev: true, dependencies: { tinyspy: '^4.0.3' } },
        'node_modules/tinyspy': { version: '4.0.3', dev: true },
      },
    },
  });
  const result = await checkRepo(dir, INHERIT_ALLOWLIST, inheritOpts());
  assert.deepEqual(errorsFor(result, 'tinyspy'), []);
  const inh = inheritedFor(result, 'tinyspy');
  assert.equal(inh.length, 1);
  assert.equal(inh[0].parent, 'vitest');
  assert.equal(inh[0].lockfile, 'package-lock.json');
});

test('MUST FIRE: package-lock peer and optional dependencies are edges too', async () => {
  const dir = tmpRepo({
    'package.json': { name: '@particle-academy/x', devDependencies: { vitest: '^4.0.0', tinyspy: '^4.0.0', loupe: '^3.0.0' } },
    'package-lock.json': {
      lockfileVersion: 2,
      packages: {
        'node_modules/vitest': {
          version: '4.0.0',
          peerDependencies: { tinyspy: '^4.0.3' },
          optionalDependencies: { loupe: '^3.0.0' },
        },
        'node_modules/tinyspy': { version: '4.0.3' },
        'node_modules/loupe': { version: '3.0.0' },
      },
    },
  });
  const result = await checkRepo(dir, INHERIT_ALLOWLIST, inheritOpts());
  assert.equal(inheritedFor(result, 'tinyspy').length, 1);
  assert.equal(inheritedFor(result, 'loupe').length, 1);
});

test('MUST NOT FIRE: the parent is not approved', async () => {
  const lock = composerLock({
    extra: [{ name: 'acme/runner', version: '1.0.0', require: { 'nunomaduro/collision': '^8.0' } }],
  });
  lock['packages-dev'] = lock['packages-dev'].filter((p) => p.name !== 'pestphp/pest');
  const dir = tmpRepo({
    'composer.json': { ...LARAVEL_APP, 'require-dev': { 'nunomaduro/collision': '^8.6', 'acme/runner': '^1.0' } },
    'composer.lock': lock,
  });
  const result = await checkRepo(dir, INHERIT_ALLOWLIST, inheritOpts({ freshness: 'off' }));
  assert.deepEqual(errorsFor(result, 'nunomaduro/collision').map((f) => f.kind), ['unapproved']);
  assert.deepEqual(inheritedFor(result, 'nunomaduro/collision'), []);
});

test('MUST NOT FIRE: the parent is approved but fails its OWN check (stale)', async () => {
  const allowlist = structuredClone(INHERIT_ALLOWLIST);
  allowlist.ecosystems.composer.authors.acme = { reason: 'x' };
  const dir = tmpRepo({
    'composer.json': { name: 'laravel/laravel', 'require-dev': { 'nunomaduro/collision': '^8.6', 'acme/stale-parent': '^1.0' } },
    'composer.lock': {
      packages: [],
      'packages-dev': [{ name: 'acme/stale-parent', version: '1.0.0', require: { 'nunomaduro/collision': '^8.0' } }],
    },
  });
  const result = await checkRepo(dir, allowlist, inheritOpts());
  assert.deepEqual(errorsFor(result, 'nunomaduro/collision').map((f) => f.kind), ['unapproved']);
  assert.deepEqual(inheritedFor(result, 'nunomaduro/collision'), []);
});

test('MUST NOT FIRE: the parent is in the lockfile but is not a direct dependency', async () => {
  // pest is installed (lockfile) and requires collision, but this repo does not
  // list pest. Inheritance is from what WE use, not from whatever got installed.
  const dir = tmpRepo({
    'composer.json': { ...LARAVEL_APP, 'require-dev': { 'nunomaduro/collision': '^8.6' } },
    'composer.lock': composerLock(),
  });
  const result = await checkRepo(dir, INHERIT_ALLOWLIST, inheritOpts({ freshness: 'off' }));
  assert.deepEqual(errorsFor(result, 'nunomaduro/collision').map((f) => f.kind), ['unapproved']);
  assert.deepEqual(inheritedFor(result, 'nunomaduro/collision'), []);
});

test('MUST NOT FIRE: there is no lockfile, so the edge is unproven', async () => {
  const dir = tmpRepo({ 'composer.json': LARAVEL_APP });
  const result = await checkRepo(dir, INHERIT_ALLOWLIST, inheritOpts({ freshness: 'off' }));
  assert.deepEqual(errorsFor(result, 'nunomaduro/collision').map((f) => f.kind), ['unapproved']);
  assert.deepEqual(inheritedFor(result, 'nunomaduro/collision'), []);
});

test('MUST NOT FIRE: the lockfile shows the parent but not the parent requiring it', async () => {
  const dir = tmpRepo({ 'composer.json': LARAVEL_APP, 'composer.lock': composerLock({ pestRequiresCollision: false }) });
  const result = await checkRepo(dir, INHERIT_ALLOWLIST, inheritOpts({ freshness: 'off' }));
  assert.deepEqual(errorsFor(result, 'nunomaduro/collision').map((f) => f.kind), ['unapproved']);
  assert.deepEqual(inheritedFor(result, 'nunomaduro/collision'), []);
});

test('MUST NOT FIRE: an OPTIONAL peer is not something the parent requires', async () => {
  // The real px-ui-sandbox shape, found by running this change against it:
  // laravel-echo 2.4.0 declares pusher-js as a peer with
  // peerDependenciesMeta.optional -- it works with pusher-js OR socket.io-client
  // and installs neither. Choosing pusher-js is exactly the decision the
  // allowlist gates, so a stale pusher-js must not ride in on laravel-echo.
  const allowlist = structuredClone(INHERIT_ALLOWLIST);
  allowlist.ecosystems.npm.packages['laravel-echo'] = { reason: 'Echo.' };
  allowlist.ecosystems.npm.packages['pusher-js'] = { reason: 'Pusher client.' };
  const dir = tmpRepo({
    'package.json': { name: 'app', dependencies: { 'laravel-echo': '^2.3.7', 'pusher-js': '^8.5.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        'node_modules/laravel-echo': {
          version: '2.4.0',
          peerDependencies: { 'pusher-js': '*', 'socket.io-client': '*' },
          peerDependenciesMeta: { 'pusher-js': { optional: true }, 'socket.io-client': { optional: true } },
        },
      },
    },
  });
  const fetcher = (eco, name) =>
    Promise.resolve(name === 'pusher-js' ? Date.parse('2026-07-23T00:00:00Z') : Date.parse('2026-10-28T00:00:00Z'));
  const result = await checkRepo(dir, allowlist, inheritOpts({ fetcher }));
  assert.deepEqual(errorsFor(result, 'pusher-js').map((f) => f.kind), ['stale']);
  assert.deepEqual(inheritedFor(result, 'pusher-js'), []);
});

test('MUST NOT FIRE: a package-lock entry\'s OWN devDependencies are not an edge', async () => {
  // A dependency's devDependencies are never installed for a consumer, so they
  // are not something the approved parent brings in.
  const dir = tmpRepo({
    'package.json': { name: '@particle-academy/x', devDependencies: { vitest: '^4.0.0', tinyspy: '^4.0.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: { 'node_modules/vitest': { version: '4.0.0', devDependencies: { tinyspy: '^4.0.3' } } },
    },
  });
  const result = await checkRepo(dir, INHERIT_ALLOWLIST, inheritOpts({ freshness: 'off' }));
  assert.deepEqual(errorsFor(result, 'tinyspy').map((f) => f.kind), ['unapproved']);
});

test('MUST FIRE: a chain keeps the original explicit root approval', async () => {
  // pest (approved) -> collision (inherits from pest) -> acme/grandchild.
  // acme/grandchild is listed directly, and its only requirer is collision,
  // which passes ONLY by inheritance. The explicit root is still pest, and
  // every production edge is recorded: the 2026-11-01 any-depth ruling.
  //
  // Collision is explicitly approved but stale. Its inherited result must not
  // replace pest's original passing approval as the root of the reported path.
  const allowlist = structuredClone(INHERIT_ALLOWLIST);
  allowlist.ecosystems.composer.packages['nunomaduro/collision'] = { reason: 'CLI error reporting.' };
  const lock = composerLock();
  lock['packages-dev'][0].require['acme/grandchild'] = '^1.0';
  lock['packages-dev'].push({ name: 'acme/grandchild', version: '1.0.0', require: {} });
  const dir = tmpRepo({
    'composer.json': {
      ...LARAVEL_APP,
      'require-dev': { ...LARAVEL_APP['require-dev'], 'acme/grandchild': '^1.0' },
    },
    'composer.lock': lock,
  });
  const result = await checkRepo(dir, allowlist, inheritOpts());
  const first = inheritedFor(result, 'nunomaduro/collision');
  assert.equal(first.length, 1, 'the first link holds');
  assert.deepEqual(first[0].waived.map((w) => w.kind), ['stale'], 'collision is approved but fails on its own');
  assert.deepEqual(errorsFor(result, 'acme/grandchild'), []);
  const grandchild = inheritedFor(result, 'acme/grandchild');
  assert.equal(grandchild.length, 1);
  assert.equal(grandchild[0].parent, 'pestphp/pest', 'an inherited intermediate never becomes the root');
  assert.deepEqual(grandchild[0].path, ['pestphp/pest', 'nunomaduro/collision', 'acme/grandchild']);
});

test('an inherited package is still REPORTED, in the text and the JSON record', async () => {
  const dir = tmpRepo({ 'composer.json': LARAVEL_APP, 'composer.lock': composerLock() });
  const result = await checkRepo(dir, INHERIT_ALLOWLIST, inheritOpts());
  const inh = inheritedFor(result, 'nunomaduro/collision');
  assert.equal(inh.length, 1);
  assert.equal(inh[0].level, 'note', 'reported, and it does not fail the build');
  assert.match(inh[0].message, /^nunomaduro\/collision via pestphp\/pest/);
  const record = result.checked.find((c) => c.name === 'nunomaduro/collision');
  assert.equal(record.inheritedFrom, 'pestphp/pest', 'the JSON record says why it passed');
  assert.match(checker.renderResult(result), /INHERITED nunomaduro\/collision via pestphp\/pest/);
});

test('a package that passes on its own is NOT reported as inherited', async () => {
  // Pest requires collision, but collision is approved and fresh in its own
  // right here, so inheritance has nothing to do and must not claim the pass.
  const dir = tmpRepo({ 'composer.json': LARAVEL_APP, 'composer.lock': composerLock() });
  const allowlist = structuredClone(INHERIT_ALLOWLIST);
  allowlist.ecosystems.composer.packages['nunomaduro/collision'] = { reason: 'CLI error reporting.' };
  const result = await checkRepo(dir, allowlist, inheritOpts({ now: Date.parse('2026-10-31T00:00:00Z') }));
  assert.deepEqual(result.findings, []);
});

test('lockfile edge readers: composer.lock and package-lock.json', () => {
  const composer = checker.composerLockEdges(composerLock());
  assert.equal(composer.get('pestphp/pest').has('nunomaduro/collision'), true);
  assert.equal(composer.get('pestphp/pest').has('php'), false, 'platform requirements are not edges');
  const npm = checker.npmLockEdges({
    lockfileVersion: 3,
    packages: {
      'node_modules/vitest': { dependencies: { tinyspy: '1' } },
      'node_modules/tinyspy': { version: '1' },
      // A nested copy is not the direct dependency the manifest names.
      'node_modules/other/node_modules/vitest': { dependencies: { loupe: '1' } },
    },
  });
  assert.deepEqual([...npm.get('vitest')], ['tinyspy']);
  // lockfileVersion 1 has no `packages` map; no proven edges, so no inheritance.
  assert.equal(checker.npmLockEdges({ lockfileVersion: 1, dependencies: { vitest: { requires: { tinyspy: '1' } } } }).size, 0);
});
