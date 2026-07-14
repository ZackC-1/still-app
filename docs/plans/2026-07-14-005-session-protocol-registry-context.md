# Context dossier: popup↔background session protocol registry (deepening candidate 4)

- **Status**: context for planning — no implementation done.
- **Grounded at**: commit `5470713` (main, 2026-07-14). Verify line anchors before editing.
- **Origin**: `/improve-codebase-architecture` review, 2026-07-14. Goal: pre-release hardening.
- **ADR note**: ADR-0001 governs the WKWebView TS↔Swift bridge only. This seam is TS on both
  sides and is NOT covered — but ADR-0001's reasoning is the reference frame (see below).

## The problem

Every session capability crossing the popup↔background seam is hand-restated in **six places**
that must be edited together, with only two of the six type-coupled to each other:

1. `ExtensionSession` interface — `core/src/sync/extension-session.ts:176-204` (13 methods)
2. `SessionRequest` union — `ext-chromium/lib/session-messages.ts:26-43` (11 arms, discriminator `action`)
3. `SessionResponses` map — `session-messages.ts:49-61`
4. `UNAVAILABLE` fail-safe map — `session-messages.ts:69-84`
5. `dispatchSession` switch — `ext-chromium/entrypoints/background.ts:202-238`
6. `extensionPurchaseDeps` closures — `ext-chromium/lib/purchase-wiring.ts:45-96` (+ the
   standalone `restoreHandler`, `:99-118`)

**What's type-coupled today**: only Responses↔UNAVAILABLE (`const UNAVAILABLE: SessionResponses`).
`SessionAction` is derived (`SessionRequest["action"]`), and `send`/`unavailableResponse` are
generic over it — but `SessionResponses` keys are hand-authored (not `Record<SessionAction,…>`),
the dispatch switch has **no `default: never` exhaustiveness guard** (a new union arm compiles
while silently falling through to `undefined`), and the interface/closures are entirely
convention-coupled.

**Zero tests**: grep confirms nothing references `session-messages`, `purchase-wiring`,
`dispatchSession`, `unavailableResponse`, `isSessionRequest`, or `fromExtensionPage` in any
test. `background.ts` is outside the vitest include (`lib/**/*.test.ts`, node env). No mock for
`runtime.sendMessage`/`onMessage` exists anywhere — no message has ever crossed this seam in a
test. ADR-0001's justification for hand-routing ("shape drift is covered by parse-reject tests
on both sides") is exactly what this seam LACKS: `isSessionRequest` checks only
`kind === "still:session"` && `typeof action === "string"` — no action-set validation, no
payload validation, no version field.

## Per-capability matrix (verified)

| Capability | Union arm | Response | UNAVAILABLE | dispatch | interface | wiring closure |
|---|---|---|---|---|---|---|
| getState | ✅ | `ExtensionSessionState` | signed-out snapshot | ✅ | ✅ | `deps.getState` |
| requestCode | ✅ `+email` | `RequestCodeOutcome` | `{kind:"send-failed"}` | ✅ | ✅ | `auth.requestCode` |
| verifyCode | ✅ `+email,token` | `VerifyCodeOutcome` | `{kind:"verify-failed"}` | ✅ | ✅ | `auth.verifyCode` |
| signOut | ✅ | `"signed-out"` | `"signed-out"` | ✅ | ✅ | `auth.signOut` (result discarded) |
| deleteAccount | ✅ | `DeleteAccountSessionOutcome` | `"delete-failed"` | ✅ | ✅ | `auth.deleteAccount` — translates `!=="deleted"` → **throw** (wiring:65) |
| reconcile | ✅ | `SessionReconcileOutcome` | `"unknown"` | ✅ | ✅ | `checkout.reconcile` — translates `signed-out`→`auth-required` (wiring:92) |
| restore | ✅ | `SessionReconcileOutcome` | `"unknown"` | ✅ | ✅ | **NOT in deps** — only standalone `restoreHandler` |
| createCheckout | ✅ | `WebCheckoutOutcome` | `{kind:"unavailable"}` | ✅ | ✅ | `checkout.createCheckout` |
| setPendingOtp | ✅ `+pending\|null` | `"ok"` | `"ok"` | ✅ | ✅ | `persistence.setPendingOtp` (void) |
| setPurchaseIntent | ✅ `+active` | `"ok"` | `"ok"` | ✅ | ✅ | `persistence.setPurchaseIntent` (void) |
| setCheckoutPending | ✅ `+pending\|null` | `"ok"` | `"ok"` | ✅ | ✅ | `checkout.setPending` — **name mismatch** |
| onNudge | — | — | — | — | ✅ | reached by separate `{kind:"reconcile"}` low-privilege message |
| resume | — | — | — | — | ✅ | internal, background start (`bg:121`) |

