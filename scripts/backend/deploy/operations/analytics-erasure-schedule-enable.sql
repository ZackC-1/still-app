-- Owner-approved operation analytics-erasure-schedule, policy_mode enable
-- (scripts/backend/deploy/analytics-subjects.mjs): run the analytics-erasure worker every 15
-- minutes with pg_cron and pg_net (Supabase Cron).
--
-- The job runs as postgres and makes one HTTP POST to the analytics-erasure function with body
-- {"action":"work"} and the worker token read from Supabase Vault (still_analytics_erasure_worker_token)
-- at run time, so the token is never stored in the job. The exact command text is built by the
-- runner (workerCommand in analytics-subjects.mjs) from the bound project ref and passed through
-- the psql environment as a bind parameter; the runner checks the stored command's SHA-256 against
-- the plan afterwards.
--
-- cron.schedule with an existing job name replaces that job, so applying this again with the same
-- command changes nothing. pg_net is created in schema extensions if absent (its functions live in
-- schema net). Nothing else changes.
\getenv analytics_worker_command STILL_ANALYTICS_WORKER_COMMAND
\if :{?analytics_worker_command}
\else
do $$ begin raise exception 'analytics worker command missing' using errcode = '22023'; end $$;
\endif
create extension if not exists pg_net with schema extensions;
select cron.schedule('still-analytics-erasure-worker', '*/15 * * * *', $1) \bind :analytics_worker_command \g
