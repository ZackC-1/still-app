# Still — Monetization Design (Free + $1.99 Pro, cross-platform)

> **Status:** design spec, not yet implemented. Intended as the input to a future `ce-plan` / `ce-work`
> run. Decisions ratified by the founder 2026-06-25 are marked **[DECIDED]**; remaining choices are in
> **§11 Open Decisions**.
>
> **Model in one line:** Free = *YouTube Shorts, gone*. Pro ($1.99 one-time, flat, cross-platform) =
> *everywhere + everything*. One purchase on any platform unlocks Pro on all of them, tied to an account.

---

## 0. Monetization principles (the constitution — obey these in every future change)

1. **Never paywall before the first "aha."** The user must install, enable the extension, and *watch
   YouTube Shorts vanish for free* before Pro is ever mentioned. Paywalling the first run is the #1
   cause of 1-star reviews and of users feeling accosted.
2. **The free tier is a complete win, not a crippled demo.** Free YouTube-Shorts blocking must work
   fully and forever, no nags inside it.
3. **Contextual, not interruptive.** Show the upsell at the *moment of desire* — when the user reaches
   for a locked feature — never on launch, never as a full-screen takeover.
4. **Show locked features, gently.** Premium toggles are visible in the list, muted with a small 🔒.
   Discovery and paywall are the same surface. Don't hide what Pro offers.
5. **Lead with "once."** Always say "$1.99 · one-time, not a subscription." Removing recurring-charge
   anxiety is most of what makes a paywall feel calm.
6. **Calm, on-brand copy. Surface once. No nagging.** Match Still's voice ("Less feed. More life."). A
   single quiet "✦ Pro" affordance is always available; it never pops itself.
7. **No account until it's needed.** Free use requires no account. An account is only required to pay
   or to go cross-device.
8. **Sign in *before* purchase (no anonymous purchase — KTD5).** The entitlement must be account-bound
   from the first tap, or cross-platform breaks. The passwordless sign-in *is* the only added step.
9. **One price everywhere ($1.99 flat).** [DECIDED] Absorb Apple's commission rather than charging
   Apple users more. Honest "one price" beats margin optimization here.
10. **Entitlement is server-authoritative and account-based.** The backend (Supabase) is the source of
    truth for "is this account Pro," fed by RevenueCat. The client never self-grants; it asks.
11. **Fail gracefully, lean generous.** If the entitlement check is offline/unknown for a user who has
    been Pro, keep Pro working from cache (see §9). Never yank a paid feature over a flaky network.

---

## 1. The model [DECIDED]

