-- Read-only structural, source and privilege check. Returns fixed issue codes only.
with expected(signature,body_md5,is_definer,allowed_role) as (values
 ('private.apple_analytics_session()','0f9f4dac6b16e0f7b2748cc0a3bf31f7',false,'none'),
 ('private.apple_analytics_scope(text,uuid,integer)','c5f5e7aed6a2b5df10c5e75126b29df4',true,'none'),
 ('private.apple_analytics_cleanup()','9b2c5cb3335066e14cd8bf6e95229a5c',true,'still_analytics_eraser'),
 ('private.apple_analytics_prepare(text,text,uuid,integer,text,text,text)','963283aea7ef9b74a5b67c4bc227bd6e',true,'still_analytics_eraser'),
 ('private.apple_analytics_read(text,text,uuid,integer,text)','15d0f725237e7cc6e004a5fec1a6b719',true,'still_analytics_eraser'),
 ('private.apple_analytics_commit(text,text,uuid,integer,text,jsonb)','57b4069767d91a6e66bec38f3108ef4c',true,'still_analytics_eraser'),
 ('private.apple_analytics_retire_device()','41942af420a7020d8297885b3d9547f0',true,'none')
), routines as (
 select e.*,p.* from expected e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.signature)
), issues(code) as (
 select 'routine_missing_or_changed' from routines where oid is null or md5(prosrc)<>body_md5
  or prosecdef is distinct from is_definer or proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
  or proowner is distinct from (select oid from pg_catalog.pg_roles where rolname='postgres' and not rolsuper)
  or prolang is distinct from (select oid from pg_catalog.pg_language where lanname='plpgsql')
 union all select 'unexpected_routine_grant' from routines r cross join lateral pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) a
  where a.grantee<>r.proowner and not (a.grantee=coalesce((select oid from pg_catalog.pg_roles where rolname=r.allowed_role),0) and a.grantee<>0 and a.privilege_type='EXECUTE' and not a.is_grantable)
 union all select 'required_grant_missing' from routines where allowed_role<>'none' and not coalesce(pg_catalog.has_function_privilege(allowed_role,oid,'execute'),false)
 union all select 'table_missing_or_unprotected' where not exists(select 1 from pg_catalog.pg_class where oid=to_regclass('private.apple_purchase_analytics') and relrowsecurity
  and relowner=(select oid from pg_catalog.pg_roles where rolname='postgres'))
 union all select 'unexpected_table_grant' from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  where c.oid=to_regclass('private.apple_purchase_analytics') and a.grantee<>c.relowner
 union all select 'unexpected_table_policy' where exists(select 1 from pg_catalog.pg_policy where polrelid=to_regclass('private.apple_purchase_analytics'))
 union all select 'unexpected_table_trigger' where exists(select 1 from pg_catalog.pg_trigger where tgrelid=to_regclass('private.apple_purchase_analytics') and not tgisinternal)
 union all select 'retirement_trigger_missing_or_changed' where not exists(select 1 from pg_catalog.pg_trigger
  where tgrelid=to_regclass('private.analytics_erasure_jobs') and tgname='apple_analytics_retire_device'
   and tgfoid=to_regprocedure('private.apple_analytics_retire_device()') and tgtype=21 and tgenabled='O' and not tgisinternal
   and tgqual is null and tgattr=''::int2vector)
 union all select 'erasure_cascade' where not exists(select 1 from pg_catalog.pg_constraint c
  where c.conrelid=to_regclass('private.apple_purchase_analytics') and c.contype='f' and c.convalidated and c.confdeltype='c'
  and c.confrelid=to_regclass('private.analytics_subjects') and c.conkey=array[(select attnum from pg_catalog.pg_attribute where attrelid=c.conrelid and attname='subject_id')]::int2[])
 union all select 'canonical_transaction_unique' where not exists(select 1 from pg_catalog.pg_constraint c
  where c.conrelid=to_regclass('private.apple_purchase_analytics') and c.contype='u' and c.convalidated
   and c.conkey=array[(select attnum from pg_catalog.pg_attribute where attrelid=c.conrelid and attname='transaction_key')]::int2[])
 union all select 'capability_primary_key' where not exists(select 1 from pg_catalog.pg_constraint c
  where c.conrelid=to_regclass('private.apple_purchase_analytics') and c.contype='p' and c.convalidated
   and c.conkey=array[(select attnum from pg_catalog.pg_attribute where attrelid=c.conrelid and attname='capability_hash')]::int2[])
 union all select 'unexpected_columns' where (select array_agg(attname::text order by attname) from pg_catalog.pg_attribute
  where attrelid=to_regclass('private.apple_purchase_analytics') and attnum>0 and not attisdropped)
  is distinct from array['anon_index','app_version','capability_hash','expires_at','origin_key','prepared_at','project_hash','purchased_at','refund_id','refunded_at','retired','sale_id','subject_id','surface','transaction','transaction_key']::text[]
 union all select 'migration_version' where not exists(select 1 from supabase_migrations.schema_migrations where version='0029')
)
select coalesce(json_agg(distinct code order by code),'[]'::json) as issues from issues;
