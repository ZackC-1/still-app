---
title: Sign in before an Apple Still Pro purchase, and a "Still Pro" tag beside the account (ISS-0071, ISS-0073)
date: 2026-10-16
status: approved by the owner 2026-10-16 (option B, copy and tag as written, tag ships first)
issues: ISS-0071 (major, owner decision), ISS-0073 (minor, owner change)
---

# Sign in before an Apple Still Pro purchase, and a "Still Pro" tag beside the account

## What the owner asked

- **ISS-0071 (16 October, about 4:10 PM).** The Mac app and the Safari popup showed "Purchased / You
  have Still Pro." next to a sync card that said "Sign in". The owner said: "if i have still pro, i
  should also be automatically signed in". Apple never tells Still the buyer's email, so automatic
  sign-in is impossible. The owner chose: **require sign-in before buying on Apple**, knowing there
  is an App Review risk.
- **ISS-0073.** After a purchase every popup drops the Still Pro card (as designed), so nothing in
  the popup says the person has Still Pro. The owner wants one minimal signal: "I do want to let the
  user know that they are signed in with Pro".
- **Copy rule (all future screens).** Wording minimal and to the point.

## 1. App Store Review: the decision to make first

**Guideline 5.1.1(v), current text:** "If your app doesn't include significant account-based
features, let people use it without a login." (The handoff's paraphrase, "may not require account
registration for purchases unless account-based", is not in the current text. It is how App Review
applies 5.1.1(v) to purchases in practice, and how it applied it to Still.)

**Still has already been rejected for exactly this.** ADR-0003 records that App Review rejected
**macOS 1.0 (3) under 5.1.1(v)**: "email registration was required before purchasing the
non-account-based Still Pro IAP". Accountless Apple purchase, the device receipt as its own
entitlement authority, and optional linking all exist because of that rejection. The settled V3
contract repeats it: "Purchase: no Apple account wall, explicit optional linking"
(`docs/release/history/v3/README.md`).

**Is Still Pro account-based enough now?** Partly. One purchase now covers Chrome, Firefox and
Safari through the account, which is a stronger case than in July. But the twelve extras work on the
device that bought them with no account at all, and Apple's Restore already proves ownership on any
Apple device. A reviewer is likely to see a sign-in wall in front of a non-consumable that works
fine without it, which is the same pattern as the rejection. **My assessment: high risk of the same
rejection.**

**Three ways to meet the owner's goal.** In all three, everyone who signs in ends up with the account
and Still Pro shown together.

| | What the person sees on Get Still Pro (signed out) | Review risk | Signed-in buyers |
|---|---|---|---|
| **A. Required (owner's choice)** | The email-code sign-in. Apple's sheet opens only after sign-in. | **High.** Same pattern as the macOS 1.0 (3) rejection. | All |
| **B. Sign-in first, skippable (recommended)** | The same sign-in, with one small link under it: "Buy without an account". | **Low.** Purchase is never gated. | Most |
| **C. Buy first, then sign in** | Apple's sheet at once. Right after the purchase: "Sign in to keep Still Pro with your account." | Lowest (today's pattern) | Fewer |

**Recommendation: B.** It gives the owner's result (sign in, then buy, then account and Still Pro
shown together) for nearly everyone, and it cannot be read as an account wall. If the owner keeps A,
the review notes below are the best case, and we should expect to fall back to B if review rejects
it.

**Review notes (A or B), plain text for App Store Connect:**
"Still Pro is a one-time purchase that unlocks twelve extra controls in Safari on this device and
in Still for Chrome and Firefox on the person's other computers. The Still account (an emailed
six-digit code, no password) is how one purchase reaches the browsers that are not on Apple
devices. Blocking YouTube Shorts and Reels, and settings sync, need no account and no purchase.
Restore purchase works without signing in. Sign-in details for review: [review account]." With B,
add: "Signing in is offered before purchase and can be skipped with 'Buy without an account'."

## 2. Existing accountless Apple Still Pro holders

This covers buyers before this change and the two QA sandbox testers who already own
`still_pro_v3`.

- **Restore keeps working signed out** (also required by Guideline 3.1.1: apps must offer a
  restore mechanism). It installs the same device-local access proof (`paid_apple_local`) as today.
  Their Still Pro on that device, including Safari, never depends on signing in.
- **After Restore, or on any open while signed out with Still Pro,** the existing
  "Link Still Pro to an account" card is shown, reworded to: **"Sign in to keep Still Pro with your
  account."** with **Sign in** and **Not now**.
- **Signing in from it** runs the existing explicit link (`linkPurchase` →
  `link-apple-access`, and `qa-sandbox-link-apple-access` on the QA route). The server right gains
  the account as its holder and an account proof is issued. The local proof stays, so the device
  keeps Still Pro if the account is later signed out.
- **Nothing is deleted or migrated** on the server. Rights stay accountless until the person links
  them. Family Sharing and Ask to Buy keep today's rule: only a purchased (not family-shared)
  transaction can be linked.

## 3. The flow (A, and B with its skip link)

1. **Get Still Pro, signed out:** the app's existing email-code sign-in (the sheet its sync card
   opens). Cancelling it changes nothing and Apple's sheet never opens. (B: "Buy
   without an account" goes straight to step 3, as today.)
2. **Signed in:** the purchase continues by itself. The person doesn't have to tap Get Still Pro
   again.
3. **Apple's purchase sheet** (unchanged StoreKit purchase, sandbox banner in QA).
4. **Verified** by the existing hosted Apple verification (the ISS-0070 path).
5. **Linked at once to the signed-in account.** The Buy press after sign-in is the person's
   deliberate choice to associate, so no extra Link tap. The guards stay: the same account and
   session before and after, and the same purchaser and ownership revision.
