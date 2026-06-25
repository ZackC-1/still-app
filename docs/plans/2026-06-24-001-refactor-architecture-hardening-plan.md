---
status: active
type: refactor
created: 2026-06-24
reviewed: 2026-06-24
---

# refactor: Architecture hardening — fetch caps, sync error-surfacing, hydration test, shared validation, reconcile tests, engine dedup

> Revised after a 5-persona `ce-doc-review` (coherence, feasibility, security, scope, adversarial).
> Key corrections baked in: U4 dedups **two** real sites (not three — `native/bridge.ts` parses a
> different shape); U2 is reframed as efficiency + error-surfacing (the backend is `updatedAt`-LWW) and
> now wires the failure flag to the UI; U1 drops its unbounded fallback and adds Content-Encoding +
> byte-cap + decoder hardening; U3 is now test-only (the original flag was dead state); U5 uses a
> value-based echo guard with concurrency tests and stays inside `ext-safari`.

## Summary

Six bounded, CI-verifiable fixes from an architecture review. TypeScript-only (no Swift, no Deno
function behavior change). Three close real correctness/security/efficiency gaps (rule-set fetch memory
cap, cloud write-through error-surfacing, content-script hydration-boundary coverage); three are
cleanliness/testability wins (one shared TS settings validator, a tested App-Group reconciler with a
timing-independent echo guard, a shared rule-engine service resolver). Must keep the workspace gate
(lint · typecheck · vitest · build) and the Deno functions gate green. Shipped as one PR; each unit is
an atomic commit.

---

## Problem Frame

An Explore pass found 12 friction points; 6 were judged genuine. Review sharpened the framing:

- **Security/efficiency (U1):** `fetchCurrentRuleSet` checks `maxBytes` *after* `await res.text()`
  buffers the entire body — so the cap asserts, it doesn't bound memory. The endpoint is first-party and
  the body is signature-verified, so this is **defense-in-depth against pre-verification buffering** of a
  broken/oversized (or hostile-MITM) response, not the primary control. The current cap is also
  `text.length` (UTF-16 code units), not bytes, and nothing guards against a compressed
  (`Content-Encoding`) expansion bomb.
- **Data integrity (U2):** `SyncService` write-through is fire-and-forget (`void writeProfile`). The
  backend is `updatedAt`-LWW (a stale write loses at the backend), so the real defect is **the swallowed
  rejection** (silent failure, no UI signal) plus redundant concurrent writes. Coalescing is an
  efficiency win; surfacing the failure is the correctness win.
- **Correctness coverage (U3):** the content script installs hooks before `cache.hydrate()` resolves; a
  reapply in that window is a silent no-op. **The unconditional post-hydrate `reapply()` already
  redirects an early navigation after hydration** — so the redirect is correct (just deferred to
  hydration; an inherent flash window). The gap is that this hydration-boundary behavior is **untested**.
- **Cleanliness/security (U4):** the StillSettings shape guard is duplicated in **two** TS modules
  (`wkwebview-adapter.ts`, `ext-safari/background.ts`); the bare `safeParse` JSON helper is duplicated in
  **three** (those two plus `native/bridge.ts`). `native/bridge.ts`'s `asObject` parses
  credential/purchase replies — a different shape — and must NOT be routed through the settings guard.
- **Testability/correctness (U5):** the Safari App-Group reconcile + `applyingFromApp` echo guard (the
  sole defense against a push/apply echo loop that double-fires the entitlement webhook) is untested, and
  the guard is a transient boolean shared across concurrent `reconcile()` calls (cold-start + per-nudge),
  so it can fail under interleaving.
- **Cleanliness (U6):** `evaluate()` and `applyDom()` independently resolve + validate the active
  service; the contract should live in one place.

---

## Scope Boundaries

**In scope (this PR):** the six fixes as U1–U6, TypeScript only, one PR of atomic commits.

**Deferred to Follow-Up Work (noted by review, not done here):**
- *Shrinking the pre-hydration flash window itself* (CSS hide-gate before hydration) — a larger UX change
  than U3's test-coverage scope; the redirect is already correct, only delayed.
- *Sharing the bare `safeParse` into `native/bridge.ts`* beyond the JSON helper — bridge replies are a
  different shape; only the JSON-parse utility is genuinely shared (U4 covers that).

**Not addressed (from the review, with reasons):** bridge message envelope unify (clean protocol);
StorageAdapter "shallow" (earns its keep as the test seam); observer scheduler perf-testing
(observability, not a bug); per-mount extension cache hydration (works via shared storage).