Asymmetries a registry must handle: `onNudge`/`resume` are interface-only (not popup-reachable);
`restore` is wire-reachable but not a deps closure; setter acks are `"ok"` deliberately
("an undefined response is indistinguishable from an unreachable background" —
session-messages doc `:47-48`); pending-OTP has FOUR near-identical shapes (wire arm, interface
param, `PendingOtpRecord` extension-session `:83-87` with `purchaseIntent?`, controller
`PendingOtp` `controller.svelte.ts:133-136`).

## The restore/reconcile alias (verified)

`extension-session.ts:398-400`: `reconcile: runReconcile, restore: runReconcile` — byte-identical
at the session and background layers. The distinction exists ONLY in UI consumption:
- `checkout.reconcile` closure (wiring:88-93) narrows to `CheckoutReconcileOutcome` (collapses
  `signed-out`→`auth-required` because the controller enum omits `signed-out`,
  `controller.svelte.ts:92-96`); consumed by the checkout poll (`pollReconcile`,
  controller `:646-667`) and popup-open reconcile (`extension-setup.ts:100`).
- `restoreHandler` (wiring:104-118) consumes the raw 5-value outcome and drives
  `setRestoreOutcome`/`reSignInFromCheckout`/`setPurchaseOutcome` — the paywall Restore button
  path (`App.svelte:201-203` → `PaywallSheet.svelte:168`).

