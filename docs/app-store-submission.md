# Still — iOS App Store submission package

Everything needed to submit **Still** (iOS) to the App Store: paste-ready App Review notes, a
step-by-step App Store Connect checklist, and the status of every known rejection risk.

- App: **Still** · bundle `com.chartash.still` · extension `com.chartash.still.Extension`
- Team **UM9HVDH3P3** (Zachary Chartash / Cadmus Labs) · archive scheme **`Still (iOS)`**
- Listing copy + privacy-label answers: see the `still-appstore-metadata` memory note.

> Current as of June 2026 (researched against Apple's live guidelines/help). The macOS app is a
> separate, later Mac App Store track — this doc is the **iOS** submission.

---

## A. Code-side rejection-preempts — status

These are the things App Review rejects content-blocker / IAP apps for. Where it's code, it's done:

| Risk (guideline) | Status |
|---|---|
| Reviewer can't enable the extension → "non-functional" (2.1) | ✅ In-app onboarding guides it (PR #18: names the 4 sites, live auto-confirm) **+** reviewer notes below |
| Thin wrapper for an extension (4.2) | ✅ Host app has real onboarding, per-service toggles, status, account UI |
| Non-consumable needs **Restore Purchases** (3.1.1) | ✅ "Restore purchase" button in `PaywallSheet.svelte` → `controller.beginRestore()` → native restore |
| In-app **account deletion** (5.1.1(v)) | ✅ Account section → "Delete account" removes the server record (PR #8) |
| Privacy manifest / required-reason APIs | ✅ `PrivacyInfo.xcprivacy` in app + extension |
| Export-compliance prompt every upload | ✅ `ITSAppUsesNonExemptEncryption = NO` in both app Info.plists (HTTPS-only, exempt) |
| Over-broad host permissions | ✅ Extension scoped to the 4 domains, not `<all_urls>` |
| Sign in with Apple equivalence (4.8) | ✅ SIWA is the only social login → 4.8 satisfied (keep SIWA if you ever add Google) |
| **Third-party logos in icon/screenshots (5.2.1)** | ⚠️ **OPEN — see §D.** Icon is clean (balance mark); the in-app service rows use real brand logos |

---

## B. Notes for App Review — paste into App Store Connect

> App Store Connect → version → **App Review Information → Notes**. Set "Sign-in required?" → **No**
> (blocking needs no account); leave the demo-account fields blank.

```
Still is a Safari web-extension content blocker that removes short-form video (YouTube Shorts,
Instagram Reels, TikTok, Facebook Reels) from Safari. The host app is the settings/onboarding UI;
all blocking is done by the bundled Safari extension. The core blocking is 100% FREE — no account,
no purchase, and NO demo account is required to evaluate it.

IMPORTANT: The Safari extension must be manually enabled and granted per-site permission. This is
expected iOS behavior (an Apple security boundary), not a bug — the app cannot auto-enable it. Our
in-app onboarding walks users through the same steps below.

STEP 1 — ENABLE THE EXTENSION
  • iOS 18 and later:  Settings → Apps → Safari → Extensions → "Still" → toggle ON
  • iOS 17 and earlier: Settings → Safari → Extensions → "Still" → toggle ON
  (In-Safari alternative: tap the "Aa"/puzzle-piece button in the address bar → Manage Extensions.)

STEP 2 — GRANT PERMISSION ON THE 4 SITES
  Under the Still extension, set Permissions to "Allow" for youtube.com, instagram.com, tiktok.com,
  facebook.com — choose "Always Allow" for each.

STEP 3 — VERIFY BLOCKING (in Safari)
  • youtube.com → the Shorts shelf is removed (toggle the extension OFF + reload to see it reappear)
  • instagram.com → Reels removed
  • facebook.com → Reels removed
  • tiktok.com → the whole site shows a "This site is blocked" page

OPTIONAL — NOT NEEDED TO EVALUATE THE APP
  • Sign in with Apple is optional, used only to enable settings Sync. Not required for blocking.
  • One non-consumable IAP: "Still Sync" (still_sync), $1.99 — syncs settings across iPhone/iPad/Mac.
    Blocking does NOT require it. To test: Account section → Sign in with Apple (your own sandbox
    Apple ID is fine) → purchase Still Sync. "Restore Purchases" is on the same screen.

ACCOUNT DELETION (5.1.1): Account section → "Delete Account" removes the server-side record.

Privacy policy: https://zackc-1.github.io/still-app/privacy.html
Support: https://zackc-1.github.io/still-app/support.html
```

---

## C. App Store Connect checklist

Legend: **[ONE-TIME]** = account/app setup done once · **[PER-RELEASE]** = repeat each version.

### 0. Sanity checks
- [ ] **[ONE-TIME]** Enrolled in the Apple Developer Program under Cadmus Labs, Team `UM9HVDH3P3`.
- [ ] **[PER-RELEASE]** Privacy + support URLs open in a **private** browser window (a dead privacy URL is a common auto-rejection):
  - Privacy `https://zackc-1.github.io/still-app/privacy.html` · Support `https://zackc-1.github.io/still-app/support.html`
- [ ] **[PER-RELEASE]** A **Sandbox** tester Apple ID exists (Users and Access → Sandbox → Test Accounts) for IAP testing.

### 1. One-time account & signing setup **[ONE-TIME]**
- [ ] **Business → Agreements**: the **Paid Applications Agreement** is **Active** (required even for a free app, because it ships an IAP). Complete banking + tax under Cadmus Labs.
- [ ] App ID `com.chartash.still` has **App Groups + Sign in with Apple + In-App Purchase**; the extension App ID has **App Groups**; both share the **same** App Group.
- [ ] An **Apple Distribution** certificate exists for the team. *(You currently have only an Apple Development cert — the first `archive.sh` run, or Xcode → Settings → Accounts → Manage Certificates → +, creates the Distribution cert.)*
- [ ] **App Store** provisioning profiles resolve for **both** the app and the extension App IDs (archive uses `-allowProvisioningUpdates`).
- [ ] Create an **App Store Connect API key** (Users and Access → Integrations → Keys, **App Manager** role). Download `AuthKey_*.p8` once; note the **Key ID** and **Issuer ID**.

### 2. App record **[ONE-TIME]**
- [ ] **Apps → + → New App**: Platform **iOS**, Name **Still: Block Shorts & Reels**, Primary language **English (U.S.)**, Bundle ID **`com.chartash.still`** (the existing App ID), SKU e.g. `still-ios-001`.
- [ ] **Pricing and Availability → Price: Free** (the IAP is priced separately).
- [ ] **App Information**: **Privacy Policy URL** = the live URL above (a *separate required field* — the nutrition label does not replace it); **Category** Primary **Utilities**; **Age Rating** → expect **4+**.

### 3. Create `still_sync` IAP and ATTACH IT TO THE VERSION **[ONE-TIME create / PER-RELEASE attach]**
> A brand-new app's **first IAP must be submitted *with* the first app version**, or it's stuck at "Missing Metadata" forever and never reviewed.
- [ ] **Monetization → In-App Purchases → +** → **Non-Consumable**. Reference Name `Still Sync`, **Product ID `still_sync`** (must match the StoreKit code), **Price $1.99**.
- [ ] Add an **English localization** (display name + description) — without it, status stays "Missing Metadata".
- [ ] Add the **IAP App Review screenshot** = a capture of the in-app **paywall** (mandatory; #1 "Missing Metadata" cause), plus IAP review notes (blocking is free; this only unlocks Sync; test via SIWA + sandbox).
- [ ] On the **version page → In-App Purchases → +** → **attach `still_sync`** so it ships in this submission.
- [ ] **[PER-RELEASE]** Sandbox-test: buy `still_sync`, confirm Sync unlocks, confirm **Restore Purchases** re-unlocks on a fresh install.

### 4. App Privacy questionnaire **[ONE-TIME]**
- [ ] **App Privacy → Get Started** → "Collect data?" **Yes**. Declare exactly three (each **Collected=Yes, Linked=Yes, Tracking=No, Purpose=App Functionality** — matches `PrivacyInfo.xcprivacy`):

  | Data | Category → type |
  |---|---|
  | Email (from Sign in with Apple) | Contact Info → **Email Address** |
  | User ID (Supabase UUID) | Identifiers → **User ID** |
  | Purchase history | Purchases → **Purchase History** |

- [ ] Do **not** declare browsing/blocking data — it runs **on-device in the extension**, never sent to the server, so it is not "collected." Result shows **"Data Linked to You"** only, no tracking section → no ATT prompt.

### 5. Version metadata **[PER-RELEASE]**
- [ ] Paste Name / Subtitle / Promotional Text / Description / Keywords / Copyright (`© 2026 Cadmus Labs`) from the `still-appstore-metadata` note. Describe sites **functionally** (naming YouTube/Instagram/TikTok/Facebook in body text is fine).
- [ ] **Version** e.g. `1.0` (must match `CFBundleShortVersionString` in the build).
- [ ] **5.2.1 guard**: confirm the **icon and screenshots contain no** third-party logos/UI (see §D).

### 6. Screenshots **[PER-RELEASE]**
Only the **largest** size per family is required (Apple scales down). PNG/JPEG, **RGB, no alpha**, 1–10 each.
- [ ] **iPhone 6.9″ (required): 1320 × 2868** px portrait (1290 × 2796 also accepted).
- [ ] **iPad 13″: 2064 × 2752** px portrait — **required only if the app is offered on iPad** (Safari extensions run on iPad, so a universal build needs these).
- [ ] Show the real host-app UI (onboarding/enable guide, toggles, status, paywall) — **not** third-party logos (§D).

### 7. Build & upload **[PER-RELEASE]**
```bash
export ASC_KEY_ID=<key id>  ASC_ISSUER_ID=<issuer id>  ASC_KEY_PATH=/abs/path/AuthKey_<id>.p8
export UPLOAD=1                       # also upload via altool; omit to drag the .ipa into Transporter
bash apps/apple/scripts/archive.sh    # archives "Still (iOS)" → signed App Store .ipa
```
- [ ] Bump `CFBundleVersion` so it's unique; `CFBundleShortVersionString` matches §5.
- [ ] After upload, wait for **processing**, then **version page → Build → attach** the processed build.
- [ ] Export-compliance auto-answers from `ITSAppUsesNonExemptEncryption = NO`.

### 8. Submit **[PER-RELEASE]**
- [ ] Paste the §B reviewer notes; set "Sign-in required?" → No.
- [ ] Final pass: build attached · `still_sync` attached to **this** submission · screenshots · metadata · App Privacy · reviewer notes · privacy URL live.
- [ ] **Add for Review → Submit**. Confirm the IAP is bundled in the **same** submission. Status → **Waiting for Review**.

---

## D. Open decision — third-party brand logos (5.2.1)

The redesign (by request) put the **real YouTube / Instagram / TikTok / Facebook logos** in the
in-app service rows. App Review guideline **5.2.1** is strict about third-party marks:

- **App icon** — clean ✅ (the balance mark, no logos).
- **Screenshots** — **must not** feature those logos. Easy to satisfy: screenshot the onboarding,
  toggles, status, and paywall — frame shots so the brand glyphs aren't the focus, or use a screen
  without them.
- **In-app service icons** — a **gray area**. Functional use (a glyph indicating which platform a
  toggle controls) often passes, but using competitor marks isn't guaranteed safe and also runs
  against those companies' own brand guidelines. **This is your call**:
  - *Keep them* — accept a small rejection risk; if flagged, swap later.
  - *Swap to neutral glyphs* — monochrome/generic icons or just the service name. Lowest risk.

Recommendation: **keep logos out of the icon and screenshots regardless**; decide the in-app icons
separately. I can switch the in-app icons to neutral glyphs on request.
