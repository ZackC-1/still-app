-- Row-count invariant for 0018_analytics_account_erasure.sql.
--
-- Read-only: a single SELECT, taken as the last action before `supabase db push` and the first
-- action after it; the runner compares the two results for byte equality and prints only
-- "unchanged" or "changed", never the counts. 0018 widens two checks, adds one index and two routes;
-- it reads, writes and deletes no existing row, so these counts should not move. The rate-limit
-- tables and private.settings_writes are excluded because they churn on every request. The erasure
-- tables are included: nothing writes them while the analytics functions are dormant. Live
-- sign-ups, deletions, purchases, first per-field settings writes, owner policy operations, or a
-- device erasure or account deletion with the functions live, inside the window also move a count;
-- after a successful apply with passing verification a change is reported as
-- "applied-verified-counts-changed" and the owner compares privately.
select pg_catalog.json_build_object(
  'auth.users', (select pg_catalog.count(*) from auth.users),
  'private.analytics_erasure_jobs', (select pg_catalog.count(*) from private.analytics_erasure_jobs),
  'private.analytics_erasure_targets', (select pg_catalog.count(*) from private.analytics_erasure_targets),
  'private.analytics_subjects', (select pg_catalog.count(*) from private.analytics_subjects),
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
