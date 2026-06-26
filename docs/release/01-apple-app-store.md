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
2. [ ] **Type:** Non-Consumable. **Reference Name:** "Still Sync" (internal). **Product ID:**
       **`still_sync`** ← must exactly match the app code; cannot change later.
3. [ ] **Pricing:** choose **$1.99** (select all territories).
4. [ ] **Display Name** + **Description** (shown at purchase): e.g. "Still Sync" / "Unlock Reels,
       TikTok & Facebook blocking + cross-device sync."
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

## 3. App Privacy → "No Data Collected"

1. [ ] App Store Connect → your app → **App Privacy**.
2. [ ] Work through the questionnaire and answer **No** to every data category. Apple's definition of
       "collect" is *transmitting data off the device*; Still's free tier is fully on-device and the app
       itself ships no analytics SDK, so the label is **"No Data Collected"** — accurate.
3. [ ] Enter the **Privacy Policy URL** (must be live, HTTP 200) and also link it inside the app.

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
2. Visit youtube.com in Safari — the Shorts shelf/tab are removed (free tier).
3. Tap "Unlock Pro" in the app and buy with the sandbox account below to enable Reels/TikTok/Facebook
   removal + sync.

Sandbox tester — email: <your-sandbox@email> / password: <password>

The app collects no data (ITSAppUsesNonExemptEncryption = false). Extension host permissions are
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

- [ ] iOS app **Approved** and released.
- [ ] macOS app **Approved** and released.
- [ ] A sandbox purchase of `still_sync` unlocks Pro and the RevenueCat → Supabase webhook records the
      entitlement (verify in [`04-revenuecat.md` §6](04-revenuecat.md)).
