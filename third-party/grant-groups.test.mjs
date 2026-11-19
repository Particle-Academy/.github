// Named grant groups (an approval for an explicit list of packages) and
// dev-only enforcement. Owner decisions of 2026-11-19 (q_26036ea0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRepo, classify, decisionProblems, groupProblems, loadAllowlist } from './check.mjs';

const real = loadAllowlist(path.join(import.meta.dirname, 'allowlist.json'));

const decision = (extra = {}) => ({
  scope: 'package-only', owner: 'wishborn', date: '2026-11-19', questions: ['q_26036ea0'],
  packages: ['group:laravel-packages'], ...extra,
});

const policy = () => ({
  schemaVersion: 1,
  policy: {},
  firstParty: { npm: ['@particle-academy'], composer: ['particle-academy'] },
  ecosystems: {
    npm: { authors: {}, packages: {
      vitest: { reason: 'Tests.', decision: { scope: 'dev-only', owner: 'wishborn', date: '2026-11-19', questions: ['q_26036ea0'] } },
      react: { reason: 'UI.' },
    } },
    composer: { authors: {}, packages: {
      'pestphp/pest': { reason: 'Tests.', decision: { scope: 'dev-only', owner: 'wishborn', date: '2026-11-19', questions: ['q_26036ea0'] } },
    } },
    pypi: { authors: {}, packages: {} },
    crates: { authors: {}, packages: {} },
  },
  packageGrants: {},
  grantGroups: {
    'laravel-packages': {
      reason: 'Our Laravel packages.',
      members: ['particle-academy/a', 'particle-academy/b'],
      composer: {
        authors: { illuminate: { reason: 'Laravel splits.', decision: decision() } },
        packages: { 'laravel/framework': { reason: 'Laravel.', decision: decision() } },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

test('a group member gets the group\'s package and author entries', () => {
  const p = policy();
  const fw = classify(p, 'composer', 'laravel/framework', 'particle-academy/a');
  assert.equal(fw.allowed, true);
  assert.equal(fw.via, 'group');
  assert.equal(fw.group, 'laravel-packages');
  assert.equal(fw.grantedTo, 'particle-academy/a');
  const split = classify(p, 'composer', 'illuminate/support', ['x', 'particle-academy/b']);
  assert.equal(split.via, 'group');
  assert.equal(split.owner, 'illuminate');
});

test('MUST FIRE: a non-member is refused, and told which group holds the grant', () => {
  const v = classify(policy(), 'composer', 'illuminate/support', ['laravel/laravel', 'pa-ux-sandbox']);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /group laravel-packages/);
});

test('MUST FIRE: membership is a literal list, never a prefix or the vendor', () => {
  const v = classify(policy(), 'composer', 'laravel/framework', 'particle-academy/a-fork');
  assert.equal(v.allowed, false);
});

test('MUST FIRE: a vendor-wide author entry does not approve a package it carves out with except', () => {
  const p = policy();
  p.ecosystems.composer.authors.laravel = { reason: 'founding list', except: ['laravel/framework'] };
  assert.equal(classify(p, 'composer', 'laravel/cashier', 'particle-academy/zzz').via, 'author');
  assert.equal(classify(p, 'composer', 'laravel/framework', 'particle-academy/zzz').allowed, false);
  assert.equal(classify(p, 'composer', 'laravel/framework', 'particle-academy/a').via, 'group');
});

test('MUST FIRE (real allowlist): the laravel vendor entry carves out laravel/framework', () => {
  assert.ok(real.ecosystems.composer.authors.laravel.except.includes('laravel/framework'));
});

test('a group grant applies only in the ecosystem it is written for', () => {
  const p = policy();
  p.grantGroups['laravel-packages'].composer.packages.react = { reason: 'x' };
  // react is kit-wide in npm anyway; the composer-side group entry must not leak into npm
  assert.equal(classify(p, 'npm', 'react', 'particle-academy/a').via, 'package');
});

test('a one-package grant still wins over a group', () => {
  const p = policy();
  p.packageGrants['particle-academy/a'] = { composer: { 'laravel/framework': { reason: 'specific' } } };
  assert.equal(classify(p, 'composer', 'laravel/framework', 'particle-academy/a').via, 'grant');
});

// ---------------------------------------------------------------------------
// groupProblems (shape) + decisionProblems (placement)
// ---------------------------------------------------------------------------

test('the real allowlist has well-formed groups', () => {
  assert.deepEqual(groupProblems(real), []);
  assert.deepEqual(decisionProblems(real), []);
});

test('the fixture is clean, so every must-fire below fires for its own reason', () => {
  assert.deepEqual(groupProblems(policy()), []);
  assert.deepEqual(decisionProblems(policy()), []);
});

test('MUST FIRE: a group with no members', () => {
  const p = policy(); p.grantGroups['laravel-packages'].members = [];
  assert.match(groupProblems(p).join('\n'), /members/);
});

test('MUST FIRE: a member listed twice, or not a string', () => {
  const p = policy(); p.grantGroups['laravel-packages'].members = ['particle-academy/a', 'particle-academy/a', 7];
  const out = groupProblems(p).join('\n');
  assert.match(out, /twice/);
  assert.match(out, /string/);
});

test('MUST FIRE: a group with no reason, or an entry with no reason', () => {
  const p = policy();
  delete p.grantGroups['laravel-packages'].reason;
  delete p.grantGroups['laravel-packages'].composer.packages['laravel/framework'].reason;
  const out = groupProblems(p).join('\n');
  assert.match(out, /laravel-packages: no reason/);
  assert.match(out, /laravel\/framework: no reason/);
});

test('MUST FIRE: an unknown ecosystem key in a group', () => {
  const p = policy(); p.grantGroups['laravel-packages'].composr = { packages: {} };
  assert.match(groupProblems(p).join('\n'), /unknown ecosystem composr/);
});

test('MUST FIRE: a group entry that is ALSO listed kit-wide, so the group restricts nothing', () => {
  const p = policy(); p.ecosystems.composer.packages['laravel/framework'] = { reason: 'kit-wide' };
  assert.match(groupProblems(p).join('\n'), /also listed in ecosystems\.composer\.packages/);
  const q = policy(); q.ecosystems.composer.authors.illuminate = { reason: 'kit-wide' };
  assert.match(groupProblems(q).join('\n'), /also listed in ecosystems\.composer\.authors/);
});

test('MUST FIRE: a group package that a kit-wide vendor entry already covers', () => {
  const p = policy(); p.ecosystems.composer.authors.laravel = { reason: 'founding list' };
  assert.match(groupProblems(p).join('\n'), /author entry laravel already approves it/);
  p.ecosystems.composer.authors.laravel.except = ['laravel/framework'];
  assert.deepEqual(groupProblems(p), []);
});

test('MUST FIRE: a group with neither an owner decision on its entries nor an approval note', () => {
  const p = policy();
  p.grantGroups.pending = { reason: 'x', members: ['m'], composer: { packages: { 'laravel/framework': { reason: 'x' } } } };
  delete p.ecosystems.composer.packages['laravel/framework'];
  assert.match(groupProblems(p).join('\n'), /pending: .*approval/);
});

test('a pending group passes when its approval says so', () => {
  const p = policy();
  p.grantGroups.pending = { reason: 'x', approval: 'pending owner review (apps)', members: ['m'], composer: { packages: { 'laravel/framework': { reason: 'x' } } } };
  assert.deepEqual(groupProblems(p), []);
});

test('a package-only decision is correctly placed in a group, and must name that group', () => {
  assert.deepEqual(decisionProblems(policy()), []);
  const p = policy();
  p.grantGroups['laravel-packages'].composer.packages['laravel/framework'].decision = decision({ packages: ['particle-academy/a'] });
  assert.match(decisionProblems(p).join('\n'), /must name its group as "group:laravel-packages"/);
});

test('MUST FIRE: a kit-wide decision recorded on a group', () => {
  const p = policy();
  p.grantGroups['laravel-packages'].composer.packages['laravel/framework'].decision = decision({ scope: 'kit-wide' });
  assert.match(decisionProblems(p).join('\n'), /belongs in ecosystems/);
});

// ---------------------------------------------------------------------------
// The batch-1 Laravel grant as recorded in the real allowlist
// ---------------------------------------------------------------------------

const APPS = ['pa-ux-sandbox', 'px-ui-sandbox', 'fancy-starter-kit', 'particle-academy/fancy-starter-kit', 'fancy-labs', 'particle-academy/fancy-labs'];

test('Laravel is no longer kit-wide: illuminate and laravel/framework live only in groups', () => {
  assert.equal(real.ecosystems.composer.authors.illuminate, undefined);
  assert.equal(real.ecosystems.composer.packages['laravel/framework'], undefined);
});

test('the laravel-packages group carries the owner decision and names no application', () => {
  const g = real.grantGroups['laravel-packages'];
  for (const entry of [g.composer.authors.illuminate, g.composer.packages['laravel/framework']]) {
    assert.equal(entry.decision.scope, 'package-only');
    assert.ok(entry.decision.questions.includes('q_26036ea0'));
    assert.equal(entry.decision.minimumVersion, '^13.0');
  }
  for (const app of [...APPS, 'laravel/laravel', 'laravel-jobs-reference']) assert.ok(!g.members.includes(app), app);
  assert.ok(g.members.includes('particle-academy/holy-sheet'));
  assert.ok(g.members.length >= 29);
});

test('the applications keep Laravel only through a group that says it awaits the owner', () => {
  const apps = real.grantGroups['laravel-apps-pending'];
  assert.match(apps.approval, /pending owner review \(apps\)/);
  for (const e of [apps.composer.authors?.illuminate, apps.composer.packages['laravel/framework']].filter(Boolean)) {
    assert.equal(e.decision, undefined, 'no owner decision covers the apps yet');
  }
  // The identities checkRepo really passes: manifest name, then repo/remote name.
  for (const ids of [['laravel/laravel', 'pa-ux-sandbox'], ['particle-academy/fancy-starter-kit', 'fancy-starter-kit'],
    ['particle-academy/fancy-labs', 'fancy-labs'], ['laravel/laravel', 'laravel-jobs-reference'], ['laravel/laravel', 'website']]) {
    assert.equal(classify(real, 'composer', 'laravel/framework', ids).group, 'laravel-apps-pending', ids.join(' / '));
  }
  // and the shared scaffold name alone grants nothing
  assert.equal(classify(real, 'composer', 'laravel/framework', ['laravel/laravel']).allowed, false);
});

test('MUST FIRE (real allowlist): an unlisted package cannot declare Laravel', () => {
  for (const dep of ['laravel/framework', 'illuminate/support']) {
    assert.equal(classify(real, 'composer', dep, ['particle-academy/brand-new-thing', 'brand-new-thing']).allowed, false, dep);
  }
});

// ---------------------------------------------------------------------------
// Inertia, owner decision q_7fd61e5d: standard pattern, no bridge
// ---------------------------------------------------------------------------

// The kit-wide entries could only go if nothing else declared Inertia. Three
// org repos outside these grants do (prism-labs, prism-sandbox, website), so
// they stay, unenforced, and say exactly who still rests on them.
test('the kit-wide Inertia entries stay only as a declared gap naming who still needs them', () => {
  for (const e of [real.ecosystems.npm.packages['@inertiajs/react'], real.ecosystems.composer.packages['inertiajs/inertia-laravel']]) {
    assert.equal(e.decision.enforced, false);
    for (const repo of ['prism-labs', 'prism-sandbox', 'website']) assert.match(e.decision.gap, new RegExp(repo));
  }
});

test('@inertiajs/react is granted to fancy-inertia, fancy-query and the three apps; nobody else holds a grant', () => {
  for (const id of ['@particle-academy/fancy-inertia', '@particle-academy/fancy-query', 'pa-ux-sandbox', 'fancy-starter-kit', 'fancy-labs']) {
    const v = classify(real, 'npm', '@inertiajs/react', [id]);
    assert.equal(v.allowed, true, id);
    assert.ok(v.entry.decision.questions.includes('q_7fd61e5d'), id);
  }
  // Anyone else still resolves only through the declared kit-wide gap above, never a grant.
  assert.equal(classify(real, 'npm', '@inertiajs/react', ['@particle-academy/react-fancy']).via, 'package');
});

test('inertiajs/inertia-laravel is granted to the three apps; nobody else holds a grant', () => {
  for (const id of ['pa-ux-sandbox', 'fancy-starter-kit', 'fancy-labs']) {
    const v = classify(real, 'composer', 'inertiajs/inertia-laravel', [id]);
    assert.equal(v.allowed, true, id);
    assert.ok(v.entry.decision.questions.includes('q_7fd61e5d'), id);
  }
  assert.equal(classify(real, 'composer', 'inertiajs/inertia-laravel', ['particle-academy/change-council']).via, 'package');
});

// ---------------------------------------------------------------------------
// dev-only enforcement
// ---------------------------------------------------------------------------

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-groups-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
}
const run = (dir, p = policy()) => checkRepo(dir, p, { freshness: 'off', cacheFile: null });

test('a dev-only dependency in a dev field passes', async () => {
  const r = await run(repo({
    'package.json': { name: '@particle-academy/x', devDependencies: { vitest: '^3' } },
    'composer.json': { name: 'particle-academy/x', 'require-dev': { 'pestphp/pest': '^5' } },
  }));
  assert.deepEqual(r.findings.filter((f) => f.level === 'error'), []);
});

test('MUST FIRE: a dev-only dependency used at runtime, in every runtime field', async () => {
  const r = await run(repo({
    'package.json': { name: '@particle-academy/x', dependencies: { vitest: '^3' }, peerDependencies: { vitest: '^3' }, optionalDependencies: { vitest: '^3' } },
    'composer.json': { name: 'particle-academy/x', require: { 'pestphp/pest': '^5' } },
  }));
  const errs = r.findings.filter((f) => f.kind === 'dev-only-in-runtime');
  assert.deepEqual(errs.map((f) => f.field).sort(), ['dependencies', 'optionalDependencies', 'peerDependencies', 'require']);
  assert.ok(errs.every((f) => f.level === 'error'));
  assert.match(errs[0].message, /dev-only/);
});

test('MUST FIRE: Python extras and Cargo build-dependencies count as runtime (fail closed)', async () => {
  const p = policy();
  const dev = { reason: 't', decision: { scope: 'dev-only', owner: 'wishborn', date: '2026-11-19', questions: ['q_26036ea0'] } };
  p.ecosystems.pypi.packages.pytest = dev;
  p.ecosystems.crates.packages.insta = dev;
  const r = await run(repo({
    'pyproject.toml': '[project]\nname = "x"\ndependencies = []\n\n[project.optional-dependencies]\ntest = ["pytest"]\n\n[dependency-groups]\ndev = ["pytest"]\n',
    'Cargo.toml': '[package]\nname = "x"\n\n[build-dependencies]\ninsta = "1"\n\n[dev-dependencies]\ninsta = "1"\n',
  }), p);
  const errs = r.findings.filter((f) => f.kind === 'dev-only-in-runtime').map((f) => `${f.ecosystem}:${f.field}`).sort();
  assert.deepEqual(errs, ['crates:build-dependencies', 'pypi:optional-dependencies.test']);
});

test('MUST FIRE: inheritance cannot waive a dev-only dependency declared at runtime', async () => {
  const p = policy();
  p.ecosystems.npm.packages.parent = { reason: 'approved runtime parent' };
  const r = await run(repo({
    'package.json': { name: '@particle-academy/x', dependencies: { parent: '^1', vitest: '^3' } },
    'package-lock.json': { lockfileVersion: 3, packages: {
      '': {}, 'node_modules/parent': { dependencies: { vitest: '^3' } }, 'node_modules/vitest': {},
    } },
  }), p);
  assert.ok(r.findings.some((f) => f.kind === 'dev-only-in-runtime' && f.level === 'error'));
});

test('an entry with no decision, or a non-dev-only one, is unaffected by the field', async () => {
  const r = await run(repo({ 'package.json': { name: '@particle-academy/x', dependencies: { react: '^19' } } }));
  assert.deepEqual(r.findings.filter((f) => f.level === 'error'), []);
});