| | **Free** | **Pro — $1.99 one-time, flat, cross-platform** |
|---|---|---|
| Account | none | required (sign in before purchase) |
| YouTube Shorts | ✅ | ✅ |
| YouTube recommendations / comments / sponsored | — | ✅ *(new surfaces, see §2)* |
| Instagram Reels · TikTok · Facebook Reels | — | ✅ *(exists today; moves behind Pro)* |
| Granular per-surface controls | — | ✅ *(new UI)* |
| Cross-device sync (iPhone · Mac · Chrome) | — | ✅ *(today's `still_sync` feature, folded into Pro)* |
| Global on/off · pause-on-this-site | ✅ (applies to free scope) | ✅ |

**Important migration note:** today blocking is *free on all four platforms* and only sync is paid.
Option A **narrows the free tier to YouTube Shorts only** and moves IG/TikTok/FB + the YT extras behind
Pro. This is the single biggest behavioral change (see §3 — the engine must gate surfaces by
entitlement). There are no production users yet, so no grandfathering is required.

---

## 2. Feature-gating map (precise — free vs Pro, exists vs to-build)

Each blockable thing is a rule-engine `surface` (see `packages/core/src/rules/engine.ts` +
`SignedRuleSet.services[].surfaces`). Gate by a per-surface `tier: "free" | "pro"` tag.

| Service | Surface | Action | Tier | Status |
|---|---|---|---|---|
| youtube | Shorts (shelf/sidebar/feed/redirect) | hide/remove/redirect | **free** | exists |
| youtube | Recommendations / suggested | hide/remove | **pro** | **to build** (new selectors) |
| youtube | Comments | hide/remove | **pro** | **to build** |
| youtube | Sponsored / promoted | hide/remove | **pro** | **to build** |
| instagram | Reels | placeholder/remove | **pro** | exists |
| tiktok | whole-site block | blockSite | **pro** | exists |
| facebook | Reels | remove | **pro** | exists |
| (all) | per-surface granular toggles | UI | **pro** | **to build** |

> The **new YouTube surfaces** (recs/comments/sponsored) are a *separate feature effort* — this doc
> specifies the **monetization framework** that gates them, not their selectors. A future feature task
> adds the surfaces to the seed rule-set with `tier: "pro"`; they then "just work" under this gating.

---

## 3. Entitlement gating in the engine (the core change)

Today `evaluate()` / `applyDom()` apply every enabled surface regardless of payment (blocking is free).
New behavior: **filter surfaces by entitlement.**

- Add `tier` to the surface type in `@still/shared-types` (`SignedRuleSet` surfaces) — default `"pro"`
  so anything unlabeled is safely gated; only the YouTube-Shorts surfaces are `"free"`.
- Thread the user's entitlement into the engine. `evaluate(ruleSet, settings, url, { pro: boolean })`
  — surfaces with `tier === "pro"` are skipped when `pro === false`.
- The `pro` flag comes from the **same settings/cache the content script already reads** — add a
  server-authoritative `entitlement: { pro: boolean }` to the synced settings/cache (written by the
  entitlement reconcile path, §6), so the content script reads it synchronously like the toggles.
- Free users: only the YouTube-Shorts surface evaluates → only Shorts are removed. TikTok/IG/FB and the
  YT extras are no-ops until Pro.

**Acceptance:** with `pro=false`, only YouTube Shorts is blocked on a live page; with `pro=true`, all
surfaces apply. Unit-tested in `engine.test.ts` (new cases) with no network.

---

## 4. Identity & accounts

- **Providers:** Sign in with Apple (Apple platforms — also *required* by Guideline 4.8 once Google is
  offered), **Google** (web/Chrome one-tap — **new**, add to Supabase), email **magic link**
  (universal, the canonical key + fallback). All passwordless.
- **Canonical key = email.** Auto-link identities that share a *verified* email in Supabase.
- **Free = no account. Pro = account, signed in before purchase** (principle 7–8; KTD5 already enforces
  "no anonymous purchase").
- **The Apple private-relay wrinkle:** SIWA may return `…@privaterelay.appleid.com`, which won't match a
  user's real Gmail → looks like two accounts. Strategy: (a) nudge "you bought with Apple — sign in with
  Apple here too" (SIWA works on web); (b) auto-link on matching verified email where possible;
  (c) a **"Find my purchase"** link flow in settings (`supabase.auth.linkIdentity` / a support path) for
  the genuine-mismatch minority.
- **RevenueCat identity:** on sign-in, set `Purchases.configure(appUserID: <Supabase UUID>)` — already
  wired (KTD5, `app-webview/src/main.ts` + `PurchaseManager`). Web Billing uses the same `app_user_id`.

---

## 5. RevenueCat setup (precise — this is the part to get exactly right)

**One entitlement, many products, one offering.**

- **Entitlement:** `pro` (rename intent: the current code uses `still_sync`; see §11). Everything maps
  to this single entitlement. The app/extension ask: *"does this user have `pro`?"*
- **Products attached to `pro`:**
  | Store | Product ID | Type | Price |
  |---|---|---|---|
  | App Store (iOS + macOS via **Universal Purchase**) | `still_pro` | **non-consumable** | $1.99 |
  | RevenueCat **Web Billing** (Stripe) | `still_pro_web` | one-time | $1.99 |
  - **Universal Purchase** [must enable]: one App Store purchase covers iPhone + iPad + Mac App Store
    automatically. Enable in App Store Connect (shared bundle family) so an iOS buy lights up the Mac app
    with no second charge.
  - Update `Still.storekit` + `PurchaseManager.productID/entitlementID` to the chosen id (§11).
- **Offering:** mark one offering **Current** containing the $1.99 package(s). The paywall reads
  `offerings.current` (the code already does — `PurchaseManager.stillSyncPackage()` now strictly matches
  the product id, no fallback, per PR #21).
- **Web Billing** [DECIDED]:
  1. In RevenueCat, enable **Web Billing**, connect **Stripe**, create the `still_pro_web` product at
     $1.99, enable tax handling.
  2. Use RevenueCat's **hosted checkout / web paywall**, passing `app_user_id = <Supabase UUID>` so the
     web purchase attaches to the same account as mobile.
  3. The Chrome/Firefox/web non-Apple paywall (today "buy on iPhone", explanatory only) links to this
     checkout. After purchase, the entitlement flows to the account → the extension unlocks.
- **Webhook → Supabase (exists, extend):** `supabase/functions/revenuecat-webhook` already receives
  events into the `entitlements` table. Extend it to set/clear the `pro` entitlement for the
  `app_user_id` on `INITIAL_PURCHASE` / `NON_RENEWING_PURCHASE` / `TRANSFER` / refund/expiration events.
  This makes the backend the source of truth (principle 10).
- **Restore:** the existing **Restore Purchases** button (`PaywallSheet.svelte` → `controller.beginRestore`
  → `PurchaseManager.restore`) covers Apple restore; cross-platform "restore" is just *sign in* → backend
  says `pro`. Keep the button (Guideline 3.1.1 requires it).
- **Pricing:** flat $1.99 [DECIDED]. Apple Tier ≈ $1.99; Web $1.99. Net differs (~$1.39–1.69 Apple vs
  ~$1.90 web) — accepted.
- **No trial** [DECIDED]: the free tier is the trial. No StoreKit intro offer, no backend trial state.
- **Family Sharing:** see §11 (one ASC toggle on the non-consumable).
- **Sandbox test before submit:** buy `still_pro` with a sandbox Apple ID → `pro` unlocks → confirm
  Restore re-unlocks on a clean install → confirm the same account is `pro` on web/extension.

---

## 6. Entitlement read path (server-authoritative → client)

1. Purchase happens (StoreKit IAP **or** Web Billing) → RevenueCat → **webhook** → `entitlements.pro = true`
   for the account (Supabase).
2. On sign-in / app open, the existing **`SyncService` / `reconcile-entitlement`** path reads the account's
   entitlement and writes `entitlement.pro` into the synced settings/cache.
3. The shared UI controller exposes `pro` (today `entitled`); the content script reads `entitlement.pro`
   from the cache synchronously and gates surfaces (§3).
4. **Offline grace (principle 11):** cache the last-known `pro=true` with a generous TTL (see §11) so a
   paid user keeps Pro offline; only a definitive `pro=false` from the server downgrades.

---

## 7. Per-platform flows (the real UX)

**iPhone / Mac (App Store):** install free → enable extension → *Shorts vanish (free)* → later taps a
locked toggle or "✦ Pro" → **Sign in with Apple** (1 tap) → IAP (Face ID) → `pro`. Mac is covered by the
same purchase (Universal Purchase).

**Chrome / Firefox / web:** install free → *Shorts vanish (free)* → taps "Unlock everywhere" → opens
**RevenueCat Web Billing** checkout → email (or 1-tap Google) → pay → `pro`. On their iPhone later: sign
in with the same identity → `pro`, no re-purchase.

---

## 8. Paywall UX (slim + elegant — fits a 340–400px popup)

**Pattern: "visible but locked," triggered at the moment of desire.** Reuse + extend the existing
`PaywallSheet.svelte` (bottom sheet) — never a full-screen wall.

```
  FREE USER VIEW                       TAP A 🔒  →  SLIM SHEET
┌──────────────────────────┐         ┌──────────────────────────┐
│  st·ll             ✦ Pro │         │         Still Pro        │
│ ┌──────────────────────┐ │         │  Quiet every feed, on    │
│ │ Still is on       [●] │ │         │  every device.           │
│ └──────────────────────┘ │         │  ✓ Instagram·TikTok·FB    │
│  ▶ YouTube               │         │  ✓ Kill YT recs+comments  │
│     Shorts        [ ●]   │ free    │  ✓ Sync iPhone · Mac      │
│     Recommendations  🔒  │ ◄─┐     │   $1.99 · one-time        │
│     Comments         🔒  │   │     │  [     Unlock Pro     ]   │
│  Instagram           🔒  │   │     │   Restore   ·   Not now   │
│  TikTok              🔒  │   └──── └──────────────────────────┘
│  Facebook            🔒  │
│ ──────────────────────── │
│  ✦ Quiet everywhere      │  ← one calm, always-available row;
│    $1.99 once   [Unlock] │     never auto-pops
└──────────────────────────┘
```

- Locked rows are visible + muted + 🔒; tapping one opens the sheet (discovery == paywall).
- The sheet: title, ≤3 value bullets, "$1.99 · one-time", **[Unlock Pro]**, **Restore**, **Not now**.
- A single "✦ Pro" pill in the header + the bottom row are the only persistent prompts.
- Copy is calm and on-brand; lead with "once."
- **Enforce principle 1 in the onboarding sequence:** the paywall/locks appear only *after* the
  enable-and-see-Shorts-vanish flow completes.

---

## 9. Edge cases & policy

- **Refund / revocation:** webhook clears `pro` → user reverts to free (Shorts still free).
- **Account deletion:** existing delete-user flow removes the account; entitlement record goes with it.
- **Offline:** serve last-known `pro` from cache within TTL (§11); never downgrade on a transient failure.
- **Cross-platform restore:** sign in → backend `pro`. (Not Apple "Restore," which is Apple-only.)
- **Apple anti-steering / 3.1.3(b):** must offer the IAP in the iOS app; *may* honor web-bought `pro`; do
  **not** advertise the web price inside the iOS app (region-dependent; safest to stay silent on iOS).
- **Two purchases by one human (Apple + web):** idempotent — both grant the same `pro` on one account;
  if truly separate accounts, the "Find my purchase" link merges (§4).

---

## 10. Implementation units (for the coding agent)

> Suggested order; each is a unit with a clear acceptance test. Keep the full gate green
> (lint · typecheck · core+ext-safari+StillKit+deno tests · web/app builds).

- **U1 — Surface `tier` + engine gating.** `@still/shared-types` (add `tier` to surfaces),
  `engine.ts` (`evaluate`/`applyDom` skip `pro` surfaces when not entitled), seed rule-set tags. Tests:
  `engine.test.ts` free vs pro. *Acceptance: free blocks only YT Shorts; pro blocks all.*
- **U2 — `entitlement.pro` in settings/cache + content script read.** Wire the server-authoritative
  flag into the cache the content script already reads; default `false`.
- **U3 — Controller + gated toggles.** Expose `pro`; service/surface toggles show locked state when not
  entitled; tapping a locked toggle calls `openPaywall()` (`controller.svelte.ts`, `App.svelte`,
  `ServiceCard.svelte`).
- **U4 — Paywall UX.** Extend `PaywallSheet.svelte` to the value-bullet layout; add the "✦ Pro" header
  pill + bottom row; wire the contextual trigger; copy in `strings.ts`. Enforce post-aha gating in
  onboarding. Tests: `App.test.ts`.
- **U5 — Identity: add Google + email-key + relay handling.** Supabase Google provider; account-linking
  policy; "Find my purchase". `app-webview/src/main.ts`, the auth port, `SignInSheet.svelte`.
- **U6 — RevenueCat config + product rename.** `still_pro` non-consumable (Universal Purchase),
  `Still.storekit`, `PurchaseManager.productID/entitlementID`, offering. (Dashboard work documented for
  the human; code references updated.)
- **U7 — Web Billing path.** RevenueCat Web Billing checkout from the non-Apple paywall; pass
  `app_user_id`. Replace the "buy on iPhone" explanatory copy with a real CTA on web/extension hosts.
- **U8 — Backend entitlement.** Extend `revenuecat-webhook` to set/clear `pro`; `reconcile-entitlement` /
  `SyncService` write `entitlement.pro`; offline grace TTL. Tests: deno function tests.
- **U9 — Full verification.** Sandbox Apple purchase, web purchase, cross-device unlock, restore, refund
  downgrade, offline grace. (Human-driven where credentials are needed.)

---

## 11. Open decisions (ratify before implementing)

1. **Product id:** rename `still_sync` → `still_pro` for clarity (recommended; pre-launch, no migration),
   or keep `still_sync` to avoid code churn? Entitlement key likewise (`pro` vs `sync`).
2. **Offline grace TTL:** how long does a paid user keep Pro fully offline before a re-check is required
   (suggest 7–30 days)?
3. **Family Sharing:** enable on the non-consumable (one ASC toggle)? Pro = "lifetime, shareable" is a
   nice story but means one purchase covers a family.
4. **Free-tier basic controls:** confirm free includes global on/off + pause-on-this-site (recommended),
   scoped to the YouTube-Shorts surface.
5. **New YouTube surfaces (recs/comments/sponsored):** built as a *separate feature task* after this
   framework lands — confirm they're out of scope for the monetization PR(s).
6. **"Pro" naming/branding:** "Still Pro" vs "Still Everywhere" vs other.

---

## 12. What already exists (leverage — you're ~70% there)

- Supabase auth (Apple + email magic-link) · RevenueCat keyed to the Supabase UUID (KTD5) ·
  `entitlements` table + `revenuecat-webhook` · `reconcile-entitlement` + `SyncService` ·
  `PaywallSheet.svelte` + the controller's purchase/restore flow + `entitled` state · the rules engine's
  per-surface model · the Safari/Chrome popups already render the shared toggle UI.
- **Net-new for this design:** surface `tier` gating (U1–U2), locked-toggle paywall UX (U3–U4), the
  Google provider + relay handling (U5), Web Billing (U7), the `pro` webhook mapping (U8), and the
  product rename/offering (U6).
