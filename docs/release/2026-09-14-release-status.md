# Still release status — September 14, 2026

Status: source integrated; website published; store rollout and final account verification pending.
This is a dated operational snapshot, not a claim that every supported surface is certified.
Recheck live store status before the next external action. Current product direction remains in
[STRATEGY.md](../../STRATEGY.md).

## Product and owner decisions

- Still is free in this release: YouTube Shorts removal/redirection, Instagram and Facebook Reels
  removal, TikTok website blocking, and optional cross-device settings sync.
- All blocking works without an account or purchase. Sign-in gates settings sync only.
- Supported surfaces: Chrome and Firefox on desktop, Safari on Mac, and Safari websites on iPhone
  and iPad through the Still app. Native social apps and mobile Chrome/Firefox are not supported.
- Keep RevenueCat identity, historical entitlements and purchase infrastructure. Both paid-tier
  feature flags remain disabled. The internal `still_sync` identifier is unchanged.
- The owner will wait for the Apple and Chrome releases to become publicly available before broad
  promotion. Keep already-completed user tests credited; do not restart the full test tour.
- Physical iPad testing is explicitly **SKIPPED / UNVERIFIED** for this release because the owner
  has no device. The owner accepts this specific limitation; it is no longer a pre-release action.
  Do not convert iPhone, simulator or browser-emulation results into physical iPad evidence.
- Retention policy describes current practice: active account/settings data is removed on account
  deletion; separate support emails and historical billing records remain until separately deleted,
  while provider logs/backups expire on their own schedules. The owner approved publication.
- Web-purchase refund wording is consistently 14 days; Apple handles Apple refunds.

## Source, pull requests and issues

Before this documentation snapshot, local `main` was clean and identical to `origin/main` at
`ee40b894eb56396954f3d29fca751d32b8a05257`. There were zero open PRs.

| Work | Result |
|---|---|
| Website source PR #189 | Merged at `a0751f10e42f7fbf62f0c55e4323441962bd1f7b`; final review and pre/postmerge CI passed. |
| Dependency PRs #184–#187 | Reviewed and integrated through #193, preserving original heads; GitHub marked all four merged. |
| Integration PR #193 | Merged at `ee40b894`; development/test dependencies and CI actions updated; Node compatibility declarations corrected. |
| Issues #149–#152 | Closed as completed, with implementation, test, deployment and accepted-policy evidence. |
| Issue #99 | Closed as superseded by the free release, not as proof that the proposed entitlement tri-state was implemented. |
| Issue #153 | Remains open for the hosted disposable-account lifecycle evidence and final certification record. Physical iPad exception is recorded there. |

The last cleanup changed development/test tooling and CI; it did not rebuild, modify, withdraw or
resubmit store artifacts. Submitted artifacts retain their original candidate and evidence; do not
relabel them as builds of the latest main commit.

Verification recorded for dependency integration: frozen install, lint, typecheck, build, formatting,
788 passing local unit tests (39 skips with their platform scope recorded), zero audit findings at
the time of the audit, and all required CI jobs. Final-head CI `34881519301` and postmerge main CI
`34882043179` passed. Website-source postmerge CI `34881401175` also passed.

