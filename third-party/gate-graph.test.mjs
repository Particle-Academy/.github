// Tests for the job-graph gate analysis.
// node --test third-party/            -- no test framework, no dependencies.
//
// Every case here is a real shape measured across the Particle-Academy org on
// 2026-09-21, not an invented one. The three that matter most are the ones the
// previous file-level, filename-matched rule got WRONG: a parallel gate job
// (reported gated, was not), a transitively gated job (reported ungated, was
// fine), and an installing workflow whose name was not on the hardcoded list
// (never looked at).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseWorkflowJobs, ungatedJobs } from './gate-graph.mjs';

const GATE = `      - name: Third-party dependency allowlist
        run: node .third-party-allowlist/third-party/check.mjs --repo .
`;

test('a gate in a PARALLEL job does not count -- the install has already run', () => {
  // fancy-labs/ci.yml, exactly: an `allowlist` job and an `app` job with no
  // `needs:` between them. The old file-level rule saw check.mjs in the file
  // and called the repo fully gated.
  const wf = `name: CI
jobs:
  allowlist:
    runs-on: ubuntu-latest
    steps:
${GATE}
  app:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: npm ci
`;
  assert.deepEqual(ungatedJobs(wf), ['app']);
});

test('`needs:` on the gate job blocks it', () => {
  const wf = `jobs:
  allowlist:
    steps:
${GATE}
  app:
    needs: allowlist
    steps:
      - run: npm ci
`;
  assert.deepEqual(ungatedJobs(wf), []);
});

test('needs is TRANSITIVE -- a job two hops from the gate is blocked', () => {
  // fancy-conformance/ci.yml: `cross-language` needs four jobs that each need
  // `allowlist`. A direct-edge-only check called it ungated and would have sent
  // someone to fix a job that was already correct.
  const wf = `jobs:
  allowlist:
    steps:
${GATE}
  node:
    needs: allowlist
    steps:
      - run: npm ci
  php:
    needs: allowlist
    steps:
      - run: composer install
  cross-language:
    needs: [node, php]
    steps:
      - run: npm ci
`;
  assert.deepEqual(ungatedJobs(wf), []);
});

test('a gate AFTER the install in the same job does not count', () => {
  // fancy-trading-js/publish.yml: install at step 4, gate at step 8.
  const wf = `jobs:
  publish:
    steps:
      - name: Install
        run: npm ci
${GATE}
`;
  assert.deepEqual(ungatedJobs(wf), ['publish']);
});

test('a gate BEFORE the install in the same job counts', () => {
  const wf = `jobs:
  publish:
    steps:
${GATE}      - name: Install
        run: npm ci
`;
  assert.deepEqual(ungatedJobs(wf), []);
});

test('the workflow FILENAME is irrelevant -- only what the job does', () => {
  // These four names were invisible to the old rule, which matched
  // publish/ci/test/third-party. All four were really ungated.
  for (const name of ['build.yml', 'conformance.yml', 'dogfood.yml', 'static.yml']) {
    const wf = `name: ${name}
jobs:
  j:
    steps:
      - run: pip install -e .
`;
    assert.deepEqual(ungatedJobs(wf), ['j'], name);
  }
});

test('a job that installs nothing is not asked to be gated', () => {
  // The PHP changelog gate: `publish.yml` after the 2026-09-21 rename. It
  // installs nothing, and matching on filename made 13 of these false warnings.
  const wf = `name: Publish
jobs:
  changelog:
    steps:
      - uses: actions/checkout@v4
      - run: grep -qE "^## " CHANGELOG.md
`;
  assert.deepEqual(ungatedJobs(wf), []);
});

test('needs accepts all three spellings GitHub does', () => {
  const block = `jobs:
  allowlist:
    steps:
${GATE}
  a:
    needs: allowlist
    steps:
      - run: npm ci
  b:
    needs: [allowlist]
    steps:
      - run: npm ci
  c:
    needs:
      - allowlist
    steps:
      - run: npm ci
`;
  assert.deepEqual(ungatedJobs(block), []);
  const jobs = parseWorkflowJobs(block);
  assert.deepEqual(jobs.a.needs, ['allowlist']);
  assert.deepEqual(jobs.b.needs, ['allowlist']);
  assert.deepEqual(jobs.c.needs, ['allowlist']);
});

test('a COMMENT mentioning an install is not an install', () => {
  // Measured on pa-ux-sandbox/dogfood.yml the hour the detector was written.
  // The comment introducing its gate says "this job INSTALLS -- composer
  // install and npm ci below". Those words sit on the checkout step, so the
  // checkout counted as an install occurring BEFORE the gate, and a correctly
  // gated job was reported ungated. The detector was reading its own prose.
  const wf = `jobs:
  latest:
    steps:
      - uses: actions/checkout@v4
      # This job INSTALLS -- composer install and npm ci below -- so it needs
      # the gate that ci.yml carries.
${GATE}      - name: Install
        run: npm ci
`;
  assert.deepEqual(ungatedJobs(wf), []);
});

test('a commented-out gate does not count as a gate', () => {
  const wf = `jobs:
  j:
    steps:
      # - run: node .third-party-allowlist/third-party/check.mjs --repo .
      - run: npm ci
`;
  assert.deepEqual(ungatedJobs(wf), ['j']);
});

test('an install performed by an ACTION counts as an install', () => {
  // prism/phpstan.yml, hand-checked by the Prism estate 2026-09-21. It pulls
  // the whole dependency tree through `uses:`, so a detector asking "does a
  // run: string contain an install command" reported it gated. 27 jobs across
  // 10 repos were ungated the entire time and read clean.
  const wf = `jobs:
  phpstan:
    steps:
      - uses: actions/checkout@v4
      - name: Setup PHP
        uses: shivammathur/setup-php@v2
      - name: Install composer dependencies
        uses: ramsey/composer-install@v3
      - name: Run PHPStan
        run: ./vendor/bin/phpstan
`;
  assert.deepEqual(ungatedJobs(wf), ['phpstan']);
});

test('an action that installs a RUNTIME is not an install', () => {
  // The whole reason the list is named rather than heuristic. Every action in
  // the fancy estate is one of these: they provide a toolchain, not a
  // dependency tree, and treating them as installs would bury the real ones.
  for (const action of [
    'actions/setup-node@v4',
    'shivammathur/setup-php@v2',
    'actions/setup-python@v5',
    'dtolnay/rust-toolchain@stable',
    'actions/setup-go@v5',
    'actions/cache@v4',
  ]) {
    const wf = `jobs:
  j:
    steps:
      - uses: ${action}
      - run: echo build
`;
    assert.deepEqual(ungatedJobs(wf), [], action);
  }
});

test('a conditional installer counts only when asked to install', () => {
  const off = `jobs:
  j:
    steps:
      - uses: pnpm/action-setup@v4
        with:
          version: 9
`;
  assert.deepEqual(ungatedJobs(off), []);

  const on = `jobs:
  j:
    steps:
      - uses: pnpm/action-setup@v4
        with:
          run_install: true
`;
  assert.deepEqual(ungatedJobs(on), ['j']);
});

test('an installing action IS blocked by a gate above it', () => {
  const wf = `jobs:
  j:
    steps:
${GATE}      - uses: ramsey/composer-install@v3
`;
  assert.deepEqual(ungatedJobs(wf), []);
});

test('a needs cycle terminates instead of hanging', () => {
  const wf = `jobs:
  a:
    needs: b
    steps:
      - run: npm ci
  b:
    needs: a
    steps:
      - run: npm ci
`;
  assert.deepEqual(ungatedJobs(wf).sort(), ['a', 'b']);
});
