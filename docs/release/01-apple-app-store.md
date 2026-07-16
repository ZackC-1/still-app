# Track 1 — Apple App Store (iOS + macOS) + Safari extension + $1.99 IAP

This is the only track where paid Pro is fully wired in the shipping UI, and it has the **longest
review queue** (budget 1–2 weeks for a first submission), so start it early.

**Prerequisites:** RevenueCat configured ([`04-revenuecat.md`](04-revenuecat.md)) so the `.p8` IAP key
and the `still_sync` product/entitlement exist; a Mac with **Xcode 16+**; a physical iPhone and Mac
to test on; the Paid Applications Agreement signed (below).

> **Key facts for this app**
> - One App Store Connect record covers **both** iOS and macOS via **Universal Purchase** (same bundle
>   id `com.chartash.still`). One purchase unlocks Pro on both.
> - The **Safari Web Extension** is *inside* the app — there is no separate Safari extension store.
>   Users install the app, then you walk them through enabling the extension in Safari settings.
> - The IAP product id is **`still_sync`** (matches `apps/apple/Still/Still.storekit` and
>   `PurchaseManager.productID`). Do **not** invent a new id.

---

## 0. Pre-flight: agreements + encryption flag

- [ ] **Sign the Paid Applications Agreement.** [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
      → **Business** → **Agreements**. You cannot ship a paid app or IAP without it.
- [ ] **Enroll in the Apple Small Business Program** (15% instead of 30%; new devs auto-qualify):
      [developer.apple.com/app-store/small-business-program/enroll](https://developer.apple.com/app-store/small-business-program/enroll/)
- [ ] **Confirm the encryption flag** is set in both the iOS and macOS targets' `Info.plist`:
      `ITSAppUsesNonExemptEncryption` = `false` (Still uses only standard HTTPS/TLS → exempt). This
      removes the export-compliance prompt on every upload.
      [docs](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption)

---

## 1. Create the app record (one record, both platforms)

1. [ ] [appstoreconnect.apple.com/apps](https://appstoreconnect.apple.com/apps) → **(+)** → **New App**.
2. [ ] **Platforms:** check **iOS** *and* **macOS**. **Name:** `Still`. **Primary Language:** English (U.S.).
       **Bundle ID:** `com.chartash.still`. **SKU:** any private string (e.g. `STILL-2026`). **User Access:** Full.
3. [ ] **Create.** Record opens in **Prepare for Submission**.

If the bundle id isn't registered yet: [developer.apple.com/account/resources](https://developer.apple.com/account/resources)
→ Identifiers → **(+)** → App IDs → App → description "Still", bundle `com.chartash.still`. (Xcode's
"Automatically manage signing" can also create it for you.)

Docs: [Add a new app](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/) ·
[Universal Purchase](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-platforms)

---

## 2. The In-App Purchase (`still_sync`, $1.99 non-consumable)

1. [ ] App Store Connect → your app → **Monetization → In-App Purchases** → **(+)**.
2. [ ] **Type:** Non-Consumable. **Reference Name:** "Still Pro" (internal). **Product ID:**
       **`still_sync`** ← must exactly match the app code; cannot change later.
3. [x] **Pricing:** choose a **$1.99** U.S. base price. Launch availability is the United States,
       Canada, and the United Kingdom; App Store Connect supplies the local equivalents.
4. [ ] **Display Name** + **Description** (shown at purchase): "Still Pro" / "Block Reels and
       TikTok, and sync across devices." Visually confirm the revised localization saved while the
       IAP is waiting for review.
5. [ ] **Review screenshot:** a shot of the in-app paywall (any 640×920+ image is accepted while testing).
6. [ ] Add at least the **English (U.S.)** localization. Status should reach **Ready to Submit**.

> **Hard rule (Guideline 4.4):** the purchase UI must live in the **container app**, never in the
> Safari extension popup/content script. Still's architecture already does this (the web-billing CTA is
> compiled out of the Apple target). Don't add a buy button to the extension.

Docs: [Create a non-consumable](https://developer.apple.com/help/app-store-connect/manage-in-app-purchases/create-consumable-or-non-consumable-in-app-purchases/)

**Sandbox testers** (to test the purchase without being charged):
- [ ] App Store Connect → **Users and Access** → **Sandbox** → **(+)**. Use an email that is **not** an
      existing Apple ID. On your test device: Settings → Developer (or App Store) → Sandbox Account.
      [docs](https://developer.apple.com/help/app-store-connect/test-in-app-purchases/create-a-sandbox-apple-account/)

---

## 3. App Privacy → declare the account + purchase data

1. [ ] App Store Connect → your app → **App Privacy** → "Collect data?" **Yes**.
2. [ ] Declare exactly four data types (each **Collected = Yes**, **Linked to identity = Yes**,
       **Used for tracking = No**, **Purpose = App Functionality**) — matches the shipped
       `PrivacyInfo.xcprivacy` and [`docs/app-store-submission.md`](../app-store-submission.md) §4:

   | Data | Category → type |
   |---|---|
   | Email (from email-code sign-in, Supabase auth) | Contact Info → **Email Address** |
   | User ID (Supabase UUID) | Identifiers → **User ID** |
   | Purchase history | Purchases → **Purchase History** |
   | Synced settings (Pro sync stores the settings object in Supabase `profiles.settings`) | Other Data → **Other Data Types** |

3. [ ] Do **not** declare browsing/blocking activity — it stays on-device in the extension and is
       never transmitted, so under Apple's definition it is not "collected". Result: **"Data Linked
       to You"** only, no tracking section → no ATT prompt.
4. [ ] Enter the **Privacy Policy URL** (must be live, HTTP 200) and also link it inside the app.

> If you later add an analytics/crash SDK, you must disclose it **and** that SDK must ship a
> `PrivacyInfo.xcprivacy` manifest (enforced since 2024). Keep the dependency tree clean.

Docs: [App privacy details](https://developer.apple.com/app-store/app-privacy-details/)

---

## 4. Listing assets + metadata

Drafted copy (name/subtitle/promo/description/keywords/privacy answers) is in
`docs/app-store-submission.md` and the App Store Connect metadata you already prepared — paste from there.

- [ ] **App icon:** 1024×1024 PNG, no alpha/transparency.
- [ ] **iPhone screenshots:** upload one set at **1290×2796** (6.9"); Apple auto-scales to smaller sizes.
- [ ] **iPad screenshots** (if iPad-enabled): **2064×2752** or 2048×2732 (13").
- [ ] **macOS screenshots:** one of 1280×800 / 1440×900 / 2560×1600 / 2880×1800.
- [ ] **Name** ≤30, **Subtitle** ≤30, **Description** ≤4000, **Keywords** ≤100 (comma, no spaces),
      **Support URL** (HTTP 200), **Copyright** "© 2026 Cadmus Labs".
- [ ] **Age rating** questionnaire (a new 2025 version — complete it or it blocks submission).

Docs: [Screenshot specs](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)

### Review Notes (paste this — pre-empts the #1 extension rejection)

```
Still is a Safari Web Extension that removes short-form video. The extension ships INSIDE this
container app. The app provides native onboarding (walks the user through enabling the extension in
Safari Settings > Extensions > Still), a settings screen, and an about/legal screen — it is not a
repackaged website (re: Guideline 4.2). This is a Safari Web Extension container app per Guideline 4.4.

To test:
1. Install the app; follow onboarding to enable the extension in Safari.
2. Visit youtube.com in Safari — the Shorts shelf/tab are removed (free tier). On **iPhone** this is
   `m.youtube.com`; confirm the Shorts shelf/tab are gone AND a `/shorts/<id>` URL redirects to the
   watch page (mobile is the historically weakest surface — see track 6 below).
3. Tap "Unlock Pro" in the app and buy with the sandbox account below to enable Reels/TikTok/Facebook
   removal + sync.

Sandbox tester — email: <your-sandbox@email> / password: <password>

Data collection is limited to the optional account (email address, user ID, purchase history,
synced settings) as declared in App Privacy; browsing/blocking activity never leaves the device
(ITSAppUsesNonExemptEncryption = false). Extension host permissions are
limited to youtube.com, instagram.com, facebook.com, tiktok.com — never <all_urls>.
```

---

## 5. Build, upload, and attach the IAP

Each platform archives and submits **separately** (iOS approval is independent of macOS).

1. [ ] In Xcode, set the version/build and confirm signing for the **iOS App** target.
       **Product → Archive** (destination "Any iOS Device") → **Distribute App → App Store Connect**.
2. [ ] Repeat for the **macOS App** target (destination "Any Mac").
3. [ ] (Optional) Test via **TestFlight** first — internal testers see builds immediately; the first
       *external* build needs Beta App Review. [testflight](https://developer.apple.com/testflight/)
4. [ ] In the app record's **iOS** tab → select the uploaded **Build**.
5. [ ] Scroll to **In-App Purchases** → **Select** → add **`still_sync`**. *(First-ever IAP must be
       attached to a version submission — it cannot be submitted standalone.)*
6. [ ] Repeat build selection on the **macOS** tab.

---

## 6. Submit + review

1. [ ] On each platform tab: complete every field → **Add for Review** → **Submit to App Review**.
2. [ ] Status flow: *Ready for Review → Waiting for Review → In Review → Approved*. Budget **1–2 weeks**
       for a first submission (2026 queues have been slow). Don't hard-commit a launch date.
3. [ ] After approval choose **Release** (immediately / manual / phased — iOS only).

Docs: [Submitting for review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review)

### Current submission checkpoint

- [x] iOS 1.0 build 3 was submitted — REJECTED July 16 (2.3.2 × 2, promoted-IAP image; see §7).
- [x] macOS 1.0 build 3 was submitted — REJECTED July 15 (5.1.1(v), 2.1(a) × 2, 2.3.2; see §7).
- [x] `still_sync` is attached to the launch submission and **Waiting for Review**.
- [x] iPhone screenshots accepted.
- [x] 13-inch iPad screenshot blocker resolved with
      `docs/release/screenshots/ipad/still-ipad-13-01.jpg`.
- [x] App Review sign-in requirement handled as not required because the free tier is usable without
      account sign-in.
- [x] iOS and macOS Review Information explain extension setup, free testing, Pro testing, optional
      email-code sign-in, privacy, and the Safari-only mobile boundary.
- [x] Both versions are configured for **manual release** after approval.
- [x] App availability and IAP availability are the United States, Canada, and the United Kingdom.
- [x] App Privacy covers four data types: email address, user ID, purchase history, and synced
      settings; all are App Functionality, linked, and not used for tracking.
- [ ] After approval, evaluate Accessibility Nutrition Labels on physical iPhone, iPad, and Mac before
      claiming support. Leave them unclaimed during first-version review.
- [ ] Recheck U.S. App Store Tags after approval; the edit section is not currently available.
- [ ] Before release, visually confirm the Still Pro public description and detailed reviewer notes
      saved. The promotional image field is intentionally EMPTY (see §7 step 6); re-add v3 only
      after approval. Keep the private review screenshot as the real paywall.
- [ ] Do not replace the submitted screenshots with service-logo marketing compositions until the
      third-party-rights risk in `screenshots/store-ready/README.md` is resolved.

---

## Pre-empt the common rejections

- [ ] **4.2 minimum functionality** — real native onboarding + settings + about screens (done in app);
      list them in Review Notes.
- [ ] **4.4.2 host permissions** — manifest scoped to the 4 domains, not `<all_urls>`. ✅ (verified in code)
- [ ] **2.1 completeness** — no crashes, no placeholder copy, Support + Privacy URLs return HTTP 200;
      test on a **real device**.
- [ ] **4.4 IAP-in-extension** — purchase UI only in the container app. ✅ (compiled out of the Apple target)
- [ ] **ITMS-91061** — run Xcode's Privacy Report at archive; no SDK missing a privacy manifest.

---

## Done when

- [ ] **Mobile-Shorts validation passed on a physical iPhone** (iOS Safari `m.youtube.com`) —
      [`06-mobile-blocking-validation.md`](06-mobile-blocking-validation.md) §A. This is the free-tier
      core promise on the weakest surface; do it **before** submitting, not after approval.
- [ ] iOS app **Approved** and released.
- [ ] macOS app **Approved** and released.
- [ ] A sandbox purchase of `still_sync` unlocks Pro and the RevenueCat → Supabase webhook records the
      entitlement (verify in [`04-revenuecat.md` §6](04-revenuecat.md)).

> July 8, 2026 PT note: StoreKit price loading was verified (`Unlock Pro - $1.99`) and the
> RevenueCat → Supabase → app entitlement spine was verified with a promotional grant to a dedicated
> test account. Account identifiers are intentionally omitted. A real Apple sandbox purchase is still
> not proven because the test device's sandbox Apple Account would not stay signed in.

---

## 7. Resubmission after the 5.1.1(v) rejection (July 15, 2026 — purchase-first; now 1.0 build 5)

The macOS 1.0 (3) rejection cited Guideline 5.1.1(v) (registration required before a
non-account-based IAP), 2.1(a) twice (demo account needed; an error entering the verification
code), and 2.3.2 (the IAP promotional image was an app screenshot). The purchase-first flow
(plan `docs/plans/2026-07-15-001`, ADR 0003) resolves 5.1.1 structurally: purchase and Restore
work fully signed out, and sign-in is optional. Resubmit BOTH platforms — they are reviewed
independently against the same guidelines; keep the marketing version on the **1.0 train with
build 5** (bumped from 4 on July 16 so the upload can never collide with the locally-archived —
possibly uploaded — build 4; a rejected version accepts a replacement build; only a RELEASED
train forces a new version). See the July 16 iOS runbook below for the ordered resubmission
steps — it applies to both platforms.

### Portal checklist before resubmitting (human)

- [ ] `still_sync` shows **"Ready to Submit"** and is attached to the 1.0 version — a rejection
      often "returns" the IAP with the binary; re-attach it (the attach UI only appears while an
      IAP is unattached) and name it in the review notes.
- [x] **IAP promotional image DELETED** (2.3.2) — resolved 2026-07-16. The v3 replacement was
      built and is compliant, but App Store Connect would not process the asset (see the
      July 16 runbook below). Deletion is Apple's own offered remedy and removes the 2.3.2
      surface entirely. The image field is **Optional**; Still Pro remains purchasable. Re-add
      `docs/release/screenshots/store-ready/apple/still-pro-iap-v3-1024x1024.jpg` AFTER approval
      (promoted-IAP metadata is version-independent). Compliance rules stay canonical in
      `screenshots/store-ready/README.md`; never upload v1/v2-era art.
- [ ] RevenueCat dashboard → project **restore behavior = "Transfer to new App User ID"** (the
      default; the restrictive setting breaks signed-out restore and is itself a rejection vector).
- [ ] App Store Connect → `still_sync` **Family Sharing stays OFF** (the attach gate assumes
      directly-purchased ownership; AE14).
- [ ] TN3186 sandbox pass on the Mac build: Paid Apps agreement active, product loads, sandbox
      purchase completes (the 2.1(a) OTP error also needs the demo-account update below).
- [ ] App Review Information: update the demo-account section — a demo account is no longer needed
      to verify Pro (sandbox purchase works signed out). For the OPTIONAL sync feature, fill the
      Username field with the review address and the Password field with the fixed verification
      code (plan 2026-07-15-002: the `review-signin` mechanism — Apple's own ASC guidance says to
      provide auth codes "in advance in the Notes field"; the account auto-creates on first
      sign-in, holds no data, and no email is ever sent). Both values come from the private
      submission record and must match the deployed `REVIEW_SIGNIN_EMAIL`/`REVIEW_SIGNIN_CODE`
      secrets EXACTLY — run the §1c cross-check in
      `docs/release/extension-purchase-deploy-checklist.md` first (hard gate).
- [ ] App Privacy label: RevenueCat now configures ANONYMOUSLY at every launch for every user
      (previously post-sign-in only), so device-scoped anonymous purchase identifiers flow to
      RevenueCat for free users too — confirm the Purchases/Identifiers declarations and the
      privacy policy cover this before resubmitting.

### Review notes (paste + adapt per platform)

```text
GUIDELINE 5.1.1 RESOLUTION
We removed the sign-in requirement from the purchase flow. Account creation
is now entirely optional and is used only for the account-based feature of
syncing settings and the Still Pro entitlement across devices and browsers.

To verify (no account or demo credentials needed — a sandbox Apple ID is
sufficient):
1. Launch the app. All free features (YouTube Shorts removal) work with no
   sign-in.
2. Tap "Get Still Pro" and complete the one-time purchase while signed out.
   Pro features (Instagram/Facebook Reels removal, TikTok blocking in
   Safari) unlock immediately on this device.
3. After purchase, an OPTIONAL screen offers "Create free account" to sync
   across devices. It can be dismissed with "Not now"; the purchase remains
   fully functional without an account.
4. "Already purchased? Restore" is available on the same paywall while
   signed out and restores via the App Store receipt.
5. If an account is created, it can be deleted in-app (Settings → Delete
   account).

VERIFYING THE OPTIONAL SYNC FEATURE (demo account)
Sign-in uses an emailed 6-digit code. The demo account below is configured
with a FIXED verification code for App Review — no email is sent or needed,
and the code never expires. If an error appears, simply re-enter the code.
  Email: <review address — fill from the private submission record>
  Code:  <fixed 6-digit code — fill from the private submission record>
Steps: tap "Sign in to Still", enter the email above, tap "Email me a code"
(no email will arrive — this is expected for this account), enter the code
above, and tap "Verify code". Settings then sync across supported browsers
and devices signed into the same account. Relaunching the app may require
signing in again on this platform — that is designed behavior, not a bug.
The account is a normal, privilege-less user and can be deleted in-app.

This build is also reviewed with the still_sync ("Still Pro") in-app
purchase, currently Waiting for Review.
```

Keep the existing Safari-extension enablement steps in the same notes — reviewer confusion is the
top rejection driver; one self-contained script per platform.

### Support notes (staleness bounds — ADR 0003, accepted for v1)

- A refunded user who never opens the app keeps Safari Pro until the stamp's 30-day TTL lapses
  (the app UI re-locks at the next launch/foreground receipt check).
- A paid Safari-only user who doesn't launch the app for 30 days re-locks in Safari; remedy:
  **open the Still app once** (the launch receipt check restamps).
- Offline reinstall with an unreadable receipt: Safari re-locks until the first ONLINE launch
  restamps — automatic recovery, no support action.
- Upgraders from build 3 carry a legacy server-source stamp: a refund observed while offline
  cannot downgrade it through the receipt lane — Safari Pro persists until the first online
  reconcile or the 30-day TTL (a variant of the refund bound above).
- Double purchase (web + Apple) refunds: refund Apple → web/account Pro unaffected; refund web →
  device keeps receipt Pro and the account back-fills from the Apple purchase at the next
  reconcile. Transfer history is queryable in `revenuecat_events` (TRANSFER payloads) for
  "why did my Pro disappear" tickets.

### July 16, 2026 — iOS 1.0 (3) rejected: 2.3.2 × 2 (promoted-IAP image) — ordered resubmission runbook

Apple's iOS review (submission `d8784a58`, review device iPad Air 11-inch M3) raised two
findings, both against the `still_sync` promotional image: it is an app screenshot with text too
small to read, and it references the price. Remediation plan: `docs/plans/2026-07-16-001`. The
compliant v3 artwork is `docs/release/screenshots/store-ready/apple/still-pro-iap-v3-1024x1024.jpg`
(rules canonical in `screenshots/store-ready/README.md`, pinned in CI by
`tests/playwright/store-assets.spec.ts`).

Facts that shape the order (per Apple docs, cited in the origin brainstorm): a metadata rejection
alone needs NO new binary — the same submission stays open, you fix the metadata in ASC and
resubmit. This resubmission nevertheless ships build 5 on both platforms because the 2.1(a)
defense (review-signin) must be live and baked in before a reviewer next attempts sign-in.
Promoted-IAP metadata changes can take ~24h to propagate to public placements; that does not
block resubmission.

Tags: `[repo]` in the fix PR (agent) · `[CLI]` agent-run against hosted Supabase · `[ASC]` human
in App Store Connect · `[device]` human on hardware.

1. `[repo]` v3 image + contract test + build-number bump to 5 — landed in the fix PR.
2. `[CLI]` review-signin backend live, in this exact order (details + hard gates:
   `extension-purchase-deploy-checklist.md` §1c): mint a fresh CSPRNG 6-digit code into a
   gitignored env file (values never printed anywhere) →
   `supabase secrets set --env-file <file> --project-ref kikpgrreradotvvefdgd` →
   `supabase functions deploy review-signin --import-map supabase/functions/deno.json --project-ref kikpgrreradotvvefdgd`
   (the explicit `--project-ref` matters: without it the commands depend on a gitignored local
   `supabase link`, which a fresh clone or another worktree does not have) → curl smoke recording
   HTTP statuses only — the exact reproducible invocation lives in the deploy checklist §1c —
   (fixed code → 200; wrong code → 401; non-review address → 404). ALL before any archive upload.
3. `[CLI]` §1c cross-check: `VITE_REVIEW_SIGNIN_EMAIL` in `packages/app-webview/.env` equals the
   deployed `REVIEW_SIGNIN_EMAIL` byte-for-byte (file-compare exit code, values never printed);
   also confirm `VITE_SUPABASE_URL`/anon key point at the hosted project — a stale value builds a
   clean archive pointed at nothing.
4. `[human dashboard]` §1b hosted-config hard gates against the LIVE dashboard (SMTP, both
   templates token-only, otp_length 6, expiry 3600) — note the 60s resend cooldown is
   dashboard-only (Auth → Rate limits); the Management-API curl does not cover it. Real-inbox OTP
   smoke with BOTH a brand-new and an existing non-review address (two GoTrue templates).
5. `[device/human]` Archives with the review env baked in, build 5:
   - iOS: `apps/apple/scripts/archive.sh` (rebuilds the web bundle + ext-safari first; needs the
     ASC API key env) or Xcode GUI.
   - macOS: NO script exists — before Xcode GUI Product → Archive you MUST run
     `pnpm --filter @still/app-webview build` and `pnpm --filter @still/ext-safari build`;
     the Xcode targets only COPY prebuilt `dist/`, so a GUI archive without the prebuild ships a
     stale bundle with no review branch and no error (silent no-op — highest-consequence failure
     in this flow). Binding check: `shasum packages/app-webview/dist/assets/index-*.js`
     immediately before Product → Archive, then compare against the same file inside the produced
     `.xcarchive` (Show Package Contents → the app's webview resources) — a mismatch means the
     archive picked up a stale bundle.
   - Upload both (Organizer/Transporter/`UPLOAD=1` for iOS).
6. `[ASC]` Portal pass, both platform tabs:
   - **Promotional image — DELETED for this submission (2026-07-16).** The v3 art was built and
     verified compliant, but ASC would not process the upload: the thumbnail rendered as a broken
     placeholder showing only the filename, in **both JPEG and PNG**, across **Chrome, Chrome
     Incognito, and Safari**. Ruled out first, in order: the file itself (1024×1024, baseline
     JPEG, sRGB, no alpha, 72 dpi — every published spec met), browser extensions (Incognito
     reproduced it), and the network (Apple's `*.mzstatic.com` CDN resolved and responded, DNS
     clean, no `/etc/hosts` entries). Conclusion: an ASC-side asset-processing failure with no
     surfaced error. Submitting with a half-processed asset risks a repeat 2.3.2 on an image
     nobody can inspect, so the image was deleted — Apple's rejection letter explicitly offers
     this remedy ("If you have no future plans on promoting this In-App Purchase product, you can
     delete the associated promotional image in App Store Connect"), the field is labeled
     Optional, and App Store Promotion was never configured, so the image only ever reached
     offer-code redemptions. Deleting removes the 2.3.2 surface entirely: no image, nothing to
     reject. **After approval**, retry the v3 upload (Apps → Still → Monetization → In-App
     Purchases → `still_sync` → App Store Image → Choose File), then RE-OPEN the page and confirm
     it actually renders before trusting it. If the field is locked while a submission is open:
     remove `still_sync` from the submission → edit → re-attach (the attach UI only appears while
     unattached) → confirm "Ready to Submit".
   - Scrub price references from promoted metadata: display name ≤ 30 chars, description
     ≤ 45 chars, neither mentioning price (the store shows localized pricing itself).
   - Attach build 5 on EACH platform tab, replacing whatever build is currently attached — iOS
     shows 3; macOS may show 3 or 4 (a local build-4 archive existed; upload state unknown). Do
     not resubmit either tab until it displays build 5. A metadata-style resubmit that leaves an
     old build selected silently discards the entire backend bundle.
   - App Review Information: enable the sign-in toggle; Username = review address, Password =
     fixed code (both from the private submission record / U5 env file); paste the §7 review
     notes (the template above) — they already explain that no email arrives for this account.
7. `[ASC+CLI]` Credentials read-back gate (LAST portal step before resubmit): copy the email and
   code back OUT of the saved ASC fields on BOTH tabs and re-run the §1c fixed-code curl with
   exactly those strings → must return 200. If ASC masks the saved password field, read the code
   back from the review-notes text instead (the template carries it verbatim). Any code re-mint
   re-triggers this gate on both platforms. This is the only check that proves the string pair
   the reviewer will actually type. A 429 during this gate or the next step is the per-email
   verify limiter (10 attempts / 10 min, fail-closed) — wait out Retry-After and continue; do
   NOT re-mint the code for a 429 (a re-mint triggers the change-coupling cascade below).
8. `[device]` On-device pass BEFORE resubmitting: VALIDATION.md items 7–8 (OTP error paths;
   review sign-in lifecycle — type the credentials from the ASC field text, not the private
   record), then the full sandbox checklist items 1–6. Include an iPad or iPad simulator for
   items 7–8: the rejection's review device was an iPad.
9. `[ASC]` Resubmit both platforms on the SAME open submission.
10. `[CLI]` After BOTH platform reviews resolve: rotate or unset `REVIEW_SIGNIN_CODE`
    (`supabase secrets unset REVIEW_SIGNIN_CODE --project-ref kikpgrreradotvvefdgd`; §1c
    rotation gate — do not skip; the mechanism should not outlive the review). In the same
    pass: remove `VITE_REVIEW_SIGNIN_EMAIL` from `packages/app-webview/.env` (a populated value
    silently bakes the review branch into every future Apple archive and re-arms if a later
    cycle sets a code) and clear the §1c status lines per the checklist's rotation note.

**Change-coupling matrix** (what a late change invalidates):

| Change | Requires |
|---|---|
| Review **email** value | Update the U5 env file + re-run `supabase secrets set --env-file … --project-ref kikpgrreradotvvefdgd` (no code re-mint) + re-archive BOTH platforms (build-time env) + update ASC fields/notes both tabs + redo steps 3, 5–8 |
| Review **code** value | Update ASC fields/notes on BOTH tabs FIRST, then the secret; NO rebuild (server-side only); redo step 7 |
| Promotional **image** | ASC upload only (step 6); independent of the binary |
| Any binary change | New build number; redo steps 5–8 |
