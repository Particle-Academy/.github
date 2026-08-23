#!/usr/bin/env node
// Third-party dependency allowlist checker for the Particle Academy / Fancy suite.
//
// Scope: DIRECT dependencies only. npm dependencies/devDependencies/
// peerDependencies/optionalDependencies, Composer require/require-dev, Python
// [project] dependencies + optional-dependencies + dependency-groups, Cargo
// [dependencies] / [dev-dependencies] / [build-dependencies].
//
// Transitive dependencies inherit approval from their allowlisted direct parent
// and are NOT enumerated. See third-party/README.md for what that does and does
// not protect against.
//
// NO THIRD-PARTY DEPENDENCIES. Node standard library only -- a tool that polices
// dependencies and carries its own would be a joke at its own expense.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

const LOCAL_SPEC = /^(file:|link:|workspace:|portal:|\.\.?[\\/])/;

// Composer "platform" requirements. Not packages, not third-party code.
const PLATFORM_RE = /^(php(-64bit|-ipv6|-zts)?|hhvm|ext-[\w-]+|lib-[\w-]+|composer(-plugin-api|-runtime-api)?)$/i;

export function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function parsePackageJson(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const deps = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = pkg[field];
    if (!block || typeof block !== 'object') continue;
    for (const [name, spec] of Object.entries(block)) {
      if (typeof spec === 'string' && LOCAL_SPEC.test(spec)) continue;
      deps.push({ name, field, spec: String(spec) });
    }
  }
  return { ecosystem: 'npm', manifest: 'package.json', name: pkg.name || null, deps };
}

// Cargo. `[dependencies]`, `[dev-dependencies]` and `[build-dependencies]`, plus
// their `[target.'cfg(...)'.dependencies]` forms.
//
// A dependency is either `name = "1.0"` or `name = { version = "1.0", ... }`.
// The table form is also where a `path` or `git` source hides, and those are
// NOT registry dependencies: `path` is local, and `git` fetches code no
// registry ever saw. Both are reported with their source so the caller can
// refuse a third-party one rather than skip it silently -- skipping is how a
// gate develops a hole exactly the shape of the thing it exists to catch.
export function parseCargoToml(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  const deps = [];
  let name = null;
  let section = null;

  const DEP_SECTION = /^(?:target\.[^.]*\.)?(dependencies|dev-dependencies|build-dependencies)$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim();
      continue;
    }

    if (section === 'package') {
      const m = line.match(/^name\s*=\s*"([^"]+)"/);
      if (m) name = m[1];
      continue;
    }

    if (!section || !DEP_SECTION.test(section)) continue;
    const field = section.slice(section.lastIndexOf('.') + 1);

    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const [, depName, rhs] = m;

    if (rhs.trim().startsWith('{')) {
      // `package = "real-name"` renames the crate; the REGISTRY name is what a
      // grant is about, so it wins over the key.
      const renamed = rhs.match(/\bpackage\s*=\s*"([^"]+)"/);
      const source = /\bgit\s*=/.test(rhs) ? 'git' : /\bpath\s*=/.test(rhs) ? 'path' : 'registry';
      deps.push({ name: renamed ? renamed[1] : depName, field, spec: rhs.trim(), source });
      continue;
    }

    const version = rhs.match(/^"([^"]*)"/);
    if (!version) continue;
    deps.push({ name: depName, field, spec: version[1], source: 'registry' });
  }

  if (!deps.length && !name) return null;
  return { ecosystem: 'crates', manifest: 'Cargo.toml', name, deps };
}

export function parseComposerJson(composer) {
  if (!composer || typeof composer !== 'object') return null;
  const deps = [];
  for (const field of ['require', 'require-dev']) {
    const block = composer[field];
    if (!block || typeof block !== 'object') continue;
    for (const [name, spec] of Object.entries(block)) {
      if (PLATFORM_RE.test(name)) continue;
      deps.push({ name: name.toLowerCase(), field, spec: String(spec) });
    }
  }
  return { ecosystem: 'composer', manifest: 'composer.json', name: composer.name ? String(composer.name).toLowerCase() : null, deps };
}

