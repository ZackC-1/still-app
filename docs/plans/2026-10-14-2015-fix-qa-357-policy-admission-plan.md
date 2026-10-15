---
title: Admit the retained .357 QA candidate to sandbox sales
date: 2026-10-14
status: in_progress
---

# Admit the retained .357 QA candidate to sandbox sales

The authenticated .357 Chrome popup reports checkout unavailable and hides the Pro offer.
The public sandbox sales policy is revision 6, enabled, and admits .351 for Chrome and Firefox;
it does not admit .357. A fresh signed-out .357 profile displays the offer. This is a candidate
admission gap; free sync does not consult this policy.

The retained candidate was built from main 7e1e83b2a6c10741f4872aab4c8c3e76baabc3b1.
Add its exact 2.1.1.357 version for the three extension surfaces to the pinned sandbox templates.
Retain the existing .351 entries so ongoing manual QA remains eligible. Apple continues to
present 2.1.0. Update both on/off SQL bodies, their hash pins, and the template contract test.
Do not rebuild the candidate or change client gates, production policy, accounts or entitlements.

## Verification and delivery

- [x] Verify JS and SQL templates and hashes: all 48 backend operation tests passed.
      All 70 deployment guard tests also passed; syntax and diff whitespace checks passed.
- [ ] Run the protected-workflow operation rehearsal on a disposable database through PR CI.
- [ ] Review the diff and merge through the protected branch workflow.
- [ ] Prepare a protected sales-on operation against the verified current sandbox revision.
- [ ] Owner approves the exact hosted operation; merging alone does not change policy.
- [ ] Read back the new policy and verify checkout availability and popup offer in the retained
      authenticated .357 browser. Do not create a checkout or complete a purchase.

If the revision changes before application, stop and refresh the plan. Existing compare-and-set,
hash, rehearsal and environment approval gates remain intact. Rollback uses the existing off
operation as another append-only revision; it disables sandbox sales for all listed builds.
