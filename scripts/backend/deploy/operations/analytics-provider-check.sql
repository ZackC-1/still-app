-- Owner-approved operation analytics-subjects-switch, policy_mode enable, before any write
-- (scripts/backend/deploy/analytics-subjects.mjs): ask analytics-erasure for its PostHog provider
-- proof. Queues ONE pg_net POST of {"action":"provider-check"} to the function, authorized with the
-- worker token read from Supabase Vault inside the database, so the runner never holds the token.
-- The function reads the PostHog project with the personal key (its public token must match the
-- project key) and bulk-deletes one random, never-used distinct id; it answers fixed codes only.
--
-- Prints the pg_net request id (a number). The runner then reads the answer with the read-only
-- analytics-provider-check.read.sql. The function URL comes from the bound project ref through the
-- psql environment as a bind parameter. Nothing else is written.
\getenv analytics_function_url STILL_ANALYTICS_FUNCTION_URL
\if :{?analytics_function_url}
\else
do $$ begin raise exception 'analytics function url missing' using errcode = '22023'; end $$;
\endif
select net.http_post(url := $1, headers := pg_catalog.jsonb_build_object('Content-Type', 'application/json', 'Authorization', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'still_analytics_erasure_worker_token')), body := '{"action":"provider-check"}'::jsonb, timeout_milliseconds := 30000) \bind :analytics_function_url \g
