# Release-notes check

These packages ship no `CHANGELOG` file. The **annotated tag message is the
changelog** — the publish workflow reads it from the tag object and publishes it
verbatim as the GitHub release body, so it is what a consumer reads on the
release page. This directory holds the check that makes it answer the one
question a consumer most needs answered.

- **`check.sh`** — the checker. POSIX `sh`, no dependencies.
- **`check.test.sh`** — its tests. `sh release-notes/check.test.sh`.

## What it requires

An annotation must **declare its breaking status**, either way. One of:

```
BREAKING CHANGE: <what breaks, and what the consumer must do about it>
```

```
No breaking changes.
```

A `## Breaking changes` heading with content under it also counts, but only
survives if you tag with `--cleanup=verbatim` or `-F` (see the trap below).

Silence is refused, not read as "nothing breaks". An annotation that declares
both ways is refused as contradictory, and a heading with nothing under it is
refused as declaring nothing.

## Why it exists

Release docs already asked for this in prose, and asking did not work. Measured
across the twenty most recent annotations in ten of these repositories:
**eighteen never used the word "breaking" at all.** `prism-harness` v0.13.0
shipped a mandatory migration, a changed scope-matching rule and a raised
framework floor, under headings that described each change accurately and
labelled none of them breaking. A consumer scanning that release page for the
word found nothing to scan.

Two things make the check stricter than it first looks, both found by testing it
rather than by reasoning about it:

**Prose does not count.** Three real annotations contain the word "breaking"
while declaring nothing — "this avoids breaking downstream consumers". A `grep
-i breaking` passes all three. The check matches the structural form instead,
and the sharpest negative control in the suite is exactly that shape.

**git deletes `#` lines from tag messages.** Under the default
`--cleanup=strip` they are commentary, so

```sh
git tag -a v1.2.3 -m '## Breaking changes
- `foo()` is gone'
```

publishes an annotation reading only `- foo() is gone`. The heading is removed
silently. That is why the two cleanup-safe forms are listed first, why the
refusal message names the trap, and why the suite asserts the stripping is still
real — so that case cannot quietly become vacuous.

## Running it

```sh
sh release-notes/check.sh --tag v1.2.3     # read an annotated tag
sh release-notes/check.sh notes.md         # read a file
… | sh release-notes/check.sh              # read stdin
```

Prefer `--tag` to piping `git tag -l --format='%(contents)'`: on a **lightweight**
tag that format yields the *commit* message instead, so the check reads text the
release will never publish and approves it. `--tag` refuses that case by name.
`prism` has already built a release page from the wrong text three separate ways
for want of that distinction.

Exit codes: `0` declared, `2` no declaration, `3` contradictory, `4` empty,
`5` not an annotated tag, `1` usage error.

## Where to run it, and what that buys

Each package's publish workflow runs this in its `guard` job. **What refusing
achieves there depends on the language:**

- **npm and PyPI packages** — `guard` runs before the upload, so the check
  genuinely **prevents publication**.
- **Composer packages** — Packagist mirrors the version the moment the tag is
  pushed. The guard can only withhold the GitHub release; it cannot withdraw a
  version. For those, the **pre-tag run is the only preventive control**:

  ```sh
  git tag -a v1.2.3                                   # write the message
  sh tools/check-release-notes.sh --tag v1.2.3        # must pass
  git push origin v1.2.3                              # only then
  ```

## Copies

Unlike `third-party/allowlist.json`, this one **is** copied: every package
vendors it as `tools/check-release-notes.sh` so a release manager can run it
against the tree they are tagging, without network access and without piping a
remote script into a shell.

The copies are therefore **guarded, not trusted** — each repository's CI diffs
its vendored copy against the canonical file here and fails when they disagree.
Generated-and-checked beats generated-and-trusted; an unchecked duplicate is a
duplicate that has already drifted and not told you.
