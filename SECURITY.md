# Security Policy

We take the security of the Fancy UI suite seriously. Thank you for helping keep
our users safe.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Instead, email **security@particle.academy** with:

- the affected package(s) and version(s),
- a description of the issue and its impact,
- steps to reproduce (a minimal proof-of-concept helps),
- any suggested remediation.

You can expect an acknowledgement within **3 business days**, and we'll keep you
updated as we investigate and prepare a fix. Please give us a reasonable window
to release a fix before any public disclosure — we're glad to credit you in the
release notes if you'd like.

## Supported Versions

Security fixes are released for the **latest published minor** of each package.
Because every package is independently versioned, "latest" means the most recent
release on npm (`@particle-academy/*`) or Packagist (`particle-academy/*`) for
that specific package. Please upgrade to the latest version before reporting, in
case the issue is already resolved.

## Scope

In scope: the published package code and its documented APIs. Out of scope:
issues that require an already-compromised developer machine or social
engineering, and vulnerabilities in third-party platforms (npm, Packagist,
GitHub) rather than in our code.
