# Still — Monetization Design (Free + $1.99 Pro, cross-platform)

> **Status:** design spec, not yet implemented. Input to a future `ce-plan` / `ce-work` run.
> **Revised 2026-06-25** after a 7-persona `ce-doc-review` — hardened for: the entitlement-store
> security model, paywall UX states, identity/relay handling, the `still_sync` rename trap, the
> $1.99-vs-$2.99 config mismatch, anti-steering, and offline grace. Founder-ratified choices are
> **[DECIDED]**; the remaining strategic call is in **§11**.
>
> **Model in one line:** Free = *YouTube Shorts, gone*. Pro ($1.99 one-time, flat, cross-platform) =
> *everywhere + everything*. One purchase on any platform unlocks Pro on all, tied to an account.

---

## 0. Monetization principles (the constitution)

1. **Never paywall before the first "aha."** User installs → enables the extension → *sees Shorts
   vanish free* before Pro is mentioned. Paywalling first-run is the #1 cause of 1-star reviews.
2. **The free tier is a complete win, not a demo.** Free YouTube-Shorts blocking works fully, forever.
3. **Contextual, not interruptive.** Upsell appears at the moment of desire (tapping a locked feature).
4. **Show locked features, gently** (visible + muted + 🔒). Discovery and paywall are one surface.
5. **Lead with "once."** "$1.99 · one-time, not a subscription."
6. **Calm, on-brand copy. Surface once. No nagging.**
7. **No account until needed.** Free use needs none; an account is only for paying / cross-device.
8. **Sign in *before* purchase (no anonymous purchase — KTD5).** Entitlement is account-bound from tap one.
9. **One price everywhere ($1.99 flat).** [DECIDED] Absorb Apple's cut; don't charge Apple users more.
10. **Entitlement is server-authoritative.** The backend decides "is this account Pro." The client asks.
11. **Fail generous.** A previously-Pro user keeps Pro from cache when offline; only a *definitive*
    server `false` downgrades (within the TTL ceiling, §6).
12. **Entitlement lives in a server-only, read-only store the client cannot write or sync** — NEVER in
    the LWW `StillSettings` blob. (This is the security spine — see §6. Violating it = trivial self-grant.)
13. **The free YouTube-Shorts surface blocks regardless of its `tier` tag.** A missing/stale/rolled-back
    tag must never disable free blocking (fail toward the free promise, §3).

---

## 1. The model [DECIDED for the mechanics; the *line* is OPEN — see §11]

