---
title: Keep sensitive request data out of review sign-in logs
status: completed
date: 2026-09-11
owner: Codex
branch: fix/review-signin-private-logs
---

# Keep sensitive request data out of review sign-in logs

## Outcome and scope

Review sign-in logs retain timestamps and fixed outcomes without copying request IPs or untrusted
provider exceptions. Authentication, responses, CORS and existing per-email/per-IP limits stay the
same. This follows the minimal-retention requirement and complements the short-lived counter
storage; it does not change provider logs, existing log copies, backups or purchase infrastructure.

## Context and decision

- [Strategy](../../STRATEGY.md): minimize collection while keeping blocking accountless and sync optional.
- [Architecture](../ARCHITECTURE.md): Edge handlers own backend authentication boundaries.
- [Retention learning](../solutions/security-issues/window-bound-security-counter-retention.md).
- [Retention runbook](../release/counter-retention.md).
- The [July review-sign-in plan](2026-07-15-002-fix-otp-error-path-and-review-signin-plan.md)
  requested IP logging for audit/network observation. No auth or throttle decision reads these logs.
  The authorized change replaces that historical audit choice with timestamp/outcome reporting.
  It loses historical network attribution while retaining failure counts and sign-in outcomes.

## Work units and acceptance

1. Replace the IP-positive audit test with synthetic request/error sentinel coverage. Assert log
   shape, no IP/email/code/token data, equivalent refusal logs, and existing response bodies/statuses.
2. Remove the request argument/IP field from audit logging. Emit fixed error categories for limiter
   and session-mint failures, never exception messages, causes or stacks. Keep all limiter calls.
3. Run focused regressions and relevant Deno checks/tests/lint, review the final diff, update the
   existing retention learning/runbook, and open a scoped PR.

Success, wrong code, mismatched email, unset configuration, exhausted limits, limiter failure for
both actions, and session-mint failure must retain their existing client outcomes. IPv4, IPv6 and
forwarded headers must not enter handler logs. Existing rate-limit tests must still prove per-email
then per-IP enforcement and Retry-After behavior.

## Risks and release boundary

Generic errors provide less provider debugging detail. Keep the event category and timestamp;
investigate provider incidents through authorized tooling with a separate retention policy. This
source change does not erase historical logs or prevent provider-generated request metadata.
Deploying the reviewed `review-signin` function is a separate action. No migration, Apple/browser
artifact rebuild, provider setting change, merge or deployment is part of this PR preparation.
If corrected logging needs adjustment, fix forward without reintroducing sensitive exception/IP data.

## Completion evidence

- Regression demonstrated before the handler change: existing 20 tests passed; the new audit test
  failed all 24 synthetic steps against raw-IP/exception logging.
- Focused handler tests: 21 passed, including all 24 IPv4/IPv6/forwarded-header and error scenarios.
- `deno test --config supabase/functions/deno.json --frozen --allow-env --allow-net supabase/functions`:
  135 tests and 32 steps passed. Existing refusal, Retry-After and IP-throttle coverage passed.
- `deno check --config supabase/functions/deno.json --frozen supabase/functions/*/index.ts`:
  all seven function entrypoints passed.
- `deno lint --config supabase/functions/deno.json supabase/functions supabase/tests`:
  41 files passed. `git diff --check` passed.
- Final diff reviewed for response changes, fail-open paths, unsanitized error arguments and
  accidental provider-erasure claims; none found in the changed scope.
- Updated the existing retention learning and runbook. No provider settings or hosted functions
  changed. Source verification is complete; merge and deployment remain separate release actions.
