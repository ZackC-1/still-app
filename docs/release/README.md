# Still — Release Runbook (first-time launch)

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
| 1 | **Apple App Store** (iOS + Mac) — [`01-apple-app-store.md`](01-apple-app-store.md) | Native app + Safari extension + **$1.99 IAP** | StoreKit 2 → RevenueCat | Code ready; needs human Xcode/device + ASC steps |
| 2 | **Chrome Web Store** — [`02-chrome-web-store.md`](02-chrome-web-store.md) | Chromium extension | RevenueCat **Web Billing** | Free tier ready; Pro web-UI is U8/U10 (server ready) |
| 3 | **Firefox Add-ons (AMO)** — [`03-firefox-amo.md`](03-firefox-amo.md) | Firefox extension (new MV3 build) | RevenueCat **Web Billing** | Build added in this PR; free tier ready |
| 4 | **RevenueCat** — [`04-revenuecat.md`](04-revenuecat.md) | Cross-platform $1.99 entitlement | — | Configure once; powers Apple **and** web Pro |
| — | **Google Play** (future) — [`05-future-google-play.md`](05-future-google-play.md) | — | — | **No Android app exists** — documented as future work |

> **Read [`04-revenuecat.md`](04-revenuecat.md) early.** RevenueCat is the shared spine for Pro on
> *every* platform. Apple IAP Pro and web Pro both resolve to the same `still_sync` entitlement.

### ⚠️ One thing to verify before web Pro goes live

The web checkout (`create-web-checkout`) now builds a RevenueCat **Web Purchase Link**
(`https://pay.rev.cat/<token>/<user-uuid>?package_id=still_sync_web`). The previous code POSTed to a
checkout API that does not exist and would have 502'd every web purchase — fixed in this PR. You must
still confirm `REVENUECAT_WEB_BILLING_CHECKOUT_URL` matches your live Purchase Link and sandbox-test
the open→pay→entitlement flow. See [`04-revenuecat.md` §3](04-revenuecat.md).

---

## Recommended order for a first launch

1. **RevenueCat dashboard config** ([`04`](04-revenuecat.md)) — products, the `still_sync` entitlement,
   Apple `.p8`, Web Billing + Purchase Link, webhook. Nothing monetized works until this exists.
2. **Apple App Store** ([`01`](01-apple-app-store.md)) — the only track with paid Pro fully wired in
   the shipping UI today, and the **longest review queue** (budget 1–2 weeks), so start it early.
3. **Chrome Web Store** ([`02`](02-chrome-web-store.md)) — fast ($5, no hardware). Ships the **free**
   Shorts remover now; the in-extension Pro CTA is U8/U10 follow-on (the server side is ready).
4. **Firefox AMO** ([`03`](03-firefox-amo.md)) — free extension, same Pro note as Chrome.

> **Why the extensions launch free-first.** The Apple apps have the StoreKit paywall wired. The
> browser extensions' in-product "Unlock Pro" UI (Supabase sign-in + Web Billing CTA) is deferred
> work (units U8/U10 in `docs/monetization-design.md`); the entitlement cache currently defaults to
> free, so the extensions ship as the free Shorts remover and gain Pro when that UI lands. The
> RevenueCat Web Billing plumbing you set up now is what that UI will call.

---

## Prerequisites (have these before you start)

| Need | For | Notes |
|------|-----|-------|
| Apple Developer Program ($99/yr) | Track 1 | ✅ Enrolled — team **UM9HVDH3P3** |
| A Mac with **Xcode 16+** | Track 1 | Required for all App Store uploads (2025+) |
| A physical iPhone + Mac to test | Track 1 | Safari-extension review needs real on-device proof |
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

## Deploy the latest backend before any store testing

The monetization remediation (PR #24) is merged. Before sandbox-testing purchases, deploy the
functions and the new RLS migration, and set the two new web-billing secrets:

```bash
supabase secrets set \
  REVENUECAT_WEB_BILLING_CHECKOUT_URL='<production pay.rev.cat link>' \
  REVENUECAT_WEB_PRODUCT_ID='still_sync_web' \
  --project-ref kikpgrreradotvvefdgd
supabase functions deploy revenuecat-webhook --project-ref kikpgrreradotvvefdgd
supabase db push --project-ref kikpgrreradotvvefdgd            # applies 0008 RLS (entitled-write gate)
supabase functions deploy create-web-checkout --project-ref kikpgrreradotvvefdgd
```

The full Go/No-Go SQL verification + rollback for that migration is in
[`04-revenuecat.md` §6](04-revenuecat.md) and was produced by the deployment-verification review.

---

## How to use the per-track files

Each track file is a standalone checklist: account setup → assets → store listing → privacy →
purchase config → submission → review → post-approval. Do them in any order after RevenueCat, but
respect the per-file prerequisites at the top of each.
