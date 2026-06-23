---
date: 2026-06-23
topic: still-second-pass
---

# Still — second-pass resolutions & open holes

## Summary

Resolves the open decisions and ambiguities in `Still-Spec-v1.md` so planning can proceed without inventing product behavior. The spec's approach is sound and should be built. Six product forks are now decided; this doc records them, the technical resolutions they imply, the scope clarifications, the copy drafts, and the handful of items that still need the founder or a human before store submission. Read this alongside the spec — it changes or sharpens specific sections rather than restating them.

## Approach assessment

Verdict: **build it as designed**, with two structural risks the founder is knowingly accepting, surfaced here so they are deliberate rather than discovered later:

- **Maintenance economics.** Keeping selectors current against four platforms that change markup constantly is a *perpetual* operational task. A one-time $2.99 unlock for the least-visible feature (settings sync) does not fund that work. v1 ships as specified; this is accepted as a labor-of-love cost structure, revisited if retention justifies a recurring model.
- **The "one settings UI" hides the hardest integration.** The same web UI runs in three hosts with three different storage realities (see D8). This is the most likely place the build stalls and is called out so planning treats the storage adapter as first-class, not an afterthought.

Everything else in the spec — the data-driven rule set, the no-account free tier, `document_start` CSS injection, backend-hosted runtime-fetched rules — is the right instinct and is retained.

## Key decisions

D1. **Full v1 scope retained.** Accounts, Still Sync IAP, Supabase backend, and settings sync all ship in v1 (not deferred). The founder chose completeness over a leaner blocker-first release.

D2. **Per-service toggles, not per-surface.** One master toggle per service (YouTube, Instagram, TikTok, Facebook), a global on/off, and per-site pauses — four service toggles, not ~24 surface toggles. Surfaces still exist as internal authoring/QA units grouped under each service; they are not individually user-controllable. This shrinks the settings model and the QA matrix ~6×.

D3. **Safety model moves from per-surface to per-service.** Because surfaces are no longer user-toggleable, the spec's rule ("new surfaces default off") shifts up a level: a rules update that adds a *new surface under an already-enabled service* takes effect immediately (the user asked for that service's short-form gone — all of it, including future surfaces); a rules update that adds a *brand-new service* defaults that service **off** until the user enables it.

D4. **Single synced settings, not two profiles.** One settings set per account, synced to every signed-in device. Drops the `desktop`/`mobile` profile split and the "this scope / other / both" targeting UI entirely. This makes seed-question #1 (iPad scope) moot and removes the `scope` enum from the data model. Per-device divergence is a v2 refinement *if users ask*.

D5. **$2.99 one-time for Still Sync, as specified.** Single non-consumable unlocking cross-device sync. (Risk noted in Approach assessment.)

D6. **No usage counter in v1.** The optional "short videos hidden today" counter is cut — it cuts against the calm, no-measurement ethos and adds build/QA cost for no clear value.

D7. **Shorts redirect happens at the network layer.** `youtube.com/shorts/<id>` → `youtube.com/watch?v=<id>` via a declarative network redirect (e.g. `declarativeNetRequest`), so the Shorts player never paints. A content-script `window.location` redirect is rejected — it fires after the Shorts UI has begun rendering and produces exactly the flash the product promises to avoid.

D8. **One settings UI, host-specific storage adapter.** The shared web UI is built once, but persistence is abstracted behind an adapter with three implementations: (a) Chromium extension → `chrome.storage` directly; (b) Safari content script → extension storage; (c) the app's WKWebView → `WKScriptMessageHandler` → native Swift → a shared App Group container that the Safari content script also reads. "Build the UI once" is true for markup and logic; storage is not free and must be designed up front.

D9. **Magic link is the universal auth path; Sign in with Apple is Apple-only.** A purchase made via SIWA on iPhone must still be reachable from the desktop Chromium extension, where SIWA is awkward-to-infeasible. Email magic link is the cross-platform bridge; SIWA is an Apple-device convenience on top.

D10. **Selector-health canary is an operational requirement, not optional.** A scheduled check that fetches each service and asserts the live markup still matches the current selectors. Because the entire product silently breaks when markup shifts, this is more load-bearing than most features.

## Requirements

**Settings & sync**

R1. There is one settings set per account: a global on/off, four per-service master toggles, and a list of per-site pauses. No per-device profiles, no per-surface user toggles.
R2. The local on-device cache is always the read path for blocking, so rules apply on page load with no network wait. When Still Sync is on, the cloud settings are source of truth and mirror into the local cache. When sync is off, the local cache is the only copy and nothing leaves the device.
R3. A rules update that adds a new *surface* under an already-enabled service applies immediately; a rules update that adds a brand-new *service* leaves that service off until the user enables it. (See D3.)

**Blocking behavior**

R4. Static navigation chrome (sidebar items, tabs, pivot rows) is hidden via CSS injected at `document_start` and must never paint. Dynamically injected feed items are removed on the same frame they are observed; a transient sub-frame flash on infinite-scroll injection is the defined acceptable ceiling, not a defect.
R5. A Shorts URL containing a video id redirects at the network layer to the standard watch page with no Shorts UI paint.
R6. A Shorts URL with no extractable video id (e.g. a `/shorts` feed root) shows the Still placeholder.
R7. Every client ships both the desktop and the mobile selector sets regardless of its platform, because which layout loads (e.g. `m.youtube.com`) is independent of the device. (See D4.)
R8. Direct Reels URLs (Instagram, Facebook) and any `tiktok.com` page show the Still placeholder.

