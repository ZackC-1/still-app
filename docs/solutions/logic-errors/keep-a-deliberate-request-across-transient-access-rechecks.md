---
title: Keep a deliberate request across transient access re-checks; re-offer it when the state settles
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/ui/v3
applies_when: A user-started flow (link, purchase, restore) waits on another async step (sign-in, verification) while the access state it depends on is being refreshed, held or re-read by other code
date: 2026-10-18
status: active
tags:
  - entitlement
  - apple
  - linking
  - races
  - ISS-0076
---

# Keep a deliberate request across transient access re-checks

## Symptom

An accountless Apple Still Pro holder taps Sign in on "Sign in to keep Still Pro with your
account.", signs in, and lands on the main screen with no "Link Still Pro to this account?"
confirmation, and nothing to link with afterwards (ISS-0076, Mac 2.1.1.383, reproduced twice).
Nothing linked silently; the request simply vanished.

## Cause

The host remembered the request in a flag and expected the account-confirmed event to pick it up.
But the sign-in itself started several access re-checks, and the same module treated every one of
them as a reason to forget:

- the eligibility re-read **erased its answer first** (`eligible = null`) and, when a newer
  snapshot fenced the read, returned without restoring it, so the request bailed on an empty
  answer;
- **every non-owned snapshot** (including the cache's own held "verification_required" while a
  refresh is in flight) cleared the request;
- nothing **re-offered** a surviving request when access became owned again.

Each piece was defensible alone (fence stale reads, hide the affordance while unsure). Together
they turned a transient state into a dropped user intent. A fixture whose rights never change
between reads cannot show it: the cache de-duplicates identical snapshots, and held reads released
in one flush let the request see the answer the last read wrote.

## Solution

1. **Remember the request before any read**, and drop it only on a conclusive answer: nothing
   owned, nothing eligible (a settled null), the sheet closed signed out, another account.
   "checking" and "verify" keep it.
2. **Keep the last settled affordance answer while a re-read is in flight**; a settled answer
   replaces it. Fencing a stale read must leave state as it was, never blank it.
3. **Re-offer from the state that settles last**: when a settled eligible answer arrives and the
   account is confirmed, offer the confirmation (the request's own read must not re-offer, or it
   recurses). Ask for sign-in at most once per request.
4. **Say something when a tap lands in a held moment** ("Linking didn't finish." with Try again)
   instead of returning silently.

Code: `packages/core/src/ui/v3/apple-pro-host.ts` (`refreshLinkEligibility`, `offerRequestedLink`,
`requestLink`, `observeAccess`, `signInDismissed`).

## A refusal is not a verdict (second finding, same day)

The first fix kept the request across held snapshots and fenced reads, but still took a **thrown**
native read ("requires verification", sent while a reconcile is in flight) as a settled "not
eligible": the request was dropped again, and the confirmation's single re-read turned the refusal
into "Linking didn't finish". Treat a refused read as no answer (keep the last settled one, ask
again on the next refresh), and let a deliberate confirmation retry one refusal.

## How to reproduce it in a test

Make the fixture behave like the device in the two ways that matter: advance the native record
generation on reconcile so the cache publishes a new snapshot after sign-in, and let the held
native reads finish **one at a time** (`holdEligibility().releaseOne()`), never in one flush.
`apple-pro-host.integration.test.ts` ("signing in from the invitation shows the confirmation…")
and the host unit tests in `apple-pro-host.test.ts` ("a requested link survives the re-checks that
sign-in starts") are the regression guards.

## Prevention

- When a flow parks intent for a later event, write down which events are allowed to drop it and
  test each of the others (holds, fenced reads, overlapping refreshes).
- An "unknown" interim answer must not overwrite a settled one; keep "unknown" separate from "no".
- Any place that re-reads a dependency after the parked event should also be a place that can
  complete the parked flow.
