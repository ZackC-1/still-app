---
title: Treat AMO Continue after validation as a possible publication boundary
category: conventions
track: knowledge
module: release/firefox
applies_when: Uploading an update to an existing listed Firefox add-on
date: 2026-09-11
status: active
tags: [amo, firefox, release, publication]
---

# AMO Continue can publish an update

An update to an existing listed add-on can become public after **Continue** on the validated-upload
step, before a later page's **Submit Version** action. During Still's September 11 update, the
public add-on API reported the new version and public status at that point. Remaining source and
review-note fields still needed saving. Treating the last button as the only publication boundary
would have left those required materials behind a version already available to users.

The cause was assuming that the documented new-add-on wizard defines the state transitions for
an existing add-on update. Mozilla's [submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
shows multiple Continue steps and a later Submit Version action for a new listing, while directing
updates through the existing add-on page. It also explains that publication can precede further
review. Neither a later button nor an expectation of manual review establishes a safe draft state.

## Preparation and verification

- Before uploading or advancing an existing listed update, have the exact candidate, reproducible
  source archive, build instructions, reviewer notes, screenshots, description and privacy metadata
  ready. Authorization must account for possible public release at Continue; “upload only” must
  not be interpreted as a guaranteed draft operation.
- Inspect the current portal and published version before the write. Do not rely on a prior run's
  button labels. If a verified draft-only path is unavailable and publication is not authorized,
  stop before advancing the upload.
- After each step that creates or advances the version, inspect both the developer version state
  and the public add-on API's `current_version.version` and `status`. A successful validation or
  an unfinished page alone cannot establish that the version is unpublished.
- Supply source and reviewer notes at the first available fields. If advancing Continue already
  made the version public, attach and save these materials immediately through the version editor,
  then verify persistence. Do not wait for an assumed final submission gate.
- Reconcile listing copy, payment declaration, screenshots and website platform-availability labels
  against the actual released version. Record live state in release evidence, not as a permanent
  promise in this learning.

Verification uses the public API `/api/v5/addons/addon/<slug>/`, the existing version's source/review
fields and the public listing. These checks established the early publication and subsequent
source/note persistence in the observed update. This is evidence that Continue **can** publish,
not a claim that every AMO flow always does. Do not infer Apple or Chrome behavior from it.

See [Firefox release runbook](../../release/03-firefox-amo.md) and
[website branch separation](github-pages-custom-domain-certificate.md).