**Out of scope (cross-language):** the Swift `SettingsBridge.parse` mirrors the TS shape guard but can't
share TS; `StillKitTests/SettingsTests` already assert parity. No Swift files change (Swift isn't in CI).

---

## Key Technical Decisions

- **KTD1 — Stream + cap; reject compressed; no unbounded fallback.** (a) If `Content-Length` exceeds
  `maxBytes`, abort and return null. (b) If `Content-Encoding` is present (gzip/br/zstd), reject — the
  first-party RPC needn't compress a ≤256 KB JSON body, and decompression can expand past the cap. (c)
  Read the body via `res.body.getReader()`, decode chunks with `TextDecoder(..., { stream: true })`
  (final flush with `decode()`), tracking **byte** length; abort once bytes exceed `maxBytes`. (d) **No
  `res.text()` fallback** — if `res.body` is absent, treat as a fetch failure (return null) so the cap is
  always a real memory bound. The cap is now bytes, not UTF-16 units; boundary tests are re-derived.
  `FetchConfig` and the `SignedRuleSet | null` contract are unchanged; the signature-verify path runs on
  the reassembled text exactly as before.
- **KTD2 — Coalesce writes (efficiency) + surface failure to the UI (correctness).** `SyncService` keeps
  one in-flight `writeProfile` and one pending "latest" (overwrite, latest-wins, matching `updatedAt`-LWW);
  flush pending when the in-flight settles. On a **rejected** write, set `cloudReachable: false` on
  `SyncState` (new field, default true) and emit via `onState`; on a later success, set it true. Pending
  is cleared on reject, but the `SettingsCache` always retains the latest settings, so the next local edit
  or sign-in reconcile re-pushes the current value — no permanent loss, and the UI shows the existing
  `cloud-unreachable` state meanwhile. **The entrypoint must forward the flag** (`controller.cloudReachable
  = state.cloudReachable`) — without that wiring the fix is invisible.
- **KTD3 — Lock the hydration-boundary behavior with a test; no new state.** The existing unconditional
  post-hydrate `reapply()` already redirects an early navigation once hydration completes. U3 adds a
  regression test that proves it across a controllable `hydrate()` boundary. No `pendingReapply` flag (it
  would be dead state — the post-hydrate reapply already covers every pre-hydration call).
- **KTD4 — One shared validator for the two real shape-guard sites; share `safeParse` for the JSON
  helper.** Extract `parseSettings(value): StillSettings | null` and `safeParse` into one core module.
  `wkwebview-adapter.ts` uses `parseSettings` directly; `ext-safari/background.ts` keeps its
  `{ settings: "<json>" }` envelope unwrap and calls the shared `parseSettings` on the inner value;
  `native/bridge.ts` imports only the shared `safeParse` and keeps its own `asObject` (credential/purchase
  shapes — NOT settings). The validator is the single hardening point.
- **KTD5 — Value-based echo guard, tested in `ext-safari`.** Extract the reconcile + echo-guard into a
  testable module **inside `ext-safari`** (add a vitest runner to that package; keep Safari-specific logic
  out of shared `core`). Replace the transient `applyingFromApp` boolean with a timing-independent guard:
  suppress a push whose `updatedAt` equals the value just applied (matches the LWW model, immune to the
  sync-vs-async notify timing difference between `InMemoryStorageAdapter` and `chrome.storage.onChanged`,
  and to concurrent `reconcile()` interleaving). Deps (`pullFromApp`, `pushToApp`, the adapter) are
  injected.
- **KTD6 — One exported service resolver in the engine.** Export
  `resolveActiveService(ruleSet, settings, url): Service | null`; `evaluate()` and `applyDom()` both call
  it and map null to their own early-return shape. A direct parity test asserts both agree.

---

## Implementation Units

### U1. Bound rule-set fetch memory (stream + Content-Length + reject compressed)

**Goal:** Make `maxBytes` a true memory bound and close the pre-verification buffering path.
**Behavior change:** yes (byte cap vs char cap; compressed responses now rejected; no `text()` fallback).
**Dependencies:** none.
**Files:** `packages/core/src/rules/fetch.ts`, `packages/core/src/rules/__tests__/fetch.test.ts`.
**Approach:** Per KTD1: Content-Length early-reject → Content-Encoding reject → streamed read with
`TextDecoder({ stream: true })` and a running byte counter → abort the existing `AbortController` and
return null on over-cap (the timeout uses the same controller; keep clearing the timer in `finally`). No
`res.text()` fallback. Decode-then-`JSON.parse`-then-`validateRuleSet`/`verifyRuleSet` exactly as today.
Author a new fake-`Response` builder for tests (the existing `okFetch` sets no headers and no spyable
reader); the existing oversize test shifts to the stream path and stays green.
**Patterns to follow:** existing `fetch.ts` AbortController/`fetchImpl` seam; `fetch.test.ts` fakes.
**Test scenarios:**
- Happy path: small valid signed rule-set under the cap parses + verifies (existing tests green, now via
  the stream path).
- Edge: `Content-Length` over `maxBytes` → null, reader never created/consumed (assert).
- Edge: no `Content-Length`, streamed body exceeds cap mid-stream → null and the controller was aborted.
- Edge (security): response carries `Content-Encoding: gzip` → null (rejected before reading).
- Edge (decoder integrity): a valid signed body split across chunks at a multibyte-character boundary →
  reassembles correctly and `verifyRuleSet` returns ok; a tampered chunk → verify fails. Covers the
  TextDecoder-stream correctness.
- Edge: body exactly at `maxBytes` (bytes) → accepted (boundary inclusive).
- Error: `res.body` absent / `fetchImpl` rejects / non-200 → null (no unbounded read).
**Verification:** `fetch.test.ts` green incl. the new oversize/compressed/multibyte cases; no code path
buffers an unbounded body.

### U2. Surface SyncService write failures + coalesce writes

**Goal:** No silently-swallowed write failures; fewer redundant concurrent writes; the UI reflects an
unreachable cloud.
**Behavior change:** yes (N edits → as few as 2 writes; a rejected write now flips `cloudReachable`).
**Dependencies:** none.
**Files:** `packages/core/src/sync/service.ts`, `packages/core/src/sync/__tests__/sync.test.ts`,
`packages/app-webview/src/main.ts` (forward the flag to the controller).
**Approach:** Per KTD2. In `startWriteThrough`, replace `void writeProfile(settings)` with a coalescing
writer: one in-flight write; while in flight, keep only the latest as `pendingWrite`; on settle, flush
pending. Add `cloudReachable: boolean` (default true) to `SyncState`; set false on rejection (emit via
`onState`), true on a later success. In `main.ts`, extend the `onState` callback to
`controller.cloudReachable = state.cloudReachable`. Preserve the entitled+signed-in gate and
`stopWriteThrough`.
**Patterns to follow:** existing `SyncService` `setState`/`onState`; `sync.test.ts` controllable-promise
mock `BackendPort`; existing `controller.cloudReachable`/`cloud-unreachable` state.
**Test scenarios:**
- Happy path: one edit while entitled → exactly one `writeProfile` with that value.
- Edge (coalesce): three rapid edits during one slow in-flight write → write #1 = edit #1, then exactly
  one follow-up = latest (#3); #2 not written (assert count + args).
- Edge (latest reaches backend): the final edit always reaches `writeProfile` (assert final value).
- Error (surface): `writeProfile` rejects → `cloudReachable` emits false; a later success emits true.
- Error (reject + pending): in-flight rejects with a pending edit queued → `cloudReachable` false, no
  unhandled rejection; a subsequent edit re-pushes the current cache value (no permanent loss).
- Edge: not entitled / signed out → no writes.
**Verification:** `sync.test.ts` green; an existing call-count assertion (if any) is intentionally updated
for coalescing; `main.ts` forwards `cloudReachable` (typecheck + the wiring is present).

### U3. Lock the content-script hydration-boundary redirect (test-only)

**Goal:** Prove an early navigation is redirected once hydration completes — the race is correct but was
untested.
**Behavior change:** no (test-only; no production code change unless a real gap surfaces).
**Dependencies:** none.
**Files:** `packages/core/src/content/__tests__/hydration.test.ts` (new) or extend `redirect.test.ts`.
Touch `packages/core/src/content/index.ts` ONLY if a concrete gap is found (do not add the dead
`pendingReapply` flag).
**Approach:** Per KTD3. Drive `start()` with a deferred `cache.hydrate()` promise; fire a navigation
(and an observer/subscribe-driven reapply) before it resolves; assert no redirect during the window and
exactly one redirect after `hydrate()` resolves (the unconditional post-hydrate `reapply()` at the end of
`start()`). Assert multiple pre-hydration triggers collapse to one post-hydration reapply. If — and only
if — the test exposes a real dropped-flush in the observer's rAF coalescing, fix that specific path;
otherwise this is coverage that locks existing behavior.
**Patterns to follow:** `redirect.test.ts` fake-window/navigation + `InMemoryStorageAdapter` +
deferred-hydrate style.
**Test scenarios:**
- Edge (the race): a reapply fired before `hydrate()` resolves → no redirect in the window, exactly one
  after resolution (assert ordering with a controllable hydrate promise).
- Edge: multiple pre-hydration triggers → a single post-hydration redirect (no storm, no double-apply).
- Happy path: navigation after hydration → immediate redirect (unchanged).
**Verification:** new test green; if `index.ts` is untouched, the suite proves the existing behavior; the
plan no longer adds dead state.

### U4. Shared TS settings validator (two shape-guard sites) + shared `safeParse`

**Goal:** One place to validate the StillSettings shape and parse JSON defensively, without conflating
the native bridge's credential parsing.
**Behavior change:** no (identical accept/reject; pure dedup).
**Dependencies:** none.
**Files:** new `packages/core/src/storage/settings-validation.ts`; update
`packages/core/src/storage/index.ts` (export), `packages/core/src/storage/wkwebview-adapter.ts`,
`packages/ext-safari/entrypoints/background.ts` (keep its envelope unwrap; call shared `parseSettings` on
the inner value), `packages/core/src/native/bridge.ts` (import shared `safeParse` ONLY; keep `asObject`);
new `packages/core/src/storage/__tests__/settings-validation.test.ts`.
**Approach:** Per KTD4. Move the shape predicate + `parseSettings` + `safeParse` into the new module;
re-export from `@still/core/storage`. `wkwebview-adapter` uses `parseSettings`; `background` unwraps
`reply.settings` then calls `parseSettings`; `bridge.ts` swaps its local `safeParse` for the shared one
and leaves `asObject` untouched. Byte-for-byte same predicate so existing adapter/bridge/background
behavior is unchanged. Comment that Swift `SettingsBridge.parse` mirrors this (parity-tested in StillKit).
**Patterns to follow:** existing `parseSettings`/`safeParse` in `wkwebview-adapter.ts`;
`wkwebview-adapter.test.ts` and `native/bridge.test.ts` cases.
**Test scenarios:**
- Happy path: a valid object and its JSON string both parse to the same `StillSettings`.
- Edge: bad fields (`globalOn` not boolean, `updatedAt` not number, no `services`) → null.
- Edge: empty/null/non-object → null; malformed JSON → null (`safeParse`).
- Integration (no drift): `wkwebview-adapter.test.ts`, `native/bridge.test.ts` stay green — crucially the
  bridge's `signInWithApple`/`purchase`/`restore`/`purchaseStatus` reply parsing is unaffected (still
  `asObject`, not the settings guard).
- Integration: `parseNativeSettings`-style call (envelope `{ settings: validJson }`) still returns a
  valid `StillSettings` after delegating the inner parse.
**Verification:** new validator tests green; three call sites updated correctly; full core + ext-safari
typecheck/test green with no behavior drift (esp. native bridge non-settings replies).

### U5. Tested App-Group reconciler with a value-based echo guard

**Goal:** Make the Safari reconcile + echo guard tested and timing-independent.
**Behavior change:** the guard mechanism changes (boolean → `updatedAt`-value compare); observable
reconcile outcomes are preserved and now tested under concurrency.
**Dependencies:** U4 (the reconciler parses native payloads via the shared `parseSettings`).
**Files:** new `packages/ext-safari/lib/app-group-reconcile.ts`; new `packages/ext-safari/vitest.config.*`
+ `package.json` `test` script (so CI's `pnpm -r test` runs it); new
`packages/ext-safari/lib/__tests__/app-group-reconcile.test.ts`; update
`packages/ext-safari/entrypoints/background.ts` to use the module.
**Approach:** Per KTD5. Extract a reconciler taking injected deps (`pullFromApp`, `pushToApp`, and the
local adapter `get`/`set`/`subscribe`). Replace the transient `applyingFromApp` boolean with a
value-based guard: when applying an app value, remember its `updatedAt`; the push subscription suppresses
a push whose `updatedAt` equals the last-applied one. This is immune to (a) sync vs async notify timing
(`InMemoryStorageAdapter` fires inside `set`; `chrome.storage.onChanged` fires later) and (b) concurrent
`reconcile()` interleaving. ext-safari wires `browser.runtime.sendNativeMessage`-backed deps. Keep the
Safari-only logic in `ext-safari` (not `core`).
**Patterns to follow:** current `background.ts` reconcile flow; `core` `sync.test.ts` mock-store style;
`InMemoryStorageAdapter` for the local side; add a deferred/microtask emit helper for async-delivery
tests.
**Test scenarios:**
- Happy path (app newer): app `updatedAt` > local → local set to app value once; no resulting push.
- Happy path (local newer): local `updatedAt` >= app → push local; local unchanged.
- Edge (echo guard by value): applying an app value does NOT push it back — assert via BOTH a synchronous
  in-memory emit AND a simulated async (`onChanged`-style, deferred) emit; the value guard suppresses
  both.
- Edge (concurrency): two overlapping `reconcile()` calls (cold-start in flight when a nudge fires a
  second) → no spurious `pushToApp` (the boolean guard would have failed this).
- Edge: app returns null → seed/push local; equal `updatedAt` → no write either way (idempotent).
- Error: `pushToApp` rejects → surfaced, no echo loop, safe to call `reconcile()` again.
**Verification:** new reconcile tests green incl. concurrency + async-delivery; ext-safari builds +
typechecks; `pnpm -r test` runs the new ext-safari suite.

### U6. One exported service resolver shared by `evaluate()` and `applyDom()`

**Goal:** The "resolve → validate active → return service" contract lives in one tested place.
**Behavior change:** no (pure refactor).
**Dependencies:** none.
**Files:** `packages/core/src/rules/engine.ts`, `packages/core/src/rules/__tests__/engine.test.ts`.
**Approach:** Per KTD6. Export `resolveActiveService(ruleSet, settings, url): Service | null` doing
`resolveService` → `isServiceActive` → presence check, returning the validated service object (so both
callers skip the redundant `ruleSet.services[serviceId]` lookup). `evaluate()` maps null → `{kind:"noop"}`,
`applyDom()` maps null → its empty `{hidden, removed}`. Commit to exporting it (not file-private) for a
direct parity test.
**Patterns to follow:** existing `resolveService`/`isServiceActive`; `engine.test.ts` decision matrix.
**Test scenarios:**
- Happy path: an active-service URL resolves to the service for both `evaluate` and `applyDom` (existing
  tests green).
- Edge: unknown host / inactive service / missing entry → both early-return their own empty shape — a
  parity test asserts `evaluate` and `applyDom` agree on validity for the same inputs.
- Unit: `resolveActiveService` returns null for inactive and the service object for active.
**Verification:** `engine.test.ts` green; the exported helper has a direct parity test.

---

## Verification Strategy

Each unit keeps both CI gates green:
- **Workspace gate (covers all the TS this PR touches):** `pnpm -r --if-present lint`, `typecheck`,
  `test` (vitest), `build`. This — not Deno — is what proves shared-type correctness.
- **Deno functions gate:** `deno lint`, `deno check */index.ts`, `deno test`. Run to confirm no function
  regressed (none should — no function files change). The functions don't import `@still/shared-types`,
  so this gate does **not** cover shared-type changes (the workspace gate does).

**Behavior-changing units:** U1 (byte cap, reject compressed), U2 (write coalescing + reachability flag),
U5 (echo-guard mechanism). Their existing call-count/boundary assertions are updated deliberately, not
silently. **Behavior-preserving units:** U3 (test-only), U4 (pure dedup), U6 (pure refactor) — existing
tests stay green unchanged.

Sequencing: U1, U2, U3 are independent (any order). U4 before U5 (U5 uses the shared validator). U6
independent. Atomic commit per unit; one PR to `main` (branch-protected; merge on green CI).

---

## Risks & Mitigations

- **U1 streaming + decoder correctness (security-critical: signature is verified on the reassembled
  text).** Mitigation: `TextDecoder({ stream: true })` per chunk + final flush; a required multibyte-
  chunk-boundary test asserts verify still passes/fails correctly. No `text()` fallback that could
  re-buffer.
- **U2 dropping the final write on reject.** Mitigation: the `SettingsCache` retains the latest, so the
  next edit/reconcile re-pushes; a reject+pending test asserts no unhandled rejection and eventual
  re-push; `cloudReachable` surfaces the state meanwhile.
- **U2 reachability flag invisible without wiring.** Mitigation: `main.ts` is in scope and forwards the
  flag; verified by typecheck + the wiring assertion.
- **U4 breaking native bridge replies.** Mitigation: `native/bridge.ts` keeps `asObject`; only `safeParse`
  is shared; `native/bridge.test.ts` (sign-in/purchase/restore) must stay green.
- **U5 echo guard regressing under real chrome async timing or concurrency.** Mitigation: value-based
  guard (timing-independent) + explicit async-delivery and concurrent-reconcile tests; logic stays in
  `ext-safari`, not `core`.
