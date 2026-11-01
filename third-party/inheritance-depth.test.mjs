import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRepo, renderResult, shortestLockPaths, MAX_INHERITANCE_DEPTH } from './check.mjs';

const NOW = Date.parse('2026-11-01T17:00:00Z');
const root = 'approved/root', leaf = 'other/leaf';
function policy(ecosystem = 'composer', approved = root) {
  return { schemaVersion: 1, policy: { freshnessDays: 92 }, firstParty: { composer: ['particle-academy'], npm: ['@particle-academy'] },
    ecosystems: { [ecosystem]: { authors: {}, packages: {} } },
    packageGrants: { 'consumer/app': { [ecosystem]: { [approved]: { reason: 'The explicit root approval.' } } } } };
}
function repo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-depth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  return dir;
}
function composer(t, edges, direct = [root, leaf]) {
  const names = [...new Set([...Object.keys(edges), ...Object.values(edges).flat()])];
  return repo(t, { 'composer.json': { name: 'consumer/app', require: Object.fromEntries(direct.map(x => [x, '^1.0'])) },
    'composer.lock': { packages: names.map(name => ({ name, version: '1.0.0', require: Object.fromEntries((edges[name] || []).map(x => [x, '^1.0'])) })) } });
}
const options = (extra = {}) => ({ now: NOW, cacheFile: null, fetcher: async () => NOW, ...extra });
const inherited = (r, name = leaf) => r.findings.find(f => f.name === name && f.kind === 'inherited');
const errors = (r, name = leaf) => r.findings.filter(f => f.name === name && f.level === 'error');

for (const hops of [2, 3]) test(`${hops}-hop lock path inherits from the explicit direct root`, async t => {
  const route = [root, ...Array.from({ length: hops - 1 }, (_, i) => `middle/hop${i}`), leaf];
  const edges = Object.fromEntries(route.slice(0, -1).map((name, i) => [name, [route[i + 1]]]));
  const r = await checkRepo(composer(t, edges), policy(), options());
  assert.deepEqual(errors(r), []);
  assert.deepEqual(inherited(r).path, route);
  assert.deepEqual(inherited(r).rootGrant, { via: 'grant', name: root, grantedTo: 'consumer/app' });
  assert.equal(r.checked.length, 2, 'intermediates are not added to direct-only checks');
  assert(renderResult(r).includes(route.join(' → ')));
  assert(renderResult(r).includes(`root approval: grant ${root} for consumer/app`));
});

test('an unapproved direct root cannot vouch for a reachable target', async t => {
  const p = policy(); p.packageGrants = {};
  const r = await checkRepo(composer(t, { [root]: ['middle/a'], 'middle/a': [leaf] }), p, options());
  assert(errors(r).some(f => f.kind === 'unapproved')); assert.equal(inherited(r), undefined);
});

for (const failure of ['stale', 'lookup-failed', 'expired-override', 'bad-override']) test(`an explicit root failing ${failure} cannot vouch`, async t => {
  const p = policy(), grant = p.packageGrants['consumer/app'].composer[root];
  if (failure.endsWith('override')) grant.freshness = { expires: failure === 'bad-override' ? 'invalid' : '2026-01-01' };
  const fetcher = failure === 'lookup-failed' ? async () => { throw new Error('offline fixture'); } : async () => failure === 'stale' ? Date.parse('2025-01-01') : NOW;
  const r = await checkRepo(composer(t, { [root]: ['middle/a'], 'middle/a': [leaf] }), p, options({ fetcher }));
  assert(r.findings.some(f => f.name === root && f.kind === failure && f.level === 'error'));
  assert.equal(inherited(r), undefined); assert(errors(r).length);
});

test('first-party direct packages are not explicit approval roots', async t => {
  const r = await checkRepo(composer(t, { 'particle-academy/ours': ['middle/a'], 'middle/a': [leaf] }, ['particle-academy/ours', leaf]), policy(), options());
  assert.equal(inherited(r), undefined); assert(errors(r).length);
});

