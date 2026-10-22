-- Existing payment, identity and erasure records must be unchanged by this additive migration.
select jsonb_build_object(
 'private.production_purchase_operations',(select count(*) from private.production_purchase_operations),
 'private.production_purchase_operations.fingerprint',(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'[]')) from private.production_purchase_operations r),
 'private.analytics_subjects',(select count(*) from private.analytics_subjects),
 'private.analytics_subjects.fingerprint',(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'[]')) from private.analytics_subjects r),
 'private.analytics_erasure_jobs',(select count(*) from private.analytics_erasure_jobs),
 'private.analytics_erasure_jobs.fingerprint',(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'[]')) from private.analytics_erasure_jobs r)
)::text;
