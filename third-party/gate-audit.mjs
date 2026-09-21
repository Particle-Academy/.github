#!/usr/bin/env node
// Gate audit: does every repo in the org actually RUN the allowlist check?
//
// The allowlist itself cannot drift -- CI fetches it, nothing vendors it. The
// failure mode that remains is a repo that quietly stops running the check, or
// a new repo that never started. That is the shape of defect this suite knows
// best: ten shipped components were invisible to consumers because a list and
// the source tree disagreed and nothing compared them.
//
// The repo list comes from the GitHub API, never from a file here. A
// hand-maintained list of repos to audit would be the same defect one level up.
//
// NO THIRD-PARTY DEPENDENCIES. Node standard library only.

import process from 'node:process';
import { ungatedJobs } from './gate-graph.mjs';

const ORG = process.env.ALLOWLIST_ORG || 'Particle-Academy';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const MARKER = 'third-party/check.mjs';
const MANIFESTS = ['package.json', 'composer.json', 'pyproject.toml'];

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'fancy-allowlist-gate-audit',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(pathname) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
    const res = await fetch(`https://api.github.com${pathname}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      const wait = Math.min(Math.max(reset - Date.now(), 1000), 60_000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (attempt === 2) throw new Error(`GET ${pathname} -> HTTP ${res.status}`);
  }
  throw new Error(`GET ${pathname} failed`);
}

async function listRepos() {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api(`/orgs/${ORG}/repos?per_page=100&page=${page}&type=all`);
    if (!batch || !batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.filter((r) => !r.archived);
}
async function auditRepo(repo) {
  const name = repo.name;
  const root = await api(`/repos/${ORG}/${name}/contents/?ref=${repo.default_branch}`);
  if (!root) return { name, skipped: 'empty repository' };
  const rootNames = new Set(root.map((e) => e.name));
  const manifests = MANIFESTS.filter((m) => rootNames.has(m));
  if (!manifests.length) return { name, skipped: 'no dependency manifest' };

  const workflows = await api(`/repos/${ORG}/${name}/contents/.github/workflows?ref=${repo.default_branch}`);
  if (!workflows || !workflows.length) {
    return { name, manifests, gated: false, reason: 'no workflows at all -- nothing enforces the allowlist here' };
  }

  const relevant = workflows.filter((f) => /\.ya?ml$/i.test(f.name) && f.name !== 'no-mcp-secrets.yml');
  const ungated = [];
  let anyGated = false;
  for (const f of relevant) {
    const res = await fetch(f.download_url, { headers: { 'User-Agent': headers['User-Agent'] }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`fetch ${name}/${f.name} -> HTTP ${res.status}`);
    const text = await res.text();
    // Per JOB, and only counting a gate the install actually WAITS for.
    // A check in a parallel job reports after `npm ci` has already run the
    // package's install lifecycle scripts -- a report, not a gate. The
    // reasoning, the measurements and the transitive-needs trap are all in
    // gate-graph.mjs, which check.mjs's gateStatus shares. One copy.
    if (text.includes(MARKER)) anyGated = true;
    for (const job of ungatedJobs(text)) ungated.push(f.name + ':' + job);
  }
  return {
    name,
    manifests,
    gated: anyGated,
    ungated,
    reason: anyGated ? null : 'has dependency manifests and CI, but no workflow runs the allowlist check',
  };
}

const repos = await listRepos();

// The only reason this job carries a PAT is that the DEFAULT token cannot see
// private repos -- it lists the public ones, audits them, and reports a clean
// estate. An under-scoped or expired-and-replaced token fails the same way:
// HTTP 200, a shorter list, green. There is no error to notice.
//
// So assert the thing the token was added FOR, rather than the thing it
// returned. Zero private repos means either this audit is blind or the PAT is
// pointless; both deserve a human, and neither deserves a silent pass.
const privateRepos = repos.filter((r) => r.private);
if (!privateRepos.length) {
  console.error(`FAIL: listed ${repos.length} repos and 0 of them private, so this audit is blind.`);
  console.error('      The repo count discriminates: a number in the hundreds means the token');
  console.error('      authenticates but its resource owner is not this org (a personal-account');
  console.error('      token sees public repos here and nothing else). A small number means it');
  console.error('      is scoped to a subset. Zero means it is not authenticating at all.');
  console.error('      A token that cannot read private repos returns 200 with a short');
  console.error('      list -- indistinguishable from a clean estate.');
  console.error('      Check GATE_AUDIT_TOKEN: it needs org read + repo contents read.');
  console.error('      If this org genuinely has no private repos, DELETE this check --');
  console.error('      do not downgrade it to a warning. A warning here goes unread and');
  console.error('      the blindness comes back silently, which is what it did before.');
  process.exit(1);
}

const results = [];
for (const repo of repos) results.push(await auditRepo(repo));

const skipped = results.filter((r) => r.skipped);
const failing = results.filter((r) => !r.skipped && !r.gated);
const partial = results.filter((r) => !r.skipped && r.gated && r.ungated?.length);
const passing = results.filter((r) => !r.skipped && r.gated && !r.ungated?.length);

process.stdout.write(`Gate audit for ${ORG}: ${repos.length} repos (${privateRepos.length} private), ${skipped.length} without a manifest.\n\n`);
for (const r of failing) process.stdout.write(`FAIL ${r.name} -- ${r.reason}\n`);
for (const r of partial) process.stdout.write(`WARN ${r.name} -- gated, but ${r.ungated.join(', ')} do not run the check\n`);
process.stdout.write(`\n${passing.length} fully gated, ${partial.length} partially, ${failing.length} not at all.\n`);

// Partial gating is a warning: one gated workflow still stops a release. No
// gated workflow at all is a failure -- the repo can ship anything.
process.exitCode = failing.length ? 1 : 0;
