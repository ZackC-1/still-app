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

- [x] iOS 1.0 build 3 is **Waiting for Review**.
- [x] macOS 1.0 build 3 is **Waiting for Review**.
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
- [ ] Before release, visually confirm the Still Pro public description, brand-safe promotional image,
      and detailed reviewer notes saved. Keep the private review screenshot as the real paywall.
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
