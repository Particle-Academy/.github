# Prism application dev-tool freshness review

Draft for owner review. Collision's exception is not approved for merge yet;
decide by **2026-11-03**, before its registry freshness cutoff on November 5.
This changes four grants for the remote application identities `prism-labs`
and `prism-sandbox`. Global approval entries and the strict 92-day policy stay
unchanged. No application dependency, lock, runtime or deployment changes.

| Package | Both application locks | Role | Registry freshness cutoff | Proposed expiry |
| --- | --- | --- | --- | --- |
| nunomaduro/collision | v8.9.5 | require-dev | 2026-11-05T15:19:57Z | 2027-01-04T00:00:00Z |
| laravel-vite-plugin | 3.2.0 | devDependencies | 2026-11-12T14:24:08.803Z | 2027-01-30T00:00:00Z |

These are targeted package advisory observations, not a supply-chain audit of
every transitive dependency: Packagist reported no Collision advisories; npm's
bulk advisory feed reported none for laravel-vite-plugin3.2.0 on October30.
Fresh exact main manifest/lock blobs of both applications were verified before
preparing these grants. Neither package has a newer stable release to adopt.

## Vite plugin: active git, slower registry releases

The latest npm release is3.2.0, published2026-08-11T14:24:08.596Z. Its default
`3.x` branch contains signed commit
[`38d2a7c`](https://github.com/laravel/vite-plugin/commit/38d2a7cbe0b5bd9c6ef77074ea5f22a013a8d114)
from2026-10-28T06:10:18Z, updating the CodeQL workflow. It is authored by
Dependabot and merged by GitHub Actions; this is not claimed as a human-authored
runtime change. Routine dependency maintenance on the default branch counts
as tending the project under the existing git-activity policy.

Use the existing `mode: git` mechanism with verification2026-10-30 and
expiry2027-01-30. Re-verify before expiry. Retire the override when a new
release restores registry freshness. Sources: [npm metadata](https://registry.npmjs.org/laravel-vite-plugin),
[merged PR404](https://github.com/laravel/vite-plugin/pull/404).

## Collision: explicit temporary risk acceptance, pending owner ruling

Latest stable isv8.9.5, released2026-07-15T19:09:14Z at
[`fb53eac`](https://github.com/nunomaduro/collision/commit/fb53eacd509a1d303858e2d20cfebf2d630254ec).
The latest default `v8.x` commit is
[`9716022`](https://github.com/nunomaduro/collision/commit/9716022d2d48a14fa72bcc40239259051b27a1aa),
2026-08-04T15:19:57Z, matching Packagist dev activity. There is no newer
qualifying maintainer activity in this review. Repository pushes on October14
are Dependabot branches; recent outsider nudges on unreviewed pull requests
are not substituted for maintainer liveness. This is **not** a git-activity
override.

The proposal retains the standard Laravel dev-only console/test runner through
January4, with a November3 decision/recheck. That is60days after the November5
cutoff (about66days after verification). Removing it was considered and then
ruled out by the assigned maintainer before any removal experiment:
[`CollisionServiceProvider::boot`](https://github.com/nunomaduro/collision/blob/fb53eacd509a1d303858e2d20cfebf2d630254ec/src/Adapters/Laravel/CollisionServiceProvider.php)
registers `TestCommand`, which supplies `php artisan test`; both applications'
Composer test scripts invoke that command. No successful removal measurement
is claimed. The applications' locked production package lists exclude it.

`mode: dev-only-exception` labels this distinction for review. The existing
checker mechanically enforces application identity and expiry; `mode` and the
dev-only rationale are descriptive. It does **not** bind an override to a
manifest dependency field or automatically invalidate it on an upstream
release. Runtime promotion, renewal or a release requires a new review and
removal/update of the grant. No ignored field condition or new checker behavior
is introduced. Owner sign-off is required before this draft can merge.

Sources: [Packagist metadata](https://repo.packagist.org/p2/nunomaduro/collision.json),
[dev metadata](https://repo.packagist.org/p2/nunomaduro/collision~dev.json),
[package advisory feed](https://packagist.org/api/security-advisories/?packages[]=nunomaduro/collision).

## Controls

The checked-in controls use the actual observed registry timestamps and an
explicit future clock. They demonstrate that the old policy becomes stale,
both scoped proposed grants pass, unrelated Laravel scaffolds remain stale,
lookup failures for other direct dependencies still fail, and missing/expired
grant dates fail closed. These are forecasts and synthetic controls; they are
not observations of a future CI run. Existing checker/gate tests also run.

Once the owner decides and merges the policy, each application's reviewed
policy pin and file hashes must be advanced in its own PR. A policy-only PR
does not update an already pinned consumer or prove its actual main CI.
