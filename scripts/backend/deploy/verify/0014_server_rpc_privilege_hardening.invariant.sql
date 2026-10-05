-- Row-count invariant for 0014_server_rpc_privilege_hardening.sql (end-state item 12).
--
-- Read-only: a single SELECT run immediately before and immediately after the apply. The runner
-- compares the two results for byte equality and prints only "unchanged" or "changed", never the
-- counts (a public repository's job logs are public). 0014 changes privileges only, so these
-- counts must not move. The rate-limit tables are excluded: they churn on every request.
-- Live sign-ups, deletions or purchase events during the few seconds between the two reads would
-- also move a count; a "changed" result therefore means "inspect privately", not "data lost".
select pg_catalog.json_build_object(
  'auth.users', (select pg_catalog.count(*) from auth.users),
  'public.canary_state', (select pg_catalog.count(*) from public.canary_state),
  'public.entitlements', (select pg_catalog.count(*) from public.entitlements),
  'public.profiles', (select pg_catalog.count(*) from public.profiles),
  'public.revenuecat_events', (select pg_catalog.count(*) from public.revenuecat_events),
  'public.rule_sets', (select pg_catalog.count(*) from public.rule_sets)
)::text;
