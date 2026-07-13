---
title: "fix: Purge stale Safari entitlement on app reinstall via install-generation marker"
type: fix
status: active
date: 2026-07-13
---

# fix: Purge stale Safari entitlement on app reinstall via install-generation marker

## Summary

Close issue #63: after an app delete/reinstall on iOS, the Safari extension's `still:entitlement` record survives (Safari owns extension storage) and keeps Pro unlocked for a signed-out fresh install for up to the 30-day TTL. The fix: the app writes an install-generation id into the App Group on every launch (idempotently); the extension receives that id on its existing entitlement pull and purges its stale entitlement record when the id **changes** — while an absent or unreadable id remains a strict no-op, preserving the AE6 offline design (AE6 of docs/plans/2026-07-01-002-feat-extension-purchase-spine-plan.md — "cached entitlement within TTL keeps Pro active offline"; not the unrelated settings-sync AE6 in the second-pass brainstorm).

## Problem Frame

iOS Safari manages web-extension storage independently of the app container. Deleting the app wipes the App Group but not `browser.storage.local`, so a prior install's `entitled:true` record persists. The entitlement pull (`packages/ext-safari/lib/entitlement-pull.ts`) deliberately never downgrades when the App Group returns nothing — that behavior is correct for the offline case (an entitled user offline for a week must stay unlocked) and must not change. The gap is that "App Group empty because reinstalled" is indistinguishable from "App Group unreachable." An install-generation marker makes reinstall affirmatively detectable, which lets the purge fire only on positive evidence.

