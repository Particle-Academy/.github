# Third-party dependency allowlist

Every piece of third-party code in the Fancy suite requires approval before it
is added, and the project it comes from must have been active within the last
**92 days**. This directory holds the machine-readable allowlist and the checker
that enforces it in CI.

- **`allowlist.json`** — the single source of truth. There are no copies.
- **`check.mjs`** — the checker. Node standard library only, no dependencies.
- **`check.test.mjs`** — its tests. `node --test "third-party/*.test.mjs"`.

The policy and its reasoning live in the envelope at
`.ai/knowledge/third-party-allowlist.md`. This file is the operational half:
what the check does, and what to do when it fails you.

## Your build just failed. What now?

Run it locally to see the same output:

```sh
git clone --depth 1 https://github.com/Particle-Academy/.github /tmp/pa-allowlist
node /tmp/pa-allowlist/third-party/check.mjs --repo .
```

### `FAIL [unapproved] <package> is not approved`

You added a dependency nobody approved. That is the check working. Raise an
**approval request** with the owner — what it does that we will not write, its
licence, its actual last-release date, its maintenance status, its transitive
dependency count, and what happens if it is refused. If it is approved, add the
entry to `allowlist.json`.

If the message says *"Granted to X only"*, the package is approved for a
different package. Grants do not transfer — see below.

### `FAIL [stale] <package> last saw activity <date>`

The project has not released or been committed to within 92 days. **Do not add a
freshness override to make this go away** unless you have actually looked and
found recent commits; see below.

### `FAIL [lookup-failed]`

The registry could not be reached, so we learned nothing about the package. That
is not a pass. Re-run it. A lookup failure counting as "current" is the same
mistake as a conformance suite that silently does not run: the log goes green
and the check did not happen.

## The three approval routes

A direct dependency passes if any one of these matches.

1. **Author** — `ecosystems.<eco>.authors`. Approves everything from one owner.
   What counts as an owner is **not the same concept in each registry**, and
   that difference is enforced, not smoothed over:

   | Registry | Checkable owner | Why |
   |---|---|---|
   | npm | the **scope** (`@types`, `@tanstack`) | A scope is the only owner visible in a manifest. Registry `maintainers` is mutable metadata a consumer never declares. **Unscoped npm packages cannot be approved by author at all** and must be listed individually. |
   | Packagist | the **vendor** (`laravel/`, `symfony/`) | Every name is `vendor/package` and Packagist enforces vendor ownership at registration. The strongest of the three. |
   | PyPI | **none exists** | PyPI has no namespace. A requirement string carries no owner. Author approval is not expressible for Python; every distribution is listed one at a time. |

2. **Package** — `ecosystems.<eco>.packages`. One named package, everywhere.

3. **Grant** — `packageGrants`. One named package, **for one of our packages
   only**. This is the wrapper case: `fancy-echarts` exists to wrap `echarts`,
   so re-approving `echarts` on every release is noise. The grant is deliberately
   narrow — `echarts` being approved for `fancy-echarts` does **not** approve it
   for `fancy-trading`, and the checker says so by name when you try.

   Grants are keyed by any of three identities, because none is reliable alone:
   the **manifest name** (`package.json` `name`, `composer.json` `name`,
   `[project] name`), the **repo directory name**, or the **repo name on the
   git remote**.

   The showcase needs all three to make the point. Its `composer.json` is named
   `laravel/laravel` — a name every Laravel app on earth shares, so keying on it
   would hand the showcase's grants to anything scaffolded with `laravel new`.
   Its `package.json` has no name at all. And it sits at `repos/px-ui-sandbox`
   in the envelope while its remote is `Particle-Academy/pa-ux-sandbox`, so the
   directory name differs between a local run and Actions. **Prefer the remote
   name when writing a grant for an application** — it is the one identity that
   is the same in both places.

First-party packages (`@particle-academy/*`, `particle-academy/*`, and the named
Python distributions) are ours and are not a dependency question.

