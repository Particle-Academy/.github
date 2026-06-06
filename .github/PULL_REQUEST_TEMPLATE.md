<!-- Thanks for contributing! Keep PRs focused and scoped to a single repo. -->

## What & why

<!-- What does this change, and why? Link any related issue (e.g. Closes #123). -->

## Checklist

- [ ] Scoped to a **single repo** (cross-package changes are separate PRs)
- [ ] Tests added/updated and passing (`php artisan test --compact` / `npm test`)
- [ ] Formatter / type-check clean (`vendor/bin/pint --dirty` / `tsc --noEmit`)
- [ ] Build is green (`npm run build`, where applicable)
- [ ] Follows the **Human+ component contract** (controlled state, stable handles, JSON-friendly inputs) for stateful/interactive components
- [ ] **No new third-party runtime dependencies**
- [ ] Docs updated (package README / `docs/*.md`) where the surface changed
- [ ] I did **not** bump the version or push tags — maintainers cut releases
