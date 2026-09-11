---
title: Reconcile outstanding PRs and verify the Still release candidate
status: in_progress
date: 2026-09-10
---

## Intent

Review all eleven open PRs, preserve newer fixes on main, integrate approved changes through
protected GitHub checks, and finish with a clean local main matching origin/main exactly.
The user authorized edits and merges. Store submission and production migration execution are
separate from source integration; report their actual readiness from evidence.

## Work

1. Inventory exact PR heads and compare ancestry and content against main.
2. Review correctness, standards, test fidelity, and relevant security/migration/build concerns
   sequentially in the main agent, following the repository's tool mapping.
3. Merge source branches into an isolated reconciliation branch, preserving original commits and
   resolving conflicts to retain both intended fixes and newer main behavior.
4. Verify the combined tree with lint, types, unit tests, production builds, both configured and
   unconfigured browser fixtures, Deno, StillKit, and relevant local database/Apple checks.
5. Record exact candidate/artifact provenance and remaining external or device release gates.
6. Merge through required CI, synchronize local main, and verify clean status and equal hashes.

## Initial evidence

- Starting main: 47484c06. Domain PR #167 passed local lint/typecheck/tests/build and all three CI
  checks; merged as 7758dc3966b631d495d7adcd72e3e2cd721a1725.
- PR #156 head 8ee95fef is already an ancestor of main. GitHub rejected retargeting because there
  are no new commits; the redundant PR was closed with this evidence.
- PRs #154, #155, #157, #158, #159 still target the old integration branch. Main lacks the export
  regression, retention migration, and 2.0 version changes. UI differences require reconciliation.
- PRs #120, #129, #145, #165 update CI actions and dependencies.
- stillapp.fit DNS resolves to GitHub Pages; HTTP returns 200. HTTPS certificate issuance is pending.

## Completion evidence

Pending final integration and checks. See the dated release reconciliation report when completed.
