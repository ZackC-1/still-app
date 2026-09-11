---
title: Align public copy with free Still 2.0
status: in_progress
date: 2026-09-11
---

## Approved outcome

Still 2.0 is free to grow adoption: all four blocking services without an account; optional free
sign-in for settings sync. The owner confirmed a 14-day refund window for earlier web purchases.
Apple continues to handle its own refunds. This is not a permanent-pricing promise.

## Scope

- Correct strategy, agent guidance, README, canonical store copy and marketing guidance.
- Update homepage, public guides, support, Terms and the website sharing image.
- Preserve support/privacy/hello contact mapping and dormant purchase infrastructure.
- Prepare a separate gh-pages update, preserving directory aliases. Publish alongside available 2.0
  store downloads, after provider/privacy and other release gates pass.

## Verification

- Check all visible copy and structured offer data for stale upgrade or price claims.
- Check support/Terms refund wording matches and store field lengths fit their limits.
- Render desktop/mobile public pages, check assets, links and directory aliases.
- Run applicable repository checks and required PR CI before merging source changes.
- Record publication as pending, not complete. Provider privacy text needs its separate gate;
  exact-candidate store screenshots and physical-device journeys remain open.

## Status

Copy prepared and locally verified: lint, typecheck, build, 788 unit tests (39 skipped), and 28
website URL/viewport checks passed. Store text fits field limits and refunds match. Source PR review
and coordinated website publication remain. App code and release package payloads unchanged.