References: [#189](https://github.com/ZackC-1/still-app/pull/189),
[#193](https://github.com/ZackC-1/still-app/pull/193),
[#153](https://github.com/ZackC-1/still-app/issues/153).

## Website — published and verified

The live site is [stillapp.fit](https://stillapp.fit/), published from `gh-pages`, independently of
`main`. Homepage and CSS were HTTP 200 and byte-identical to the reviewed publishing files after
PR #192; Pages run `34881089212` passed. Publishing merge:
`707eb15095177a0cc97d971a9c1dd0ed6c60ee34`.

Owner-directed changes:

- Eyebrow: “Your favorite websites, without short-form videos”.
- Main heading: “Do what you came to do”.
- Body preserved as supplied: “Still remove Shorts, Reels, and Tiktoks from the websites you use.
  One intentional visit doesn't become hours of scrolling”. Do not silently rewrite owner text.
- Hero buttons link directly to the App Store, Chrome Web Store and Firefox AMO.
- Free-use paragraph explains optional sync across Safari, Chrome and Firefox on desktop and iOS.
- Both homepage Apple buttons select `platform=mac`, `iphone` or `ipad` using browser device hints;
  iPad desktop-mode user agents are handled. Unknown devices and browsers without JavaScript retain
  the ordinary HTTPS App Store link. Apple app ID remains `6784061138`.
- Removed the hero and bottom homepage rollout notices and the “Check release availability” CTA.
  Preserved incoming `#release-status` links by moving the anchor to the store grid.
- Removed public website “Still 2.0” branding and Firefox-only availability emphasis. Secondary-page
  rollout notices remain; internal version numbers and existing asset filenames were not renamed.
- Pricing heading: “All of the blocking. None of the cost”.
- Outcome heading can use its full section width; the download heading is centered.
- Reduced vertical section spacing and halved outcome-card number-to-heading margin, 62px to 31px.
  Keep every section: the owner withdrew the earlier unidentified section-removal request.
- Updated the website sharing image from its HTML source. Store screenshot assets were not
  regenerated as part of website editing.
- Privacy, support, terms and setup aliases were kept consistent with their source pages. Current
  URLs include `/privacy/`, `/support/`, `/terms/`, and `/setup/` on stillapp.fit.

Verification: desktop and phone layouts visually checked; no horizontal overflow; 28 secondary-page
route/viewport checks, 87 internal-link/anchor checks, source/publishing parity and live byte checks
passed. Seven browser scenarios checked both Apple links: Mac, iPhone, iPad, iPad desktop mode,
Windows, Android and JavaScript disabled. This is browser emulation, not physical-device certification.

References: [website plan](../plans/2026-09-14-001-docs-website-copy.md),
[#190](https://github.com/ZackC-1/still-app/pull/190),
[#191](https://github.com/ZackC-1/still-app/pull/191),
[#192](https://github.com/ZackC-1/still-app/pull/192).

## Store snapshot

| Store | Latest known state and evidence scope |
|---|---|
| Firefox AMO | Public version 2.0.0, rechecked September 14 using the public API. Free blocking/sync description and screenshots are published. |
| Chrome Web Store | Owner submitted 2.0.0 for review September 14. A fresh public-page check later that morning still showed 1.0.3 and the old $1.99 Pro description. Submission is not public availability. |
| Apple iOS | Version 2.0.0 build 8 was directly verified WAITING_FOR_REVIEW at 11:01 PDT September 14; release mode MANUAL. A later public lookup still returned version 1.0. |
| Apple macOS | Version 2.0.0 build 8 was directly verified WAITING_FOR_REVIEW at 11:01 PDT September 14; release mode MANUAL. Do not assume approval or publication from that snapshot. |

Apple and Chrome descriptions were updated for free blocking and optional sync across supported
computer browsers and Safari on iPhone/iPad. The owner made further Apple portal wording edits;
those portal edits are intentional and must not be overwritten with canonical repository drafts.

Mac screenshots were replaced with two large, readable views of the actual build 8 UI: blocking
controls first, optional sync second. Upload completion/order was verified and the owner confirmed
the images. No later website or dependency change modified submitted screenshots or builds.

The existing Apple `still_sync` non-consumable price was changed to zero across all 175 price points;
product identity, historical records and territory availability were preserved. Review notes now
explain free functionality and the retained legacy product; they no longer direct reviewers to a
paid upgrade. The public Apple page later displayed “Still Pro $0.00”. The app download is also free.
Apple may still display an in-app-purchase label because the product remains configured.

Apple app availability was expanded by the owner to 142 territories. Keep app availability separate
from the existing in-app product's territory availability; do not expand either silently.

## Backend, email and operational decisions

- Migration `0013_counter_retention` was applied; updated Edge Functions were deployed. The later
  `review-signin` deployment was also confirmed. Do not redeploy solely because a session resumed.
- Resend verified `stillapp.fit`. The SMTP API key was scoped to that domain, and the owner confirmed
  sign-in mail arrives from the updated sender. Open/click tracking was confirmed off.
- `support@stillapp.fit`, `privacy@stillapp.fit` and `hello@stillapp.fit` all successfully forwarded to
  the owner's work inbox. Public contact addresses and privacy URLs were updated for store use.
- RevenueCat credentials/webhook were reviewed; successful delivery evidence was present. It remains
  connected for historical purchase/identity handling, not as an access gate in the free release.
- Daily Supabase backups were confirmed. Point-in-time recovery and log drains were not enabled;
  the owner accepted the current setup and manual operational monitoring for now.
- Recheck the email provider allowance before a large campaign. Last observed free-plan capacity
  was limited; do not infer that a Supabase hourly setting increases the provider's daily allowance.

## Remaining work and next safe action

1. Check Apple and Chrome review status live. After approval, complete the selected publication
   steps and verify the actual public version, free-feature wording, screenshots and download links.
2. Complete or locate evidence for the hosted disposable-account seed/switch/export/delete/re-create
   lifecycle and finalize the certification record in #153. Do not delete or mutate the owner's real
   account. Existing synthetic tests do not alone prove the hosted journey.
3. Keep physical iPad coverage SKIPPED / UNVERIFIED under the owner-accepted exception. No repeat
   request for unavailable hardware is needed for this release.
4. Review email capacity before scaling promotion. The owner is waiting for store rollout first.

No new code defect requiring an application change was identified at session end. This does not
turn missing certification evidence into a pass. Preserve the existing signed artifacts and owner
portal text while review is pending.

## Memory and local evidence

Repository documentation is the cross-agent source of truth. Searchable memory is a compact index;
full chat history is not automatically shared between all agents, profiles or future sessions.
Store only privacy-safe summaries, never credentials or raw transcripts. Live facts must be
revalidated before action.

Detailed receipts are intentionally ignored under `docs/build/release-gates/implementation/`,
including `website-copy-20260914/`, `pr-cleanup-20260914/`, `github-issues-20260914/`, and
`apple-listing-audit-20260914/`. These local records are not guaranteed to exist on another checkout.
The user-facing system diagram is a local artifact at
`docs/build/release-gates/artifacts/still-system-diagram/still-system-diagram.png`, with its SVG source
alongside. It explains on-device blocking, optional Supabase/Resend sign-in and sync, account
functions and retained RevenueCat records; it is not website content.
