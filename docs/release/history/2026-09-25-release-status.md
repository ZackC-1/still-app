# Still 2.1 release status (September 25, 2026)

This supersedes the [September 14 status](2026-09-14-release-status.md) for store state. It is a
dated record: check each portal live before acting.

## Store snapshot

| Store | Version | State on 2026-09-25 | How it got there |
|---|---|---|---|
| Firefox AMO | **2.1.1** | **Public** (approved automatically after upload) | Owner uploaded the package and complete source; listing copy, tags and 5 captioned screenshots updated |
| Chrome Web Store | **2.1.1** | **Pending review**; 2.1.0 stays public until approval | Owner uploaded the package, 2.1 description and 5 screenshots; privacy tab unchanged and verified |
| App Store, iPhone and iPad | **2.1.0 (9)** | **Submitted for review**; 2.0.0 (8) is live | Owner uploaded through Xcode Organizer; 7 iPhone + 3 iPad screenshots, 2.1 copy, App Privacy updated |
| Mac App Store | **2.1.0 (9)** | **Submitted for review**; 2.0.0 (8) is live | Owner uploaded through Xcode Organizer; 6 Mac screenshots, Mac copy |

All four carry rule set 1.1.11, with both Facebook Reels fixes (#213 Page tab flicker, #218 home-feed
shelf). Only store updates deliver them: installed copies can't receive packaged-CSS changes from a
remote rule set ([production rule-set keys](../../production-rule-set-keys.md), "Packaged CSS limits").

## Packages

| File | SHA-256 | Source |
|---|---|---|
| `stillext-chromium-2.1.1-chrome.zip` | `3c23377e37465026475035ae53131038ceed7e5b9793dc1566535417487382b3` | `ec1e68b` |
| `stillext-chromium-2.1.1-firefox.zip` | `b6b282534773d85a473c5d84d5b45ec4fd208d390bf148c51d431f8888c56ff2` | `ec1e68b` |
| `still-2.1.1-amo-complete-source.zip` | `86024cf1ec283fb9096298aaf259a9f341d9dc4502e5e054ab8d444213ed2387` | `ec1e68b` |
| `Still.ipa` (iOS 2.1.0, build 9) | `0694a9cc7fb2c751fb97b195709bd5caa88bf3d635cb72b172dc10c91b40f6f0` | `8a67977` (same app source as `ec1e68b`) |
| `Still.pkg` (macOS 2.1.0, build 9) | `6b2cbd9659203b12b30c425918401400f23f8f8bcb9342587eee2aaeb60d093c` | `8a67977` |

The files and their manifests are kept locally (gitignored) in
`release-builds/2.1.1/` and `release-builds/2.1.0/apple/` (see the [release runbook](../README.md#where-release-files-live)).
Organizer re-signed the Apple uploads from the same archives, so the uploaded binaries' hashes may
differ from the exported files above.

**Browser packages:**
- Built from a clean worktree with only the four public `VITE_` values.
- The AMO source archive rebuilt all 20 Firefox files byte for byte.
- `addons-linter` reported 0 errors and the same 2 known warnings as 2.1.0.

**Apple:**
- Archived with Xcode automatic signing (`-allowProvisioningUpdates`, owner-approved), which added
  the missing iCloud key-value entitlement to the Mac provisioning profile.
- Exported with `apps/apple/scripts/ExportOptions.plist` (App Store distribution profiles).

## Owner decisions recorded in portals

- **Screenshot order:** the owner chose the order on each store deliberately. Don't reorder to
  match `screenshots/store-ready/README.md`.
- **Firefox name:** the Firefox listing name is now "Still: Remove Shorts & Reels, Stop Scrolling".
- **Still Pro removed from sale:** the owner removed Still Pro (`still_sync`, non-consumable) from
  sale in App Store Connect, so the listing no longer advertises in-app purchases.
  - Earlier buyers keep the purchase, and restore still works.
  - The product record and RevenueCat identity stay in place.
  - To bring paid features back, put the product on sale again (see [RevenueCat](../04-revenuecat.md) for the retained setup).
  - App Privacy still declares Purchase History, which matches the privacy manifest.
- **App Privacy:** published with Email Address, User ID, Device ID, Product Interaction, Purchase
  History and Other Data Types (all linked, none used for tracking), matching `PrivacyInfo.xcprivacy`.

## Next actions

1. Watch for the Chrome, iOS and macOS review results. On approval, check each public listing: the
   version, screenshots, description, and whether the "In-App Purchases" label is gone on Apple.
2. If a review is rejected, read the reason before rebuilding. A new Apple build needs build 10 or
   higher; a new browser package needs a version above 2.1.1.
3. **Next release:** redo the iPhone, iPad and Mac App Store screenshots. The owner isn't satisfied
   with the 2.1 Apple set; the Chrome and Firefox sets are fine. The tools and content rules are in
   [`screenshots/source/frames/README.md`](../screenshots/source/frames/README.md).
4. The earlier open items in the [September 14 status](2026-09-14-release-status.md) (#153 hosted
   account evidence, iPad coverage marked skipped) are unchanged.
