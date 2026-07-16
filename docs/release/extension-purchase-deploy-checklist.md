# Extension purchase spine — deploy checklist (human tasks)

Companion to `docs/plans/2026-07-01-002-feat-extension-purchase-spine-plan.md` (U7).
Everything below is a HUMAN task — the code ships safely with all of it undone
(the spine fails safe to "unavailable"), but users cannot buy from Chrome/Firefox
until this list is complete. Work top to bottom; the order matters.

## 1. Supabase (hosted project `kikpgrreradotvvefdgd`)

- [x] **Custom SMTP** on the hosted project (Auth → SMTP). The built-in sender
      allows ~2-4 emails/hour project-wide — OTP sign-in is unusable without
      this. Blocker for everything below. — VERIFIED live 2026-07-16.
- [ ] **Email templates — BOTH of them**: edit "Magic Link" AND "Confirm signup"
      to include `{{ .Token }}` ONLY (the extension 6-digit code) — do NOT
      include `{{ .ConfirmationURL }}`. Warning: link-prefetching mail scanners
      (Outlook Safe Links etc.) fetch the ConfirmationURL and consume the
      one-time token server-side, breaking the code before the user can type it
      (Supabase documents this under auth email templates → email prefetching);
      the extension flow only needs the code. GoTrue sends **"Confirm signup"**
      — not "Magic Link" — the FIRST time an address signs in via OTP, so
      missing that template means no new customer can ever complete the code
      sign-in. Making the two templates identical is correct: users get one
      consistent email either way. ⚠️ The 2026-07-06 "verified live" note was
      WRONG or the template later regressed: on 2026-07-16 the live "Confirm
      signup" template still carried `{{ .ConfirmationURL }}` — the §1b
      don't-trust-old-notes rule caught it. FIXED 2026-07-16: both templates
      are now token-only and were re-verified end-to-end the same day.
- [x] **Email OTP length = 6** (Auth → Sign In / Providers → Email). The hosted
      project defaulted to 8; the popup's code field accepts exactly 6
      (`supabase/config.toml` pins `otp_length = 6` locally), so an 8-digit code
      cannot be entered at all. — VERIFIED 2026-07-16 (length 6, expiry 3600).
- [x] **Immediately after the template edits**, verify end-to-end: sign in from
      the extension popup with a BRAND-NEW address, then again with the same
      (now-existing) address — the two requests exercise the two different
      templates. For each, enter the emailed 6-digit code in the popup and
      confirm sign-in completes (the email contains no link, so there is
      nothing for a mail scanner to prefetch). — PASS 2026-07-16: both address
      types received token-only emails and signed in end-to-end.
- [x] Confirm hosted OTP settings match expectations: 1h OTP expiry, 60s
      resend cooldown (Auth → Rate limits), and note the hosted refresh-token
      timebox for the U7 verification run. — VERIFIED 2026-07-16 (expiry 3600,
      60s resend).

### 1b. HARD resubmission gates (Apple 1.0 build 4 — plan 2026-07-15-002 R14)

