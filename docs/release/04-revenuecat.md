# Track 4 — RevenueCat (the cross-platform $1.99 spine)

RevenueCat is the shared backbone for Pro on **every** platform. A purchase on Apple **or** on the web
both grant the same project-wide `still_sync` entitlement to the same `app_user_id` (the Supabase auth
UUID), so one $1.99 unlocks Pro everywhere. **Webhooks require the RevenueCat Pro plan.**

> **Exact ids for this app:** entitlement **`still_sync`** · Apple product **`still_sync`** · Web
> Billing product **and** package **`still_sync_web`** · price **$1.99** one-time (non-consumable) ·
> `app_user_id` = the Supabase user UUID.

---

## 1. Project, apps, keys, and the Apple `.p8`

1. [ ] Sign in at [app.revenuecat.com](https://app.revenuecat.com) → **+ New project** → name it "Still".
2. [ ] **Apps → + New App → App Store**. Bundle id `com.chartash.still`, name "Still". This generates a
       **Public SDK key** (`appl_…`). Add a **second** App Store app for the **Mac** bundle id if it
       differs; both share the project's entitlement.
3. [ ] Put the Public SDK key in the iOS/Mac app as **`RC_PUBLIC_KEY`** (injected via
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

## 2. Products → the `still_sync` entitlement → an offering

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

## 3. Web Billing → the Web Purchase Link → `REVENUECAT_WEB_BILLING_CHECKOUT_URL`

This is what powers Pro on the Chrome/Firefox extensions via `create-web-checkout`.

1. [ ] **Connect Stripe** (project **owner** only): RC → [account settings](https://app.revenuecat.com/settings/account)
       → **Connect Stripe account** → install the
       [RevenueCat app in Stripe](https://marketplace.stripe.com/apps/revenuecat) → link it back.
       [docs](https://www.revenuecat.com/docs/web/connect-stripe-account)
2. [ ] RC → **Web** section → create a **Web Billing** config, select your connected Stripe account.
3. [ ] **Product catalog → Products** → Web Billing tab → **+ New**: identifier **`still_sync_web`**,
       customer-facing name "Still Sync Pro", type **Non-consumable**, price **$1.99**. *(Price is
       locked after save.)* [product setup](https://www.revenuecat.com/docs/web/web-billing/product-setup)
4. [ ] **Entitlements → still_sync → Attach** the `still_sync_web` product. Now Apple **and** web both
       feed the one entitlement.
5. [ ] Add a **package** to your offering with id **`still_sync_web`** → attach the web product. The
       package id must equal `REVENUECAT_WEB_PRODUCT_ID`.
6. [ ] **Funnels → Purchase Links → + New** → billing engine **RevenueCat Web Billing**, your offering +
       web config → brand it → **Save & Publish**. You get a **Production** and a **Sandbox** URL of the
       form `https://pay.rev.cat/<token>`. [web purchase links](https://www.revenuecat.com/docs/web/web-billing/web-purchase-links)

### Wire it to the function

- [ ] `REVENUECAT_WEB_BILLING_CHECKOUT_URL` = the **production** `pay.rev.cat/<token>` base (no trailing
      `/<app_user_id>`).
- [ ] `REVENUECAT_WEB_PRODUCT_ID` = `still_sync_web`.

```bash
supabase secrets set \
  REVENUECAT_WEB_BILLING_CHECKOUT_URL='https://pay.rev.cat/<your-token>' \
  REVENUECAT_WEB_PRODUCT_ID='still_sync_web' \
  --project-ref kikpgrreradotvvefdgd
supabase functions deploy create-web-checkout --project-ref kikpgrreradotvvefdgd
```

> **How the function uses it (fixed in this PR).** `create-web-checkout` verifies the Supabase JWT,
> derives `app_user_id` from its `sub`, then returns
> `https://pay.rev.cat/<token>/<app_user_id>?package_id=still_sync_web` for the browser to open. There
> is **no** RevenueCat checkout-minting API — the link *is* the session. (The earlier code POSTed to a
> non-existent API and would have 502'd; corrected to build the Web Purchase Link.) The client never
> assembles the URL or supplies the id — the server does, from the verified token.
>
> ✅ **Verify at launch:** open `…/create-web-checkout` with a real session, confirm it returns your
> `pay.rev.cat` link, complete a **sandbox** purchase (Stripe test card `4242 4242 4242 4242`), and
> confirm the webhook flips the entitlement. **Never distribute the Sandbox Purchase Link** — anyone
> can "buy" with test cards.

---

## 4. Webhook → `revenuecat-webhook`

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

## 5. Customer identity (one purchase, every platform)

- **Apple app:** configure RevenueCat with `appUserID` = the Supabase user UUID at sign-in
  (`Purchases.configure(withAPIKey: RC_PUBLIC_KEY, appUserID: supabaseUUID)`), and `logOut()` on
  sign-out (already implemented in `PurchaseManager`).
- **Web:** `create-web-checkout` embeds the JWT-verified UUID in the Purchase Link — no separate call.
- Because the `still_sync` entitlement is project-scoped, any purchase tied to that UUID makes
  `entitlements["still_sync"].isActive == true` on Apple and web alike.

Docs: [Identifying customers](https://www.revenuecat.com/docs/customers/identifying-customers)

---

## 6. Sandbox test, then the Supabase Go/No-Go

### Sandbox
- [ ] **Apple:** buy `still_sync` with a sandbox tester → webhook event has `environment: SANDBOX` →
      entitlement recorded.
- [ ] **Web:** open the **Sandbox** Purchase Link, pay with Stripe test card `4242 4242 4242 4242` →
      webhook records the entitlement. [sandbox docs](https://www.revenuecat.com/docs/test-and-launch/sandbox)

### Backend deploy verification (the RLS migration `0008`)
Before going live, run the deployment-verification checklist (from the PR review). Key checks:

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

## Production checklist

- [ ] Apple Paid Applications Agreement signed; `.p8` uploaded to RC ("Valid credentials").
- [ ] `still_sync` entitlement has **both** `still_sync` (Apple) and `still_sync_web` (web) attached.
- [ ] Stripe connected to a **live** account; `still_sync_web` published.
- [ ] `REVENUECAT_WEB_BILLING_CHECKOUT_URL` = **production** Purchase Link; `REVENUECAT_WEB_PRODUCT_ID` =
      `still_sync_web`.
- [ ] Webhook points at the production function URL; Authorization token matches; RC **Pro plan** active.
- [ ] Sandbox purchase verified on **both** Apple and web before flipping anything live.