## Freshness, and the override

The bar is a release **or a commit** within 92 days. Registries only report
releases, so a project that is alive on git but slow to tag looks stale to an
automated lookup. That gap is closed by hand, on purpose:

```json
"leaflet": {
  "reason": "The OSM map engine this package exists to wrap.",
  "freshness": {
    "mode": "git",
    "evidence": "https://github.com/Leaflet/Leaflet -- pushed 2026-08-17",
    "verifiedOn": "2026-08-19",
    "expires": "2026-11-19",
    "why": "Last npm publish 2025-08-16, but the repository is actively committed to."
  }
}
```

The checker does **not** go and read GitHub itself. Mapping a package to a
repository is guesswork, the metadata that would tell it is controlled by
whoever publishes the package, and an automated "well, there were some commits"
is exactly the reassuring non-answer the 92-day bar exists to prevent. A human
looked, wrote down what they saw, and signed a date.

**`expires` is mandatory and enforced.** An override with no expiry is rejected
outright; an expired one fails. An exception that never expires is not an
exception, it is a hole.

## Direct only. Transitive dependencies inherit.

The check covers **direct** dependencies: npm `dependencies` /
`devDependencies` / `peerDependencies` / `optionalDependencies`, Composer
`require` / `require-dev`, Python `[project] dependencies` plus
`optional-dependencies` and `dependency-groups`.

Anything an approved dependency pulls in is approved by inheritance and is
**not filed**. No entries, no baseline, no enumeration. The allowlist stays a
short document of deliberate decisions, because a file nobody can read is a file
nobody checks.

**What this protects against:** somebody adding an unapproved library, or an
abandoned one, on purpose. That is a real and common way risk enters, and it is
now impossible to do quietly.

**What this does not protect against:** a compromised, hijacked or abandoned
package deep inside somebody else's dependency tree. A green check here is not
supply-chain coverage and must never be read as any. Dependabot and the registry
advisory feeds are what cover that ground; this check does not overlap with them.

**The promotion case.** A package can be transitive today and direct tomorrow —
someone imports it directly because it is "already in `node_modules`". At that
moment it needs approval, and the check will correctly start failing. **That is
the system working, not a false positive.** Do not fix it by adding a blanket
entry; raise the approval request the same as for anything else.

## Distribution

The allowlist is **fetched at CI time, never vendored**. Every workflow does:

```yaml
- name: Fetch the third-party allowlist
  uses: actions/checkout@v4
  with:
    repository: Particle-Academy/.github
    path: .third-party-allowlist
    persist-credentials: false

- name: Third-party dependency allowlist
  run: |
    node .third-party-allowlist/third-party/check.mjs --repo .
    # Delete it. A fetched checkout left lying in the workspace is not
    # inert: vitest globbed the checker's own tests out of it and failed
    # a package whose code was fine. Removed with node rather than
    # `rm -rf`, because a multi-line `run:` is PowerShell on the
    # windows-latest matrices some of these repos use.
    node -e "require('node:fs').rmSync('.third-party-allowlist',{recursive:true,force:true})"
```

There are no per-repo copies, so there is nothing to drift. This repository is
public, so no token is needed. The remaining failure mode is a repo that quietly
stops running the check at all, and that is what the gate audit covers:

- `check.mjs --sweep <reposDir> --require-gate` sweeps every repo in the
  envelope and fails any whose `publish.yml` / `ci.yml` / `test.yml` does not
  run this check.
- `gate-audit.mjs` does the same against the live GitHub org nightly, so a repo
  that never appears in the envelope is still caught.

## Flags

```
--repo <dir>            repo to check (default: cwd)
--freshness error       stale or unverifiable fails the run (default)
--freshness warn        report but exit 0 -- local exploration, never CI
--freshness off         allowlist membership only, no network
--offline               cached registry data only; missing data is a failure
--sweep <dir>           check every repo in a directory
--require-gate          with --sweep, also fail repos whose CI skips the check
--json                  machine-readable output
```
