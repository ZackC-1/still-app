---
title: Stop the released apps' settings save from retrying forever on the server
status: completed
date: 2026-10-17
---

# Stop the released apps' settings save from retrying forever on the server

## Problem

Since 2026-10-16 about 03:39 UTC, around 20 PostgREST (`authenticator`) database connections in
production have each been re-running the same refused transaction without end: roughly 1,600
rolled-back transactions a second in total, every one logged as `settings client upgrade required`
from `public.write_profile_settings`. They hold most of the PostgREST connection pool, so real
users see intermittent `PGRST003` pool timeouts. The loops continue whether or not any app is
still connected.

## Root cause (verified)

Migration 0015 added a guard to the released apps' settings RPC `public.write_profile_settings`
that refuses a released-app write for an account a newer client now owns. It raised SQLSTATE
`40001` (serialization_failure). PostgREST treats 40001 and 40P01 as transient and retries the
whole transaction; the hosted PostgREST version retries without a limit (fixed upstream in
PostgREST 16). The guard is deterministic, so every refused request that reached it turned into a
permanent server-side loop.

`private.commit_settings` also raises 40001, but PostgREST cannot reach it: only
`still_settings_writer` may execute it, and `sync-settings` calls it over its own direct
PostgreSQL connection (postgres.js, `SETTINGS_WRITER_DB_URL`), which never retries. It is
unchanged.

## Change

- `supabase/migrations/0024_legacy_settings_guard_non_retryable.sql`: the 0015 body with one change,
  the guard raises `PT409` (HTTP 409, never retried); same message, signature, result columns,
  owner, SECURITY DEFINER, search path and signed-in-only grant. Precondition: replaces only the
  reviewed 0015 body (or its own); self-check of the end state.
- `scripts/backend/deploy/verify/0024_legacy_settings_guard_non_retryable.sql` (read-only gate) and
  `.invariant.sql` (no row changes).
- `scripts/backend/deploy/verify/qa-function-prerequisites.sql` pins the 0024 body.
- `scripts/backend/deploy/deploy.test.mjs`: the real 0024 plan, and a scan that fails if any
  function a PostgREST request can reach raises 40001/40P01 (latest definition wins).
- `supabase/tests/legacy_settings_guard_test.ts`, run by `scripts/backend/rehearse-settings.sh`:
  0023 to 0024 upgrade, directly and through the real PostgREST gateway.

Released apps (for example 2.1.1) treat any failed write the same way, with exponential backoff
capped at 30 seconds, and read no error code, so the new code needs no client change.

## Deploy (owner approval required)

1. After the PR merges, dispatch the protected production migration for the merge commit,
   plan first, then apply:

   ```bash
   gh workflow run supabase-production-deploy.yml --ref main \
     -f commit=<merge commit SHA> -f operation=migrations \
     -f migrations=0024_legacy_settings_guard_non_retryable.sql -f mode=apply
   ```

   The run must report the 0024 gate as `[]`. A row-count warning is possible from live released-app
   saves during the run; check the invariant privately if it appears.
2. Record the deploy time (UTC).

## After deploy: confirm the loops stopped (read-only)

New transactions run the new body, so a backend that re-runs the function should stop on its own
at its next retry. Confirm instead of assuming:

1. Rollback rate. Run twice, 60 seconds apart, and compare `xact_rollback`:

   ```sql
   select now(), xact_commit, xact_rollback
   from pg_catalog.pg_stat_database where datname = pg_catalog.current_database();
   ```

   Before the fix the difference was about 96,000 a minute. Afterwards it should be near the normal
   baseline (tens a minute at most).
2. Logs. In the Supabase Postgres logs, count `settings client upgrade required` per minute. The
   message is unchanged (refusals still happen when an old app saves), but it should fall from the
   capped 100 a second to a handful a minute, logged with SQLSTATE `PT409`, not `40001`.
3. Looping backends:

   ```sql
   select pid, backend_start, state, xact_start
   from pg_catalog.pg_stat_activity
   where usename = 'authenticator' and state = 'active'
     and query ilike '%write_profile_settings%';
   ```

   Expect no rows, or only short-lived ones.

## If the loops continue (owner approval required)

If checks 1 or 3 still show looping `authenticator` backends that started before the deploy time,
terminate exactly those, then repeat the read-only checks. PostgREST reopens pool connections on its
own.

```sql
select pid, pg_catalog.pg_terminate_backend(pid)
from pg_catalog.pg_stat_activity
where usename = 'authenticator' and state = 'active'
  and backend_start < '<deploy time UTC>'::timestamptz
  and query ilike '%write_profile_settings%';
```

## Verification

- Red first: `node --test scripts/backend/deploy/deploy.test.mjs` without 0024 fails the 0024 plan
  test and the retry scan (it names `public.write_profile_settings (0015_settings_sync_per_field.sql)`).
  With 0024 every deploy suite passes.
- Local disposable stack (CLI 2.117, PostgREST 16.2): at 0023 the gate reports
  `migration_version`, `routine_body`, `routine_retryable_sqlstate`, and a guarded save through
  PostgREST returns HTTP 500 with code `40001` (this local PostgREST does not loop; the hosted one
  does). After `supabase migration up` the gate returns `[]`, the invariant is unchanged, the same
  save returns HTTP 409 `PT409` in a few milliseconds with the row unchanged, ordinary saves still
  return 200, and a second apply changes nothing.
- CI: the settings rehearsal runs the same proof on a GitHub-hosted runner; the QA functions
  rehearsal runs the prerequisite gate at 0024.
- Production (17 Oct 2026, applied 16:10 UTC): the function body now hashes to the 0024 value.
  Rolled-back transactions went from about 1,700 a second to 0 within the first minute; the
  "settings client upgrade required" log line went from 6,000 a minute (the cap) to none after
  16:10; all project log lines fell from about 6,080 to about 70 a minute. The 20 looping
  `authenticator` backends that started on 16 Oct closed by themselves, and no connection is left
  idle in a transaction. No backend had to be terminated.
- First attempt refused: a deploy dispatched before another PR changed
  `scripts/backend/deploy/operations.mjs` was rejected by the freshness check (`main-moved`) and
  applied nothing. Dispatch production runs only after every PR touching `scripts/backend/` merges.
