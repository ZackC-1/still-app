---
title: Prepare accurate privacy and availability copy for Still 2.0
status: completed
date: 2026-09-11
owner: Codex
branch: docs/privacy-release-ready
---

# Prepare accurate privacy and availability copy for Still 2.0

## Outcome

Visitors can understand the free 2.0 model, distinguish it from store availability, and see which
information account deletion removes. Prepare source pages and the website publishing branch for
review. Publication is a separate release action.

## Context and evidence

- [Strategy](../../STRATEGY.md): free blocking, optional free sync, retained RevenueCat identity.
- [Existing privacy draft](../release/privacy-retention-draft.md) and
  [counter-retention runbook](../release/counter-retention.md): separate active counters from
  service logs, audit records, backups and billing history.
- [Counter retention learning](../solutions/security-issues/window-bound-security-counter-retention.md):
  preserve qualified cleanup bounds and the local account-safety marker.
- [Website branch/alias learning](../solutions/conventions/github-pages-custom-domain-certificate.md):
  source merges do not publish gh-pages; verify directory aliases and assets in a browser.
- Owner confirmed Supabase Pro/daily physical backups/PITR off/no drains, Resend Free/tracking off,
  RevenueCat's sole integration to Supabase, and Google Workspace support mail until manual deletion.
  Provider documentation linked in the policy supports advertised windows, not all-copy erasure.
- The review-sign-in logging fix is deployed and downloaded application source matches the reviewed
  revision. This does not establish historical log erasure or sanitize unrelated handlers.

## Scope and decisions

Update `docs/privacy.html` and warranted public copy inconsistencies. Add version-availability
qualification to public pages and each store link. Preserve the approved 14-day earlier-web-purchase
refund terms. Mirror reviewed pages and existing directory aliases into the website draft PR.
No runtime, billing configuration, provider retention settings, store submission or publication changes.

The policy describes current deletion exclusions without inventing a new retention period. That
copy correction needs no runtime change. The retention runbook still requires resolving database
audit storage/cleanup and retained billing/customer history before publication. Owner acceptance
of a specific retention policy is separate from describing current behavior. Historical Stripe
processing must be established before adding Stripe to the policy's active provider inventory.

## Acceptance and verification

- Privacy wording explains anonymous RevenueCat identity, optional account sync, native provider
  logs versus database audit records, backups, manual support retention and account deletion limits.
- No page claims that signed-out use collects nothing, that all data disappears immediately, or
  that every linked store already distributes 2.0. Homepage structured data makes no current 2.0 offer.
- Existing 14-day refund terms and public contact addresses remain consistent.
- Visit all 14 public URLs at 375px and 1440px; check responses, assets, anchors, JSON-LD and overflow.
  Inspect privacy at 320px in dark mode and screenshots of mobile privacy/download sections.
- Compare mirrored source and all four directory aliases byte-for-byte. Run `git diff --check`.
  Full application suites are unnecessary for static copy changes.

## External gates and recovery

Keep the website PR draft. Before publication, approve the retention/deletion wording against the
existing runbook, reconcile App Privacy classifications, update each platform's availability from
its store, and set policy/Terms dates to actual publication. A source PR merge does not publish the
website. Revert only this bounded copy commit if needed; preserve prior website preparation.

## Completion evidence

- All 14 public URLs returned 200 at 375px and 1440px: 28 page checks, no missing assets, page
  errors, horizontal overflow or invalid JSON-LD. All 33 distinct internal links/anchors resolved.
- Privacy also passed at 320px in dark mode. Mobile privacy and release-copy screenshots inspected.
- All 10 source pages and four directory aliases match byte-for-byte; both worktree diffs pass
  `git diff --check`. No app suites were run for static copy.
- Source and website changes are prepared for review only; publication gates above remain open.
- No new durable solution document is needed: existing website branch/alias and retention learnings
  cover the failure modes and are applied here.
