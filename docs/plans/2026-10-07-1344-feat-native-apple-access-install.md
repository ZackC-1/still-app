---
title: Install signed Apple local rights through native StoreKit verification
status: complete
date: 2026-10-07
---

This bounded lane implements the native prerequisite for the [V3.1 redesign plan](2026-10-07-1118-feat-still-v31-redesign-plan.md). The backend issuer and host factory are separate integration lanes. It changes StillKit, the Apple main-frame router/purchase oracle, and core native/session contracts. It does not activate providers, change paid flags, modify UI/backend code, or submit an artifact.

A signed local proof grants access only after native independently matches its signed Apple binding to a current verified StoreKit transaction. The binding uses the environment-bound access key allowlist, the separate `still-apple-right-binding-v1` signing domain, and a closed canonical payload. Missing native configuration supplies an empty allowlist. A Boolean receipt or JS local-right UUID supplies no mapping authority.

The existing App Group entitlement transaction stores the verified binding, local proof and receipt clock together. An optional linked account proof additionally requires native verification of the exact transient access token through the code-signed Supabase auth endpoint, a confirmed matching account, and an unchanged native account generation. Sign-out removes account rights while the local mapping remains. The successful bridge reply identifies the exact durable proof signatures, right, revision, times and generation; the explicit session association checks that reply before reporting success.

Code-signed native configuration uses `StillAccessEnvironment`, `StillAccessTrustKeys` (closed rows: kid/publicKeyHex/environment/purpose), `StillAccessSupabaseURL`, and `StillAccessSupabasePublishableKey`. JavaScript cannot supply these settings. Defaults remain closed. Configuration and deployed issuer readiness require separate integration evidence.

Verification so far: all 403 StillKit tests pass, including eleven new forged/domain/schema/native-identity/stale-generation/replay/expiry/failed-write/configuration and native absence controls; all 31 focused TypeScript native install/readback and explicit-link tests pass; workspace lint and typecheck pass. Full workspace unit tests pass (5,313 passed, 39 existing skips), and the ordinary build passes. Final unsigned macOS and iOS Simulator app/extension target compilation passes with a separately recorded prerequisite return fix used only as a verification overlay and restored afterward. The final Safari capability parity case passed in the subsequent focused suite. Physical StoreKit/provider/account/device journeys remain required before release.

The isolated worktree preserves a prerequisite snapshot. Delivery is a delta-only patch and local receipt; no commit, push, provider configuration or production activation occurs in this lane.

Native paid Safari capability support matches the canonical six implemented extras (Instagram Explore/Stories/Suggested/Threads and Facebook Stories/Videos), plus four free outcomes. A TypeScript parity test detects drift. The native ownership observation has a three-second deadline, below the five-second web observation deadline. Signed binding installation accepts at most five minutes of initial issuer/device wall skew in either direction; identical retries preserve their receipt clock and latches. The shipped flags remain disabled.
