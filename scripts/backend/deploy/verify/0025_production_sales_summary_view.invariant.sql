-- No existing application data is changed by 0025 (it only adds one read-only view and its grant).
-- Counts and bounded MD5 fingerprints of the tables the view reads, and of the operation ledger
-- they reference; printed by the deploy runner only as unchanged / changed, never in the clear.
select pg_catalog.jsonb_build_object(
  'private.paid_cutoff', (select pg_catalog.count(*) from private.paid_cutoff),
  'private.paid_cutoff.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from private.paid_cutoff r),
  'private.product_policy_operations', (select pg_catalog.count(*) from private.product_policy_operations),
  'private.product_policy_operations.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from private.product_policy_operations r),
  'private.product_policy_revisions', (select pg_catalog.count(*) from private.product_policy_revisions),
  'private.product_policy_revisions.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from private.product_policy_revisions r),
  'private.product_policy_owners', (select pg_catalog.count(*) from private.product_policy_owners),
  'private.product_policy_owners.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from private.product_policy_owners r)
)::text;
