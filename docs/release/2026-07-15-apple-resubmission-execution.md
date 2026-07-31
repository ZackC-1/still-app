# Apple resubmission execution — 1.0 build 4 (both platforms)

Single ordered runbook from merged `main` to App-Store approval, tying together the pieces that
now live in `01-apple-app-store.md` §7, `extension-purchase-deploy-checklist.md` §1b/§1c, and
`VALIDATION.md`. Everything below is **human-gated / external-state** — the code is done and on
`main` (`774a700`). Work top to bottom; the phase order matters (backend before build, build
before portal, portal before submit).

## Rejection items — status

| # | Guideline | Item | Status |
|---|---|---|---|
| 1 | 5.1.1(v) | Registration required before a non-account IAP | ✅ Shipped — purchase-first (PR #111, ADR 0003) |
| 2 | 2.1(a) | "An error message was displayed when we entered the verification code" | ✅ Shipped — OTP error path (PR #112) |
| 3 | 2.1(a) | Demo account needed to verify the optional login | ✅ Shipped — `review-signin` fixed-code sign-in (PR #112) |
| 4 | 2.3.2 | IAP promotional image is an app screenshot | ⬜ Portal-only (Phase C) |
| 5 | — | `still_sync` IAP "returned" with the rejected build | ⬜ Portal-only (Phase C) |

Items 1–3 required code and are merged. Items 4–5 and every step below are operational.

The macOS 1.0(3) rejection and the pending iOS submission are reviewed independently against the
same guidelines. Resubmit **both** on the **1.0 train, build 4** (a rejected version accepts a
replacement build; only a *released* train forces a new version number).

---

## Phase A — Backend (must land before the build is archived)

These are the actual fix for the original 2.1(a) verification-code error: no client code can
compensate for a wrong template or a capped sender. Verify each against the live hosted dashboard
(project `kikpgrreradotvvefdgd`) or the Management API. Full detail + the read-only `curl` in
`extension-purchase-deploy-checklist.md` §1b.

- [ ] **Custom SMTP active** (Auth → SMTP) — the built-in sender caps at ~2 emails/hour project-wide.
- [ ] **Both templates token-only** — "Magic Link" AND "Confirm signup" contain `{{ .Token }}` and
      NO `{{ .ConfirmationURL }}`/`{{ .TokenHash }}` link (link-prefetch consumes the shared token →
      the exact "wrong code" the reviewer saw).
- [ ] **`otp_length` = 6**, **`otp_expiry` = 3600** (matches the client `OTP_TTL_MS`), resend 60s.
- [ ] **Deploy `review-signin`** (§1c): `supabase secrets set REVIEW_SIGNIN_EMAIL=<review address>
      REVIEW_SIGNIN_CODE=<random 6 digits>` (values from the private submission record — never
      committed), then `supabase functions deploy review-signin --import-map supabase/functions/deno.json`.
- [ ] **Post-deploy smoke** (HARD gate): one real-inbox OTP sign-in with a **non-review** address
      end-to-end (proves normal users + templates + SMTP), AND one fixed-code sign-in with the review
      address (the only end-to-end proof of the session-mint chain against hosted GoTrue).

---

## Phase B — Build (from merged `main` `774a700`)

- [ ] **Set the Apple-build-only env** before building the app-webview bundle:
      `VITE_REVIEW_SIGNIN_EMAIL=<review address>` in `packages/app-webview/.env` (gitignored). It
      must equal the `REVIEW_SIGNIN_EMAIL` secret **exactly** — the **client↔server cross-check is a
      HARD upload gate**; drift reproduces the un-reviewable dead end for App Review (the client's
      fallback email lands in an inbox reviewers can't read).
- [ ] **Re-archive iOS + macOS build 4** from merged main — the archives built earlier in the day
      predate PR #112 and must be rebuilt so build 4 carries the OTP fix + review-signin client.
      (iOS via `scripts/archive.sh` or Xcode; macOS via Xcode — an App Manager API key can't
      cloud-sign a Mac export.)
- [ ] **On-device sandbox pass** — run the full `VALIDATION.md` checklist (items 1–8), which now
      includes: the rate-limit UX (wait copy + locked button), the review-signin fixed-code sign-in
      on a real device (also the WKWebView `file://`-origin CORS check), and the full reviewer
      lifecycle (sign in → sandbox purchase → attach → toggle a setting on a 2nd surface → delete
      account → re-sign-in → restore → reconcile lands Pro on the new account).

---

## Phase C — App Store Connect portal (both platforms)

Detail + the paste-ready review-notes text in `01-apple-app-store.md` §7.

- [ ] **iOS**: developer-reject the in-review 1.0(3) so build 4 can replace it on the 1.0 train.
- [ ] **Re-attach `still_sync`** → "Ready to Submit"; name it in the review notes (item 5).
- [ ] **Delete the IAP promotional image** (item 4 / 2.3.2) — replace later with non-screenshot art.
- [ ] RevenueCat restore behavior = **Transfer to new App User ID**; `still_sync` **Family Sharing
      OFF**; App Privacy label covers the anonymous purchase identifier (RC configures anonymously at
      every launch now).
- [ ] **App Review Information** (both platforms):
      - Notes: paste the §7 template (sign-in optional; sandbox purchase verifies Pro with no account).
      - Demo account for the optional sync feature: **Username** = review address, **Password** =
        the fixed 6-digit code (both filled from the private record, matching the deployed secrets).
        Add the §7 note: "no email is sent — the code is fixed for App Review and never expires;
        if an error appears, re-enter the code."

---

## Phase D — Upload + submit

- [ ] Upload both archives via **Xcode Organizer** (macOS must go through Organizer; iOS can too).
- [ ] Attach build 4 to the 1.0 version on each platform; submit.

---

## Coordination notes

- **Do not rotate the review code while any submission referencing it is still in review.** macOS
  and iOS run on staggered timelines sharing one `REVIEW_SIGNIN_CODE`; rotating after the first
  approval would strand the second reviewer with a dead code. Rotate/unset only once **all**
  in-flight reviews are resolved (`01-apple-app-store.md` §7, plan R13).
- **Browser stores are unaffected** — no version bump; the shared-core OTP fix ships with the next
  natural extension release. Chrome 1.0.1 live, AMO 1.0.2 in review, 1.0.3 staged.
- **Secrets never enter the repo** (public): the review address + code live only in the private
  submission record, App Store Connect, and `supabase secrets` / the gitignored Apple `.env`.
