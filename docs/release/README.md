# Still — Release Runbook

Current operational handoff: [`launch-progress-2026-07-13.md`](launch-progress-2026-07-13.md).

A follow-along, check-off guide to shipping **Still** to every store. Written for a first
app release — each step says exactly where to click, the exact value to enter for *this* app,
and the official URL. Work top-to-bottom; check boxes as you go.

> **What Still is.** A short-form-video remover. **Free:** removes YouTube Shorts. **Still Pro
> ($1.99 one-time):** removes Reels/TikTok/Facebook surfaces + cross-device
> settings sync. Brand: *Still Blue*, `st·ll` wordmark, by **Cadmus Labs**.

---

## The four release tracks

| # | Track | What ships | Pro purchase path | Status today |
|---|-------|-----------|-------------------|--------------|
| 1 | **Apple App Store** (iOS + Mac) — [`01-apple-app-store.md`](01-apple-app-store.md) | Native app + Safari extension + **$1.99 IAP** | StoreKit 2 → RevenueCat | iOS and macOS submissions in review |
| 2 | **Chrome Web Store** — [`02-chrome-web-store.md`](02-chrome-web-store.md) | Chromium extension **+ Pro purchase** | RevenueCat **Web Billing** | Version 1.0.1 submitted for review |
| 3 | **Firefox Add-ons (AMO)** — [`03-firefox-amo.md`](03-firefox-amo.md) | Firefox extension (MV3) **+ Pro purchase** | RevenueCat **Web Billing** | Version 1.0.0 awaiting review; corrected desktop-only 1.0.2 ready to upload |
| 4 | **RevenueCat** — [`04-revenuecat.md`](04-revenuecat.md) | Cross-platform $1.99 entitlement | — | Entitlement integration validated; portal operations remain human-gated |
| 5 | **Mobile blocking validation** — [`06-mobile-blocking-validation.md`](06-mobile-blocking-validation.md) | On-device YouTube-Shorts check (all mobile) | — | Physical-iPhone validation passed; rerun after release changes |
| — | **Google Play** (future) — [`05-future-google-play.md`](05-future-google-play.md) | — | — | **No Android app exists** — documented as future work |

> **Read [`04-revenuecat.md`](04-revenuecat.md) early.** RevenueCat is the shared spine for Pro on
> *every* platform. Apple IAP Pro and web Pro both resolve to the same `still_sync` entitlement.

## Current validation

The canonical automated and manual result is [VALIDATION.md](VALIDATION.md). Dated checkpoints and
agent handoffs are retained under [`../archive/`](../archive/README.md) for history only; they are not
current release instructions.

Before web Pro goes live, confirm `REVENUECAT_WEB_BILLING_CHECKOUT_URL` matches the live RevenueCat
Purchase Link and sandbox-test the open → pay → entitlement flow. See
[`04-revenuecat.md` §3](04-revenuecat.md).

---

## Recommended order for a first launch

1. **RevenueCat dashboard config** ([`04`](04-revenuecat.md)) — products, the `still_sync` entitlement,
   Apple `.p8`, Web Billing + Purchase Link, webhook. Nothing monetized works until this exists.
2. **Apple App Store** ([`01`](01-apple-app-store.md)) — paid Pro fully wired via StoreKit, and the
   **longest review queue** (budget 1–2 weeks), so start it early.
3. **Chrome Web Store** ([`02`](02-chrome-web-store.md)) — fast ($5, no hardware). Ships the Shorts
   remover **plus** the in-extension Pro purchase (OTP sign-in + Web Billing CTA).
4. **Firefox AMO** ([`03`](03-firefox-amo.md)) — same extension, same Pro purchase path as Chrome.
5. **Mobile blocking validation** ([`06`](06-mobile-blocking-validation.md)) — the **required launch
   gate** is a real iPhone running Safari, the only mobile surface advertised at launch. Firefox
   Android validation is a future gate before adding `gecko_android` to a later AMO build. CI runs
   headless Chromium against fixtures and cannot cover either real mobile runtime.

The browser extensions include the full in-product "Unlock Pro" flow: email-OTP sign-in, the
RevenueCat Web Billing checkout hand-off, entitlement, and settings sync. Remaining human/portal
work is tracked in
[`extension-purchase-deploy-checklist.md`](extension-purchase-deploy-checklist.md). An unconfigured
build fails safe to the free Shorts remover.

---

## Prerequisites (have these before you start)

