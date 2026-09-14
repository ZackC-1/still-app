---
title: Refresh reference documents for Still 2.0.0
status: implemented
date: 2026-09-14
owner: codex-personal
branch: docs/still-2-reference-audit
---

# Refresh reference documents for Still 2.0.0

Baseline: `4877e2ed38b8ea81feaca7b1d4d807a0a2b4f7ef`, the merged organization PR #197.
The owner requested a complete current-reference audit after that organization pass.

## Work and boundaries

- Inventory tracked Markdown documents, distinguish current guidance from dated evidence, and
  check current product, architecture, setup, release, privacy and marketing references.
- Add a current product specification. Preserve the original v1 specification as historical design.
- Replace paid-era reference instructions with the free 2.0.0 behavior; preserve original documents
  and their unique decisions in a labeled archive with working links.
- Explain optional account sync, first-sign-in reconciliation, account isolation, local sign-out,
  dormant purchases, supported browsers, actual configuration and version/artifact provenance.
- Reconcile completed deployment/privacy decisions and pending certification without inventing new
  device tests or portal checks. Preserve the physical iPad exception and owner portal wording.
- Update changelog, vocabulary, navigation and related learnings. Preserve source, assets, policies,
  migrations, configuration and submitted artifacts; no external deployment or store changes.

## Verification

Verify all non-Markdown baseline files remain byte-identical, archive content is preserved except
for explicit link rebasing and historical labeling, local links have no new failures, documented
commands/configuration match source, and current references no longer direct a paid activation flow.
Use the normal required CI checks and protected PR merge; finish with local/GitHub synchronization.

The September 14 release record is dated evidence. Live store status must be checked before an
external release action; this documentation audit is not such an action and does not certify it.

## Implementation evidence

- Audited all 147 baseline Markdown files, classified in the ignored per-file inventory.
- Added the current product specification and reconciled product, architecture, configuration,
  store, privacy, marketing and operational references with source and dated release evidence.
- Preserved nine superseded documents in full with historical labels and commit-pinned links.
- Verified all 403 non-Markdown baseline files remain byte-identical.
- Local path/anchor checks: zero new broken links; 21 documented package commands verified.
- Confirmed free flags, browser package versions, Xcode defaults and platform/toolchain requirements.
- `git diff --check` passed. Required CI and protected merge are recorded in the linked PR.

No application build, website publication, device test or store action was performed by this audit.
