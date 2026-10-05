-- Row-count invariant for 0015_settings_sync_per_field.sql.
--
-- Read-only: a single SELECT, taken as the last action before `supabase db push` and the first
-- action after it; the runner compares the two results for byte equality and prints only
-- "unchanged" or "changed", never the counts. 0015 adds a private schema, a role, helpers and a
-- retention job and replaces two function bodies; it reads, writes and deletes no row of these
-- tables, so the counts should not move. The rate-limit tables are excluded because they churn on
-- every request, and the new private tables because they do not exist before the apply. Live
-- sign-ups, deletions, purchases or settings writes inside the window also move a count; after a
-- successful apply with passing verification a change is reported as
-- "applied-verified-counts-changed" and the owner compares privately.
select pg_catalog.json_build_object(
  'auth.users', (select pg_catalog.count(*) from auth.users),
  'public.canary_state', (select pg_catalog.count(*) from public.canary_state),
  'public.entitlements', (select pg_catalog.count(*) from public.entitlements),
  'public.profiles', (select pg_catalog.count(*) from public.profiles),
  'public.revenuecat_events', (select pg_catalog.count(*) from public.revenuecat_events),
  'public.rule_sets', (select pg_catalog.count(*) from public.rule_sets)
)::text;
