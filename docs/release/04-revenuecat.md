# Track 4 — RevenueCat for free Still 2.0

Still 2.0 provides free blocking without an account and optional free settings sync. RevenueCat
identity and historical entitlements remain active; purchases are dormant. Follow the
[strategy](../../STRATEGY.md) and [release overview](README.md) when older paid-launch instructions
below differ. Do not create billing products, buy a test product, connect Stripe, grant entitlements
or upgrade a RevenueCat plan solely to release free 2.0.

## Current release checklist

**Dashboard verification pending.** This checklist identifies the evidence to collect; it does not
assert that live settings have been verified. Record only non-secret outcomes. Keep API keys,
webhook authorization values and customer records out of screenshots, issues and release notes.

- [ ] Keep `PAID_TIER_ENABLED` and `MonetizationConfig.paidTierEnabled` disabled. Free blocking and
      free sync must not depend on a purchase or an active `still_sync` entitlement. Migration
      `0012_profiles_write_free_sync.sql` supersedes the paid-sync checks described below.
- [ ] In the existing Still project, open **Apps & providers** (older UI: **Apps**) and confirm the
      Apple App Store app uses `com.chartash.still`. Confirm the release SDK public key belongs to
      that app/project, rather than Test Store. Check the app's existing credential-health status
      without uploading or rotating anything. A wrong app/key association needs correction; a
      warning needs a concrete impact assessment. [Apps and providers](https://www.revenuecat.com/docs/projects/connect-a-store),
      [release SDK keys](https://www.revenuecat.com/docs/getting-started/configuring-sdk).
- [ ] In **Integrations**, inventory enabled destinations and **Scheduled Data Exports**, including
      environment, feeds and forwarded attribute categories. Resolve any undisclosed recipient or
      advertising/attribution use before privacy publication. An empty integration list is valid;
      add nothing to fill the checklist. [Integrations](https://www.revenuecat.com/docs/integrations/integrations),
      [exports](https://www.revenuecat.com/docs/integrations/scheduled-data-exports).
- [ ] In **Integrations → Webhooks**, inspect the existing destination, enabled status, authorization
      presence, app coverage, event filters and production/sandbox selection. The destination must
      be Still's approved Supabase `/functions/v1/revenuecat-webhook`. Existing delivery results can
      establish success without sending test events or exposing authorization values. Presence
      alone does not prove the header matches the server. Investigate repeated delivery failures;
      absence of new purchases/events is not itself a failure. If the current plan lacks a needed
      feature, record the limitation before proposing a plan change. [Webhook configuration](https://www.revenuecat.com/docs/integrations/webhooks).
- [ ] Preserve `still_sync`, existing products, offerings, keys, webhook configuration and historical
      customers. In **Project settings → General**, record production restore behavior and any
      sandbox override. Do not silently change ownership/transfer behavior or require a purchase
      journey to validate free blocking/sync. [Restore behavior](https://www.revenuecat.com/docs/projects/restore-behavior).
- [ ] Using an existing approved test customer if available, confirm anonymous and UUID-based
      identities without publishing their values. The Apple app configures anonymously at launch,
      calls `logIn` with the Supabase UUID at sign-in and `logOut` on sign-out/account deletion.
      Browser extensions use Supabase; they do not initialize a RevenueCat SDK. The native
      `configurePurchases` bridge carries an account ID, not an email subscriber attribute.
- [ ] Establish customer/event retention, deletion timing, alias handling and downstream export
      deletion with the provider. Still account deletion does not invoke RevenueCat customer
      deletion. Do not infer immediate erasure of purchase records, logs or backups, or an unlimited
      retention exception from the retained identity design. RevenueCat's **Customer → Manage**
      deletion operation is separate and must not be used as a test. Follow the
      [retention inventory](counter-retention.md) and [privacy draft](privacy-retention-draft.md).
      [Customer deletion](https://www.revenuecat.com/docs/dashboard-and-metrics/customer-profile#delete-customer).
- [ ] Reconcile **App Store Connect → Still → App Privacy** and the final privacy notice with the
      retained SDK. RevenueCat's guidance includes Purchase History used for Analytics and App
      Functionality, and User ID when custom identifiers are used. Inventory integrations before
      deciding other categories. Purchase analytics differs from browsing-history collection;
      “only email,” “nothing while signed out” and blanket “no analytics data” claims are unsupported.
      [Apple privacy guidance](https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/apple-app-privacy).

Source checks establish both disabled paid flags and the retained identity calls. Existing tests
cover dormant monetization, identity transitions and mocked webhook/reconcile behavior; they do not
certify dashboard state or provider retention. Deploying the reviewed `review-signin` logging fix
and verifying its hosted source is a separate Supabase release action under the
[retention runbook](counter-retention.md#application-logging-follow-up), not a RevenueCat setting.

## Retained paid-launch reference

The sections below preserve prior setup, purchase and validation procedures for an explicitly
approved future paid release or a demonstrated maintenance issue. Their unchecked items are not
free 2.0 release requirements. Re-verify provider requirements and pricing before using them.
Do not run configuration, secret, purchase, migration or deployment commands as part of a read-only
readiness check.

The prior $1.99 model used the same project-wide `still_sync` entitlement and Supabase account UUID
for Apple and web purchases. RevenueCat documents webhooks as a Pro-plan feature; confirm actual
plan availability before proposing any change. This is retained purchase infrastructure.

> **Exact ids for this app:** entitlement **`still_sync`** · Apple product **`still_sync`** · Web
> Billing product **`still_sync_web`** · prior price **$1.99** one-time (non-consumable) ·
> `app_user_id` = the Supabase user UUID.

---

### 1. Project, apps, keys, and the Apple `.p8`

1. [ ] Sign in at [app.revenuecat.com](https://app.revenuecat.com) → **+ New project** → name it "Still".
2. [ ] **Apps → + New App → App Store**. Bundle id `com.chartash.still`, name "Still". This generates a
       **Public SDK key** (`appl_…`). Add a **second** App Store app for the **Mac** bundle id if it
       differs; both share the project's entitlement.
3. [ ] Put the Public SDK key in the iOS/Mac app as **`REVENUECAT_PUBLIC_API_KEY`** (injected via
       `Config/Secrets.local.xcconfig` → Info.plist `RevenueCatPublicAPIKey`). This is the only RC key
       the apps need.
4. [ ] **Project → API keys** → copy the **Secret API key** (`sk_…`). This is `REVENUECAT_SECRET_API_KEY`
       for the Supabase functions.
5. [ ] **Upload the Apple In-App Purchase key (`.p8`)** (required for StoreKit 2 / SDK v5+):
       - App Store Connect → **Users and Access → Integrations → In-App Purchase** → **Generate In-App
         Purchase Key** → download the `.p8` (one download only) and note the **Issuer ID**.
         [ASC integrations](https://appstoreconnect.apple.com/access/integrations/api)
       - RC → **Project → Apps → [App Store app] → In-app purchase key configuration** → upload the
         `.p8` + Issuer ID → **Save**. Wait for "Valid credentials".

Docs: [Authentication / API keys](https://www.revenuecat.com/docs/projects/authentication) ·
[IAP key configuration](https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/in-app-purchase-key-configuration)

---

### 2. Products → the `still_sync` entitlement → an offering

1. [ ] Make sure the Apple IAP `still_sync` exists in App Store Connect (see
       [`01-apple-app-store.md` §2](01-apple-app-store.md)).
2. [ ] RC → **Product catalog → Products** → App Store tab → **+ New** → identifier `still_sync`, type
       **Non-consumable**.
3. [ ] RC → **Product catalog → Entitlements → + New** → identifier **`still_sync`** → open it →
       **Attach** the Apple `still_sync` product. *(Non-consumables attached to an entitlement unlock it
       forever; entitlements are project-wide → cross-platform.)*
4. [ ] RC → **Product catalog → Offerings → + New** → identifier `default`. Add a **package** for the
       Apple product (type Lifetime / custom id `still_sync`). You'll add the web package in §3.

Docs: [Entitlements](https://www.revenuecat.com/docs/getting-started/entitlements) ·
[Offerings](https://www.revenuecat.com/docs/offerings/overview)

---

### 3. Web Billing → the Web Purchase Link → `REVENUECAT_WEB_BILLING_CHECKOUT_URL`

This is what powers Pro on the Chrome/Firefox extensions via `create-web-checkout`.

1. [ ] **Connect Stripe** (project **owner** only): RC → [account settings](https://app.revenuecat.com/settings/account)
       → **Connect Stripe account** → install the
       [RevenueCat app in Stripe](https://marketplace.stripe.com/apps/revenuecat) → link it back.
       [docs](https://www.revenuecat.com/docs/web/connect-stripe-account)
2. [ ] RC → **Web** section → create a **Web Billing** config, select your connected Stripe account.
3. [ ] **Product catalog → Products** → Web Billing tab → **+ New**: identifier **`still_sync_web`**,
       customer-facing name "Still Pro", type **Non-consumable**, price **$1.99**. *(Price is
       locked after save.)* [product setup](https://www.revenuecat.com/docs/web/web-billing/product-setup)
4. [ ] **Entitlements → still_sync → Attach** the `still_sync_web` product. Now Apple **and** web both
       feed the one entitlement.
5. [ ] Add the web product to the intended offering; preserve any existing package identifier. The
       hosted Purchase Link selects its configured offering and packages; the server does not
       select a package by product ID.
6. [ ] **Funnels → Purchase Links → + New** → billing engine **RevenueCat Web Billing**, your offering +
       web config → brand it → **Save & Publish**. You get a **Production** and a **Sandbox** URL of the
       form `https://pay.rev.cat/<token>`. [web purchase links](https://www.revenuecat.com/docs/web/web-billing/web-purchase-links)

#### Wire it to the function (future paid launch)

- [ ] `REVENUECAT_WEB_BILLING_CHECKOUT_URL` = the **production** `pay.rev.cat/<token>` base (no trailing
      `/<app_user_id>`).

```bash
supabase secrets set \
  REVENUECAT_WEB_BILLING_CHECKOUT_URL='https://pay.rev.cat/<your-token>' \
  --project-ref kikpgrreradotvvefdgd
supabase functions deploy create-web-checkout --project-ref kikpgrreradotvvefdgd \
  --import-map supabase/functions/deno.json
```

Before deploying, read the [dependency configuration note](counter-retention.md#edge-dependency-configuration)
for the legacy import-map argument and CLI 2.107.0 warning.

> **Current retained function behavior.** `create-web-checkout` verifies the Supabase JWT,
> derives `app_user_id` from its `sub`, then returns
> `https://pay.rev.cat/<token>/<app_user_id>` for the browser to open. There
> is **no** RevenueCat checkout-minting API — the link *is* the session. (The earlier code POSTed to a
> non-existent API and would have 502'd; corrected to build the Web Purchase Link.) The client never
> assembles the URL or supplies the id — the server does, from the verified token.
> `REVENUECAT_WEB_PRODUCT_ID` is not read by current code, and no `package_id` query is appended.
>
> **For a future paid launch:** open `…/create-web-checkout` with a real session, confirm it returns your
> `pay.rev.cat` link, complete a **sandbox** purchase (Stripe test card `4242 4242 4242 4242`), and
> confirm the webhook flips the entitlement. **Never distribute the Sandbox Purchase Link** — anyone
> can "buy" with test cards.

---

### 4. Webhook → `revenuecat-webhook`

1. [ ] Pick a strong random token; set it as the Supabase secret and paste the **same** value into RC:
       ```bash
       supabase secrets set REVENUECAT_WEBHOOK_TOKEN='<random-strong-token>' --project-ref kikpgrreradotvvefdgd
       ```
2. [ ] RC → **Integrations → Webhooks → Add new configuration**:
       - **URL:** `https://kikpgrreradotvvefdgd.supabase.co/functions/v1/revenuecat-webhook`
       - **Authorization header value:** exactly your `REVENUECAT_WEBHOOK_TOKEN`. **No `Bearer ` prefix**
         — the function compares the raw header (a `Bearer ` mismatch is the classic 401).
       - **Environment:** "both" for testing, "production" for the live config.
3. [ ] Relevant events for a one-time purchase: `NON_RENEWING_PURCHASE`, `INITIAL_PURCHASE`,
       `CANCELLATION` (refund), `TRANSFER`. The function re-derives entitlement from canonical subscriber
       state, so it's robust to event ordering/duplicates.

Docs: [Webhooks](https://www.revenuecat.com/docs/integrations/webhooks)

---

### 5. Customer identity across supported surfaces

- **Apple app:** `PurchaseManager.configure()` initializes anonymously at launch;
  `configure(appUserID:)` calls `logIn` with the Supabase UUID at sign-in. `reset()` calls `logOut`
  on sign-out/account deletion. The public build setting is `REVENUECAT_PUBLIC_API_KEY`, exposed
  through Info.plist `RevenueCatPublicAPIKey`. Settings sync starts independently of this rekeying.
- **Web:** `create-web-checkout` embeds the JWT-verified UUID in the Purchase Link — no separate call.
- Because the `still_sync` entitlement is project-scoped, any purchase tied to that UUID makes
  `entitlements["still_sync"].isActive == true` on Apple and web alike.
- **Restore decision rule:** a Supabase account with `still_sync = true` auto-provisions Pro after
  sign-in/reconcile and does not need a Restore button. An unentitled signed-in account should see the
  upgrade path plus a secondary Apple `Restore purchase` button in the paywall. Restore is for Apple
  receipt recovery: reinstall/new Apple device, or an Apple ID that already owns the non-consumable
  while the current Supabase account is not yet entitled. If Apple/RevenueCat finds the purchase,
  reconcile should provision the signed-in Supabase account. Web purchase restore remains sign in →
  backend reconcile.

Docs: [Identifying customers](https://www.revenuecat.com/docs/customers/identifying-customers)

---

### 6. Sandbox test, then the Supabase Go/No-Go

#### Sandbox (future paid launch)

- [ ] **Apple:** buy `still_sync` with a sandbox tester → webhook event has `environment: SANDBOX` →
      entitlement recorded.
- [ ] **Web:** open the **Sandbox** Purchase Link, pay with Stripe test card `4242 4242 4242 4242` →
      webhook records the entitlement. [sandbox docs](https://www.revenuecat.com/docs/test-and-launch/sandbox)

#### July 8, 2026 PT entitlement validation (historical)

- [x] Apple offering/product lookup reached the device paywall: `Unlock Pro - $1.99`.
- [x] RevenueCat dashboard promotional grant for `still_sync` was applied to a dedicated test
      account. Account identifiers are intentionally omitted from the repository.
- [x] App reconcile flipped Supabase `public.entitlements.still_sync` to `true` with `source =
      reconcile`.
- [x] App showed `Synced across your devices`.
- [ ] Real Apple sandbox purchase is still unverified because the physical device could not keep a
      sandbox Apple Account signed in. The current evidence points to Apple sandbox auth/device
      flakiness, not an offering or Supabase entitlement issue.

#### Prior paid-sync verification (migrations `0008` and `0009`)

**Historical only:** migration `0012_profiles_write_free_sync.sql` removed the entitlement gate
for current free sync. Do not apply these old denial expectations to Still 2.0 or reverse that
migration during release preparation. Migration `0008` gated profile writes by entitlement;
migration `0009` added the server-authoritative settings RPC. The earlier checks were:

```sql
-- after `supabase db push`: confirm 0008 applied and the policies swapped
select policyname, cmd from pg_policies where tablename='profiles' order by policyname;
-- expect: 'profiles: insert own entitled', 'profiles: update own entitled', 'profiles: read own'

-- un-entitled write is denied (run as an un-entitled user via a rolled-back txn)
begin;
  set local role authenticated;
  set local "request.jwt.claims" = '{"sub":"<un-entitled-uuid>","role":"authenticated"}';
  insert into public.profiles (id, settings, updated_at) values ('<un-entitled-uuid>', '{}', now());
  -- expect: ERROR new row violates row-level security policy
rollback;
```

- [ ] **Rollback is documented** at the bottom of
      `supabase/migrations/0008_profiles_write_requires_entitlement.sql` (only revert if entitled users
      are wrongly blocked — it re-opens the write path).
- [ ] **Monitor post-deploy:** `revenuecat-webhook` 5xx (`reconcile_failed`) rate, `create-web-checkout`
      502 (`checkout_unavailable` → a missing/incorrect `REVENUECAT_WEB_BILLING_CHECKOUT_URL`), and any
      403 on `/rest/v1/profiles` for an *entitled* user (entitlement-check bug).

---

### Prior paid-launch checklist (not required for free 2.0)

- [ ] Apple Paid Applications Agreement signed; `.p8` uploaded to RC ("Valid credentials").
- [ ] `still_sync` entitlement has **both** `still_sync` (Apple) and `still_sync_web` (web) attached.
- [ ] Stripe connected to a **live** account; `still_sync_web` published.
- [ ] `REVENUECAT_WEB_BILLING_CHECKOUT_URL` = **production** Purchase Link with the intended offering.
      Package selection is configured in the dashboard, not by a `REVENUECAT_WEB_PRODUCT_ID` setting.
- [ ] Webhook points at the production function URL; Authorization token matches; RC **Pro plan** active.
- [ ] Sandbox purchase verified on **both** Apple and web before flipping anything live.
