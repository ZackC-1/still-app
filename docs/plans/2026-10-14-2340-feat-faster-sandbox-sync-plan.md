---
title: "feat: Deliver sandbox settings changes promptly"
date: 2026-10-14
status: active
type: feat
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
---

# Deliver sandbox settings changes promptly

## Goal Capsule

Make a saved setting appear promptly on another active signed-in surface, preserving free blocking, conflict resolution, offline recovery and account isolation. Deliver reviewed source to main and a reproducible sandbox candidate for the owner's next QA session.

## Product Contract

### Summary

Add private server-originated change notifications to the shared-hosted sandbox sync path. Notifications prompt authenticated canonical reads; they never supply settings or grant access.

### Problem Frame

The QA backend deliberately has no public profile subscription. Current modern sync compensates with a five-second periodic read. Two Chrome campaigns passed 26 scenarios, with a single-field median of 5.727 seconds. Brief database connection errors remain unexplained, making globally faster polling an unsuitable first improvement.

### Requirements

- R1: Improve active cross-surface delivery without weakening existing functionality.
- R2: Preserve canonical receipts, per-field merge, immutable retry identity, lifecycle/account fences, signed-out local operation and purchase-independent sync.
- R3: Keep sandbox notifications confined to enabled QA subjects and their own authenticated channels; ordinary production subscriptions and policies remain unchanged.
- R4: Validate through automated unit, integration, database, browser and available native tests, recording skipped physical-device acceptance honestly.
- R5: Merge verified source to main, deploy the authorized sandbox database change through existing protected gates, and prepare the next QA candidate with installation/evidence notes.

### Scope Boundaries

No purchases, customer account deletion, store submission, production Realtime activation or global provider setting changes. No claim of instantaneous delivery while an OS suspends a surface. Existing native App Group authority remains authoritative; no second cloud session in Safari extensions.

## Planning Contract

### Key Technical Decisions

- KTD1: A new additive migration installs a private trigger on committed profile changes for enabled QA members. Emit only a versioned invalidation hint on an account-specific private Broadcast topic. Do not publish profile rows, receipts or settings. A notification error must not fail a settings save.
- KTD2: Private Broadcast receive authorization checks both the authenticated subject and enabled QA membership; clients receive only, never publish. No public-profile subscription is enabled in the QA route. Ordinary production clients retain their current subscription.
- KTD3: The shared SyncService handles hints through existing authenticated canonical acquisition. Coalesce bursts, retain a trailing refresh for changes during an exchange, fence all callbacks by lifecycle, and close the initial subscribe/read gap.
- KTD4: Retain the existing five-second fallback and bounded outage backoff for this release. Faster delivery must not depend on increasing periodic request frequency. Foreground/reconnect catch-up remains required on every host.
- KTD5: Existing protected migration workflow binds exact source, SQL and read-only verification. Owner authorization covers sandbox changes, but GitHub's required human approval must not be bypassed.

### Assumptions

A practical initial target is typical active delivery near 1–2 seconds, to be measured rather than promised. Signed-in two-browser testing may require reuse of existing isolated QA sessions without copying credentials into files. Physical Apple acceptance remains the owner's follow-up when no unattended device lane is available.

### Grounding

Current main 47d965e2; shared sync implementation in packages/core/src/sync/service.ts and profile.ts. Settings commits update public.profiles through private.commit_settings. Sandbox membership is private.qa_sandbox_subjects. Read-only hosted prerequisite check found migration 0022, realtime.send available, realtime.messages RLS enabled and zero current Realtime policies. Existing lessons: docs/solutions/logic-errors/invalidate-sync-work-by-session-lifecycle.md and treat-a-lost-settings-reply-as-unknown-and-reread.md.

External guidance: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes, https://supabase.com/docs/guides/realtime/authorization and https://supabase.com/docs/guides/realtime/broadcast. Private Broadcast uses receive RLS on realtime.messages; managed table ownership must not be altered.

## Implementation Units

### U1. Private sandbox notifications

**Requirements:** R1–R3. **Dependencies:** none.

**Files:** supabase/migrations/0023_qa_settings_notifications.sql; scripts/backend/deploy/verify/0023_qa_settings_notifications.sql and its invariant; supabase/tests/qa_settings_notifications_test.ts; relevant rehearsal workflow.

**Approach:** Add an own-account membership helper, receive-only policy and best-effort trigger with pinned search paths and minimal grants. Preserve all existing data, functions and policies. Rehearse on disposable PostgreSQL with real role/RLS boundaries.

**Tests:** enabled owner can receive; other subject, anonymous and disabled subjects cannot; client insert forbidden; no event for non-QA/no-change updates; changed QA setting emits only the fixed hint; rollback emits nothing durable; notification failure preserves settings save; migration preserves existing rows/ACLs.

### U2. Shared notification acquisition

**Requirements:** R1–R3. **Dependencies:** U1 contract.

**Files:** packages/core/src/sync/{ports,profile,service}.ts and their existing tests.

**Approach:** Give modern sync an invalidation callback without inventing an envelope. Bind QA to its private topic and production to its existing row notification. Join/rejoin requests a canonical read. Coalesce hints and preserve trailing work across in-flight reads/writes. Cancellation removes channels and ignores old callbacks.

**Tests:** immediate peer update; notice during delayed read/write eventually fetches latest; duplicate burst bounded; initial join gap; failure and five-second fallback; sign-out and A→B→A stale callback; no settings or receipt trusted from payload; existing merge/offline/native suites unchanged.

### U3. Validate, ship and prepare QA

**Requirements:** R4–R5. **Dependencies:** U1, U2.

**Files:** verification record beside this plan; docs/release/shared-hosted-sandbox-qa.md; scoped reusable solution; sandbox candidate admission/build metadata as needed.

**Approach:** Run normal repository gates, fixtures, Deno/SQL rehearsal and available Apple checks. Review security/correctness/contracts. Merge through protected PR; dispatch exact migration and expose any owner-only approval promptly. Build a new unique candidate, validate two peers and notification failure/recovery against the hosted sandbox, restore test preferences and preserve prior packages.

**Tests:** time single-field and rapid/concurrent edits; cut notification transport while retaining HTTP and prove fallback; disconnect/reconnect; unauthorized channel negative; compare database errors and idle request counts. Validate actual candidate hashes and distinguish simulator/native test evidence from physical devices.

## Verification Contract and Definition of Done

All source gates pass; database grant/trigger tests pass on a disposable real database; relevant lifecycle/native tests pass; source is merged to main. Hosted migration and exact candidate live tests are separately recorded, never inferred from CI. Candidate and QA handoff identify commit, configuration, hashes, installation instructions and outstanding owner/device gates. Unmet latency target is reported with measurements, not hidden by extending thresholds.

## Risks and Recovery

Broadcast is advisory and can be dropped: retain polling and canonical read authority. Subscription callbacks can arrive after sign-out: lifecycle fencing is mandatory. Database/Realtime failure must not block a committed setting. The migration can be disabled by removing only its trigger/policy through a reviewed forward change; clients fall back to existing polling. No global Realtime configuration change is needed or authorized by this plan.