test('a root freshness warning still fails its own inheritance check', async t => {
  const r = await checkRepo(composer(t, { [root]: [leaf] }), policy(), options({ freshness: 'warn', fetcher: async () => Date.parse('2025-01-01') }));
  assert(r.findings.some(f => f.name === root && f.kind === 'stale' && f.level === 'warn'));
  assert.equal(inherited(r), undefined); assert(errors(r).length);
});

test('a root cannot waive malformed target override policy', async t => {
  const p = policy(); p.ecosystems.composer.packages[leaf] = { reason: 'Target with malformed policy.', freshness: {} };
  const r = await checkRepo(composer(t, { [root]: [leaf] }), p, options());
  assert(errors(r).some(f => f.kind === 'bad-override')); assert.equal(inherited(r), undefined);
});

test('a lockfile package unreachable from any approved direct root still fails', async t => {
  const r = await checkRepo(composer(t, { [root]: [], 'unlisted/root': [leaf] }), policy(), options());
  assert.equal(inherited(r), undefined); assert(errors(r).length);
});

test('manifest requirements alone cannot create inheritance edges', async t => {
  const dir = repo(t, { 'composer.json': { name: 'consumer/app', require: { [root]: '^1', [leaf]: '^1' } }, 'composer.lock': { packages: [{ name: root, 'require-dev': { [leaf]: '^1' } }, { name: leaf }] } });
  const r = await checkRepo(dir, policy(), options()); assert.equal(inherited(r), undefined); assert(errors(r).length);
});

test('a cycle is visited once and cannot rewrite the shortest root path', () => {
  const result = shortestLockPaths(new Map([[root, new Set(['middle/a'])], ['middle/a', new Set([root])]]), root);
  assert.equal(result.overflow, false); assert.equal(result.paths.size, 2);
  assert.deepEqual(result.paths.get(root), [root]); assert.deepEqual(result.paths.get('middle/a'), [root, 'middle/a']);
});

function chain(length) {
  const names = [root, ...Array.from({ length }, (_, i) => `deep/n${String(i + 1).padStart(3, '0')}`)];
  return { names, edges: Object.fromEntries(names.slice(0, -1).map((x, i) => [x, [names[i + 1]]])) };
}
test('the depth boundary passes but overflow fails closed', async t => {
  const { names, edges } = chain(MAX_INHERITANCE_DEPTH + 1), within = names.at(-2), beyond = names.at(-1);
  const r = await checkRepo(composer(t, edges, [root, within, beyond]), policy(), options());
  assert.equal(inherited(r, within).path.length, MAX_INHERITANCE_DEPTH + 1);
  assert.equal(inherited(r, beyond), undefined); assert(errors(r, beyond).length);
  assert(r.findings.some(f => f.name === beyond && f.kind === 'inheritance-depth-limit'));
});

test('a failing explicit intermediate that later inherits never becomes a new root', async t => {
  const { names, edges } = chain(MAX_INHERITANCE_DEPTH + 1), middle = names.at(-2), beyond = names.at(-1), p = policy();
  p.ecosystems.composer.packages[middle] = { reason: 'Explicit but stale approval.' };
  const r = await checkRepo(composer(t, edges, [root, middle, beyond]), p, options({ fetcher: async (_eco, name) => name === middle ? Date.parse('2025-01-01') : NOW }));
  assert.equal(inherited(r, middle).parent, root);
  assert.equal(inherited(r, beyond), undefined); assert(errors(r, beyond).length);
});

test('shortest path wins, then lexical path, independent of manifest/lock order', async t => {
  const edges = { 'approved/z': ['middle/z'], 'middle/z': [leaf], 'approved/a': ['middle/b', 'middle/a'], 'middle/b': [leaf], 'middle/a': [leaf] };
  const p = policy(); p.ecosystems.composer.packages = { 'approved/a': { reason: 'a' }, 'approved/z': { reason: 'z' } };
  const run = async (e, d) => inherited(await checkRepo(composer(t, e, d), p, options())).path;
  const expected = ['approved/a', 'middle/a', leaf];
  assert.deepEqual(await run(edges, ['approved/z', 'approved/a', leaf]), expected);
  assert.deepEqual(await run(Object.fromEntries(Object.entries(edges).reverse()), [leaf, 'approved/a', 'approved/z']), expected);
  assert.deepEqual(await run({ ...edges, 'approved/z': [leaf] }, ['approved/a', 'approved/z', leaf]), ['approved/z', leaf]);
});

