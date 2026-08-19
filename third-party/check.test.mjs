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
  pyRequirementName,
  ownerOf,
  classify,
  checkRepo,
  gateStatus,
  loadAllowlist,
  freshnessOf,
  SCHEMA_VERSION,
} from './check.mjs';

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

test('gateStatus reports which release/CI workflows run the check', () => {
  const dir = tmpRepo({
    '.github/workflows/publish.yml': 'steps:\n  - run: node .allowlist/third-party/check.mjs --repo .\n',
    '.github/workflows/ci.yml': 'steps:\n  - run: npm test\n',
    '.github/workflows/no-mcp-secrets.yml': 'steps:\n  - run: true\n',
  });
  const status = gateStatus(dir);
  assert.deepEqual(status.present, ['publish.yml']);
  assert.deepEqual(status.missing, ['ci.yml']);
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
