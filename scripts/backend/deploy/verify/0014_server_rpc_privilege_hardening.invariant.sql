-- Row-count invariant for 0014_server_rpc_privilege_hardening.sql (end-state item 12).
--
-- Read-only: a single SELECT. The runner takes the first read as the last action before
-- `supabase db push` and the second as the first action after it, so the window is exactly one
-- push (connection setup plus the migration transaction); the run reports that window in
-- milliseconds. It compares the two results for byte equality and prints only "unchanged" or
-- "changed", never the counts (a public repository's job logs are public). 0014 changes
-- privileges only, so these counts should not move. The rate-limit tables are excluded: they
-- churn on every request. Live sign-ups, deletions or purchase events inside the window also move
-- a count, so after a successful apply with passing verification a change is reported as
-- "applied-verified-counts-changed", not as a failed deploy: the owner re-runs this query in the
-- Supabase SQL editor and compares privately. The hosted window has not been measured yet; the
-- first real run records it.
select pg_catalog.json_build_object(
  'auth.users', (select pg_catalog.count(*) from auth.users),
  'public.canary_state', (select pg_catalog.count(*) from public.canary_state),
  'public.entitlements', (select pg_catalog.count(*) from public.entitlements),
  'public.profiles', (select pg_catalog.count(*) from public.profiles),
  'public.revenuecat_events', (select pg_catalog.count(*) from public.revenuecat_events),
  'public.rule_sets', (select pg_catalog.count(*) from public.rule_sets)
)::text;