Everything in §1 above is now a HARD gate for the Apple resubmission, not
best-effort setup: the 2.1(a) rejection ("an error message was displayed when
we entered the verification code") is most plausibly one of these items, and
NO client code can compensate for a wrong template or a capped sender — a
prefetch-consumed token looks like a wrong code to a perfect client. Verify
each item against the live dashboard immediately before upload; do not trust
the 2026-07-06 verification note (checkboxes above are still unticked).

Verification methods, per item:

- Dashboard: Auth → SMTP (custom sender active), Auth → Templates (BOTH
  "Magic Link" and "Confirm signup" contain `{{ .Token }}` and contain NO
  `{{ .ConfirmationURL }}` or `{{ .TokenHash }}` link), Auth → Providers →
  Email (`otp_length` 6, expiry 3600), Auth → Rate limits (60s resend).
- Or the Management API (read-only; needs a personal access token from
  app.supabase.com/account/tokens):

  ```bash
  curl -s "https://api.supabase.com/v1/projects/kikpgrreradotvvefdgd/config/auth" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    | jq '{otp_length: .otp_length, otp_exp: .mailer_otp_exp, smtp: .smtp_host,
           magic_has_link: (.mailer_templates_magic_link_content | test("ConfirmationURL|TokenHash")),
           confirm_has_link: (.mailer_templates_confirmation_content | test("ConfirmationURL|TokenHash"))}'
  ```

  Expected: `otp_length` 6, `otp_exp` 3600, `smtp` non-null, both
  `*_has_link` false.

  NOTE: the Management API read above does NOT cover the 60s resend cooldown —
  that gate is dashboard-only (Auth → Rate limits). Check it by eye even when
  the curl passes; a passing curl marks §1b only four-fifths verified.
- **Client-constant pin (R15):** hosted `otp_expiry` mirrors `OTP_TTL_MS` in
  `packages/core/src/ui/controller.svelte.ts` and hosted `otp_length` mirrors
  the sheet's 6-digit input. Changing either hosted value requires changing
  the client constant in the SAME PR — never portal-only.

### 1c. review-signin deploy + config cross-check (HARD gates, R14/R16)

- [ ] Set the function secrets (values from the private submission record —
      NEVER committed; the code is a fresh random 6-digit CSPRNG value minted
      into the gitignored `packages/app-webview/.env.review-signin`, never
      printed):
      `supabase secrets set --env-file packages/app-webview/.env.review-signin --project-ref kikpgrreradotvvefdgd`
      (explicit `--project-ref` — do not rely on a gitignored local `supabase link`).
      Update the private submission record from that file before filling the
      ASC fields.
      Status 2026-07-16: DONE for the current cycle (count 2).
- [ ] Deploy:
      `supabase functions deploy review-signin --import-map supabase/functions/deno.json --project-ref kikpgrreradotvvefdgd`
      Status 2026-07-16: DONE for the current cycle (version 1, ACTIVE, verify_jwt=false).
- [ ] **Cross-check (HARD gate):** the Apple build's `VITE_REVIEW_SIGNIN_EMAIL`
      equals the `REVIEW_SIGNIN_EMAIL` secret exactly. Drift here reproduces
      the un-reviewable dead end for App Review: the client falls back to a
      real email that reviewers can never read.
      Status 2026-07-16: PASS for the current cycle (byte-identical file
      compare; hosted URL + anon key also verified).
      The boxes above stay unchecked by design: they are per-cycle gates, and
      the step-10 rotation (runbook §7) invalidates them — when rotating or
      unsetting the code, clear these status lines in the same commit.
- [ ] **Post-deploy smoke (HARD gate, R16):** (a) real-inbox OTP sign-ins with
      TWO non-review addresses — one BRAND-NEW and one existing (they exercise
      the two different GoTrue templates; "Confirm signup" fires for first-time
      addresses, so a one-address smoke leaves the template every new customer
      hits unproven); (b) one fixed-code sign-in with the review address (the
      only end-to-end proof of the session-mint chain against hosted GoTrue)
      PLUS one wrong-code attempt that must return 401 (proves the gate
      actually rejects). All must pass before Organizer upload. Record results
      as pass/fail + date ONLY — never raw codes, request/response bodies, or
      session tokens (this file is committed).
      Reproducible invocation (values come from the gitignored env file via
      shell expansion — never inline; no auth headers are needed because the
      function pins `verify_jwt = false` in `supabase/config.toml`, and a
      positive-path 200 also proves headers are not the issue for the 401 leg):

      ```bash
      set -a; source packages/app-webview/.env.review-signin; set +a
      URL="https://kikpgrreradotvvefdgd.supabase.co/functions/v1/review-signin"
      curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" -H 'Content-Type: application/json' \
        --data "{\"action\":\"verify\",\"email\":\"$REVIEW_SIGNIN_EMAIL\",\"code\":\"$REVIEW_SIGNIN_CODE\"}"   # expect 200
      # wrong code → expect 401; non-review address → expect 404 (same body shape)
      ```
      Status 2026-07-16: (b) PASS — fixed code 200, wrong code 401, non-review
      address 404, against the hosted function. (a) PASS (later same day) —
      brand-new address (Confirm signup template) and existing address (Magic
      Link template) both received token-only emails and signed in end-to-end,
      after the ConfirmationURL regression above was fixed. All §1b/§1c
      software gates are now green; uploads unblocked.
- [ ] After ALL in-flight platform reviews referencing the code are resolved
      (approved or withdrawn — macOS and iOS run staggered on ONE shared
      code): rotate or `supabase secrets unset REVIEW_SIGNIN_CODE` (unsetting
      disables the whole mechanism server-side; the client falls back to
      normal OTP with no release). Rotating while any submission is in review
      requires updating that submission's App Review notes first.

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

> This section verifies the **purchase** spine. The **free-tier** mobile
> YouTube-Shorts blocking has its own required on-device gate — see
> [`06-mobile-blocking-validation.md`](06-mobile-blocking-validation.md).
> Do both before submitting.
