---
title: Never raise 40001 or 40P01 for a business error in a function PostgREST can reach
date: 2026-10-17
category: integration-issues
module: supabase/migrations
problem_type: integration_issue
component: database
applies_when: Writing or reviewing any SQL function, RPC or trigger that a Supabase Data API (PostgREST) request can run, or choosing an error code for a refusal
symptoms:
  - "Thousands of rolled-back transactions a second with no matching client traffic"
  - "Postgres logs flooded with one error message from one RPC, capped at 100 lines a second"
  - "Intermittent PGRST003 (connection pool timeout) for unrelated requests"
  - "authenticator backends that started hours ago and never go idle"
root_cause: wrong_error_code
resolution_type: code_fix
severity: critical
status: active
tags: [supabase, postgrest, sqlstate, retry, serialization-failure, migrations, incident]
---

# Never raise 40001 or 40P01 for a business error in a function PostgREST can reach

## Problem

Migration 0015 refused a released-app settings save with
`raise exception 'settings client upgrade required' using errcode = '40001'`. The function is
called by released apps through PostgREST. From 2026-10-16 03:39 UTC about 20 PostgREST backends
each re-ran the refused transaction without end (about 1,600 rollbacks a second in total). They
held the PostgREST pool and other users got `PGRST003` timeouts. The loops kept going after the
apps were gone.

## Cause

PostgREST treats SQLSTATE `40001` (serialization_failure) and `40P01` (deadlock_detected) as
transient: it rolls back and re-runs the whole request transaction. The hosted PostgREST retries
without a limit (Supabase troubleshooting guide "SQLSTATE 40001 in an RPC function causes infinite
retries"; fixed upstream in PostgREST 16, postgrest/postgrest#4222). A deterministic refusal fails
the same way every time, so the retry never ends and never reaches the client.

The code looked reasonable because the refusal sits next to a lock ("someone else changed this,
retry"), and the local stack hid the bug: the CLI's PostgREST 16 answers 40001 at once as HTTP 500.

## Solution

Migration 0024 replaced the function with the same body and the code `PT409`. PostgREST maps a
`PTxyz` code to HTTP status xyz and does not retry it; the message and the unchanged row stay the
same. Pick the code for what the client should see:

- `PTxyz` (for example `PT409`, `PT403`) when the HTTP status matters to the caller;
- `P0001` or a domain code (`22023`, `28000`, `42501`) otherwise.

Keep 40001/40P01 only where nothing retries automatically, such as a helper reached only over a
direct PostgreSQL connection that handles the code itself. `private.commit_settings` raises 40001
for that reason: only `still_settings_writer` may execute it and `sync-settings` calls it over
postgres.js, which does not retry.

## Fixing the function may not stop loops already running

A loop re-executes the function on every retry, and PL/pgSQL recompiles a function whose catalog
row changed, so after the deploy the next retry should get `PT409` and stop. Do not assume it:
after deploying, compare `xact_rollback` in `pg_stat_database` over a minute and look for active
`authenticator` backends running the function. If any that started before the deploy keep looping,
terminate exactly those with an owner-approved `pg_terminate_backend`; PostgREST reopens its pool
connections by itself. The runbook is
`docs/plans/2026-10-17-001-fix-legacy-settings-infinite-retry.md`.

On the hosted project (PostgREST 14) the redefinition was enough: within a minute of the deploy
the rollback rate fell to zero, the log line stopped, and the looping backends, which had run for
about 36 hours, closed on their own. No termination was needed. Keep the check anyway; a
different loop shape may not re-read the function.

## Prevention

- `scripts/backend/deploy/deploy.test.mjs` scans every migration (latest definition wins) and
  fails if a function in an API schema, granted to `anon`/`authenticated`/PUBLIC, or used as a
  trigger raises `40001`, `40P01`, `serialization_failure` or `deadlock_detected`. It also pins
  the one allowed exception, `private.commit_settings`.
- The 0024 gate reports `routine_retryable_sqlstate` if the code ever returns to the released
  apps' RPC.
- Review rule: an error code is part of the API contract. Check how the gateway handles a code
  before choosing it, and test refusals through the real gateway, not only in SQL.

## Verification

- Red first: without 0024 the scan names `public.write_profile_settings (0015_settings_sync_per_field.sql)`;
  with it, the deploy suites pass.
- Local disposable stack: at 0023 a guarded save through PostgREST returned HTTP 500 `40001`;
  after applying 0024 it returned HTTP 409 `PT409` in milliseconds with the row unchanged, and a
  second apply was a no-op.
- `scripts/backend/rehearse-settings.sh` repeats the upgrade on a GitHub-hosted runner, directly and
  through the gateway, and checks no retry loop is left running.
