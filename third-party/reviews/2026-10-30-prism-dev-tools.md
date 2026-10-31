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

Neither application currently installs Pest. An allow-plugins permission does
not install a package. The owner chose Pest4 or newer, specifically current
Pest5 with PHPUnit13, and asked for separate application contributions. No
pestphp/pest-plugin-laravel dependency is added. Each selected Pest/Collision
edge must be present in the actual application's lock and accepted by the
separate owner-controlled inheritance checker in .github PR8. That prerequisite
is not supplied by this grant contribution; no green inheritance claim is made
before the rule and actual application dependency changes merge.

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
manifest-field restriction is introduced here. Owner PR6 fixes the unrelated
baseline self-check; actual merge/rebase and fresh PR CI are required. Assigned
maintainer owns merges. Consumers must advance reviewed policy pins and hashes
separately after actual policy publication.