// PEP 503 normalisation: lowercase, runs of -_. collapse to a single -
export function normalizePyName(raw) {
  return raw.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

// PEP 508 requirement -> distribution name
export function pyRequirementName(req) {
  const head = String(req).split(';')[0].trim();
  const m = head.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? normalizePyName(m[1]) : null;
}

// A deliberately small TOML reader. It understands exactly the three shapes we
// declare dependencies in and nothing else; anything cleverer would be a parser
// we have to maintain, and anything vaguer would silently miss a dependency.
export function parsePyproject(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  const deps = [];
  let projectName = null;
  let section = '';

  const arrayBody = (startIndex) => {
    let line = lines[startIndex];
    let buf = line.slice(line.indexOf('[') + 1);
    let i = startIndex;
    if (buf.includes(']')) return { body: buf.slice(0, buf.indexOf(']')), end: i };
    i++;
    for (; i < lines.length; i++) {
      const l = lines[i];
      const close = l.indexOf(']');
      if (close !== -1) {
        buf += '\n' + l.slice(0, close);
        break;
      }
      buf += '\n' + l;
    }
    return { body: buf, end: i };
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      section = trimmed.replace(/^\[+/, '').replace(/\]+$/, '');
      continue;
    }
    if (section === 'project') {
      const nm = trimmed.match(/^name\s*=\s*["']([^"']+)["']/);
      if (nm) projectName = normalizePyName(nm[1]);
    }
    const keyed = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*\[/);
    if (!keyed) continue;

    let field = null;
    if (section === 'project' && keyed[1] === 'dependencies') field = 'dependencies';
    else if (section === 'project.optional-dependencies') field = `optional-dependencies.${keyed[1]}`;
    else if (section === 'dependency-groups') field = `dependency-groups.${keyed[1]}`;
    if (!field) continue;

    const { body, end } = arrayBody(i);
    i = end;
    // Split on top-level commas so `{include-group = "lint"}` stays one item --
    // and stay inside quotes while doing it, because a version range like
    // "stripe>=11,<16" is ONE requirement containing a comma. Splitting naively
    // silently drops the dependency instead of failing loudly, which is the
    // worst outcome available to a checker.
    let depth = 0;
    let quote = null;
    let current = '';
    const items = [];
    for (const ch of body) {
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        items.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    items.push(current);

    for (const item of items) {
      const t = item.trim();
      if (!t) continue;
      // `{include-group = "dev"}` points at another group in this same file.
      // It is not a distribution and must not be looked up as one.
      if (t.startsWith('{')) continue;
      const q = t.match(/^["']([^"']+)["']$/);
      if (!q) continue;
      const name = pyRequirementName(q[1]);
      if (name) deps.push({ name, field, spec: q[1] });
    }
  }

  if (!deps.length && !projectName) return null;
  return { ecosystem: 'pypi', manifest: 'pyproject.toml', name: projectName, deps };
}

// The repo's name ON THE REMOTE. This is the identity that stays the same in
// the envelope and in CI; a directory name does not. px-ui-sandbox is checked
// out at `repos/px-ui-sandbox` here and at `pa-ux-sandbox` in Actions, because
// the git remote is `Particle-Academy/pa-ux-sandbox` -- so a grant keyed on the
// directory passed locally and failed in CI, which is the worst way round.
export function remoteRepoName(repoDir) {
  try {
    let gitDir = path.join(repoDir, '.git');
    const stat = fs.statSync(gitDir);
    if (stat.isFile()) {
      // Submodules and worktrees keep a `gitdir:` pointer instead of a directory.
      const pointer = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!pointer) return null;
      gitDir = path.resolve(repoDir, pointer[1].trim());
    }
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const url = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s);
    if (!url) return null;
    const name = url[1].replace(/\.git$/, '').split(/[/:]/).pop();
    return name || null;
  } catch {
    // No remote is not an error -- an unpublished repo still gets checked, it
    // just has one fewer identity a grant can be keyed on.
    return null;
  }
}

