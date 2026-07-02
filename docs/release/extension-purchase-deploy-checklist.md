# Extension purchase spine — deploy checklist (human tasks)

Companion to `docs/plans/2026-07-01-002-feat-extension-purchase-spine-plan.md` (U7).
Everything below is a HUMAN task — the code ships safely with all of it undone
(the spine fails safe to "unavailable"), but users cannot buy from Chrome/Firefox
until this list is complete. Work top to bottom; the order matters.

## 1. Supabase (hosted project `kikpgrreradotvvefdgd`)

- [ ] **Custom SMTP** on the hosted project (Auth → SMTP). The built-in sender
      allows ~2-4 emails/hour project-wide — OTP sign-in is unusable without
      this. Blocker for everything below.
- [ ] **Email template**: edit the "Magic Link" template to include BOTH
      `{{ .ConfirmationURL }}` (Apple magic-link flow) and `{{ .Token }}`
      (extension 6-digit code). One template serves both flows.
- [ ] **Immediately after the template edit**: verify the Apple magic-link
      sign-in end-to-end (send → email renders both the link and the code →
      link completes sign-in in the app). The template change touches the LIVE
      Apple flow; do not proceed with a broken link.
- [ ] Confirm hosted OTP settings match expectations: 1h OTP expiry, 60s
      resend cooldown (Auth → Rate limits), and note the hosted refresh-token
      timebox for the U7 verification run.

## 2. RevenueCat (Web Billing)

- [ ] Create the **Web Billing product** `still_sync_web`, one-time, **$1.99**,
      attached to the existing `still_sync` entitlement (do NOT create a new
      entitlement — one entitlement, many products).
- [ ] Create the **Web Purchase Link** for it; customize the hosted success
      page copy: header "Pro unlocked", subheader "Head back to the Still
      popup — everything's ready." No redirect URL needed (the extension
      reconciles on popup open and on page-visit nudges).
- [ ] Set the link as the Edge Function secret:
      `supabase secrets set REVENUECAT_WEB_BILLING_CHECKOUT_URL=https://pay.rev.cat/<token>`
      (the function appends the JWT-verified app_user_id itself; never the client).

## 3. Extension build config

- [ ] Create `packages/ext-chromium/.env` from its `.env.example` with the
      production `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` before building
      store artifacts. A build without them ships the spine disabled (fail-safe)
      — fine for Safari, wrong for the Chrome/Firefox store uploads.

## 4. Store listings

- [ ] **Chrome Web Store**: description names the paid tier (Still Pro, $1.99
      one-time unlocks Instagram/TikTok/Facebook + sync), identifies Cadmus
      Labs (not Google) as the seller, and links terms + refund policy.
      Privacy disclosures cover the account email and synced settings.
- [ ] **Firefox AMO**: listing data-collection statements match the manifest's
      `data_collection_permissions: ["authenticationInfo"]`; re-verify AMO's
      current category names at submission (H1-2026 enforcement applies to all
      extensions).

## 5. Support playbook

- [ ] **Post-deletion web-purchase recovery**: Web Billing has no store-side
      restore — deleting a Supabase account permanently orphans a web purchase.
      Playbook: locate the Stripe charge in the RC dashboard by receipt email →
      grant the `still_sync` entitlement to the customer's NEW app_user_id
      (RC customer transfer or promotional grant) → confirm reconcile unlocks.
      Requests arrive via the "Find my purchase" mailto (zack@cadmuslabs.co).

## 6. Sandbox verification run (record results honestly)

- [ ] Buy on web (Chrome) → payoff shows → rows unlock → Safari + iPhone unlock
      via account sign-in.
- [ ] Restore on a second browser: sign in → tap Unlock Pro → 409 path → payoff,
      no second charge.
- [ ] Refund in RC → revocation reaches the extension (popup open reconcile;
      then a page-visit nudge within the 24h staleness window).
- [ ] Offline grace: entitled, then offline → Pro persists from cache; TTL
      semantics unchanged.
- [ ] Self-grant attempt: forge `still:entitlement` in extension storage →
      rows re-lock on the next reconcile; sync writes stay server-rejected
      (RLS on `still_sync`).
- [ ] **Double-purchase window probe**: open a web checkout tab, complete a
      purchase for the same account from another device, then complete the
      stale tab — record whether RC blocks or double-charges. If it
      double-charges, document refund remediation under the Find-my-purchase
      playbook (§5).
- [ ] Paid-but-never-reopened: pay, close everything, visit instagram.com —
      blocking activates via the background nudge without opening the popup.
