---
title: An offer must know when its action is already done; ask the authority that did it
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/ui/v3
applies_when: A screen offers an action (link, restore, sync) from a "can do" check, and the result of doing it lives with another authority (the server) that the "can do" check never reads
date: 2026-10-19
status: active
tags:
  - entitlement
  - apple
  - linking
  - ISS-0081
---

# An offer must know when its action is already done

## Symptom

On the Mac app (2.1.1.387 and .392), a person linked an accountless Apple Still Pro purchase to
their account and saw "Still Pro is linked to <address>". The server recorded the link. On the next
launch, signed in as the same account, Settings offered "Link Still Pro to your account." again.
Link ended in "Still Pro is linked to <address>" because the server answered `already_linked`. This
happened on every launch (ISS-0081).

## Cause

The link offer came from one question: can this device prove the purchaser? The native read
(`observeAppleLinkAccess`) matched the current StoreKit purchaser to its signed local binding and
returned the right with its ownership revision. A linked right still passes that check, so the host
(`ownershipRevision >= 0`) kept saying "can link". The fact that ended the offer lived elsewhere. It
was the server-signed `paid_account` proof that the account reconcile installs for a linked right.
The offer never read it. Within one session the offer disappeared only because the host kept the
`linked` card in memory.

## Solution

The native read now also answers "linked to whom" for each right (`linkedAccount`), and it gets that
answer from the server:

- StillKit (`observeAppleAccess(wall:matching:)`) names the account only when the record holds a
  current, unrevoked, server-signed `paid_account` proof for the same right. The proof's holder must
  be the account native bound from a session that hosted Auth verified, and its ownership revision
  must be at least the local binding's. Otherwise the field is an explicit `null`. Binding another
  session or signing out (`changeAccessSession`/`bindSession`) deletes the earlier session's
  account proofs, so a new session names no one until its reconcile installs them again.
- The host (`apple-pro-host.ts`, `linkedHere`) hides the offer only when that account equals the
  account shown as signed in. If they differ, or the person is signed out, the offer works as it did
  before, and the server still decides any Link.
- A link request that resolves to "already linked here" shows the linked status instead of asking
  for confirmation again. This happens when someone signs in from the signed-out invitation as the
  account that already holds the right, but only once the reconcile has installed that account's
  proof. A brand-new session starts with none, so the read right after sign-in usually still says
  "not linked" and the confirmation appears first. When a later read names this account, the host
  turns that confirmation into the linked status and fences its Link tap.

### Why not use the reconcile acknowledgement

The alternative was to suppress the offer from `reconcileAccountAccess`'s
`accountStatus`/`proofIdentities`. That acknowledgement lists proof identities, not the rights they
cover. The web view would have to remember it and match it to a purchase across a separate read, and
it exists only after a reconcile in this launch. Native already holds the verified binding and the
verified account proof in one record, so it can answer in the same read that decides eligibility.
That read sits behind the same lineage and revocation fences as the rest of the Apple access route.

## Verification

- StillKit `AppleRightBindingTests.testLinkEligibilityNamesTheBoundAccountOnlyFromItsCurrentServerProof`
  covers accountless and signed-in-without-proof (null), linked (the account), a newer local binding,
  a session change and sign-out (proofs deleted), an expired proof, and the explicit-null encoding.
- `testLinkedAccountComesOnlyFromTheBoundAccountsCurrentProofForTheSameRight` exercises each guard
  with the proofs still stored: the account's proof for a different right (a web purchase) names no
  one, the reconcile's newer proof for this right names the account, and a stored proof that is
  revoked or held by another account names no one. A revoked proof also fails the clock check
  (`validPaid`), so the explicit `!revoked` test is defence in depth.
- `native-apple-access.test.ts` covers the closed grammar (member required, UUID or null).
- `apple-pro-host.test.ts` and `apple-pro-host.integration.test.ts` ("ISS-0081") cover these cases:
  linked to the signed-in account on launch (sync card's Still Pro User tag and nothing else), linked
  to another account (since ISS-0104, 20 Oct: no offer; the card says "Still Pro works on this
  device. It's linked to another account." (owner wording, 20 Oct), remembered per account and
  purchaser revision after the server's owned_elsewhere, or at once when native names the account),
  accountless and signed in (offer), and
  signed out (the invitation stays). Signing in as the holder with the reconcile held shows the
  confirmation first, then "linked" once the proof arrives, without calling the server.

## Prevention

- Test fixtures must deliver the answer when the device would, not earlier. The first version of
  these tests named the account as soon as anyone signed in, which hid the confirmation-first
  ordering that a real new session produces.

- When an affordance offers an action, also ask whether the action's result already exists. Ask the
  authority that records the result, not the display state the UI keeps in memory.
- A "linked to whom" answer must come from the server's signed proof for the verified account. The
  displayed account may only narrow when the answer applies. It must never stand in for the proof.