| | **Free** | **Pro — $1.99 one-time, flat, cross-platform** |
|---|---|---|
| Account | none | required (sign in before purchase) |
| YouTube Shorts | ✅ | ✅ |
| YT recommendations / comments / sponsored | — | ✅ *(new surfaces — to build; see launch-value note)* |
| Instagram Reels · TikTok · Facebook Reels | — | ✅ *(exists today; moves behind Pro)* |
| Granular per-surface controls | — | ✅ *(new UI)* |
| Cross-device sync (iPhone · Mac · Chrome) | — | ✅ *(today's `still_sync` feature, folded into Pro)* |
| Global on/off · pause-on-site | ✅ (free scope) | ✅ |

**Migration / grandfathering [OPEN — verify before build]:** the doc previously claimed "no production
users → no grandfathering." That conflates *App Store release* with *distribution* — the repo is at
submission stage (PR #19) with a registered test device, so **TestFlight/dev-build testers may have
installed when blocking was free on all four platforms.** Before relying on no-grandfather: **(a)**
confirm zero pre-monetization builds were distributed, or **(b)** add a `legacyInstall` flag that keeps
pre-monetization installs on the old free-all-platforms scope.

**Launch-value note [decide in §11]:** at launch, Pro's genuinely-*new* capabilities (YT
recs/comments/sponsored, granular controls) are deferred to a separate feature task — so day-one Pro =
IG/TikTok/FB blocking (free today) + sync (already paid). That risks the launch reading as "they charged
for the free features." Either **sequence the new YT surfaces into the monetization launch** so Pro
carries new value, or commit to positioning that frames it.

---

## 2. Feature-gating map (free vs Pro, exists vs to-build)

Rows 1–7 are rule-engine **surfaces** (`SignedRuleSet.services[].surfaces`, gated canonically by
`requiredCapability`, with `tier:"free"|"pro"` retained as a v1 authoring/UI shorthand). Row 8 is a
**UI feature** (not an engine surface — owned by U4/U5, not U1).

| Service | Surface / feature | Action | Tier | Status |
|---|---|---|---|---|
| youtube | Shorts (shelf/sidebar/feed/redirect) | hide/remove/redirect | **free** | exists |
| youtube | Recommendations / suggested | hide/remove | **pro** | **to build** |
| youtube | Comments | hide/remove | **pro** | **to build** |
| youtube | Sponsored / promoted | hide/remove | **pro** | **to build** |
| instagram | Reels | placeholder/remove | **pro** | exists |
| tiktok | whole-site block | blockSite | **pro** | exists |
| facebook | Reels | remove | **pro** | exists |
| (all) | per-surface granular toggles — **UI, not a surface** | — | **pro** | **to build** |

---

## 3. Entitlement gating in the engine

Today `evaluate()`/`applyDom()` apply every enabled surface (blocking is free). New behavior gates by
entitlement in **two** places — miss either and gating is incomplete:

1. **Dynamic path:** thread capabilities into `evaluate(ruleSet, settings, url, { capabilities })`.
   V1 may bridge `pro=true` to the full Pro capability set, but the engine surface model should be
   capability-based so future subscriptions, bundles, and granular launches do not require another
   schema rewrite. Missing `requiredCapability` defaults conservatively to Pro-only unless the surface
   is explicitly always-free.
2. **Static manifest-CSS path** *(do not forget):* hide-action surfaces are also applied via the packaged
   `still.css` injected at `document_start` (`cssInjectionMode:"manifest"`), scoped under
   `html.still-active` and generated **tier-unaware** by `generateHideCss`. The new pro hide-surfaces
   (recs/comments) would hide for **free** users once added to that CSS. Fix: scope pro hide-rules under
   a **second root class `html.still-pro-active`** that the content script adds *only when entitled*, and
   split `generateHideCss` / packaged CSS into **free** and **pro** stylesheets.
3. **Missing capability/tier defaults to Pro-only** (safe for revenue) — **except** the current
   YouTube-Shorts surfaces, which the engine treats as **always-free regardless of the tag** (principle
   13), so a missing/stale tag can never break the free promise.

`pro` is read synchronously from the **server-only entitlement store** (§6), not the settings blob.

**Acceptance:** `pro=false` → only YT Shorts blocked, live, via *both* paths; `pro=true` → all surfaces.
A rule-set with the YT-Shorts surface untagged still blocks Shorts for free. Unit-tested in `engine.test.ts`.

---

## 4. Identity & accounts

- **Providers:** Sign in with Apple (Apple platforms; required by 4.8 once Google is offered), **Google**
  (web/Chrome — *new*), email **magic link** (universal key + fallback). All passwordless.
- **Canonical account key = Supabase `auth.users.id` UUID.** Verified email is a login/contact/linking
  attribute only; it is not the entitlement subject and must not be used for silent merges.
- **Account-linking [DECIDED]:** link a second provider only via `supabase.auth.linkIdentity` **while the
  user is already authenticated**, with email verified on both — **never** silent server-side merge on
  email collision (that would let an attacker who registers `victim@gmail` via Google inherit the
  victim's Pro). Test: Google sign-in on an email already owned by a magic-link Pro account must *link
  (if authenticated)* or *cleanly error* — never silently transfer entitlement.
- **The Apple private-relay reality (don't oversell auto-link):** SIWA may return a
  `…@privaterelay.appleid.com` alias that will **not** match the user's Gmail — so "auto-link on matching
  email" **structurally cannot** cover the web-Google-vs-iOS-Apple case it's meant to. Mitigations:
  (a) **proactively detect** a freshly-signed-in account with no `pro` and surface **"Find my purchase"
  as a first-class prompt** (not buried in settings); (b) capture the Apple relay *forwarding* email to
  link on where possible; (c) **"Find my purchase" = a support link (mailto) for v1** [DECIDED] — not a
  programmatic merge screen.
- **RevenueCat reset on sign-out [DECIDED]:** the sign-out sequence must call `Purchases.logOut()` (iOS)
  / the RC web anonymous-reset **first**, before clearing the Supabase session — otherwise the SDK stays
  scoped to the prior user. Call sites: `SyncService.signOut()` + `deleteAccount()`.
- **RevenueCat identity on sign-in:** `Purchases.configure(appUserID:<Supabase UUID>)` (KTD5, exists).

---

## 5. RevenueCat setup (precise)

**One entitlement, many products, one offering. Keep the existing ids — do NOT rename.**

- **Entitlement key = `still_sync` (KEEP) [DECIDED].** The earlier "rename to `pro`" is a **trap**: the
  key is hardcoded as `STILL_SYNC_ENTITLEMENT` in `supabase/functions/_shared/revenuecat.ts` and mirrored
  in the DB column, the `set_entitlement` RPC, shared-types, `.storekit`, and the **App Store Connect
  product id — which is immutable once created** (and may already exist from PR #19). Renaming risks
  *bricking every entitlement* (constant mismatch → all users derive `pro=false`) and *blocking purchases*
  (`stillSyncPackage()` strict-matches the product id with no fallback — a mismatch returns `.unavailable`).
  **Keep `still_sync` everywhere server/StoreKit-side; only relabel the user-facing string to "Pro."**
- **Products → entitlement `still_sync`:**
  | Store | Product ID | Type | Price |
  |---|---|---|---|
  | App Store (iOS+macOS via **Universal Purchase**) | `still_sync` | non-consumable | **$1.99** |
  | RevenueCat **Web Billing** (Stripe) | `still_sync_web` | one-time | **$1.99** |
- **Price reconciliation [must fix — factual mismatch]:** `Still.storekit` (`displayPrice "2.99"`) and
  `PurchaseManager`'s docstring currently say **$2.99**, not the decided $1.99. Tasks: set `$1.99` in
  `Still.storekit`, update the `PurchaseManager` docstring, change the **ASC price tier**, and **audit
  drafted metadata/screenshots for any "$2.99."**
- **Offering:** one offering marked **Current** with the $1.99 package(s). The paywall reads
  `offerings.current`.
- **Webhook (exists — narrow change):** `revenuecat-webhook` already re-derives entitlement from canonical
  subscriber state for *every* event (it does not switch per event type), so the real work is **`TRANSFER`
  handling** (entitlement moving between `app_user_id`s on link/merge — see §9 residual) and the
  entitlement *write target* (the server-only store, §6). **Family Sharing = disabled for v1 [DECIDED]**,
  so no family-grant event handler is needed.
- **Webhook auth gotcha:** the handler compares the raw `Authorization` header against the secret with a
  constant-time check — the RC dashboard token must match **exactly** (a stray `Bearer ` prefix → 401 →
  silent entitlement stall). Document the expected header format for the implementer.
- **Webhook PII minimization:** `revenuecat_events` is an idempotency/audit log, not a billing-data
  archive. Store only event id/type plus UUID candidates needed for support/debugging; do not persist
  raw `customerInfo`, subscriber attributes, email, or Stripe/billing metadata from webhook bodies.
- **Web Billing [DECIDED]:** enable RC Web Billing → Stripe → `still_sync_web` $1.99 + tax; use the hosted
  checkout via the authenticated `create-web-checkout` Edge Function. The function derives
  `app_user_id` from the verified Supabase JWT subject and ignores any client-supplied user id/product
  id/price. The client never assembles a checkout URL or passes `app_user_id` directly to RevenueCat.
- **Restore:** the existing button (3.1.1) covers Apple; cross-platform restore = sign in → backend.
- **No trial [DECIDED].** Sandbox-test before submit (buy → unlock → restore → cross-platform).

---

## 6. Entitlement store + read path (the security + offline spine)

**The store (principle 12) — server-only, not the settings blob:**
- Persist entitlement in a **separate, read-only store the settings layer cannot forge**: in the
  extension, hold the latest verified entitlement in service-worker memory plus the best available
  extension-local cache (`chrome.storage.session` where supported; otherwise local extension storage
  containing only a signed token). **Do not treat extension storage itself as a security boundary.** For
  cross-restart persistence, use a **server-issued asymmetric signed entitlement token** (for example
  compact JWS / Ed25519) over `{ userId, capabilities, issuedAt, expiresAt, tokenVersion }`, signed by
  a dedicated backend entitlement-signing key and verified by clients with a bundled public key. A
  client edit invalidates the signature without shipping any signing secret in the app. **Written only
  by the authenticated reconcile/checkout paths; never by `SettingsCache.commit` or `writeProfile`.**
  `parseSettings()` must **whitelist-strip** any `entitlement` field so a forged settings value can't
  inject it.
- **Threat model clarity:** this protects the paid trust boundary from synced-settings self-grants,
  profile writes, and extension-storage edits. It does **not** cryptographically stop a user from
  patching their own local extension/app binary; server-side account state, cross-device sync, and any
  backend-facing Pro features remain authoritative.
- *Why:* the natural "put `pro` in the synced `StillSettings`" lands it in `chrome.storage.local`, which
  `applyRemote()` accepts from `onChanged` on any newer `updatedAt` — a user could set `pro:true` via
  DevTools and even sync it to the cloud. That breaks principle 10 trivially.

**Tri-state read (not a boolean):** `entitled | not-entitled | unknown`. Offline/error → `unknown` (keep
cached `pro` within TTL); only a *successful server response of `false`* downgrades. The read contract
(`readEntitlement` / BackendPort) returns the tri-state — a boolean collapses offline→false and would
downgrade a paid user offline (forbidden by principle 11).

**TTL [DECIDED = 30 days]:** named constant `ENTITLEMENT_CACHE_TTL_DAYS`. **On TTL expiry while still
offline → downgrade to free** (free works fully, so failing closed costs nothing paid-for); this bounds
revocation latency for refunds/abuse. A cached token is usable only when its `userId` matches the
currently signed-in Supabase session; sign-out, account deletion, and identity switch must clear memory
and persistent token caches.

**Fast-path feedback, not authority:** on a successful purchase, show immediate success/pending feedback
from RevenueCat's local `customerInfo`/receipt, but do **not** persist Pro engine gating or sync from
local receipt state alone. Pro blocking/sync requires a successful backend reconcile or valid
server-signed entitlement token. If the webhook→Supabase→reconcile round-trip has not landed yet, keep
the paywall in a calm "checking your purchase…" / pending state rather than treating local
`customerInfo` as server-authoritative.

---

## 7. Per-platform flows (with the guards)

**iPhone / Mac (App Store):** install free → enable → *Shorts vanish (free)* → tap a 🔒 / "✦ Pro" →
**Sign in with Apple** (1 tap) → **online entitlement check** → IAP (Face ID) → `pro` (fast-path).
Mac is covered by the same purchase (Universal Purchase — assumes Mac App Store distribution; see §11).
> **Cross-store double-charge guard [required]:** before presenting *and* before processing the IAP,
> do a fresh **online** entitlement check; if `pro` is already true (e.g. bought on web), **suppress the
> buy button** and show "already unlocked." Otherwise a web-buyer who opens iOS offline gets charged a
> second $1.99 with no Apple record of the first.

**Chrome / Firefox / web:** install free → *Shorts vanish (free)* → tap "Unlock everywhere" →
**establish a Supabase session first** (magic-link or 1-tap Google) → call authenticated
`create-web-checkout` → open the returned **RC Web Billing** checkout URL → pay → `pro`.
> **Why session-first [required]:** `reconcile-entitlement` looks up entitlement by the Supabase UUID
> (`getSubscriber(claims.sub)`). A checkout under a RC-minted anonymous id would never be found — the user
> pays and never gets Pro. The checkout function uses the verified JWT subject as the RevenueCat
> `app_user_id`; body-supplied ids are ignored. **Handoff UX:** "Unlock everywhere" opens checkout in a
> new tab; on return, the extension reconciles on next popup open (brief "checking your purchase…"
> state), then unlocks.

---

## 8. Paywall UX (slim, elegant, fully specified)

Reuse + extend `PaywallSheet.svelte`. **Interaction model [specified]:** in a popup, the sheet is a
**card that slides up over the list within the popup bounds, with a scrim behind** — it does *not*
replace the whole popup and is not a separate full-screen route. The mock shows it at popup width because
the popup *is* the surface; render it as an overlay, not a content swap.

```
  FREE USER VIEW                  PRO USER VIEW              SLIM SHEET (slides up, scrim behind)
┌────────────────────────┐   ┌────────────────────────┐   ┌──────────────────────────┐
│  st·ll          ✦ Pro  │   │  st·ll        Pro ✓    │   │         Still Pro        │
│ │ Still is on     [●] ││   │ │ Still is on     [●] ││   │  Quiet every feed, on    │
│  ▶ YouTube             │   │  ▶ YouTube             │   │  every device.           │
│     Shorts       [ ●]  │   │     Shorts       [ ●]  │   │  ✓ Instagram·TikTok·FB    │
│  Instagram         🔒  │   │  Instagram       [● ]  │   │  ✓ Sync iPhone · Mac      │
│  TikTok            🔒  │   │  TikTok          [● ]  │   │   $1.99 · one-time        │
│  Facebook          🔒  │   │  Facebook        [● ]  │   │  [     Unlock Pro     ]   │
│ ──────────────────────│   │ (no upsell row)        │   │   Restore   ·   Not now   │
│  ✦ Quiet everywhere    │   └────────────────────────┘   └──────────────────────────┘
│    $1.99 once  [Unlock]│        ↑ 🔒→toggles,             ↑ value bullets are LAUNCH-REAL
└────────────────────────┘        pill→status, row hidden    (no "YT recs/comments" until built)
```

- **Value bullets are launch-real:** **no "Kill YT recs+comments"** until that feature ships (it's
  deferred — advertising it is false-advertising). When the YT surfaces land, add the bullet (`TODO` in
  `strings.ts`).
- **Pro-user view:** 🔒 rows become normal toggles; "✦ Pro" pill → a quiet status badge; the bottom
  upsell row is **hidden**.
- **Sign-in intercept:** tapping **[Unlock Pro]** while unauthenticated shows the passwordless options
  (SIWA / Google / magic-link) **inline in the sheet** (or `SignInSheet` stacked with back-nav), then
  proceeds to purchase. (Principle 8 — sign in before pay.)
- **Purchase states:** **in-flight** → button spinner + disabled; **success** → brief "Unlocked" → sheet
  dismisses ~1s → popup re-renders Pro (fast-path local receipt); **error** → button returns to default
  + a calm inline line ("Couldn't complete — try again"), no dismiss; **user-cancelled** → silent.
- **Restore states:** loading → **found** (same as success) | **none** ("No prior purchase — try signing
  in", sheet stays) | **error** ("Couldn't check — try again").
- **Anti-steering enforcement:** the **Web Billing CTA is compiled OUT on the iOS/Safari-app target**
  (not merely hidden); acceptance test asserts the iOS paywall is **IAP-only**, no external-checkout link
  or web-price copy. (One shared component + an inline web CTA is a launch-blocking 3.1.1/3.1.3 risk.)
- **Post-aha gating:** locks/paywall appear only *after* the onboarding "see Shorts vanish" flow.

---

## 9. Edge cases & policy

- **Cross-store re-purchase is NOT "idempotent" on money** — only on the entitlement bit. The §7 online
  check is the actual guard against the double charge.
- **Refund / revocation:** webhook clears the entitlement → reverts to free on next reconcile; **offline
  ceiling = the 30-day TTL** (then downgrade to free).
- **TRANSFER events** can move the entitlement between `app_user_id`s on link/merge, briefly flipping a
  paid user to unpaid mid-session — handle in the webhook + reconcile; surface nothing jarring (keep Pro
  from cache until a definitive false).
- **Account deletion:** existing flow removes the account + entitlement.
- **Apple 3.1.3(b):** offer the IAP in-app; *may* honor web-bought `pro`; never advertise the web price
  on iOS (enforced by the §8 compile-out).

---

## 10. Implementation units (revised; each agent-testable)

- **U1 — Surface capability metadata + dynamic engine gating** (+ YT-Shorts always-free regardless of
  tag). `shared-types`, `engine.ts`, seed tags/capabilities, `engine.test.ts`.
- **U2 — Static-CSS gating.** `still-pro-active` root class + split free/pro stylesheets + `generateHideCss`.
- **U3 — Server-only entitlement store + tri-state read + content-script read.** The security-critical
  store (§6); `parseSettings` strips `entitlement`; never written by `commit`/`writeProfile`.
- **U4 — Controller `pro` + gated/locked toggles + paywall trigger.** `controller.svelte.ts`, `App.svelte`,
  `ServiceCard.svelte`.
- **U5 — Paywall UX (all states).** Interaction model, sign-in intercept, in-flight/success/error/restore,
  Pro-user view, launch-real bullets, **anti-steering compile-out + test**, copy in `strings.ts`.
- **U6 — Identity.** Google provider; authenticated-only `linkIdentity`; relay handling + proactive
  "Find my purchase" (support link); **`Purchases.logOut()` on sign-out**.
- **U7a (code) — Price + offering.** `Still.storekit` $1.99, `PurchaseManager` docstring, keep `still_sync`
  ids. **U7b (human)** — RC dashboard offering/entitlement; **ASC price change to $1.99 + Universal
  Purchase + metadata/$2.99 audit**; Web Billing + Stripe setup.
- **U8 — Web checkout + guards.** RC Web Billing from the non-Apple paywall via authenticated
  `create-web-checkout`; `app_user_id` is derived server-side from the verified JWT subject
  (session-first); web→extension handoff; **iOS online-check-before-IAP** double-charge guard.
- **U9 — Backend entitlement.** Webhook `TRANSFER` + write to the server-only store; reconcile writes
  tri-state; TTL constant; deno tests.
- **U10 — Extension auth+sync+entitlement spine.** *Net-new, not a small add* — the Chrome/Safari popup's
  `createUiController` has **no auth/sync/entitlement** today (`canPurchase:false`); build Supabase
  auth (magic-link/Google) + reconcile + entitlement read in the popup/background worker.
- **U11 — Full verification.** Sandbox Apple buy, web buy, cross-device unlock, restore, refund downgrade,
  offline grace + TTL expiry, double-charge guard, **and a self-grant attempt that must fail** (forge
  storage → still locked). Human-driven where credentials are needed.

---

## 11. Open decisions

**Ratified in this revision [DECIDED]:** keep `still_sync` ids (relabel UI to "Pro") · TTL = 30 days,
expiry-while-offline → free · Family Sharing disabled v1 · "Find my purchase" = support link · linking
= authenticated-only.

**Still open — your call:**
1. **The free/paid LINE (strategic — the biggest bet):** **Option A** (free = YouTube Shorts only) vs an
   **add-only alternative** (free = short-form on *all four* platforms — the core brand promise; Pro =
   sync + the new YT surfaces + granular controls). Option A maximizes the paid surface but **narrows the
   "short-form everywhere" promise**, competes against free multi-platform blockers, and makes day-one
   Pro mostly *re-partitioned free features*. Decide the line, **and** whether to **sequence the new YT
   surfaces into the monetization launch** so Pro carries new value, **and** a **success metric** (target
   conversion / acceptable adoption cost) to judge it.
2. **Grandfathering:** verify no TestFlight/dev build shipped the old free-all scope (§1).
3. **Mac distribution channel:** Mac App Store (enables Universal Purchase) vs direct/notarized (then Mac
   buyers fall to Web Billing, not Universal Purchase).

---

## 12. What already exists (honest scope)

**Exists (Apple app + server only):** Supabase auth (Apple + email magic-link) · RC keyed to the UUID
(KTD5) · `entitlements` table + `revenuecat-webhook` · `reconcile-entitlement` + `SyncService`
(**instantiated only in `app-webview/src/main.ts` — the WKWebView app**) · `PaywallSheet` + purchase/
restore flow · the rules-engine per-surface model · the shared toggle UI in both popups.

**Net-new — do not under-scope (the "~70% there" is Apple-only):** the **entire Chrome/Safari extension
auth + sync + entitlement spine** (U10 — the popup has none today) · the **server-only entitlement store
+ tri-state** (U3) · **static-CSS gating** (U2) · the **Google provider** (U6) · **Web Billing** (U8) ·
the **paywall UX states + anti-steering compile-out** (U5) · the **$2.99→$1.99** change (U7).
