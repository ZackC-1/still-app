---
title: Make free Still 2.0 the primary RevenueCat release checklist
status: completed
date: 2026-09-11
owner: Codex
branch: docs/revenuecat-free-release-runbook
---

# Make free Still 2.0 the primary RevenueCat release checklist

## Outcome and scope

The RevenueCat runbook must guide operators through retained identity, provider configuration and
privacy validation for free 2.0 without requiring a new purchase, Stripe setup or plan upgrade.
Preserve useful paid-launch setup and July validation history under an explicit reference section.
Only the runbook and this plan change; the documentation index already links the release runbooks.

## Context and decisions

- [Strategy](../../STRATEGY.md): all blocking is accountless; optional settings sync is free; both
  paid flags remain disabled while RevenueCat identity and historical entitlements remain intact.
- [Architecture](../ARCHITECTURE.md) and
  [retention learning](../solutions/security-issues/window-bound-security-counter-retention.md):
  source behavior and provider retention require separate evidence.
- [RevenueCat runbook](../release/04-revenuecat.md): previously led with paid activation and
  obsolete paid-sync expectations. No live dashboard facts are asserted by this documentation change.
- CodeGraph context/explore and targeted tracked-source inspection establish
  `REVENUECAT_PUBLIC_API_KEY` → `RevenueCatPublicAPIKey`, current server secret names,
  anonymous/UUID identity transitions, static webhook-header comparison and Purchase Link assembly.
  Current checkout code does not consume `REVENUECAT_WEB_PRODUCT_ID` or append `package_id`.

## Work and acceptance

1. Add a pending free-release checklist covering app/key association, integrations/exports,
   existing webhook settings/delivery, identity, retention/deletion and App Privacy.
2. Mark paid setup and old migration checks as historical; correct source/config mismatches without
   changing current runtime behavior or claiming portal verification.
3. Check links, whitespace and final diff; commit and open a documentation-only PR.

An operator should be able to identify the free-release checks without entering a purchase flow.
Existing customer history, catalog and restoration settings must not be changed merely to mark a
checkbox complete. Provider faults require observed evidence; missing evidence stays pending.

## Risks and external boundary

Retained paid procedures may be mistaken for current instructions. Separate headings and explicit
warnings identify their scope, and the obsolete migration-denial expectations are labeled historical.
Public documentation includes no new private reports, customer records, credentials or provider IDs.
No dashboard access, provider change, source deployment, app rebuild or store publication is included.
Fix documentation forward if verified source/provider behavior changes. Root reviews the PR before
any merge; app suites need not be rerun locally for this documentation-only change.

## Completion evidence

- `git diff --check` passed; both documents have balanced fences and all 10 relative link targets
  exist. Checks found no private working-directory paths or private-report references.
- Reviewed the complete diff against the scope, source configuration and current free-release
  strategy. Public API-key build-setting names and obsolete checkout parameters were corrected.
- Official RevenueCat documentation for SDK keys, apps/providers, integrations/exports, webhooks,
  customer deletion, restore behavior and Apple privacy was read on September 11; the runbook links
  those primary sources. Live dashboard settings remain explicitly pending.
- App tests and builds were not rerun for these documentation-only changes. Required PR CI remains
  separate. No runtime code or external state changed.
- No new solution document is needed: the existing operational instructions now apply the
  established retention learning to the free-release checklist.
