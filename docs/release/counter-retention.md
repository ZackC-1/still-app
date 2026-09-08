# Security counter retention deployment

Status: **approval required** for hosted migration, purge, deployment, provider changes, and privacy
publication. Issue #152; migration `0013_counter_retention.sql`. Do not run these steps against a
hosted project just because local tests pass. This runbook covers security counters; it does not
promise erasure of provider logs, purchase records, WAL, backups, or every account identifier.

## Storage and lifetime

| Data | Purpose and storage | Removal and limit |
|---|---|---|
| Raw connection IP | Transient request header and bound database RPC input; never a new stored counter key | Not written to application counter tables. Provider request/query/error logging must be checked separately. |
| Derived connection counter | HMAC under a random key shared only within a fixed 60s or 600s window; count, window, expiry | Window key deletion cascades to counters. No account association. Account deletion preserves the existing shared-network cap. |
| Derived user/email counter | Same window-specific HMAC; optional UUID foreign key to `auth.users` | Account deletion cascades linked counters in its auth transaction; review-email triggers attach pre-account counters and remove remaining current-email buckets. Otherwise same expiry as the connection counter. |
| Window key | Random 32 bytes, window and expiry; owner-only table | Deleted with expired counters. It is not a persistent connection identifier. |
| Device safety marker | Last-synced-account UUID in local extension/App Group storage | Deliberately survives sign-out/account deletion to prevent one account's settings crossing into another. Local settings reset/uninstall behavior is platform-specific; no new marker change here. |

The longest existing window is 600 seconds. The scheduled job runs every minute, with a five-second
statement timeout. **Under healthy, on-time scheduling and a successful cleanup, records are removed
within their remaining window plus 65 seconds** (at most 125 seconds for a 60-second window; at most
665 seconds for a 600-second window). This includes the cleanup interval and successful execution
budget. Logical expiry alone does not delete records. PostgreSQL DELETE removes live table records;
MVCC dead tuples, WAL, replicas and backups do not become securely erased bytes at that instant.

There is no unconditional wall-clock bound during database downtime, scheduler failure, lock
contention that times out a job, or suspended projects. A missed/failed job is a retention incident,
not permission to extend policy. The next successful cleanup removes all overdue window keys and
counters. Incoming limiter calls also attempt cleanup and fail closed if cleanup fails. They cannot
repair a completely unavailable database. Monitor overdue rows and job failures before launch.

The RPC signature, 60/600-second windows, per-account-first behavior, shared-network caps and
`Retry-After` remain compatible with existing callers. The migration resets transient legacy caps
once because legacy rows contain raw identifiers and do not store their duration. Do not run it
repeatedly as an operational cleanup.

## Provider inventory and unresolved release gates

These are separate from the tested counter-table behavior. An application SQL DELETE does not
establish any of these providers' retention/deletion guarantees.

| System | Potential retained data | Required owner verification |
|---|---|---|
| Supabase Auth database and audit logs | Sessions/refresh tokens; audit events may include account/email/IP | Verify actual auth cascades, `auth.audit_log_entries`, database audit logging settings, expiry and deletion support. Do not infer audit erasure from deleting `auth.users`. |
| Supabase Edge/API/Realtime and database logs | Request IPs/headers, auth subject, RPC parameters or error details | Verify plan retention, parameter/error logging, log drains and downstream copies; establish deletion or retention exception before publication. The driver now drops parameter-bearing errors from application handler logs. |
| PostgreSQL WAL/replicas/daily backups/PITR | Earlier raw counters, account records, window secrets and derived keys | Confirm retention/recovery configuration, replica lag, purge propagation and restore process. Restore only into isolation and reapply deletions/expiry before serving traffic. |
| SMTP/email provider | Delivery address, send/delivery events, potentially request metadata | Verify the configured vendor, retention, deletion API and backups. No email was sent by these tests. |
| RevenueCat, Apple and retained billing/event records | Anonymous/account purchase identifiers and financial/event records; application `revenuecat_events` retains identifiers independently of this counter FK | Confirm necessary retention and deletion responsibilities. Existing dormant payment plumbing and event history were not changed. No blanket account-data-erasure claim is supported by this change. |
| Static hosting and any operator log drains | Transport IP/log metadata and forwarded logs | Verify actual enabled services, retention and deletion support. |

