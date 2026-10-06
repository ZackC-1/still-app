-- Row-count invariant for 0017_analytics_erasure.sql.
--
-- Read-only: a single SELECT, taken as the last action before `supabase db push` and the first
-- action after it; the runner compares the two results for byte equality and prints only
-- "unchanged" or "changed", never the counts. 0017 adds one role, three empty private tables and
-- routines, and replaces the limiter body with two more bucket names; it reads, writes and deletes
-- no existing row, so these counts should not move. The rate-limit tables and
-- private.settings_writes are excluded because they churn on every request, and the new erasure
-- tables because they do not exist before the apply (the post-apply check proves they are empty).
-- Live sign-ups, deletions, purchases, first per-field settings writes or owner policy operations
-- inside the window also move a count; after a successful apply with passing verification a change
-- is reported as "applied-verified-counts-changed" and the owner compares privately.
select pg_catalog.json_build_object(
  'auth.users', (select pg_catalog.count(*) from auth.users),
  'private.paid_cutoff', (select pg_catalog.count(*) from private.paid_cutoff),
  'private.product_policy_owners', (select pg_catalog.count(*) from private.product_policy_owners),
  'private.product_policy_revisions', (select pg_catalog.count(*) from private.product_policy_revisions),
  'private.settings_anchors', (select pg_catalog.count(*) from private.settings_anchors),
  'public.canary_state', (select pg_catalog.count(*) from public.canary_state),
  'public.entitlements', (select pg_catalog.count(*) from public.entitlements),
  'public.profiles', (select pg_catalog.count(*) from public.profiles),
  'public.revenuecat_events', (select pg_catalog.count(*) from public.revenuecat_events),
  'public.rule_sets', (select pg_catalog.count(*) from public.rule_sets)
)::text;
