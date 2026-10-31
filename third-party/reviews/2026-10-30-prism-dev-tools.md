# Prism application Vite freshness review

Owner routing through master3412/3420 removes the proposed Collision exceptions.
This contribution now adds only two scoped laravel-vite-plugin git-freshness
grants for prism-labs and prism-sandbox. Their original evidence, verification
date and expiry are unchanged. Global approvals and the strict92-day policy
remain unchanged. No application dependency, lock, runtime or deployment changes.

The npm latest remains3.2.0, published2026-08-11T14:24:08.596Z. The default3.x
branch has signed commit
[38d2a7c](https://github.com/laravel/vite-plugin/commit/38d2a7cbe0b5bd9c6ef77074ea5f22a013a8d114),
2026-10-28T06:10:18Z, updating the CodeQL workflow. Dependabot authored it and
GitHub Actions merged it; no human-authored runtime change is claimed. Routine
default-branch dependency maintenance counts under the existing policy.

Use the existing git-activity mechanism, verified2026-10-30 and expiring
2027-01-30. Re-verify before expiry; retire the override when a release restores
registry freshness. The observed npm registry freshness cutoff is
2026-11-12T14:24:08.803Z. Sources: [npm metadata](https://registry.npmjs.org/laravel-vite-plugin),
[merged PR404](https://github.com/laravel/vite-plugin/pull/404).

## Collision requires an actual dependency edge

At the original review neither application installed Pest. An allow-plugins
permission does not install a package. The owner chose Pest4 or newer, specifically current
Pest5 with PHPUnit13, and asked for separate application contributions. No
pestphp/pest-plugin-laravel dependency is added. Each selected Pest/Collision
edge must be present in the actual application's lock and accepted by the
inheritance checker merged through .github PR8 at 00f21df8465f4437a0a88ca9aad7ee5ad9440136.
Rule B requires the actual repository lock edge from an approved, passing
direct Pest dependency to Collision. Separate application Pest contributions
and their reviewed consumer pins supply that edge; this grant contribution
does not establish application inheritance or installation.

There is no Collision exception, false claim of recent upstream activity or
removal of the php artisan test runner. Original proposals and baseline CI
failures remain in history.

## Controls and delivery

Seven native control groups check Vite's future registry cliff, exact expiry,
missing expiry, application identity isolation, unrelated dependency lookup
failure, unchanged global policy and the absence of a Collision exception.
Forecasts use explicit future clocks; they do not claim a future CI observation.
The Collision negative fixture contains no Pest lock edge and must remain stale.

The existing checker enforces identity and expiry; no new checker behavior or
manifest-field restriction is introduced here. Owner PR6 fixed the unrelated
baseline self-check at 1137f43f, and PR8 subsequently merged at 00f21df8. This
contribution is rebased onto that actual main; fresh head-bound PR CI is required. Assigned
maintainer owns merges. Consumers must advance reviewed policy pins and hashes
separately after actual policy publication.