Verified on-device 2026-07-09 (issue #63); confirmed still unfixed on main as of 2026-07-13 (commits 41abd6f/0d9ec24 addressed expired-record storage, not reinstall).

---

## Requirements

Detection and purge:
- R1. After app delete → reinstall → app launched at least once, the Safari extension purges its stale entitlement record on its next entitlement pull: Pro rows re-lock (explicit `entitled:false` write), YouTube free tier unaffected.
- R2. An absent, unreadable, or malformed install id NEVER triggers a purge (offline/AE6 preservation): native host unreachable, App Group unprovisioned, or an old app build that doesn't write the marker all resolve to a no-op.
- R3. Upgrade adoption: an existing 1.0 install upgrading to this fix (extension has an entitlement record but no last-seen id) adopts the current id WITHOUT purging — no existing entitled user is relocked by the upgrade itself.
- R4. Ordinary app relaunches and app-store updates never regenerate the id (read-before-write idempotency) — a regenerating marker would purge Pro on every app open, the inverse of this fix.

State scope:
- R5. The purge touches only user-scoped entitlement state (`still:entitlement`); the user's service toggle settings (`still:settings`) are preserved. The last-seen-id key itself is written, not purged, by the purge path.

Concurrency and contract:
- R6. Concurrent entitlement pulls (cold start + reconcile nudges from multiple tab loads) cannot let a stale late-resolving reply overwrite a newer purge/apply: pulls are single-flighted.
- R7. The `getEntitlement` reply becomes a three-state envelope that carries the install id even when no entitlement record exists. The Safari extension is the reply's only live consumer (verified: `packages/core/src/native/bridge.ts` never sends `getEntitlement` and discards `setEntitlement`'s reply unparsed; `WebBridgeRouter.swift`'s `getEntitlement` case is a code-present but currently unreachable route). Re-confirm that at implementation time; no WKWebView-side change is expected.

Verification:
- R8. Both sides are test-covered (StillKit XCTest + vitest). StillKit tests have NO CI gate — the PR must record a local `swift test` run (and an iOS simulator build) before merge.

---

## Key Technical Decisions

- **Install-generation marker over first-launch `entitled:false`**: chosen (owner-confirmed). The marker mirrors the proven identity-switch purge pattern and is robust to sessions surviving reinstall in the keychain; the first-launch-false alternative can misfire on that path.
- **No new bridge message kind** (ADR-0001): the app writes the marker directly into App-Group `UserDefaults` — no wire message is needed to write it. The extension receives it as an **additive field on the existing `getEntitlement` reply**, keeping the hand-routed kind count flat.
- **Reply envelope replaces the empty-string signal**: today `EntitlementBridge.handle(.get)` returns `""` when nothing is stored, and TS `parseNativeEntitlement` maps `""` → `null`. Post-reinstall the App Group holds a marker but no entitlement record, so `""` can no longer mean "nothing." New envelope, all fields always present: `{"installId": string|null, "entitled": bool|null, "updatedAt": number|null}`. `EntitlementRecord` (the stored shape) is unchanged; the envelope is a distinct reply type. Two locked tests change deliberately: `EntitlementBridgeTests.testGetAgainstEmptyStoreRepliesEmpty` and the "empty reply" case in `entitlement-pull.test.ts`. ⚠️ Swift's synthesized `Codable` uses `encodeIfPresent` and DROPS nil keys (empirically verified) — the envelope requires a hand-written `encode(to:)` using `container.encode(_:forKey:)` for all three fields so nil serializes as explicit JSON `null`, plus a literal JSON-string test asserting all three keys appear in the empty-store reply.
- **Explicit comparison outcome, not string equality inline**: a small pure function maps `(storedId, replyId)` → `"same" | "changed" | "adopt" | "unknown"`. Only `"changed"` purges. `"adopt"` (no stored id, reply has one) stores the id without purging — the upgrade path. `"unknown"` (reply id null/malformed) is a strict no-op. Mirrors the structured-outcome-over-string learning (docs/solutions/design-patterns/structured-outcome-over-cross-language-string.md).
- **Marker read injected as a closure into `EntitlementBridge`** (like the existing `now`): keeps the bridge pure and `InMemoryBacking`-testable; a hardcoded `UserDefaults` read would break the whole existing test file's seam.
- **Purge mirrors `clearUserScopedState`** (packages/core/src/sync/extension-session.ts): explicit `entitled:false` + `updatedAt: now()` write (never key deletion — storage subscribers only fire on value changes), swallow-and-continue per step. Scope verified by grep: ext-safari's only user-scoped key is `still:entitlement` (Safari is purchase-free by construction — no checkout/OTP/nudge state exists there).
- **Single-flight pulls**: `pullEntitlementFromApp` gains an in-flight-promise-reuse guard — concurrent callers share the in-flight pull's promise (module-level `Promise | null` slot, cleared in `finally`), mirroring `refreshRuleSetCache` in packages/core/src/rules/loader.ts. NOT `nudgeInFlight` (that is throttle-and-drop, a different idiom — a dropped second caller would violate R6's "second awaits the first" contract). No sequence counter needed once pulls can't overlap.
- **Accepted limitation (documented, not fixed)**: a user who reinstalls but never launches the app — or who reinstalled before upgrading to this version — keeps stale Pro until the 30-day TTL, repeatably. Bounded exactly as today; closing it fully would require the extension to expire grants without any native signal, which would break the offline design. Record in the PR description and the issue close-out.
- **Degraded App Group = fix silently inactive**: when `UserDefaults(suiteName:)` fails, app and extension fall back to process-local defaults, the extension reads "no id," outcome `"unknown"`, no purge loop and no fix — consistent with the existing degradation of settings/onboarding on the same path.

---

## High-Level Technical Design

```mermaid
sequenceDiagram
    participant App as App (ViewController)
    participant AG as App Group (UserDefaults)
    participant Ext as Safari ext background
    participant Store as browser.storage.local

    Note over Store: pre-reinstall leftovers:<br/>still:entitlement {entitled:true}<br/>still:installGeneration "A" (new)
    Note over AG: app deleted → App Group EMPTY
    App->>AG: launch: ensure installGeneration (absent → write "B")
    Ext->>AG: getEntitlement (cold start / nudge, single-flight)
    AG-->>Ext: envelope {installId:"B", entitled:null, updatedAt:null}
    Ext->>Ext: compare stored "A" vs "B" → "changed"
    Ext->>Store: purge: still:entitlement ← {entitled:false, now}
    Ext->>Store: still:installGeneration ← "B"
    Note over Ext: later, app reconciles & writes entitled:true to AG;<br/>next pull re-applies it (self-healing flicker, R1-correct)
```

Outcome decision (pure function, TS):

| stored id | reply id | outcome | action |
|---|---|---|---|
| any | null / malformed | unknown | no-op (AE6 preserved) |
| null | "B" | adopt | store "B", no purge |
| "B" | "B" | same | no-op |
| "A" | "B" | changed | purge entitlement, store "B" |

