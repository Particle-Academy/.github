// Owner decisions recorded on allowlist entries: who, when, which question, what scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { decisionProblems, loadAllowlist } from './check.mjs';

const real = loadAllowlist(path.join(import.meta.dirname, 'allowlist.json'));

const ok = { scope: 'kit-wide', owner: 'wishborn', date: '2026-11-19', questions: ['q_1983859b'] };
const fixture = (packages = {}, grants = {}) => ({
  ecosystems: { npm: { authors: {}, packages } },
  packageGrants: grants,
});

test('the real allowlist records every decision completely and where its scope puts it', () => {
  assert.deepEqual(decisionProblems(real), []);
});

test('batch 1 (2026-11-19) is recorded with its question ids and scopes', () => {
  const npm = real.ecosystems.npm.packages;
  const composer = real.ecosystems.composer;
  const kitWide = { react: 'q_1983859b', 'react-dom': 'q_1983859b', tailwindcss: 'q_6314f3dc', '@tailwindcss/vite': 'q_6314f3dc',
    typescript: 'q_41f277ba', vite: 'q_41f277ba', '@vitejs/plugin-react': 'q_41f277ba' };
  for (const [name, q] of Object.entries(kitWide)) {
    assert.equal(npm[name].decision.scope, 'kit-wide', name);
    assert.deepEqual(npm[name].decision.questions, [q], name);
  }
  // Laravel moved from kit-wide entries onto the laravel-packages grant group (q_26036ea0).
  const laravel = real.grantGroups['laravel-packages'].composer;
  assert.equal(composer.packages['laravel/framework'], undefined);
  assert.equal(composer.authors.illuminate, undefined);
  assert.equal(laravel.packages['laravel/framework'].decision.scope, 'package-only');
  assert.equal(laravel.packages['laravel/framework'].decision.minimumVersion, '^13.0');
  assert.equal(laravel.authors.illuminate.decision.scope, 'package-only');
  const grant = real.packageGrants['@particle-academy/fancy-inertia'].npm['@inertiajs/react'].decision;
  assert.equal(grant.scope, 'package-only');
  assert.deepEqual(grant.questions, ['q_63e61e43', 'q_906c61e0', 'q_7fd61e5d']);
  assert.equal(grant.enforced, undefined, 'the fancy-inertia grant is where the scope puts it, so it is enforced');
});

test('MUST FIRE: an unknown scope', () => {
  const p = decisionProblems(fixture({ react: { reason: 'x', decision: { ...ok, scope: 'everywhere' } } }));
  assert.match(p.join('\n'), /scope must be one of/);
});

test('MUST FIRE: a decision with no question id', () => {
  const p = decisionProblems(fixture({ react: { reason: 'x', decision: { ...ok, questions: [] } } }));
  assert.match(p.join('\n'), /question ids/);
});

test('MUST FIRE: a decision with no owner or a malformed date', () => {
  const p = decisionProblems(fixture({ react: { reason: 'x', decision: { ...ok, owner: '', date: '19 Nov' } } })).join('\n');
  assert.match(p, /no owner/);
  assert.match(p, /YYYY-MM-DD/);
});

test('MUST FIRE: a package-only decision sitting in the kit-wide list without saying so', () => {
  const p = decisionProblems(fixture({ x: { reason: 'x', decision: { ...ok, scope: 'package-only', packages: ['a'] } } }));
  assert.match(p.join('\n'), /belongs in packageGrants/);
});

test('MUST FIRE: a kit-wide decision recorded on a one-package grant', () => {
  const p = decisionProblems(fixture({}, { a: { npm: { x: { reason: 'x', decision: ok } } } }));
  assert.match(p.join('\n'), /belongs in ecosystems/);
});

test('MUST FIRE: enforced:false with no stated gap', () => {
  const d = { ...ok, scope: 'package-only', packages: ['a'], enforced: false };
  assert.match(decisionProblems(fixture({ x: { reason: 'x', decision: d } })).join('\n'), /say what the gap is/);
});

test('MUST FIRE: a package-only decision that names no packages', () => {
  const p = decisionProblems(fixture({}, { a: { npm: { x: { reason: 'x', decision: { ...ok, scope: 'package-only' } } } } }));
  assert.match(p.join('\n'), /must name its packages/);
});

test('a package-only decision outside packageGrants passes only when it declares the gap', () => {
  const d = { ...ok, scope: 'package-only', packages: ['a'], enforced: false, gap: 'not expressible yet' };
  assert.deepEqual(decisionProblems(fixture({ x: { reason: 'x', decision: d } })), []);
});

test('entries without a decision are not judged here', () => {
  assert.deepEqual(decisionProblems(fixture({ x: { reason: 'x', approval: 'founding list' } })), []);
});
