-- Owner-approved operation analytics-subjects-secrets, modes apply and rotate
-- (scripts/backend/deploy/analytics-subjects.mjs): the database half of the analytics
-- per-device identity secrets.
--
--   1. still_analytics_eraser (created NOLOGIN by migration 0017) gets LOGIN with a SCRAM-SHA-256
--      verifier ("SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>") computed on the runner from
--      a password that exists only in runner memory. PostgreSQL stores a pre-hashed verifier as
--      given, so no password ever reaches the server or its logs. The matching
--      ANALYTICS_ERASER_DB_URL function secret is written by the runner through the Management API.
--   2. The erasure worker's invocation token (also generated in runner memory, also written to the
--      ANALYTICS_ERASURE_WORKER_TOKEN function secret) is stored in Supabase Vault as
--      still_analytics_erasure_worker_token, so the pg_cron schedule can send it without anyone
--      ever seeing it. It travels as a bind parameter (\bind, psql 16+): the statement text that a
--      server log could record carries $1, never the token. (\bind takes the variable unquoted:
--      :'name' would keep its quotes inside the value.)
--
-- The runner passes each value only through the psql process environment (never argv) and only
-- for the parts this run changes; \getenv leaves a variable unset when its environment variable is
-- absent, so \if skips that part. The runner wraps the file in one transaction
-- (--single-transaction) and never echoes statements (-q, no -a/-e).
--
-- Only the eraser's LOGIN and password and the one Vault entry change. No grant, membership,
-- per-role setting or other role changes; the runner compares every role's facts before and after.
\getenv analytics_eraser_verifier STILL_ANALYTICS_ERASER_VERIFIER
\getenv analytics_worker_token STILL_ANALYTICS_WORKER_TOKEN
\if :{?analytics_eraser_verifier}
alter role still_analytics_eraser with login password :'analytics_eraser_verifier';
\endif
\if :{?analytics_worker_token}
select vault.update_secret(s.id, $1) from vault.secrets s where s.name = 'still_analytics_erasure_worker_token' \bind :analytics_worker_token \g
select vault.create_secret($1, 'still_analytics_erasure_worker_token', 'Still analytics erasure worker token (pg_cron schedule)') where not exists (select 1 from vault.secrets s where s.name = 'still_analytics_erasure_worker_token') \bind :analytics_worker_token \g
\endif
