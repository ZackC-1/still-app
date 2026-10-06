# Phase 2 — architecture deepening (post-review-sweep)

**Date:** 2026-07-09 · **Branch:** `refactor/phase2-architecture-deepening` · **Objective function:** functional > secure > scalable (in that order); mid-release (iOS in App Review), so bounded changes only.

Produced by an `/improve-codebase-architecture` pass (two exploration agents: core TS; Swift + backend), folding in the four advisories deferred from PR #60's ce-code-review. Vocabulary per the skill: depth = behavior behind a small interface; seam = where an interface lives.

## Requirements

- R1 (functional): remove the dead pause mutators — `UiController.togglePause`/`currentPaused`, `SettingsCache.pauseHost`/`resumeHost`/`isPausedHost`. They are unreachable from any UI, and their writes are silently erased by `parseSettings`' pauses-normalization on the next reparse — a live invisible-write trap for any future caller. Keep the `pauses` type field and `engine.isPaused` as the documented dormant seam (full field removal is deferred: the field is load-bearing in the sync envelope).
- R2 (functional): single-source the DNR gate. `ext-chromium/entrypoints/background.ts` re-derives the engine's service-active predicate inline (`s.globalOn && s.services.youtube && !s.pauses.includes("youtube.com")`) in untested closure wiring. Add a pure, tested `isServiceEnabledGlobally(settings, serviceId)` to the engine; both `isServiceActive` and the background gate call it.
- R3 (functional): a shared teardown-parity contract test run by BOTH session orchestrators (apple-session, extension-session) against injected fakes, pinning the invariants currently guaranteed only by comments: (a) a failed account-delete preserves session + local state; (b) voluntary sign-out purges locally even when the remote call rejects; (c) neither path throws. Test-only; do NOT merge the orchestrators — their differences (App-Group mirror vs record store + browser-scoped purges) are real.
- R4 (secure): land the in-flight CORS/OPTIONS work for the Supabase functions as its own attributed commit (it was uncommitted release-testing work; the wrapper below builds on it), then extract ONE `withAuthenticatedUser(req, auth, body)` wrapper in `_shared/` that owns the OPTIONS → 405 → Bearer-regex → verifyJwt → isUuid preamble copy-pasted across all four handlers (`create-web-checkout`, `delete-user`, `export-user-data`, `reconcile-entitlement`), plus one shared `AuthDeps` shape. Response shapes must not change; each handler keeps its distinctive body. The trust boundary gets tested once instead of four times.
- R5 (secure): replace the one string-built-JS path — `ViewController.pushStoredSettingsToWeb`'s `evaluateJavaScript("…__stillApplyRemote(\(json));")` — with `callAsyncJavaScript(_:arguments:in:contentWorld:)` passing the record as a structured argument in `.page` (API floor iOS 14/macOS 11 clears the 15/11 deployment targets; the handler world is `.page`).
- R6 (scalable): single-flight coalescing in `refreshRuleSetCache` (`core/rules/loader.ts`): N service tabs navigating fire N concurrent `fetchCurrentRuleSet` calls against one cache slot today. Concurrent callers with an equivalent config share one fetch+compare+write; the write-side compare already makes the race benign, so this is fan-out elimination, not a correctness fix.

## Explicitly closed as no-action (do not re-suggest)

- PurchaseManager actor isolation (PR #60 advisory): the class and its only caller (WebBridgeRouter) are **already `@MainActor`**; the spawned `Task {}`s inherit that isolation; converting to `actor` would drop guaranteed main-thread execution for zero gain.
- ViewController's Darwin observe/push glue: framework orchestration per `docs/solutions/architecture-patterns/testable-swift-decision-logic-via-stillkit.md` — the one decision (applied-only notify) already lives tested in StillKit.
- SafariWebExtensionHandler: healthy 57-line thin adapter; its reply shapes genuinely differ from WebBridgeRouter's (ADR-0001 stands).
- Entitlement lane hop count: each hop crosses a real process/language boundary; `entitlementStampExpired` is already single-sourced.
- `PurchaseDecision.identityAfterFailedRekey` extraction: a 3-line branch at the don't-extract-pure-orchestration counter-case.

## Deferred (post-release)

- `CheckoutPendingController` extraction from the 985-line `UiController`: right idea, wrong moment — a reactive Svelte class refactor for pure maintainability during App Review is functional risk with no functional payoff. Revisit after v1 ships, together with the auth-flow sub-machine.
- Full `pauses` field removal from `StillSettings`/envelope/seed (R1 removes only the mutators).

## Implementation Units

### U1. R1 — remove dead pause mutators (+ their tests)
### U2. R2 — `isServiceEnabledGlobally` in the engine + background gate calls it + unit tests
### U3. R3 — shared teardown-parity contract suite (`core/src/sync/__tests__/teardown-parity.test.ts`)
### U4. R4a — land the CORS/OPTIONS preflight work (attributed as in-flight release-testing work)
### U5. R4b — `withAuthenticatedUser` + `AuthDeps` in `_shared/auth.ts`; four handlers rewired; wrapper unit tests; handler tests stay green
### U6. R5 — `callAsyncJavaScript` value bridging (needs the record as a Foundation dictionary — add a `SettingsBridge` accessor or decode the JSON string); unsigned iOS+macOS builds verify
### U7. R6 — module-level single-flight in `refreshRuleSetCache` + concurrency test

One commit per unit. Gates per unit where applicable; full gates (vitest, Deno, StillKit, Xcode unsigned builds, lint, typecheck) before PR.
