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

**For PyPI, "ours" is a claim that must be CHECKED before the name is listed.**
On npm and Packagist the registry enforces ownership of the scope or vendor, so
a first-party prefix cannot be wrong. On PyPI there is no namespace, so an entry
in `firstParty.pypi` is a bare assertion that *we* own that distribution name —
and the checker then approves whatever is published under it, by anyone. A name
we do not own, or do not own yet, is an unconditional grant to a stranger.

So: before adding a distribution to `firstParty.pypi`, confirm it is published
AND that the publisher is us — `https://pypi.org/pypi/<name>/json`, read
`info.author`. Add names **on publish**, never in advance. An unpublished name
is the dangerous case, because it reads as merely premature.

This is not hypothetical, and it has already happened here twice.

The nine `prism-ai-*` entries were added on 2026-10-11, and the obvious tenth —
`prism-ai` — **is not ours**: it is an empty 0.1.0 by an unrelated author, while
our own core distribution is `prism-ai-core`. Listing the family by eye would
have granted blanket approval to someone else's package on the single name a
reader is most likely to assume is ours. `prism-ai-mcp-server` was also left
out, for a different reason: it is unpublished, and as the *consumer* it never
needs approval for itself.

Checking that found the **live** case, which had been sitting in this list since
it was written. Three entries — `holy-sheet`, `dark-slide`, `last-word` — named
distributions that **do not exist on PyPI and never did**. Our Python ports
publish as `fancy-holy-sheet`, `fancy-dark-slide` and `fancy-last-word`; the
list had the *Composer/repo* names, where the `particle-academy` vendor prefix
makes the bare form correct. So the three entries were wrong in both directions
at once: a real dependency on `fancy-holy-sheet` would have been **rejected**,
while all three bare names stood pre-approved as "Ours." for whoever registered
them first. Corrected the same day.

Note which half of that was dangerous. The rejection would have surfaced
immediately, the way the `prism-ai-mcp` finding did — a red job and a filed
request. The pre-approval was silent, and would have stayed silent until someone
used it.

`fancy-conformance` remains in the list and is the one open case: the name is
right, but the owner ruled it is never published to PyPI (consumers pin it by
git tag, and every manifest here reaches it through `pythonpath`, not a
requirement). Nothing depends on it as a registry package, so the entry approves
nothing legitimate while leaving the name squattable. Removing it is pending the
owner's decision rather than done, because it touches that ruling.

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

### A direct listing that an approved dependency also requires

Owner's ruling, 2026-10-31: *"dependencies of our whitelisted dependencies
inherit their status from what we use."* That already covered everything an
approved dependency pulls in. The ruling extends it to a package we **also**
list directly, when an approved direct dependency requires it anyway.

The motivating case: a Laravel app lists `nunomaduro/collision` in
`require-dev`, and `pestphp/pest` (approved through the `pestphp` author entry)
itself requires `nunomaduro/collision ^8.9.4`. Removing the direct line would
change nothing that gets installed, so failing collision for freshness or
approval while passing it as Pest's transitive was a distinction with no
difference.

A direct dependency **D** that fails its own check inherits from parent **P**
only when **all** of these hold:

- **P is a direct dependency of the same manifest** in the same repo.
- **P is approved** (author, package or grant) **and passes its own check**:
  approval, freshness, override expiry, lookup. First-party packages are not
  parents; ours is not an approval decision.
- **The repo's lockfile records P requiring D.** `composer.lock`: the
  `packages` / `packages-dev` entry's `require`. `package-lock.json` v2/v3: the
  top-level `packages["node_modules/<P>"]` entry's `dependencies`,
  `peerDependencies` or `optionalDependencies`. A dependency's own
  `require-dev` / `devDependencies` are not edges, because they are never
  installed for a consumer. **An optional peer is not an edge either**
  (`peerDependenciesMeta.<x>.optional`): the parent works without it and npm
  does not install it, so choosing it is our decision. That is exactly the
  decision this list gates. `laravel-echo` declares `pusher-js` this way, and
  a stale `pusher-js` does not inherit from it. The checker never looks the edge up on the network
  and never infers it from names.
- **One level only.** P must pass on its **own**. A package that passes only by
  inheriting cannot pass that status on, so chains are not followed.

What D can inherit its way out of: `unapproved`, `stale`, `lookup-failed` and
`expired-override`. **Not** `bad-override`. That is a defect in this allowlist,
not a fact about the package, and no parent can vouch for it.

**An inherited pass is reported, never silent.** It prints as its own line:

```
  INHERITED nunomaduro/collision via pestphp/pest -- pestphp/pest is approved (author) and passes its own check, and composer.lock records it requiring nunomaduro/collision. Waived: stale.
```

In `--json` it is a finding of `kind: "inherited"` (level `note`, so it does not
fail the build) carrying `parent`, `parentVia`, `parents`, `lockfile`, and
`waived`: the findings it would otherwise have failed on, kept whole. The
dependency's record in `checked` carries `inheritedFrom`. A package that passes
on its own is **not** reported as inherited, even when a parent requires it.

**What it does not cover:**

- **A direct listing that no approved direct dependency requires still needs
  approval like anything else.** Being popular, being in `vendor/`, or being
  required by something that is merely installed (not listed by us) is not a
  parent.
- **No lockfile means no inheritance.** Neither does npm lockfile v1, which has
  no `packages` map. Neither does a lockfile that does not show the edge. The
  normal check applies, which is the safe direction to be incomplete in.
- **Python and Rust get no inheritance.** A pyproject repo has no single
  lockfile format, and `Cargo.lock` was left out to keep this change to the two
  ecosystems the ruling was about. Both fall back to the normal check.
- **Inheritance follows the lockfile, so it moves when the lockfile does.** If
  Pest drops collision in a future release and the lock is updated, the direct
  listing goes back to being checked on its own. That is correct: the reason it
  passed is gone.

**The promotion case.** A package can be transitive today and direct tomorrow —
someone imports it directly because it is "already in `node_modules`". If an
approved direct dependency still requires it (and the lockfile shows it), it
now inherits that dependency's status and prints as `INHERITED`. That is the
ruling above, not a loophole: nothing new is installed by listing it. If **no**
approved direct dependency requires it, it needs approval at that moment and
the check will correctly start failing. **That is the system working, not a
false positive.** Do not fix it by adding a blanket entry; raise the approval
request the same as for anything else.

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


## Rust (`crates`)

Added 2026-08-23, with the suite's first Rust packages. `Cargo.toml`'s
`[dependencies]`, `[dev-dependencies]` and `[build-dependencies]` — including
the `[target.'cfg(...)'.dependencies]` forms.

Three things are worth knowing:

- **A renamed crate is checked under its REGISTRY name.**
  `renamed = { version = "1", package = "tokio" }` installs `tokio`, and a grant
  is about what is installed. Reading the key would let any dependency be
  smuggled past by renaming it.
- **`git` and `path` dependencies are reported, not skipped.** Neither is a
  registry dependency, so nothing about one is checkable — which means an
  unapproved one must be refused by name rather than pass by being unreadable.
- **crates.io requires a User-Agent.** Without one it answers 403 for every
  name, which a naive reader turns into "this crate does not exist". The
  freshness lookup sends one.

crates.io has no namespace, so — exactly as with PyPI — author-level approval is
not expressible and every crate is listed individually.