| Need | For | Notes |
|------|-----|-------|
| Apple Developer Program ($99/yr) | Track 1 | ✅ Enrolled — team **UM9HVDH3P3** |
| A Mac with **Xcode 16+** | Track 1 | Required for all App Store uploads (2025+) |
| A physical iPhone + Mac to test | Tracks 1 & 6 | Safari-extension review + mobile-Shorts validation need real on-device proof |
| A physical Android device (or emulator) with Firefox | Future Firefox Android | Not required for the desktop-only launch; validate before adding `gecko_android` ([`06`](06-mobile-blocking-validation.md)) |
| Chrome Web Store dev account ($5 one-time) | Track 2 | [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole) |
| Firefox AMO account (free) | Track 3 | [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) |
| RevenueCat account (**Pro plan** for webhooks) | Track 4 | [app.revenuecat.com](https://app.revenuecat.com) |
| A **Stripe** account | Track 4 (Web Billing) | RC Web Billing settles through Stripe |
| A public **privacy policy URL** + **support URL** | All tracks | Must return HTTP 200; see `docs/app-store-submission.md` for the drafted copy |

---

## Canonical identifiers for this app (use these exact values everywhere)

| Thing | Value |
|-------|-------|
| App name | **Still** |
| Apple bundle id (iOS + Mac, Universal Purchase) | `com.chartash.still` |
| Apple team id | `UM9HVDH3P3` |
| Apple IAP product id (non-consumable) | `still_sync` |
| RevenueCat entitlement id | `still_sync` |
| RevenueCat Apple product id | `still_sync` |
| RevenueCat Web Billing product **and** package id | `still_sync_web` |
| Price | **$1.99 USD** one-time (non-consumable) |
| Firefox add-on id (gecko, permanent) | `still@chartash.com` |
| Supabase project ref | `kikpgrreradotvvefdgd` (us-west-2) |
| Extension host permissions | `youtube.com`, `instagram.com`, `facebook.com`, `tiktok.com` (never `<all_urls>`) |

---

## Supabase Edge Function secrets (set before web Pro + webhooks work)

Set with `supabase secrets set KEY=value --project-ref kikpgrreradotvvefdgd`. Full deploy detail is
in each track and in `docs/CONNECTIONS.md`.

| Secret | Used by | Where it comes from |
|--------|---------|---------------------|
| `REVENUECAT_SECRET_API_KEY` | webhook, checkout (entitlement precheck) | RC → Project → API keys (`sk_…`) |
| `REVENUECAT_WEBHOOK_TOKEN` | `revenuecat-webhook` | You choose it; paste the same value into RC webhook Authorization |
| `REVENUECAT_WEB_BILLING_CHECKOUT_URL` | `create-web-checkout` | RC → Funnels → Purchase Links → **production** Share URL (the `pay.rev.cat/<token>` base) |
| `REVENUECAT_WEB_PRODUCT_ID` | `create-web-checkout` | `still_sync_web` (the offering **package** id) |
| `SUPABASE_JWT_SECRET`, `SUPABASE_URL` | `create-web-checkout` | Auto-injected by Supabase |
| `ENTITLEMENT_WRITER_DB_URL` | `revenuecat-webhook` | Narrow writer-role DB URL (already set) |

(`RC_PUBLIC_KEY` lives in the **iOS/Mac app**, not Supabase — see [`04-revenuecat.md`](04-revenuecat.md).)

---

## Deploy the latest backend before client testing

Every environment receiving the current clients must include migration
`0009_profile_settings_server_clock.sql`, which supplies `write_profile_settings` and the profile
sync metadata columns. Store submission may wait; this database migration may not wait once a client
is installed in that environment.

Before sandbox-testing purchases, deploy the functions, push migrations, and set the web-billing
secrets:

```bash
supabase secrets set \
  REVENUECAT_WEB_BILLING_CHECKOUT_URL='<production pay.rev.cat link>' \
  REVENUECAT_WEB_PRODUCT_ID='still_sync_web' \
  --project-ref kikpgrreradotvvefdgd
supabase functions deploy revenuecat-webhook --project-ref kikpgrreradotvvefdgd \
  --import-map supabase/functions/deno.json
supabase link --project-ref kikpgrreradotvvefdgd
supabase db push                                                # includes migration 0009
supabase functions deploy create-web-checkout --project-ref kikpgrreradotvvefdgd \
  --import-map supabase/functions/deno.json
```

> **`--import-map` is required.** `_shared/pg-store.ts` imports the bare specifier `postgres`, mapped
> in `supabase/functions/deno.json` — but the CLI does not upload that file to the remote bundler on
> its own, so a deploy without the flag fails with `Relative import path "postgres" not prefixed…`
> (HTTP 400). The failure is atomic (nothing partially deploys).

The full Go/No-Go SQL verification + rollback for that migration is in
[`04-revenuecat.md` §6](04-revenuecat.md) and was produced by the deployment-verification review.

---

## How to use the per-track files

Each track file is a standalone checklist: account setup → assets → store listing → privacy →
purchase config → submission → review → post-approval. Do them in any order after RevenueCat, but
respect the per-file prerequisites at the top of each.
