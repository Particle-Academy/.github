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

// Owner, 2026-11-19, q_7d592ac6 / q_906c61e0: "all of our laravel packages
// should get the laravel dep". The 30 Weaver connectors are first-party Laravel
// packages (laravel/framework in require-dev for their Laravel integration
// tests), so they join laravel-packages as members; no new approval.
const CONNECTORS = [
  'amazon-ses', 'buffer', 'discord', 'facebook-lead-ads', 'facebook-pages', 'gmail', 'gmail-inbox',
  'google-ads', 'google-analytics', 'google-calendar', 'google-docs', 'google-drive', 'google-meet',
  'google-sheets', 'google-slides', 'hubspot', 'instagram-business', 'linkedin-ads', 'microsoft-outlook',
  'microsoft-teams', 'monday', 'notion', 'resend', 'slack', 'square', 'stripe', 'telegram', 'twilio',
  'youtube', 'zoom',
];

test('the 30 Weaver connectors are literal members of laravel-packages', () => {
  assert.equal(CONNECTORS.length, 30);
  const g = real.grantGroups['laravel-packages'];
  for (const c of CONNECTORS) assert.ok(g.members.includes(`particle-academy/${c}-php`), c);
  assert.equal(g.members.length, 29 + 30);
  assert.match(g.note, /q_7d592ac6/);
  assert.match(g.note, /q_906c61e0/);
  assert.equal(g.approval, undefined, 'membership, not a pending approval');
  for (const c of CONNECTORS) {
    // the identities checkRepo passes: composer name, then repo directory / remote name
    for (const dep of ['laravel/framework', 'illuminate/support']) {
      const v = classify(real, 'composer', dep, [`particle-academy/${c}-php`, c]);
      assert.equal(v.group, 'laravel-packages', `${c} ${dep}`);
      assert.equal(v.grantedTo, `particle-academy/${c}-php`, `${c} ${dep}`);
    }
  }
});

test('MUST FIRE (real allowlist): a connector repo name alone, or a near-miss name, grants nothing', () => {
  assert.equal(classify(real, 'composer', 'laravel/framework', ['gmail']).allowed, false);
  assert.equal(classify(real, 'composer', 'laravel/framework', ['particle-academy/gmail']).allowed, false);
  assert.equal(classify(real, 'composer', 'laravel/framework', ['particle-academy/gmail-php-fork', 'gmail-php-fork']).allowed, false);
});

// Owner, 2026-11-19, q_7a15982f: Laravel package-only for the four applications
// (the owner's alternative option). laravel-jobs-reference is left out on
// purpose: it is to become a lab test, not a separate app.
test('the four applications hold Laravel through laravel-apps, on the owner decision q_7a15982f', () => {
  const apps = real.grantGroups['laravel-apps'];
  assert.deepEqual([...apps.members].sort(),
    ['pa-ux-sandbox', 'particle-academy/fancy-labs', 'particle-academy/fancy-starter-kit', 'website']);
  const d = apps.composer.packages['laravel/framework'].decision;
  assert.equal(d.scope, 'package-only');
  assert.deepEqual(d.questions, ['q_7a15982f']);
  assert.deepEqual(d.packages, ['group:laravel-apps']);
  assert.equal(apps.approval, undefined, 'a decided group carries no pending note');
  // The identities checkRepo really passes: manifest name, then repo/remote name.
  for (const ids of [['laravel/laravel', 'pa-ux-sandbox'], ['particle-academy/fancy-starter-kit', 'fancy-starter-kit'],
    ['particle-academy/fancy-labs', 'fancy-labs'], ['laravel/laravel', 'website']]) {
    const v = classify(real, 'composer', 'laravel/framework', ids);
    assert.equal(v.group, 'laravel-apps', ids.join(' / '));
    assert.ok(v.entry.decision.questions.includes('q_7a15982f'), ids.join(' / '));
  }
  // and the shared scaffold name alone grants nothing
  assert.equal(classify(real, 'composer', 'laravel/framework', ['laravel/laravel']).allowed, false);
});

test('laravel-jobs-reference alone stays pending: the owner wants it as a lab test, not an app', () => {
  assert.ok(!real.grantGroups['laravel-apps'].members.includes('laravel-jobs-reference'));
  const pending = real.grantGroups['laravel-apps-pending'];
  assert.deepEqual(pending.members, ['laravel-jobs-reference']);
  assert.match(pending.approval, /pending owner review/);
  assert.match(pending.approval, /q_7a15982f/);
  assert.equal(pending.composer.packages['laravel/framework'].decision, undefined, 'no owner decision covers it');
  const v = classify(real, 'composer', 'laravel/framework', ['laravel/laravel', 'laravel-jobs-reference']);
  assert.equal(v.group, 'laravel-apps-pending');
  assert.equal(v.entry.decision, undefined);
});

