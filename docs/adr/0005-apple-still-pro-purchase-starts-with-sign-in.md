# ADR-0005: Apple Still Pro purchase starts with sign-in, and it can be skipped

Date: 2026-10-16 · Status: accepted (owner decision D543, option B; V3 builds only). Amends
[ADR-0003](0003-entitlement-authority-receipt-and-server.md).

## Context

In QA on 16 October 2026 (ISS-0071) the Mac app and the Safari popup showed "You have Still Pro."
beside a sync card that said "Sign in". The owner wants a person who buys Still Pro to end up
signed in with it. Apple never tells Still the buyer's email, so automatic sign-in is impossible.

App Review rejected macOS 1.0 (3) under Guideline 5.1.1(v) because an email sign-in was required
before buying the non-account-based Still Pro purchase. ADR-0003 answered that rejection: the
device's Apple receipt is its own entitlement authority, so a signed-out buyer has full Still Pro on
that device, and linking it to an account is optional. Requiring sign-in again (option A in the
[design note](../plans/2026-10-16-005-design-apple-signin-before-buy-and-pro-tag.md)) repeats the
pattern that was rejected. The owner chose option B.

## Decision

1. **Signed out, Get Still Pro in the iPhone and Mac apps opens the app's existing email-code
   sign-in first.** The sheet adds one line, "Sign in first, so Still Pro stays with your
   account.", and a link under it, "Buy without an account".
2. **Sign-in is skippable.** "Buy without an account" goes straight to Apple's purchase sheet,
   exactly as an accountless purchase always did. Cancelling the sign-in opens no Apple sheet and
   changes nothing.
3. **A successful sign-in continues the purchase by itself**, into the unchanged StoreKit purchase
   and the existing hosted Apple verification. There is no second tap.
4. **A purchase started signed in links to that account automatically after verification**,
   through the existing explicit link path (`link-apple-access`, and
   `qa-sandbox-link-apple-access` on the QA route). Pressing Get Still Pro after signing in is the
   person's choice to associate the purchase, so there is no extra Link confirmation. Every existing
   guard stays: the same account and session before and after, a purchaser this device can prove
   (purchased, never family-shared), and the ownership revision the device read. If the account
   changes or signs out in between, nothing is linked and the device keeps its local Still Pro. If
   linking fails, Still Pro stays on the device and the link card offers Try again. An account
   update before Apple's sheet opens (the session settling) re-arms the continuation once, and
   only for the same account; a sign-out or another account drops it.
   A purchase that Apple completes later (Ask to Buy, or one recovered after an interrupted
   reply) is verified when the app next refreshes and is not linked automatically. That is
   deliberate: the person who started it may no longer be the one signed in. The existing link
   card offers the link instead.
5. **Already signed in, there is no sign-in step.**
6. **Restore never requires sign-in** (also required by Guideline 3.1.1). It installs the same
   device-local access proof (`paid_apple_local`) as before.
7. **Accountless holders** (after Restore, or on any open while signed out with Still Pro) see one
   card, "Sign in to keep Still Pro with your account.", with **Sign in** and **Not now**. Sign in
   runs the existing explicit link, including its confirmation.
8. **Unchanged:** the Safari popup's Get Still Pro hands off to the app; Chrome and Firefox
   purchases already require an account (browsers have no device receipt); the server functions
   are unchanged; nothing on the server is migrated, and accountless rights stay accountless until
   the person links them.

## Consequences

- ADR-0003's consequence "a signed-out purchaser has full Pro on the device … without requiring an
  account" still holds for anyone who chooses "Buy without an account" and for every Restore. The
  receipt stays the device's entitlement authority. What changes is the default path: sign-in is
  offered first, and a signed-in purchase links at once instead of waiting for a separate Link tap.
- Purchase is never gated, which is why the review risk is low. The App Store Connect review
  notes say sign-in is offered before purchase and can be skipped (see the
  [Apple runbook](../release/01-apple-app-store.md) and
  [store listing copy](../release/store-listing-copy.md)).
- Sign-in still never gates free blocking or free settings sync.
- "No account needed" no longer appears on any Apple purchase surface.
