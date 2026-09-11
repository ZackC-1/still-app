---
title: Reconcile release branches by ancestry and content
date: 2026-09-10
category: conventions
track: knowledge
module: release
applies_when: Draft release PRs remain open after a stacked or cherry-picked integration
status: active
tags: [git, release, verification, dependencies]
---

## Problem

An earlier merge train can include some release fixes while leaving others only in draft PRs
against an old integration branch. Green CI and a locally built candidate do not prove that main
contains that candidate. Cherry-picked commits also make branch names and commit hashes alone
insufficient to identify equivalent changes.

## Verified approach

Capture each open PR's exact head, base, file list, and checks. Use `git merge-base --is-ancestor`
to prove whether the head is already on main; compare patches and changed files for the remaining
heads. A head already on main needs no second merge. GitHub may refuse retargeting that redundant
PR because there are no new commits; close it with the ancestry evidence.

Integrate the remaining original heads in an isolated branch. Resolve overlapping edits from their
intended behavior, preserving later fixes on main. Merge the integration branch through protected
checks using a merge commit so the original heads remain ancestors and GitHub can recognize their
integration. Do not squash an integration containing PR heads that must retain their ancestry.

For overlapping dependency PRs, preserve both manifest changes, regenerate the lockfile, then
verify a frozen install. Audit the combined lockfile: successful individual dependency PRs can
still leave vulnerable transitive versions. A targeted compatible transitive update avoids an
unrelated manifest override. The reviewed reconciliation updated only Undici 7.28.0 to 7.29.1
after the combined audit identified it; the subsequent audit reported zero advisories.

## Evidence and prevention

The September 10 reconciliation found that sync lifecycle isolation was already on main, while
export-error handling, counter retention, and shipping versions were missing. It preserved newer
UI behavior and unified the configured-popup environment name with its CI producer. Both capability
variants then passed browser fixtures, and real Deno, StillKit, and disposable database tests passed.

Before calling a checkout synchronized, fetch and compare local HEAD with origin/main and verify
tracked/untracked Git status. Preserve unrelated worktrees and ignored local configuration; they
are not release source. Before calling a release ready, separately verify artifact provenance,
hosted migration state, signing, and required device journeys.

Related: [configured visual contracts](codify-cross-platform-visual-contract-in-tests.md) and
[release reconciliation plan](../../plans/2026-09-10-release-pr-reconciliation.md).