Deletion-test verdict: the wire-level action split is interface surface with no implementation
behind it. It can collapse to one action with the two UI affordances differing caller-side —
but note the session interface doc frames `restore` as a deliberate alias (R5, "Web Billing has
no store-side restore"), so an ADR-style note in code should record why one action serves two
buttons.

## Transport + failure semantics (must survive)

- One-shot `runtime.sendMessage`; **no port, no timeout, no retry** in `send`
  (purchase-wiring `:24-39`). `response ?? unavailableResponse(action)` + catch → UNAVAILABLE.
- UNAVAILABLE covers three cases: spine-less build (`createSessionSpine` → null → dispatch
  short-circuits, bg `:206`), torn handler (dispatch catch `:236`), unreachable background /
  undefined response (popup-side). Doc: "everything reads as signed-out / couldn't-do-it …
  never downgrades a cached entitlement (AE6)".
- Update-window behavior (today, undocumented): a NEW action hitting an OLD background passes
  `isSessionRequest`, misses every case, returns `undefined`, popup maps it to
  `unavailableResponse(newAction)` — silent calm degradation. Any registry redesign must keep
  (or consciously replace) this property.
- Two listeners in the background: low-privilege nudge (`bg:74-80`, returns false) and the
  privileged session router (`bg:94-115`) with sender validation
  (`sender.id === chrome.runtime.id && sender.url.startsWith(chrome.runtime.getURL(""))`,
  `:100-105`) — deliberately stronger than a `sender.tab` check so the embedded options page
  passes while content scripts are walled to the nudge (doc `:82-92`). **This security boundary
  has never executed in a test.**

## What the controller expects (the consumer side)

`UiControllerDeps` (`controller.svelte.ts:176-187`): `auth?: UiAuth` (`:112-128`),
`persistence?: AuthPersistence` (`:142-147`), `checkout?: UiCheckout` (`:161-174`),
`host: { canPurchase }`. `extensionPurchaseDeps()` returns undefined when
`extensionSupabaseConfig` is null (spine-less build) → Safari-style no-injection. Mount
snapshot: `purchase.getState()` (`extension-setup.ts:85-107`) rehydrates code-entry +
checkout-pending and fires the popup-open reconcile.

## Existing test coverage (what's safe to lean on)

- `core/src/sync/__tests__/extension-session.test.ts` (615 lines) covers the ENTIRE
  `ExtensionSession` surface including the `restore()` alias (`:324-328`), teardown parity,
  onNudge throttling, resume. The session itself is well-tested — the untested layer is
  everything between the session and the popup (messages, dispatch, wiring, sender check).
- `core/src/ui/__tests__/extension-setup.test.ts` covers the controller wiring with `vi.fn()`
  fakes for the closures — not the real `send`.

## TypeScript machinery available

TS `^6.0.3`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. No
`exactOptionalPropertyTypes`. Precedents: `SessionResponses[A]` indexed generics already in
`send`/`unavailableResponse`; discriminated unions by `kind`/`action` throughout; ONE `satisfies`
in the repo (`strings.ts:43`, `satisfies Record<ServiceId,…>`); **no `assertNever`/`never`-guard
pattern anywhere** — introducing one is a new convention (small, but note it).

## Sketch of the registry direction (for the planner to design properly)

One declaration per capability in `session-messages.ts` — payload type, response type,
unavailable value — from which derive: the request union, `SessionResponses`
(`Record<SessionAction,…>` so a missing key is a compile error), `UNAVAILABLE`, and a
`dispatchSession` built as a typed handler map (`Record<SessionAction, (session, req) => …>`)
instead of a switch — making place 5 exhaustive by construction. Places 1 and 6 (interface,
closures) stay hand-written but get compile-time pins (e.g. `satisfies` checks tying closure
signatures to the registry). Add `isSessionRequest` action-set validation + minimal payload
guards, and the missing tests (below). Whether `restore` collapses is open question 2.

## Minimum test set the seam must earn (ADR-0001's own bar)

1. Round-trip: fake `runtime.sendMessage`/`onMessage` harness driving every action through
   `dispatchSession` against a stubbed session — pins request→handler→response per capability.
2. Fail-safe: null session returns each action's UNAVAILABLE value; unknown action → calm
   degradation (pin the update-window property).
3. Sender validation: extension-origin popup/options pass; content-script-shaped sender
   (page URL, has tab) is rejected; embedded options page (has tab, extension URL) passes.
4. Translation pins: `signed-out`→`auth-required` (wiring:92); deleteAccount throw (wiring:65);
   restoreHandler's outcome→controller-method mapping.

## Open questions for the planning agent

1. Derive all six from one source, or add exhaustiveness pins to the existing six? (Full
   derivation is deeper; pins are cheaper pre-release. The registry can come in two steps.)
2. Collapse `restore` into `reconcile` at the wire level? Changes 5 of 6 places; UI affordances
   stay distinct caller-side. If kept, document why in the registry.
3. Where does the `signed-out`→`auth-required` collapse belong — controller adopts the full
   `SessionReconcileOutcome`, or the narrowing stays at the seam (and gets a test)?
4. Protocol version field on `Base`? (Today's silent-unavailable degradation may be the right
   answer — but decide it, don't inherit it.)
5. Payload validation depth for `isSessionRequest` — full parse-reject (Swift `BridgeRequest.parse`
   analog) or action-set check only?
6. Pending-OTP shape unification: which of the four shapes is canonical?
7. Should sender validation move to `session-messages.ts` (co-located + testable) with the
   background passing `chrome.runtime.id`/origin in?
8. Does `getState` stay a pull-snapshot, or is that out of scope? (Recommend out of scope.)

## Relationship to other dossiers

Independent of dossiers 002/003 (different files). Overlaps dossier 004 only at the background
entrypoint (dispatch registration); if both proceed, coordinate the `background.ts` edits.
Low-risk, mechanical, high test payoff — good candidate to run FIRST among the four.
