---
title: Stale Safari-extension entitlement survives app reinstall
date: 2026-07-13
category: logic-errors
track: bug
module: packages/ext-safari
problem_type: logic_error
component: payments
severity: high
symptoms:
  - "Delete app while signed-in + entitled, reinstall, enable extension, do NOT sign in — Instagram/Facebook/TikTok stay Pro-blocked for a free user (verified on-device, issue #63)"
  - "Signing in and out clears it (explicit entitled:false write propagates); otherwise stale Pro persists up to the 30-day TTL"
root_cause: logic_error
resolution_type: code_fix
severity_note: monetization-gating, bounded by TTL and single device
tags: [entitlement, reinstall, app-group, safari-extension, install-generation, never-downgrade, purge]
status: active
---

# Stale Safari-extension entitlement survives app reinstall

## Problem

iOS Safari owns web-extension storage independently of the app container: deleting the app wipes
the App Group but NOT `browser.storage.local`, so a prior install's `still:entitlement`
(`entitled:true`) record kept unlocking Pro for a signed-out fresh install (issue #63, fixed by
PR #82).

## Symptoms

- Reinstall repro above; bounded by the 30-day TTL, single device, prior entitlement required.

## What Didn't Work

- **First-launch explicit `entitled:false`** (the "simple" direction) was rejected at planning:
  a Supabase session surviving reinstall in the keychain makes "first launch with no session" an
  unreliable predicate, and misfiring writes a false revocation.
- The two storage lifetimes cannot be unified — Safari gives the extension no reinstall signal of
  its own.

## Solution

An **install-generation marker**: the app stamps a UUID into the App Group once per install
(`StillKit InstallGeneration.ensure` — read-before-write idempotent; regenerating per launch would
purge Pro on every app open). The `getEntitlement` reply became a three-key envelope
(`{installId, entitled, updatedAt}`, all keys always present — Swift's synthesized Codable DROPS
nil keys via `encodeIfPresent`, so the envelope needs a hand-written `encode(to:)` and
literal-JSON-string tests). The extension compares the reply id against a last-seen id
(`still:installGeneration`) with an explicit outcome union:

| stored id | reply id | outcome | action |
|---|---|---|---|
| any | null/malformed | unknown | strict no-op (offline design preserved) |
| null | "B" | adopt | store id, never purge (upgrade path) |
| "B" | "B" | same | no-op |
| "A" | "B" | changed | purge (explicit `entitled:false`), then store id |

Key files: `apps/apple/StillKit/Sources/StillKit/InstallGeneration.swift`,
`EntitlementBridge.swift`, `packages/ext-safari/lib/entitlement-pull.ts`.

## Why This Works

Reinstall becomes **affirmatively detectable** instead of being conflated with "App Group
unreachable." Only positive evidence (a *different* id) purges; absence stays a no-op, so the
30-day offline never-downgrade design is untouched. This is deliberately fail-open toward the
user's paid state — the opposite of the edge-function fail-closed rule, and correct here: purging
on ambiguity would relock paying users on ordinary read hiccups.

## Prevention

- **One-shot destructive signals must gate their acknowledgment on success.** The review's biggest
  catch (3 reviewers + the Codex bot independently): advancing the marker after a FAILED purge
  write permanently forfeits the retry, and a thrown marker READ must resolve to `unknown` (no
  writes) — coercing it to "adopt" overwrites the real stored id. Rule: record "I have handled
  signal X" only after handling X actually succeeded; treat read failures as no-signal, never as
  first-contact.
- **Version-suffixed keys aren't all bumpable.** `still.installGeneration.v1` must never be bumped
  as a soft reset (unlike `OnboardingGate`'s key): every device would look freshly reinstalled and
  mass-relock Pro. Migrate values forward instead.
- **Cross-language wire contracts need literal-string tests on the encoder side** — a Swift
  `encodeIfPresent` regression is invisible to round-trip decoding and surfaces only as a TS-side
  behavioral gap nobody tests.
- Single-flight the pull (in-flight promise reuse per `core/rules/loader.ts`, NOT
  `nudgeInFlight`'s throttle-and-drop) so a stale late-resolving reply can't interleave with a
  newer purge.
- Accepted limitation (documented, not fixed): reinstall-without-ever-launching-the-app keeps
  stale Pro ≤ TTL; a degraded App Group makes the fix silently inert.

## Related Issues

- Issue #63 (fixed), PR #82. Plan: `docs/plans/2026-07-13-001-fix-reinstall-entitlement-purge-plan.md`.
- `docs/solutions/security-issues/supabase-signout-leaves-local-session-on-revoke-failure.md` —
  sibling teardown/purge learning (its teardown-generation guard is the race-protection cousin of
  this doc's single-flight choice).
- `docs/solutions/conventions/mirror-fixes-across-parallel-paths.md` — Chromium/Firefox verified
  structurally immune (no App-Group coupling; profile reinstall wipes `chrome.storage.local`
  atomically).
- CONTEXT.md glossary: **Install generation**.
