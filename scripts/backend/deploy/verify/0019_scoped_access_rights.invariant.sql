-- Read-only pre/post invariant. Existing row counts and (0020) complete scoped rows
-- are compared privately by the accepted deploy operation. Never print the values.
select pg_catalog.jsonb_build_object(
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
  'public.rule_sets', (select pg_catalog.count(*) from public.rule_sets),
  'public.entitlements.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from public.entitlements r),
  'public.profiles.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from public.profiles r),
  'private.settings_anchors.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from private.settings_anchors r),
  'private.paid_cutoff.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from private.paid_cutoff r),
  'private.product_policy_owners.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from private.product_policy_owners r),
  'private.product_policy_revisions.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from private.product_policy_revisions r)
)::text;
