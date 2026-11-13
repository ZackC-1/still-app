-- No existing application data is changed by 0030 (it only adds one read-only view and its grant).
-- Count and bounded MD5 fingerprint of the one table the view reads; printed by the deploy runner
-- only as unchanged / changed, never in the clear.
select pg_catalog.jsonb_build_object(
  'private.production_purchase_operations', (select pg_catalog.count(*) from private.production_purchase_operations),
  'private.production_purchase_operations.fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by pg_catalog.to_jsonb(r)::text)::text,'[]')) from private.production_purchase_operations r)
)::text;
