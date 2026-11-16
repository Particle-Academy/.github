<!--
  Three sections, in this order, are required and checked in CI
  (Particle-Academy/.github pr-body-check.yml). Keep the headings exactly as
  written. Prompts inside these comments do not count as content.
-->

## Why

<!-- The problem, in plain words, and what fixing it unblocks. Link the issue if there is one (e.g. Closes #123). -->

## What changes

<!-- What this PR changes. Scoped to a single repo. -->

## Who authorized it

<!--
  Who authorized this, and when. Cite at least one of:
    - a ForceTheQuestion id (q_...)
    - a council id (CC-fancy-NNNN)
    - a G-NNN id
    - the word "owner"
  plus the date, as YYYY-MM-DD.
-->

## Checklist

- [ ] Scoped to a **single repo** (cross-package changes are separate PRs)
- [ ] Tests added/updated and passing (`php artisan test --compact` / `npm test`)
- [ ] Formatter / type-check clean (`vendor/bin/pint --dirty` / `tsc --noEmit`)
- [ ] Build is green (`npm run build`, where applicable)
- [ ] Follows the **Human+ component contract** (controlled state, stable handles, JSON-friendly inputs) for stateful/interactive components
- [ ] **No new third-party runtime dependencies**
- [ ] Docs updated (package README / `docs/*.md`) where the surface changed
- [ ] I did **not** bump the version or push tags — maintainers cut releases
