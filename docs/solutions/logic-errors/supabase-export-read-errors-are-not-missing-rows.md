---
title: Supabase export read errors are not missing rows
category: logic-errors
track: bug
problem_type: logic_error
module: supabase/functions
applies_when: An account read uses the Supabase SDK and accepts absent rows
date: 2026-09-08
status: active
tags: [supabase, export, error-handling, account-api]
---

## Symptom and cause

The account export API returned HTTP 200 with null records after database reads failed. The SDK's
`maybeSingle()` resolves with both `data` and `error`; it does not necessarily reject its promise.
`SupabaseUserStore.getProfile` and `getEntitlement` read only `data`, so `data ?? null` silently
converted an outage or permissions failure into a successful empty or partial export.

## Verified solution

Both reads now inspect `error` and throw it before returning `data ?? null`. Genuine absent rows
still return null. The existing authenticated handler wrapper catches either failure and returns
the established HTTP 500 `{ "error": "internal" }` response with CORS headers. Raw SDK details
stay out of the client response. No new error wrapper or retry mechanism is needed.

This change applies to export reads only. Deletion's existing 404 idempotency rule is separate;
do not generalize a missing-user exception into ignoring database read failures.

## Behavioral proof and prevention

[`export-adapter.test.ts`](../../../supabase/functions/__tests__/export-adapter.test.ts) exercises
the real export handler, Supabase adapter/SDK and JWT signer/verifier with fake HTTP responses.
An in-memory `UserStore` alone cannot reveal the SDK's resolved-error behavior.

The tests cover healthy rows, either absent row or both, profile-only/entitlement-only/both failed
reads, an HTTP 503 retry path, exact generic errors and response headers, verified-subject query
filters despite a different body identifier, and invalid authentication with no database reads.
Profile-only and entitlement-only regressions each failed before their own production check, then
passed. Removing each check independently reproduced the failure; source bytes were restored.

Run the focused regression without network permission:

```sh
deno test --config supabase/functions/deno.json --frozen --allow-env supabase/functions/__tests__/export-adapter.test.ts supabase/functions/__tests__/account.test.ts
```

Verification also passed the full frozen Deno suite, function typechecking and lint. This is local
SDK/handler evidence; it does not establish deployed backend compatibility or exercise hosted
accounts. Deployment remains an explicit release gate.

Related: [Supabase Edge Function hardening](../security-issues/supabase-edge-function-hardening.md),
[issue #150](https://github.com/ZackC-1/still-app/issues/150), and
[implementation plan](../../plans/2026-09-08-150-fix-export-read-errors.md).