---

## Implementation Units

### U1. StillKit install-generation marker helper

- **Goal**: A pure, tested Swift helper that idempotently ensures an install-generation id exists in App-Group `UserDefaults`.
- **Requirements**: R4 (and enables R1).
- **Dependencies**: none.
- **Files**: `apps/apple/StillKit/Sources/StillKit/InstallGeneration.swift` (new), `apps/apple/StillKit/Tests/StillKitTests/InstallGenerationTests.swift` (new).
- **Approach**: Mirror `OnboardingGate` (StillKit/Sources/StillKit/Onboarding.swift): an enum with pure functions over an injected `UserDefaults`, versioned key (e.g. `"still.installGeneration.v1"`), `ensure(_ defaults:) -> String` that returns the existing value or generates a UUID and writes it — read-before-write is the load-bearing behavior. Also a `current(_ defaults:) -> String?` read for the bridge closure. ⚠️ Unlike OnboardingGate's key, this key must NEVER be bumped as a soft reset — a bump makes every device look freshly reinstalled and would mass-relock Pro across the install base; any future format change must migrate the old key's value forward. Record this in the code comment and the CONTEXT.md entry (U6).
- **Execution note**: Write the idempotency test first — a regenerating marker is the highest-blast-radius regression possible in this plan (it would purge Pro on every app relaunch).
- **Patterns to follow**: `OnboardingGate.shouldShow`/`markComplete` (existing-value guard, `appGroupDefaults` graceful degrade), StillKit fixed-clock/in-memory test style.
- **Test scenarios**:
  - First `ensure` on empty defaults generates a non-empty id and persists it.
  - Second `ensure` returns the identical id and does not rewrite (idempotency across calls — R4).
  - `current` returns nil on empty defaults, the id after `ensure`.
  - Ids are unique across separate suites (two fresh defaults → different ids).
- **Verification**: `swift test` green locally (no CI gate — record in PR).

### U2. EntitlementBridge reply envelope with install id

- **Goal**: `getEntitlement` replies always carry the install id, including when no entitlement record exists.
- **Requirements**: R7 (and enables R1/R2).
- **Dependencies**: U1.
- **Files**: `apps/apple/StillKit/Sources/StillKit/EntitlementBridge.swift`, `apps/apple/StillKit/Tests/StillKitTests/EntitlementBridgeTests.swift`.
- **Approach**: New `EntitlementReplyEnvelope` (`installId: String?`, `entitled: Bool?`, `updatedAt: Int?`) with a HAND-WRITTEN `encode(to:)` using `container.encode(_:forKey:)` for all three fields — synthesized Codable would `encodeIfPresent` and drop nil keys, violating the all-keys-present contract. `EntitlementBridge.init` gains `installId: () -> String?` (default: `InstallGeneration.current` over the app-group defaults), injected like `now`. `.get` returns the envelope built from `store.peek()` + `installId()`; `.set` keeps its storage semantics and returns the same envelope shape so both replies parse one way. `EntitlementRecord` (stored shape) unchanged. `SafariWebExtensionHandler` needs no change (it routes raw JSON through).
- **Patterns to follow**: existing `now` injection; `EntitlementBridgeTests` in-memory factory.
- **Test scenarios**:
  - Empty store: `.get` returns envelope with `installId` set, `entitled`/`updatedAt` null (replaces `testGetAgainstEmptyStoreRepliesEmpty` — deliberate contract change). Assert the LITERAL JSON string contains all three keys (`"entitled":null` etc.), not just round-trip decoding — an `encodeIfPresent` regression must fail `swift test` directly.
  - Stored record: `.get` returns all three fields populated.
  - `installId` closure returning nil (degraded App Group): envelope carries `installId: null`; entitlement fields still correct.
  - `.set` stores the record and replies with the envelope including `installId`.
  - Non-entitlement messages still fall through (`handle(rawBody:)` returns nil) — settings lane unaffected.
- **Verification**: `swift test` green. WKWebView-side compatibility is a re-confirmation, not a change: `packages/core/src/native/bridge.ts` never sends `getEntitlement`, and `setEntitlement`'s reply is discarded unparsed (no caller reads it) — verified during planning. Re-confirm at implementation time by checking `setEntitlement`'s current callers; no WKWebView-side code change is expected (mirror-fixes convention satisfied by the check itself).