**Accounts, purchase, entitlement**

R9. Cross-platform sign-in uses email magic link as the universal method; Sign in with Apple is offered only on Apple devices. The desktop Chromium extension authenticates via magic link.
R10. Account deletion and data export are available in v1 from the Sync/account screen (App Store requirement).
R11. The Still Sync entitlement is tied to the Still account; any device signed into that account reads the entitlement and enables sync.

## Acceptance examples

AE1. **Covers R5.** User opens `youtube.com/shorts/abc123` → lands on `youtube.com/watch?v=abc123` in the normal player; the Shorts interface never appears.
AE2. **Covers R6.** User opens a Shorts URL with no id → Still placeholder, no redirect loop.
AE3. **Covers R2.** Device is offline at launch → client uses the last cached rule set; if none, the bundled default; blocking still works.
AE4. **Covers R3.** Rules update adds a new "Shorts in notifications" surface while the user has YouTube enabled → it is removed immediately. The same update adds a hypothetical new service "Threads" → Threads removal stays off until the user turns it on.
AE5. **Covers R1.** User pauses Still on the current site → no rules apply there until unpaused; other sites unaffected.
AE6. **Covers R2.** A free (sync-off) user toggles a service off → the change is written to the local cache only and is never transmitted.

## Scope boundaries

**Deferred for later (planned, not v1):** Firefox add-on; Android; Stripe / web checkout; per-device settings profiles; whole-app blocking of the native apps (Screen Time / Family Controls / VPN); a usage counter.

**Outside this product's identity (deliberately not built):** whole-site blocking of anything except TikTok; timers, streaks, schedules, focus modes, or any hard lock; ad-blocking; parental controls; "fixing" the regular (non-short-form) infinite feeds — Still removes the short-form *surface*, it does not de-infinite the home feed; short-form that appears *outside* the four domains (Google Search/Video tab results, third-party TikTok/Reel embeds on other sites) — Still runs only on the four services' own domains, by design, for the narrowest host permissions.

## Dependencies / assumptions

- The shared settings UI depends on the storage adapter in D8 existing before the UI can persist anywhere but the Chromium extension.
- Email magic link requires a production email sender (Supabase's built-in is rate-limited; production needs SMTP/Resend) — config/human task.
- Apple price tier maps $2.99 to the nearest point; Apple Small Business Program enrollment assumed for the 15% rate — human task.
- The network-layer Shorts redirect (D7) assumes Safari's declarative network redirect support is sufficient for a single `main_frame` path rewrite. **Verify in Safari**; if unsupported, a Safari-specific fallback is needed (early content-script redirect accepting a minor flash, scoped to Safari only).
- Rule sets are fetched over HTTPS from the project's own origin, schema-validated, and size-capped before being swapped in; a malformed or oversized set is rejected and the last-good set is kept.

## Outstanding questions

**Resolve before planning**

- Canonical Still Blue hex — needs the founder's source asset (working value #2A47E8 is a sample, not pinned).
- Legal entity for the Apple account (individual vs company) — gates App Store Connect setup.
- Confirm Safari declarative redirect support for D7 (see Dependencies) — determines whether the redirect is one mechanism or two.

**Deferred to planning / codebase**

- RevenueCat vs StoreKit 2 + Supabase Edge Function for receipt validation (default: RevenueCat).
- Svelte vs React for the shared UI (default: Svelte; either is fine).
- Exact host-permission match list per service including locale subdomains (`m.youtube.com`, country TikTok domains, etc.) — enumerate at rule-authoring time.
- Mac Safari-extension hosting: separate native iOS + macOS targets sharing SwiftUI (recommended) vs Mac Catalyst — confirm during Apple-project setup.

## Drafted copy (founder to edit)

Calm, outcome-phrased, sentence case, no scolding. These are drafts to react to, not finals.

**Still placeholder** (direct Shorts/Reels open, and all of TikTok):
- Primary: "Nothing here. That's the point."
- Alternates: "You came here for something else." / "Quiet on purpose."

**Onboarding (4 screens):**
1. Welcome — "Still" / "The short-form video disappears. Everything else stays."
2. Outcome — "Reels, Shorts, and TikTok — gone. The sites you use stay exactly as they were." (deliberately does *not* claim to fix endless scrolling generally; see Scope boundaries.)
3. Enable the extension — "One quick step." / "Still works through Safari. Turn it on and short-form is gone for good." + guided, illustrated steps, with live state: "Not on yet" → "You're all set."
4. Done — "That's it. Short-form is gone." → lands on Settings.

**Paywall (Still Sync):**
- Title: "Keep your settings in step."
- Body: "Still Sync carries your settings to every device you sign in on — phone, iPad, Mac, computer. Set it once."
- Price: "$2.99, once. No subscription."
- Primary button: "Get Still Sync" · Secondary: "Maybe later"
- Availability note: "Buy once on iPhone, iPad, or Mac — sync turns on everywhere you sign in."
