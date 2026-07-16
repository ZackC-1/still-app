---
title: App Store Connect silently submits an app version without its in-app purchase
date: 2026-07-16
category: integration-issues
module: docs/release
problem_type: integration_issue
component: development_workflow
symptoms:
  - "Both platform versions reached Waiting for Review, but the still_sync IAP was never in review — its state read READY_TO_SUBMIT"
  - "The App Store Connect UI showed each submission as \"1 Item\" and looked complete; nothing warned that the IAP was missing"
  - "A leftover Draft submission sat unsubmitted holding the IAP, with the warning \"Unable to Submit for Review — add an app version for the selected platform\""
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: high
tags: [app-store-connect, asc-api, in-app-purchase, submission-workflow, apple-review, portal-verification]
---

# App Store Connect silently submits an app version without its in-app purchase

## Problem

On 2026-07-16 both Still platforms (iOS and macOS 1.0 build 5) were submitted to App Store
Review — but the `still_sync` in-app purchase was not in either submission. The portal showed
no error. Had Apple approved them, Still Pro would have been unpurchasable in a shipped app,
recoverable only through another full review cycle.

## Symptoms

- App Store Connect showed each submission as **"1 Item"**, every field filled, both versions
  **Waiting for Review**. Nothing indicated an omission.
- A leftover **Draft** submission sat unsubmitted, holding the IAP, warning *"Unable to Submit
  for Review — To submit your items for review, add an app version for the selected platform."*
- The decisive signal was only visible via the API: `still_sync` had
  `state: READY_TO_SUBMIT` — meaning **not in review** — while both versions read
  `WAITING_FOR_REVIEW`.

## What Didn't Work

- **Reading the UI.** The submission list, item counts, and per-tab status all looked correct.
  The portal is truthful about what is in *a* draft, never about what is missing from
  *another* one.
- **Following documented click-paths.** ASC's submission model had changed; guidance derived
  from Apple's own docs and this repo's runbook described a flow that no longer matched the
  screens. Screenshots could not settle the question either — they showed "1 Item" without
  saying which item.
- **Clicking "Add for Review" on each page in turn.** This is what *caused* the split: the IAP
  page's button created its own draft; each version page's button then created a **separate**
  submission containing only that version.

## Solution

Query the API instead of interpreting the UI. Auth is an ES256 JWT (`aud: appstoreconnect-v1`,
15-minute expiry, `kid` header); Python with `pyjwt[crypto]` is sufficient.

The single fastest check — is the IAP actually in review?

```
GET /v1/apps/{app}/inAppPurchasesV2   →  attributes.state
      READY_TO_SUBMIT   = NOT in review
      WAITING_FOR_REVIEW = in review
```

Confirm the right binary is attached (an old build silently discards the work in the new one):

```
GET /v1/apps/{app}/appStoreVersions?include=build   →  per-platform state + build number
```

See what a submission actually bundles. The items endpoint returns **empty relationships**, and
`?include=appStoreVersion,inAppPurchaseV2` returns **HTTP 400** — so decode the item id, which is
base64 of `<submissionId>|<typeCode>|<entityId>`:

```
GET /v1/reviewSubmissions?filter[app]={app}      → submissions, platform, state, submittedDate
GET /v1/reviewSubmissions/{id}/items             → item ids to decode
      typeCode 6  = appStoreVersion
      typeCode 17 = in-app purchase
```

`submittedDate: null` marks an unsubmitted draft.

The fix, once the split is visible: **Remove from Review** each version (macOS then reads
*Developer Rejected*), open the draft that holds the IAP, add the version **into that draft** →
it shows **Items Ready to Submit (2)** → Submit. Verify via the API that all three objects read
`WAITING_FOR_REVIEW` before walking away.

## Why This Works

Apple requires the **first non-consumable IAP to be reviewed together with an app version** — it
cannot be submitted standalone. Two "Add for Review" buttons on two pages produce two independent
submissions, and the version submission is perfectly valid on its own, so nothing errors. The IAP's
draft is the one that complains ("add an app version"), and it is easy to read that warning as a
stale artifact rather than as the actual blocker.

The API exposes the one field the UI never puts on screen: the IAP's own `state`. That field cannot
be misread.

## Prevention

- **Verify submission state via the API before considering a release submitted.** Check three
  things: each version's `appStoreState`, each version's attached **build number**, and the IAP's
  `state`. All must read `WAITING_FOR_REVIEW` with the expected build.
- **Treat "N Items" in the portal as unverified.** It counts one draft's contents; it says nothing
  about what belongs there.
- **When a portal UI stops matching documented guidance, stop clicking and read the API.** Portal
  UIs change without notice and click-path documentation rots silently — the failure mode is a
  confident, wrong answer.
- The credentials and full endpoint recipe for this app live outside the repo (the ASC key is not
  committed); the issuer ID is at ASC → Users and Access → Integrations → App Store Connect API.

## Related Issues

- `docs/release/01-apple-app-store.md` §7 — the resubmission runbook and portal checklist.
- `docs/solutions/conventions/hosted-portal-config-drifts-verify-live.md` — the sibling lesson:
  portal *config* also lies, and a prior "verified" note is not evidence. Both failures on this
  release came from trusting apparent state instead of the source of truth.
