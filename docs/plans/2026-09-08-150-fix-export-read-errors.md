---
title: "Reject incomplete account exports after database read failures"
status: implemented
date: 2026-09-08
owner: "Codex / issue 150"
branch: "fix/150-export-errors"
---

## Outcome and context

Account exports return the existing generic HTTP 500 when either database read fails, while healthy
and absent rows retain their HTTP 200 contract. [Issue #150](https://github.com/ZackC-1/still-app/issues/150)
defines the approved real-handler, real-adapter, synthetic-JWT and fake-HTTP test seam.

References: [strategy](../../STRATEGY.md), [architecture](../ARCHITECTURE.md), and
[Supabase hardening](../solutions/security-issues/supabase-edge-function-hardening.md).
The approved release specification supersedes stale paid-tier strategy wording; both paid flags
remain false. Base: `b98f801e7036bac21d0687b18eed0aee88723ee6`.

## Scope and decisions

Only `SupabaseUserStore.getProfile` / `getEntitlement`, focused adapter/account tests and supporting
documentation change. The existing authenticated error wrapper is sufficient. No new retries,
error framework, dependencies, refactoring, deletion behavior or dormant feature changes.
Issue #152 separately owns `deleteUser`; the coordinator reviews the combined adapter.
The test seam is explicitly approved; no unresolved product decisions apply.

## Work units and acceptance

1. Reproduce a profile-only read failure and retain a healthy control at the actual HTTP boundary;
   add only the profile error check and run the focused tests/typecheck.
2. Reproduce an entitlement-only failure; add its error check and rerun focused verification.
3. Cover both failures, genuine absent rows, verified-subject filters despite a body identifier,
   invalid auth, and exact generic error/CORS contracts. Preserve existing deletion tests.
4. Remove each production error check in turn, prove the matching regression fails, and restore
   byte-identical source. Run full frozen Deno tests, typechecking and relevant lint.
5. Capture the reusable learning, commit scoped evidence, and request independent standards/spec
   review through the coordinator.

## Risks, recovery and external gates

The SDK resolves errors rather than throwing; tests must exercise the real SDK to detect this.
Fake HTTP always replaces network access and uses synthetic identifiers. Focused tests run without
network permission. Revert the scoped commit to recover. Deployment and hosted compatibility
verification remain separately approval-gated; no production calls belong to this implementation.

## Completion evidence

- Profile-only regression: healthy control passed; failed with HTTP 200 instead of 500 before the
  profile error check, then both tests passed. Entitlement-only regression independently failed
  with HTTP 200 before its check, then all three tests passed.
- Final focused run:
  `deno test --config supabase/functions/deno.json --frozen --allow-env supabase/functions/__tests__/export-adapter.test.ts supabase/functions/__tests__/account.test.ts`
  passed 19 tests and eight auth steps without network permission. This includes unchanged deletion
  and idempotency tests. The HTTP 503 case exercises the actual SDK retry path.
- Removing each production error check independently caused its corresponding single-read failure
  regression to fail with HTTP 200 instead of 500. Both source restorations were byte-identical.
- `deno test --config supabase/functions/deno.json --frozen --allow-env --allow-net supabase/functions`
  passed 133 tests and eight steps after restoration; all dependencies were synthetic.
- `deno check --config supabase/functions/deno.json --frozen supabase/functions/*/*.ts` passed all
  40 TypeScript files. `deno lint --config supabase/functions/deno.json supabase/functions` passed
  all 40 files. `git diff --check` passed.
- Both paid flags remain false; `deleteUser` is byte-for-byte unchanged from the base.
- [Reusable learning](../solutions/logic-errors/supabase-export-read-errors-are-not-missing-rows.md)
  records the SDK error contract and behavioral test seam.
- Independent standards/spec review is pending with the coordinator. Deployment and hosted
  compatibility remain outside this local implementation; no hosted account flow was invoked.