### U3. App writes the marker on launch

- **Goal**: Every app launch (iOS + macOS) ensures the install-generation id exists in the App Group before the extension can pull.
- **Requirements**: R1, R4.
- **Dependencies**: U1.
- **Files**: `apps/apple/Still/Shared (App)/ViewController.swift`.
- **Approach**: One `InstallGeneration.ensure(...)` call in `viewDidLoad` (shared file covers both OS targets via existing `#if os` structure), using the same app-group-defaults accessor pattern as `OnboardingGate`. No UI, no ordering dependency on the WKWebView load — the marker write is synchronous and earlier than any reconcile.
- **Patterns to follow**: `OnboardingPresenter.presentIfNeeded` wiring style (small, single call from the lifecycle hook).
- **Test scenarios**: Test expectation: none in the app target (untestable lifecycle glue by repo convention) — the behavior is covered by U1's unit tests; on-device verification covers the integration (see Verification below).
- **Verification**: iOS simulator build succeeds; manual on-device step in the PR checklist.

### U4. TS envelope parse + outcome + purge

- **Goal**: The extension decodes the envelope, resolves the install-generation outcome, and purges stale entitlement state only on `"changed"`.
- **Requirements**: R1, R2, R3, R5, R7.
- **Dependencies**: U2 (envelope shape agreed; TS can land in the same PR).
- **Files**: `packages/ext-safari/lib/entitlement-pull.ts`, `packages/ext-safari/lib/__tests__/entitlement-pull.test.ts`.
- **Approach**: Replace `parseNativeEntitlement` with an envelope parser returning `{ record: NativeEntitlementRecord | null, installId: string | null }` (malformed/`""`/missing → both null — old-app-build compatibility). Add pure `resolveInstallGeneration(storedId, replyId)` returning the four-way outcome union. Add `applyInstallGeneration(outcome, deps)`: `"changed"` → explicit `entitled:false, updatedAt: now()` through the existing sink, then store the new id under a new extension-storage key (e.g. `still:installGeneration`); `"adopt"` → store id only; `"same"`/`"unknown"` → no-op. Each purge step wrapped swallow-and-continue (mirror `clearUserScopedState`'s `attempt`). The generation check runs BEFORE `applyNativeEntitlement` so a stale `entitled:true` in the same reply cannot land after the purge decision — order within one pull: resolve outcome → purge/adopt → then apply the reply's entitlement record (post-purge, the reply's record is null on the reinstall path anyway).
- **Patterns to follow**: existing `entitlement-pull.ts` injected-deps style (`EntitlementSink`, `now`), `entitlement-pull.test.ts` table structure, structured-outcome learning.
- **Test scenarios**:
  - Envelope parsing: legacy `""` → both null; marker-only envelope → record null + id present; full envelope → both present; malformed JSON / missing keys → both null.
  - Outcome table (all four rows of the HTD matrix, exactly).
  - `"changed"` purge writes explicit `entitled:false` with fresh `updatedAt` (never deletes the key) and stores the new id; settings key untouched (assert sink/storage interactions only — R5).
  - `"adopt"` stores the id and does NOT write to the entitlement sink (R3 — upgrade cannot relock an entitled user).
  - `"unknown"` twice in a row: nothing written (R2).
  - Sequence test (reinstall flow): stored id "A" + reply {id "B", record null} → purge; next pull reply {id "B", record entitled:true fresh} → entitlement re-applies (the self-healing flicker lands in the right end state).
  - Combined single-reply case (the scenario the marker approach was chosen for — keychain session survived reinstall, app reconciled before the extension's first pull): stored id "A" + ONE reply {id "B", record entitled:true, fresh updatedAt} → outcome "changed" → purge write (`entitled:false`) followed immediately by apply write (`entitled:true`) — assert the write ORDER on a mock sink and the final state entitled:true. Guards against a future short-circuit that skips apply on "changed".
  - TTL interaction: `"changed"` purge followed by a reply carrying an EXPIRED `entitled:true` → still rejected by the existing staleness predicate.
- **Verification**: vitest green; typecheck green.

### U5. Background wiring + single-flight pulls

- **Goal**: The background entrypoint uses the new pull pipeline, and overlapping pulls cannot interleave writes.
- **Requirements**: R6.
- **Dependencies**: U4.
- **Files**: `packages/ext-safari/entrypoints/background.ts`, `packages/ext-safari/lib/entitlement-pull.ts` (single-flight lives in the lib for testability), `packages/ext-safari/lib/__tests__/entitlement-pull.test.ts`.
- **Approach**: Wrap the pull path in a single-flight guard exposed from the lib so `background.ts` stays thin wiring: cold-start call + `{kind:"reconcile"}` nudge call both route through it. Mirror `refreshRuleSetCache` (packages/core/src/rules/loader.ts): callers arriving while a pull is in flight share ITS promise (module/closure-level `Promise | null` slot, cleared in `finally`) — do NOT copy `nudgeInFlight`'s boolean-flag-and-early-return shape, which silently drops the second caller instead of awaiting the first.
- **Test scenarios**:
  - Two concurrent pull invocations result in exactly one native round-trip and one write pass (second awaits the first).
  - A pull issued after the first completes performs a fresh round-trip.
  - Covers the race: a purge-carrying pull and a stale-apply pull cannot interleave (asserted via call-order on a mock sink).
- **Verification**: vitest green; `pnpm build` green (WXT bundles both entrypoints).

### U6. Docs, glossary, and close-out

- **Goal**: The new concept and its accepted limitation are discoverable; verification steps recorded.
- **Requirements**: R8.
- **Dependencies**: U1–U5.
- **Files**: `CONTEXT.md`, PR description (not a repo file), issue #63 close-out comment.
- **Approach**: Add a terse `CONTEXT.md` glossary entry for **Install generation** (the marker, who writes it, what changing it means, the never-purge-on-absence rule, the never-bump-the-key rule, and that a null/absent `entitled` in the reply envelope must never be read as entitled — it gates a paid feature). PR description records: local `swift test` output, iOS simulator build, the accepted limitation (reinstall-without-launch keeps stale Pro ≤ TTL), and the on-device verification checklist from the issue (delete entitled app → reinstall → don't sign in → after one app launch IG/FB/TikTok unlock... must NOT be blocked; YouTube Shorts still blocked; then sign-in restores Pro).
- **Test scenarios**: Test expectation: none — documentation unit.
- **Verification**: design-contract tests still pass (docs changes don't affect them); `pnpm lint` clean.

---

## Scope Boundaries

- **In scope**: Safari/Apple lane only (StillKit, ext-safari, shared ViewController); the reply-envelope contract change with its WKWebView-consumer compatibility check.
- **Out of scope (verified non-issues)**: Chromium/Firefox lane — grep-confirmed zero App-Group/native coupling; a browser-profile reinstall wipes `chrome.storage.local` atomically, so the bug cannot occur there. The 30-day TTL design itself. Settings lane (`still:settings`, LWW reconcile) — architecturally distinct, untouched.
- **Deferred to follow-up work**: any push-driven extension wake on app launch (would shrink the purge latency from "next tab load" to "immediate"); telemetry/diagnostics for degraded App Group provisioning.
- **Accepted limitation**: reinstall-without-app-launch (or reinstall before upgrading to this version) keeps stale Pro up to the TTL — bounded exactly as today's behavior; documented in the PR and issue close-out.

## Risks & Dependencies

- **Contract-change blast radius**: the envelope replaces a `""` reply that two test suites lock. The Safari extension is the only live consumer (the WKWebView web app never sends `getEntitlement`; `WebBridgeRouter.swift`'s route is code-present but unreachable, and `setEntitlement`'s reply — which also changes shape — is discarded unparsed). Mitigation: U2 re-confirms the no-JS-consumer fact at implementation time; the hand-written encoder keeps all keys present so any future decoder stays total.
- **Marker regeneration** (R4): guarded by U1's execution note (idempotency test first).
- **No Swift CI gate**: `swift test` and the simulator build are local-only gates — the PR checklist must show them run; reviewers should treat a missing record as blocking.
- **1.0 in store review**: this ships as 1.0.1; nothing here changes the 1.0 artifacts. The old app build + new extension build cannot co-occur (they ship in one bundle), so mixed-version handling reduces to the "old reply shape" case already covered by the parser's malformed/legacy handling.
