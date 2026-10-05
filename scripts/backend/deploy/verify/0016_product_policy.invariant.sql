-- Row-count invariant for 0016_product_policy.sql.
--
-- Read-only: a single SELECT, taken as the last action before `supabase db push` and the first
-- action after it; the runner compares the two results for byte equality and prints only
-- "unchanged" or "changed", never the counts. 0016 adds two roles, four empty private tables,
-- triggers and routines; it reads, writes and deletes no existing row, so these counts should not
-- move. The rate-limit tables and private.settings_writes are excluded because they churn on every
-- request (and the per-minute retention job), and the new policy tables because they do not exist
-- before the apply (the post-apply check proves they are empty of owners, policies and cutoffs).
-- Live sign-ups, deletions, purchases or first per-field settings writes inside the window also
-- move a count; after a successful apply with passing verification a change is reported as
-- "applied-verified-counts-changed" and the owner compares privately.
select pg_catalog.json_build_object(
  'auth.users', (select pg_catalog.count(*) from auth.users),
  'private.settings_anchors', (select pg_catalog.count(*) from private.settings_anchors),
  'public.canary_state', (select pg_catalog.count(*) from public.canary_state),
  'public.entitlements', (select pg_catalog.count(*) from public.entitlements),
  'public.profiles', (select pg_catalog.count(*) from public.profiles),
  'public.revenuecat_events', (select pg_catalog.count(*) from public.revenuecat_events),
  'public.rule_sets', (select pg_catalog.count(*) from public.rule_sets)
)::text;