6. **The app and the Safari popup show the signed-in account and Still Pro together** (section 5).

Edge cases: the account changes or signs out between steps 2 and 5, so linking stops and the device
keeps its local Still Pro; the link fails, so Still Pro stays on the device and the existing link
card offers **Try again**; Apple is cancelled, so the person stays signed in and nothing is bought;
already signed in, so step 1 is skipped. The Safari popup's Get Still Pro keeps handing off to the
app.

## 4. Copy (minimal and to the point)

| Where | Now | Proposed |
|---|---|---|
| Purchase screen line under Get Still Pro (`PurchaseView.svelte`) | "Payment is handled by Apple. No account needed." | "Payment is handled by Apple." |
| Sign-in sheet opened by Get Still Pro (Apple) | the sync sign-in sheet's wording | unchanged; one added line: "Sign in first, so Still Pro stays with your account." |
| B only, under the sign-in sheet | none | link: "Buy without an account" |
| Link card for accountless holders | "Link Still Pro to an account" / "So you can restore it in other browsers. Optional." | "Sign in to keep Still Pro with your account." / **Sign in** / **Not now** |
| Link failed (existing `AccountLinkCard`) | existing | unchanged |

## 5. ISS-0073: one "Still Pro" tag beside the account

- **What:** a small boxed **Still Pro** tag in the sync card's account row, beside the account
  address (signed in) or beside "Sign in" (signed out with Still Pro). It uses the existing
  `access-tag boxed` style of the settings card's "Purchased" tag. No new sentence.
- **When:** only while a Still Pro row is `purchased` (verified ownership). Not for frozen
  released-free protection (`protected`), not while checking or verifying.
- **Where (identical everywhere):** the popups (`DesktopPopup.svelte` for Chrome, Firefox desktop
  and Safari on the Mac; `MobilePopup.svelte` for Firefox for Android and Safari on iPhone), plus
  the shared `SyncCard.svelte` on the browser Settings pages and in the Apple app, so popup and
  Settings match.
- **PR evidence:** a screenshot of each popup (Chrome, Firefox desktop, Firefox for Android, Safari
  Mac, Safari iPhone) signed in with Still Pro, and one signed out with Still Pro.

## 6. Product truths and the documents that change

- **Unchanged:** sign-in never gates free blocking or free settings sync. It is asked for only at
  Get Still Pro on Apple. Restore never requires it. Browser purchases already require an account
  (the browsers have no device receipt).
- **Decision record:** a new owner decision **D526** in the V3 release record (recorded as **D543**:
  D527–D542 were already used in the local decision log), and
  **ADR-0005** "Apple Still Pro purchase starts with sign-in". ADR-0005 supersedes ADR-0003's
  consequence that "a signed-out purchaser has full Pro … without requiring an account" for *new*
  purchases (A) or amends it (B). Both keep the receipt authority for Restore and existing holders.
- **Docs to update:** `docs/release/history/v3/README.md` ("Purchase: no Apple account wall"),
  `CONCEPTS.md` (Still Pro: "Apple receipt ownership can work without an account"),
  `docs/PRODUCT.md` (Still Pro section: Apple purchase and sign-in), `STRATEGY.md` (no change: its
  "usable without an account" lines are about blocking and sync; recheck wording), ADR-0003 (status
  note pointing to ADR-0005), `docs/release/01-apple-app-store.md` and
  `docs/release/store-listing-copy.md` (review notes above, "Sign-in required" answer for the
  purchase), and `packages/core/src/ui/v3/PurchaseView.svelte` copy. The App Privacy answers don't
  change: email is already collected for optional sync.

## 7. QA programme steps the QA lead will rewrite

- **IOS-42 / MAC-44:** the card no longer offers "No account needed" anywhere. B also shows the skip
  link in the sign-in sheet.
- **New, before IOS-43 / MAC-45:** signed out, Get Still Pro opens sign-in; cancelling opens no
  Apple sheet. Then sign in with the QA account.
- **IOS-44..45 / MAC-45..46:** Apple's sheet opens straight after sign-in, without a second tap;
  then the purchase.
- **DB-13 / DB-14:** expect an Apple sandbox `still_pro_v3` right **held by the signed-in QA
  account** (not an empty holder), active, with its account proof. For B's skip path, the old
  accountless expectation stays as a separate check.
- **IOS-46 / MAC-46:** the app shows the account and the Still Pro tag in the sync card.
- **IOS-47 / MAC-47 / CH-59 / FX-48 (ISS-0073):** the Still Pro card is gone, and the sync card
  shows the account with the **Still Pro** tag.
- **New, for existing accountless holders (both testers):** signed out, Restore shows "Still Pro is
  restored on this device." Then the link card; Sign in links it (a new DB check: holder becomes
  the account).
- **IOS-48 / MAC-48:** Still Pro and the account survive a relaunch.
- **IOS-49 / MAC-49:** add "account switch between sign-in and Apple's sheet" as a case,
  engineering route only.

## Owner decisions (16 October 2026)

1. **Option B:** Get Still Pro on Apple opens sign-in first, with a "Buy without an account" link.
2. The copy in section 4 and the tag in section 5 are approved as written.
3. ISS-0073 (the tag) ships first, in its own PR and package; ISS-0071 follows.

## Questions the owner answered

1. **A (required) or B (sign-in first, skippable)?** B is recommended; A has a high chance of the
   same 5.1.1(v) rejection Still already received once.
2. Approve the copy in section 4 and the tag in section 5?
3. Ship ISS-0073 (the tag) first and on its own? It doesn't depend on the A/B choice and is small.

After approval: code in an isolated worktree, one PR per issue, with tests that fail first,
screenshots and plain-English descriptions, then a package with its sandbox sales allowlist line.