export function readManifests(repoDir) {
  const out = [];
  const pkg = readJsonIfPresent(path.join(repoDir, 'package.json'));
  if (pkg) {
    const parsed = parsePackageJson(pkg);
    if (parsed) out.push(parsed);
  }
  const composer = readJsonIfPresent(path.join(repoDir, 'composer.json'));
  if (composer) {
    const parsed = parseComposerJson(composer);
    if (parsed) out.push(parsed);
  }
  const pyprojectPath = path.join(repoDir, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    const parsed = parsePyproject(fs.readFileSync(pyprojectPath, 'utf8'));
    if (parsed) out.push(parsed);
  }
  const cargoPath = path.join(repoDir, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    const parsed = parseCargoToml(fs.readFileSync(cargoPath, 'utf8'));
    if (parsed) out.push(parsed);
  }
  // Applications declare no package name (px-ui-sandbox and fancy-starter-kit
  // both ship an unnamed package.json). A grant has to be scoped to SOMETHING,
  // so those fall back to the repo directory name -- which is also the key you
  // write in the allowlist for them.
  const fallback = path.basename(path.resolve(repoDir));
  for (const m of out) if (!m.name) m.name = fallback;
  return out;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export function loadAllowlist(file) {
  const raw = readJsonIfPresent(file);
  if (!raw) throw new Error(`Cannot read allowlist at ${file}`);
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Allowlist schemaVersion ${raw.schemaVersion} but this checker speaks ${SCHEMA_VERSION}. ` +
      `Update the checker rather than the number -- a checker that misreads the allowlist passes things it should not.`
    );
  }
  return raw;
}

// The owner identity a registry actually lets us check FROM THE MANIFEST.
// These are not equivalent concepts and pretending they are is how an author
// allow silently covers a package nobody vetted.
export function ownerOf(ecosystem, name) {
  if (ecosystem === 'npm') {
    // npm's only manifest-visible owner is the scope. Unscoped packages have
    // no checkable owner at all -- registry `maintainers` is mutable metadata,
    // not part of what a consumer declares -- so they must be listed one by one.
    return name.startsWith('@') ? name.slice(0, name.indexOf('/')) : null;
  }
  if (ecosystem === 'composer') {
    // Packagist names are always vendor/package and Packagist enforces vendor
    // ownership, so the vendor prefix is a real, checkable identity.
    return name.includes('/') ? name.slice(0, name.indexOf('/')) : null;
  }
  // PyPI and crates.io have no namespace whatsoever. There is no owner in the
  // requirement string, so author-level approval is not expressible for Python
  // or Rust, and every distribution is listed individually.
  return null;
}

// `identity` is the name a grant is keyed by. A repo has up to two usable ones:
// the manifest name, and the repo directory name. Both are accepted, because
// neither is reliable alone -- px-ui-sandbox's composer.json is named
// `laravel/laravel` (the scaffold's name, shared by every Laravel app) while its
// package.json has no name at all.
export function classify(allowlist, ecosystem, depName, manifestName) {
  const identities = (Array.isArray(manifestName) ? manifestName : [manifestName])
    .filter((n) => typeof n === 'string' && n && !n.startsWith('_'));
  const eco = allowlist.ecosystems?.[ecosystem];
  if (!eco) return { allowed: false, via: 'unknown-ecosystem', reason: `No policy for ecosystem ${ecosystem}` };

  const firstParty = allowlist.firstParty?.[ecosystem] || [];
  for (const prefix of firstParty) {
    if (depName === prefix || depName.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || depName === prefix) {
      return { allowed: true, via: 'first-party', reason: 'Ours.', firstParty: true };
    }
  }

  for (const identity of identities) {
    const grants = allowlist.packageGrants?.[identity]?.[ecosystem];
    if (grants && Object.prototype.hasOwnProperty.call(grants, depName)) {
      const g = grants[depName];
      return { allowed: true, via: 'grant', grantedTo: identity, reason: g.reason || 'Package-scoped grant.', entry: g };
    }
  }

  const pkgEntry = eco.packages?.[depName];
  if (pkgEntry) return { allowed: true, via: 'package', reason: pkgEntry.reason || '', entry: pkgEntry };

  const owner = ownerOf(ecosystem, depName);
  if (owner) {
    const authorEntry = eco.authors?.[owner];
    if (authorEntry) return { allowed: true, via: 'author', reason: authorEntry.reason || '', owner, entry: authorEntry };
  }

  // A grant that exists for a DIFFERENT package is the most useful thing we can
  // say here, because it is the mistake this design exists to prevent.
  const elsewhere = [];
  for (const [pkgName, byEco] of Object.entries(allowlist.packageGrants || {})) {
    if (identities.includes(pkgName) || pkgName.startsWith('_')) continue;
    if (byEco?.[ecosystem]?.[depName]) elsewhere.push(pkgName);
  }
  return {
    allowed: false,
    via: 'none',
    reason: elsewhere.length
      ? `Granted to ${elsewhere.join(', ')} only. A grant is scoped to the package it was made for; approve it for ${manifestName || 'this package'} explicitly or do not use it here.`
      : 'Not on the allowlist.',
    identities,
  };
}

// ---------------------------------------------------------------------------
// Freshness -- registry last-activity lookup
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

export function defaultCachePath() {
  return path.join(os.tmpdir(), 'fancy-third-party-freshness-cache.json');
}

function loadCache(file) {
  const raw = readJsonIfPresent(file);
  return raw && typeof raw === 'object' ? raw : {};
}

function saveCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  } catch {
    /* a cache we cannot write is a slow check, not a broken one */
  }
}

async function getJson(url, headers = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return { notFound: true };
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      return { data: await res.json() };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('lookup failed');
}

function maxIso(dates) {
  let best = null;
  for (const d of dates) {
    if (!d) continue;
    const t = Date.parse(d);
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best;
}

export async function lastActivity(ecosystem, name) {
  if (ecosystem === 'npm') {
    // The abbreviated packument carries `modified`: the last time ANYTHING was
    // published for this package. Small response, exactly the signal we want.
    const { data, notFound } = await getJson(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
      Accept: 'application/vnd.npm.install-v1+json',
    });
    if (notFound) throw new Error(`npm has no package ${name}`);
    const t = maxIso([data?.modified, ...Object.values(data?.time || {})]);
    if (t === null) throw new Error(`npm returned no timestamps for ${name}`);
    return t;
  }

  if (ecosystem === 'composer') {
    // Two files: stable releases, and the dev metadata whose dev-<branch> entry
    // moves on every commit. Taking the max honours "a release OR a commit".
    const [vendor, pkg] = name.split('/');
    const timesFrom = (data) => {
      const times = [];
      for (const versions of Object.values(data?.packages || {})) {
        if (!Array.isArray(versions)) continue;
        for (const v of versions) times.push(v?.time);
      }
      return times;
    };
    const stable = await getJson(`https://repo.packagist.org/p2/${vendor}/${pkg}.json`);
    if (stable.notFound) throw new Error(`Packagist has no package ${name}`);
    let times = timesFrom(stable.data);
    try {
      const dev = await getJson(`https://repo.packagist.org/p2/${vendor}/${pkg}~dev.json`);
      if (!dev.notFound) times = times.concat(timesFrom(dev.data));
    } catch {
      /* dev metadata is a bonus signal; its absence never makes a live package look stale */
    }
    const t = maxIso(times);
    if (t === null) throw new Error(`Packagist returned no timestamps for ${name}`);
    return t;
  }

  if (ecosystem === 'pypi') {
    const { data, notFound } = await getJson(`https://pypi.org/pypi/${name}/json`);
    if (notFound) throw new Error(`PyPI has no distribution ${name}`);
    const times = [];
    for (const files of Object.values(data?.releases || {})) {
      if (!Array.isArray(files)) continue;
      for (const f of files) times.push(f?.upload_time_iso_8601 || f?.upload_time);
    }
    for (const f of data?.urls || []) times.push(f?.upload_time_iso_8601 || f?.upload_time);
    const t = maxIso(times);
    if (t === null) throw new Error(`PyPI returned no timestamps for ${name}`);
    return t;
  }

  if (ecosystem === 'crates') {
    // crates.io REQUIRES a User-Agent. Without one it answers 403 for every
    // name, which a naive reader turns into "this crate does not exist" -- so a
    // missing header would fail every Rust dependency for the wrong reason, or,
    // worse, be papered over with a `notFound` skip.
    const { data, notFound } = await getJson(
      `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
      { 'User-Agent': 'particle-academy-third-party-check (https://github.com/Particle-Academy)' }
    );
    if (notFound) throw new Error(`crates.io has no crate ${name}`);
    const times = [];
    for (const v of data?.versions || []) times.push(v?.created_at || v?.updated_at);
    times.push(data?.crate?.updated_at);
    const t = maxIso(times);
    if (t === null) throw new Error(`crates.io returned no timestamps for ${name}`);
    return t;
  }

  throw new Error(`No freshness source for ecosystem ${ecosystem}`);
}

export async function freshnessOf(ecosystem, name, opts) {
  const { cache, cacheFile, cacheTtlMs, offline, now, fetcher } = opts;
  const key = `${ecosystem}:${name}`;
  const hit = cache[key];
  if (hit && typeof hit.at === 'number' && now - hit.at < cacheTtlMs) {
    return { ...hit.value, cached: true };
  }
  if (offline) {
    if (hit) return { ...hit.value, cached: true, stale: true };
    return { error: 'no cached freshness data and --offline was given' };
  }
  try {
    const ts = await (fetcher || lastActivity)(ecosystem, name);
    const value = { lastActivity: new Date(ts).toISOString() };
    cache[key] = { at: now, value };
    if (cacheFile) saveCache(cacheFile, cache);
    return value;
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function parseDate(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export async function checkRepo(repoDir, allowlist, options = {}) {
  const {
    freshness = 'error',
    now = Date.now(),
    cacheFile = defaultCachePath(),
    cacheTtlMs = DAY,
    offline = false,
    fetcher,
  } = options;

  const freshnessDays = allowlist.policy?.freshnessDays ?? 92;
  // A dated rollout ramp, not an escape hatch. Membership is enforced from the
  // day this lands; freshness findings are reported but non-fatal until this
  // date, because turning a time-dependent check hard on every repo at once
  // makes the first thing everyone sees a red build for a decision nobody has
  // been asked to make yet. The date is in the allowlist so it is visible, and
  // it expires by itself.
  const enforcedFrom = parseDate(allowlist.policy?.freshnessEnforcedFrom || '');
  const ramping = enforcedFrom !== null && now < enforcedFrom;
  const freshnessLevel = freshness === 'warn' || ramping ? 'warn' : 'error';

  const cache = cacheFile ? loadCache(cacheFile) : {};
  const manifests = readManifests(repoDir);
  const findings = [];
  const checked = [];

  const repoIdentities = [
    path.basename(path.resolve(repoDir)),
    remoteRepoName(repoDir),
    // GITHUB_REPOSITORY is `owner/repo`; only meaningful for a single --repo run.
    process.env.GITHUB_REPOSITORY?.split('/').pop() || null,
  ];
  for (const manifest of manifests) {
    const identities = [...new Set([manifest.name, ...repoIdentities].filter(Boolean))];
    for (const dep of manifest.deps) {
      const verdict = classify(allowlist, manifest.ecosystem, dep.name, identities);
      const record = {
        ecosystem: manifest.ecosystem,
        manifest: manifest.manifest,
        manifestName: manifest.name,
        field: dep.field,
        name: dep.name,
        spec: dep.spec,
        via: verdict.via,
      };
      checked.push(record);

      if (!verdict.allowed) {
        findings.push({
          level: 'error',
          kind: 'unapproved',
          ...record,
          message: `${dep.name} (${manifest.ecosystem}, ${dep.field}) is not approved for ${identities.join(' / ')}. ${verdict.reason}`,
        });
        continue;
      }
      if (verdict.entry?.review) {
        findings.push({
          level: 'note',
          kind: 'review',
          ...record,
          message: `${dep.name}: ${verdict.entry.review}`,
        });
      }
      if (verdict.firstParty) continue;
      if (freshness === 'off') continue;

      const entry = verdict.entry || {};
      const override = entry.freshness;
      if (override) {
        const expires = parseDate(override.expires);
        if (expires === null) {
          findings.push({
            level: 'error',
            kind: 'bad-override',
            ...record,
            message: `${dep.name} has a freshness override with no valid \`expires\` date. An override that never expires is not an exception, it is a hole.`,
          });
          continue;
        }
        if (now > expires) {
          findings.push({
            level: freshnessLevel,
            kind: 'expired-override',
            ...record,
            message: `${dep.name} freshness override expired ${override.expires}. Re-verify the project is alive and renew it, or drop the dependency.`,
          });
        }
        continue;
      }

      const result = await freshnessOf(manifest.ecosystem, dep.name, {
        cache, cacheFile, cacheTtlMs, offline, now, fetcher,
      });

      if (result.error) {
        // A lookup that failed tells us NOTHING about the package. Counting it
        // as current is the same mistake as a conformance suite that silently
        // does not run: the log goes green and the check did not happen.
        // `kit:dogfood` already treats a failed registry lookup as a failure;
        // this matches it deliberately.
        findings.push({
          level: freshnessLevel,
          kind: 'lookup-failed',
          ...record,
          message: `Could not determine last activity for ${dep.name} (${manifest.ecosystem}): ${result.error}. A lookup failure is not a pass.`,
        });
        continue;
      }

      const ts = parseDate(result.lastActivity);
      const ageDays = Math.floor((now - ts) / DAY);
      record.lastActivity = result.lastActivity.slice(0, 10);
      record.ageDays = ageDays;
      if (ageDays > freshnessDays) {
        findings.push({
          level: freshnessLevel,
          kind: 'stale',
          ...record,
          message: `${dep.name} last saw activity ${record.lastActivity} (${ageDays} days ago). The bar is ${freshnessDays} days.`,
        });
      }
    }
  }

  return {
    repoDir,
    ramping,
    freshnessEnforcedFrom: allowlist.policy?.freshnessEnforcedFrom || null,
    manifests: manifests.map((m) => ({ ecosystem: m.ecosystem, name: m.name })),
    checked,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Gate presence -- a check no workflow runs is a check that does not exist
// ---------------------------------------------------------------------------

const GATE_MARKER = 'third-party/check.mjs';

export function gateStatus(repoDir) {
  const dir = path.join(repoDir, '.github', 'workflows');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
  } catch {
    return { workflows: [], missing: [], present: [], hasWorkflows: false };
  }
  const present = [];
  const missing = [];
  for (const f of files) {
    if (f === 'no-mcp-secrets.yml') continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const gated = text.includes(GATE_MARKER);
    // Release gates and the fast PR suites are the two positions that matter.
    const matters = /^(publish|ci|test)\.ya?ml$/i.test(f);
    if (!matters) continue;
    (gated ? present : missing).push(f);
  }
  return { workflows: files, present, missing, hasWorkflows: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    repo: process.cwd(),
    allowlist: null,
    freshness: process.env.FANCY_ALLOWLIST_FRESHNESS || 'error',
    json: false,
    sweep: null,
    requireGate: false,
    offline: false,
    cache: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--allowlist') opts.allowlist = argv[++i];
    else if (a === '--freshness') opts.freshness = argv[++i];
    else if (a === '--cache') opts.cache = argv[++i];
    else if (a === '--sweep') opts.sweep = argv[++i];
    else if (a === '--require-gate') opts.requireGate = true;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown flag ${a}`);
  }
  if (!['error', 'warn', 'off'].includes(opts.freshness)) {
    throw new Error(`--freshness must be error, warn or off (got ${opts.freshness})`);
  }
  return opts;
}

const HELP = `fancy third-party allowlist checker

  node check.mjs [--repo <dir>] [--freshness error|warn|off] [--offline] [--json]
  node check.mjs --sweep <reposDir> [--require-gate]

Checks DIRECT dependencies only -- npm dependencies/devDependencies/
peerDependencies/optionalDependencies, Composer require/require-dev, Python
[project] dependencies plus optional-dependencies and dependency-groups.
Transitive dependencies inherit approval from their direct parent and are not
enumerated.

  --freshness error   a stale or unverifiable dependency fails the run (default)
  --freshness warn    report but exit 0 -- for local exploration, never CI
  --freshness off     allowlist membership only, no network
  --offline           use only cached registry data; missing data is a failure
  --sweep <dir>       run over every repo in <dir> (the envelope drift check)
  --require-gate      with --sweep, also fail repos whose CI does not run this
`;

function render(result, { showAll = false } = {}) {
  const lines = [];
  const order = { error: 0, warn: 1, note: 2 };
  const tags = { error: 'FAIL', warn: 'WARN', note: 'NOTE' };
  const sorted = [...result.findings].sort((a, b) => order[a.level] - order[b.level]);
  for (const f of sorted) lines.push(`  ${tags[f.level]} [${f.kind}] ${f.message}`);
  if (result.ramping && result.findings.some((f) => f.level === 'warn')) {
    lines.push(`  ---- freshness findings above are WARNINGS until ${result.freshnessEnforcedFrom}, then they fail the build.`);
  }
  if (showAll && !result.findings.length) {
    lines.push(`  ok -- ${result.checked.length} direct dependencies, all approved`);
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const allowlistPath = opts.allowlist || path.join(here, 'allowlist.json');
  const allowlist = loadAllowlist(allowlistPath);
  const checkOptions = {
    freshness: opts.freshness,
    offline: opts.offline,
    cacheFile: opts.cache || defaultCachePath(),
  };

  if (opts.sweep) {
    const root = opts.sweep;
    const repos = fs.readdirSync(root).filter((d) => {
      try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
    }).sort();
    const results = [];
    let failed = 0;
    for (const repo of repos) {
      const dir = path.join(root, repo);
      const result = await checkRepo(dir, allowlist, checkOptions);
      const gate = opts.requireGate ? gateStatus(dir) : null;
      const gateFail = gate && gate.hasWorkflows && gate.missing.length > 0;
      results.push({ repo, ...result, gate });
      const errs = result.findings.filter((f) => f.level === 'error').length;
      if (errs || gateFail) failed++;
      if (!opts.json) {
        const head = `${repo}: ${result.checked.length} direct deps`;
        if (!errs && !gateFail && !result.findings.length) {
          process.stdout.write(`${head} -- ok\n`);
        } else {
          process.stdout.write(`${head}\n${render(result)}\n`);
          if (gateFail) {
            process.stdout.write(`  FAIL [no-gate] ${gate.missing.join(', ')} do not run the allowlist check. A gate no workflow runs is not a gate.\n`);
          }
        }
      }
    }
    if (opts.json) process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
    else process.stdout.write(`\n${repos.length} repos swept, ${failed} failing.\n`);
    return failed ? 1 : 0;
  }

  const result = await checkRepo(opts.repo, allowlist, checkOptions);
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const errs = result.findings.filter((f) => f.level === 'error').length;
    process.stdout.write(`Third-party allowlist: ${result.checked.length} direct dependencies in ${path.resolve(opts.repo)}\n`);
    const body = render(result, { showAll: true });
    if (body) process.stdout.write(body + '\n');
    if (errs) {
      process.stdout.write(
        `\n${errs} unapproved or stale direct ${errs === 1 ? 'dependency' : 'dependencies'}.\n` +
        `Third-party code needs approval before it is added, and the project must have been active in the last ` +
        `${allowlist.policy?.freshnessDays ?? 92} days. See ${allowlist.docs || 'third-party/README.md'}.\n`
      );
    }
  }
  return result.findings.some((f) => f.level === 'error') ? 1 : 0;
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`allowlist check failed: ${err?.stack || err}\n`);
    process.exitCode = 2;
  });
}