// Owner, 2026-11-19, q_dc78bdad: Laravel package-only for Prism's 11 Laravel repos.
test('Prism\'s estate holds Laravel through laravel-prism, on the owner decision q_dc78bdad', () => {
  assert.equal(real.grantGroups['laravel-prism-pending'], undefined, 'nothing of Prism\'s is pending any more');
  const g = real.grantGroups['laravel-prism'];
  assert.equal(g.members.length, 11);
  assert.equal(g.approval, undefined);
  for (const entry of [g.composer.authors.illuminate, g.composer.packages['laravel/framework']]) {
    assert.equal(entry.decision.scope, 'package-only');
    assert.deepEqual(entry.decision.questions, ['q_dc78bdad']);
    assert.deepEqual(entry.decision.packages, ['group:laravel-prism']);
  }
  for (const [dep, ids] of [['laravel/framework', ['particle-academy/prism-labs', 'prism-labs']],
    ['laravel/framework', ['particle-academy/prism-sandbox', 'prism-sandbox']],
    ['illuminate/support', ['particle-academy/prism-opentelemetry', 'prism-opentelemetry']]]) {
    const v = classify(real, 'composer', dep, ids);
    assert.equal(v.group, 'laravel-prism', ids.join(' / '));
    assert.ok(v.entry.decision.questions.includes('q_dc78bdad'));
  }
});

test('no grant group is still pending except the one the owner deferred', () => {
  const pending = Object.entries(real.grantGroups).filter(([n, g]) => !n.startsWith('_') && g.approval).map(([n]) => n);
  assert.deepEqual(pending, ['laravel-apps-pending']);
});

test('MUST FIRE (real allowlist): an unlisted package cannot declare Laravel', () => {
  for (const dep of ['laravel/framework', 'illuminate/support']) {
    assert.equal(classify(real, 'composer', dep, ['particle-academy/brand-new-thing', 'brand-new-thing']).allowed, false, dep);
  }
});

// ---------------------------------------------------------------------------
// Inertia, owner decision q_7fd61e5d: standard pattern, no bridge
// ---------------------------------------------------------------------------

// The kit-wide entries could only go once nothing outside the grants declared
// Inertia. The last three (prism-labs, prism-sandbox, website) were granted on
// q_dc78bdad, so the entries are gone and the scope is enforced.
test('Inertia is no longer kit-wide', () => {
  assert.equal(real.ecosystems.npm.packages['@inertiajs/react'], undefined);
  assert.equal(real.ecosystems.composer.packages['inertiajs/inertia-laravel'], undefined);
});

const INERTIA_Q7 = ['@particle-academy/fancy-inertia', '@particle-academy/fancy-query', 'pa-ux-sandbox', 'fancy-starter-kit', 'fancy-labs'];
const INERTIA_PRISM = ['prism-labs', 'prism-sandbox', 'website'];

test('@inertiajs/react is granted to fancy-inertia, fancy-query, the three apps, and prism-labs, prism-sandbox and website', () => {
  for (const id of INERTIA_Q7) {
    const v = classify(real, 'npm', '@inertiajs/react', [id]);
    assert.equal(v.via, 'grant', id);
    assert.ok(v.entry.decision.questions.includes('q_7fd61e5d'), id);
  }
  for (const id of INERTIA_PRISM) {
    const v = classify(real, 'npm', '@inertiajs/react', [id]);
    assert.equal(v.via, 'grant', id);
    assert.deepEqual(v.entry.decision.questions, ['q_dc78bdad'], id);
    assert.deepEqual(v.entry.decision.packages, [id], id);
  }
});

test('inertiajs/inertia-laravel is granted to the three apps and prism-labs, prism-sandbox and website', () => {
  for (const id of ['pa-ux-sandbox', 'fancy-starter-kit', 'fancy-labs']) {
    const v = classify(real, 'composer', 'inertiajs/inertia-laravel', [id]);
    assert.equal(v.via, 'grant', id);
    assert.ok(v.entry.decision.questions.includes('q_7fd61e5d'), id);
  }
  for (const id of INERTIA_PRISM) {
    // the composer identities checkRepo passes for these: manifest name, then remote name
    const ids = [id === 'website' ? 'laravel/laravel' : `particle-academy/${id}`, id];
    const v = classify(real, 'composer', 'inertiajs/inertia-laravel', ids);
    assert.equal(v.via, 'grant', id);
    assert.deepEqual(v.entry.decision.questions, ['q_dc78bdad'], id);
  }
});

test('MUST FIRE (real allowlist): a package outside the grants cannot declare Inertia', () => {
  assert.equal(classify(real, 'npm', '@inertiajs/react', ['@particle-academy/react-fancy']).allowed, false);
  assert.equal(classify(real, 'npm', '@inertiajs/react', ['@particle-academy/brand-new-thing', 'brand-new-thing']).allowed, false);
  assert.equal(classify(real, 'composer', 'inertiajs/inertia-laravel', ['particle-academy/change-council', 'change-council']).allowed, false);
  // the shared scaffold name grants nothing: website's grant is keyed on its remote name
  assert.equal(classify(real, 'composer', 'inertiajs/inertia-laravel', ['laravel/laravel']).allowed, false);
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