test('npm follows installed nested intermediates and keeps the full lock path', async t => {
  const dir = repo(t, { 'package.json': { name: 'consumer/app', dependencies: { approved: '1', leaf: '1' } }, 'package-lock.json': { lockfileVersion: 3, packages: {
    'node_modules/approved': { dependencies: { middle: '1' } }, 'node_modules/approved/node_modules/middle': { dependencies: { leaf: '1' } }, 'node_modules/leaf': { version: '1' },
  } } });
  const r = await checkRepo(dir, policy('npm', 'approved'), options()), f = inherited(r, 'leaf');
  assert.deepEqual(f.path, ['approved', 'middle', 'leaf']);
  assert.deepEqual(f.lockPath, ['approved', 'node_modules/approved/node_modules/middle', 'leaf']);
});

test('npm nested same-name target does not approve a different top-level instance', async t => {
  const dir = repo(t, { 'package.json': { name: 'consumer/app', dependencies: { approved: '1', leaf: '2' } }, 'package-lock.json': { lockfileVersion: 3, packages: {
    'node_modules/approved': { dependencies: { middle: '1' } }, 'node_modules/middle': { dependencies: { leaf: '1' } }, 'node_modules/middle/node_modules/leaf': { version: '1' }, 'node_modules/leaf': { version: '2' },
  } } });
  const r = await checkRepo(dir, policy('npm', 'approved'), options()); assert.equal(inherited(r, 'leaf'), undefined); assert(errors(r, 'leaf').length);
});

for (const field of ['devDependencies', 'optional-peer', 'missing-install']) test(`npm ${field} is not a transitive production edge`, async t => {
  const mid = field === 'optional-peer' ? { peerDependencies: { leaf: '1' }, peerDependenciesMeta: { leaf: { optional: true } } } : { [field === 'devDependencies' ? field : 'dependencies']: { leaf: '1' } };
  const packages = { 'node_modules/approved': { dependencies: { middle: '1' } }, 'node_modules/middle': mid };
  if (field !== 'missing-install') packages['node_modules/leaf'] = { version: '1' };
  const dir = repo(t, { 'package.json': { name: 'consumer/app', dependencies: { approved: '1', leaf: '1' } }, 'package-lock.json': { lockfileVersion: 3, packages } });
  const r = await checkRepo(dir, policy('npm', 'approved'), options()); assert.equal(inherited(r, 'leaf'), undefined); assert(errors(r, 'leaf').length);
});

test('npm required peers and installed optional requirements retain inheritance at depth', async t => {
  for (const field of ['peerDependencies', 'optionalDependencies']) {
    const dir = repo(t, { 'package.json': { name: 'consumer/app', dependencies: { approved: '1', leaf: '1' } }, 'package-lock.json': { lockfileVersion: 3, packages: {
      'node_modules/approved': { dependencies: { middle: '1' } }, 'node_modules/middle': { [field]: { leaf: '1' } }, 'node_modules/leaf': { version: '1' },
    } } });
    const r = await checkRepo(dir, policy('npm', 'approved'), options()); assert.deepEqual(inherited(r, 'leaf').path, ['approved', 'middle', 'leaf']);
  }
});

test('watcher recorded Guzzle graph reaches psr/http-message through psr7', async t => {
  const edges = { 'guzzlehttp/guzzle': ['guzzlehttp/promises', 'guzzlehttp/psr7', 'psr/http-client'], 'guzzlehttp/psr7': ['psr/http-factory', 'psr/http-message'] };
  const r = await checkRepo(composer(t, edges, ['guzzlehttp/guzzle', 'psr/http-message']), policy('composer', 'guzzlehttp/guzzle'), options());
  assert.deepEqual(inherited(r, 'psr/http-message').path, ['guzzlehttp/guzzle', 'guzzlehttp/psr7', 'psr/http-message']);
});