Read-only management checks confirmed hosted auth configuration and the presence of managed
backups. Those observations do not establish log/backup retention or account-deletion handling.
The release owner must verify plan-specific retention, PostgreSQL parameter/error logging and
restore procedures through an authorized dashboard/operator. If
provider retention contradicts the approved functionality-only/IP-deletion policy, obtain a specific
decision or configure supported deletion before release. The short-lived counter exception does not
authorize indefinite provider retention.

Primary references (checked 2026-09-08): [Supabase Cron](https://supabase.com/docs/guides/cron),
[logs](https://supabase.com/docs/guides/observability/logs),
[Auth audit logs](https://supabase.com/docs/guides/auth/audit-logs), and
[backups](https://supabase.com/docs/guides/platform/backups). Log retention depends on the project
plan; documentation is not evidence of this project's live settings.

## Disposable local verification

Use a dedicated container and loopback-only port. The fixture refuses any URL except
`127.0.0.1:55432/postgres` and also requires a synthetic-only marker. The commands below use a
synthetic password and are **only for a new disposable container**. Never substitute a hosted URL.

```sh
docker run -d --name still-retention-152 --label still.synthetic-test=152 \
  -e POSTGRES_PASSWORD=synthetic-local-only -e POSTGRES_DB=postgres \
  -p 127.0.0.1:55432:5432 supabase/postgres:17.6.1.166 \
  postgres -c listen_addresses='*' -c shared_preload_libraries=pg_cron,pg_stat_statements \
  -c cron.database_name=postgres -c cron.use_background_workers=on
```

After `pg_isready`, set the disposable `supabase_auth_admin` password to the same synthetic password
using its local `psql`, then apply the installed GoTrue migrations without starting the auth server:

```sh
docker exec still-retention-152 psql -U supabase_admin -d postgres \
  -c "alter role supabase_auth_admin password 'synthetic-local-only';"
docker run --rm --network container:still-retention-152 \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL=postgresql://supabase_auth_admin:synthetic-local-only@127.0.0.1:5432/postgres \
  -e GOTRUE_SITE_URL=http://127.0.0.1:9999 -e API_EXTERNAL_URL=http://127.0.0.1:9999 \
  -e GOTRUE_JWT_SECRET=synthetic-jwt-secret-at-least-32-characters \
  public.ecr.aws/supabase/gotrue:v2.196.0 auth migrate
```

Initialize only this disposable DB via `docker exec ... psql -U supabase_admin`:

```sql
create schema retention_test authorization postgres;
create table retention_test.synthetic_only(issue integer primary key check(issue = 152));
insert into retention_test.synthetic_only values (152);
grant all on retention_test.synthetic_only to postgres;
grant usage on schema auth to postgres;
grant all on all tables in schema auth to postgres;
create extension if not exists pg_cron;
grant usage on schema cron to postgres;
grant all on all tables in schema cron to postgres;
grant execute on all functions in schema cron to postgres;
create role still_entitlement_writer nologin;
grant still_entitlement_writer to postgres with set true;
```

The local-only grants let the fixture reset synthetic auth data, exercise the narrow writer, and
observe the scheduler. They are **not migration instructions for production**. The shipped migration
adds no new client RPC grants. Run from the worktree with its frozen lockfile:

```sh
STILL_RETENTION_TEST_DATABASE_URL=postgresql://postgres:synthetic-local-only@127.0.0.1:55432/postgres \
  deno test --config supabase/functions/deno.json --frozen --allow-env \
  --allow-net=127.0.0.1:55432 --allow-read=supabase/migrations \
  supabase/tests/rate_limit_retention_test.ts
deno check --config supabase/functions/deno.json --frozen supabase/functions/*/index.ts
deno test --config supabase/functions/deno.json --frozen --allow-env --allow-net supabase/functions
```

The fixture destructively resets only its synthetic application's tables, then applies migrations
0001 through 0013. It uses the real Supabase auth schema updated by GoTrue 2.196.0 migrations, including identity
cascades, and pg_cron. It replaces only
`clock_timestamp()` with a controlled clock **inside the disposable database**; production exposes
no clock override. It exercises real SQL rows and locks; the auth HTTP boundary is synthetic and
executes an actual SQL user deletion. It does not claim a live hosted GoTrue deletion. The cron
step waits for a real scheduled run, at most 65 seconds. Remove only this labeled disposable
container when its evidence is complete; do not prune other workers' containers or volumes.

## Approval package and dry run

Prepare exact reviewed migration/Edge commit hashes and the combined #150 adapter revision. Obtain
approval naming the target project and these effects before the first hosted mutation. Keep project
IDs, credentials and private row counts out of public PRs. Use the existing secret-management path;
never put passwords or service keys in command arguments.

Read-only preflight, as an authorized operator:

```sql
select extname, extversion from pg_extension where extname in ('pgcrypto', 'pg_cron');
select has_table_privilege(current_user, 'auth.users', 'TRIGGER') as can_install_auth_triggers;
select count(*) as legacy_counter_rows from public.rate_limit_counters;
select proname, pg_get_userbyid(proowner) as owner from pg_proc
where oid = 'public.consume_rate_limit(text,integer,integer)'::regprocedure;
```

Also confirm `extensions.hmac`/`extensions.gen_random_bytes`, cron schema/schedule access, deployed
caller limits, existing migration history and sufficient lock/statement timeouts. Do not print raw
bucket keys or query parameters. Capture counts/fingerprints privately for unrelated profiles,
entitlements, auth identities and operational tables. Complete provider inventory first.

Run `supabase db push --dry-run` from the exact reviewed checkout linked to the confirmed project.
Abort if it proposes anything beyond the approved pending migration(s). Dry-run lists migrations;
it does not establish SQL validity, row preservation, privilege success or cron health. Disposable
execution supplies those checks. If pg_cron is absent, enabling it is a separately named approved
provider action; do not broaden the migration role to work around a denied prerequisite.

## Approved deployment sequence

1. Obtain explicit approval for enabling cron if needed, the migration's one-time legacy purge,
   Edge deployment and later privacy publication. Record target and exact reviewed commit.
2. Apply only approved migration 0013 using the established migration runner (`supabase db push`
   after the inspected dry run). It adds two auth triggers, a cascading account FK, the owner-only
   window-key table, constraints/indexes, replacement RPC and minute cleanup job. Apply atomically;
   SQL failure must roll back the migration. No profile/entitlement/identity data should change.
3. Deploy the reviewed Edge revisions containing `_shared/pg-store.ts` and deletion adapter with
   `supabase functions deploy <name>` for `reconcile-entitlement`, `create-web-checkout`,
   `review-signin`, and `delete-user`. This shared-module deployment changes retention/error handling,
   not dormant purchase behavior. Coordinate any combined #150 export deployment separately.
4. Validate below without issuing OTP, creating sessions, deleting real accounts or exercising a
   mutating limiter RPC casually. Use an explicitly approved synthetic staging account for end-to-end
   mutation checks; never treat a rollback transaction as authorization for production writes.
5. After provider gates, deployment evidence and explicit publication approval, apply the reviewed
   privacy draft to the actual public page. A draft in this repository is not the live notice.

## Deployment verification and recovery

```sql
select count(*) as invalid_keys from public.rate_limit_counters
where bucket_key !~ '^(checkout|reconcile|review-signin:(request|verify)):(user|ip):[0-9a-f]{64}$';
select count(*) as overdue from public.rate_limit_window_keys
where expires_at < clock_timestamp() - interval '65 seconds';
select jobid, schedule, active from cron.job where jobname = 'still-rate-limit-retention';
select status, start_time, end_time from cron.job_run_details
where jobid in (select jobid from cron.job where jobname = 'still-rate-limit-retention')
order by start_time desc limit 3;
select conname, convalidated from pg_constraint
where conrelid = 'public.rate_limit_counters'::regclass;
```

Require zero invalid/overdue rows, active minute schedule, a successful recent job, validated expiry
and cascading FK constraints, and unchanged unrelated fingerprints. Confirm client roles cannot
SELECT either counter/key table or EXECUTE cleanup; the narrow writer alone retains consume access.
Monitor cron failures and overdue counts using existing operations monitoring, with no identifiers
in alerts. A schedule existing in the catalog without a successful run is insufficient.

If migration fails, the migration transaction must roll back; fix the prerequisite and retry the
reviewed forward migration. If cleanup fails after deployment, retain the new format, diagnose job
status/locks/permissions privately, and obtain approval for the concrete corrective operation.
After correction, `select public.cleanup_rate_limit_counters();` removes all expired windows and
counters, preserving live shared counters and unrelated data. Verify zero overdue rows and the next
scheduled success. Do not suppress errors or report account deletion success on cleanup failure.

Never restore migration 0010's raw-key writer or repopulate purged counters from backup. Recovery is
forward-only for personal data. If a broader restore is necessary, restore into isolation, apply
0013 and account-deletion reconciliation before reopening traffic. Provider-backed deletion
reconciliation requires its own documented approved process; this runbook does not invent a new
long-lived account/IP ledger. Keep release blocked if that process or provider retention is unknown.
