-- Structural/source/privilege gate; outputs issue categories, never transaction data.
with expected(signature,body_md5) as (values
 ('public.begin_apple_sandbox_review_observation(text,text,text,text)','06938f205df1373facafb884cab7757e'),
 ('public.commit_apple_sandbox_review_observation(text,uuid,boolean)','d45eb3d1cbe0ebca0db5fc4544325e52'),
 ('public.confirm_apple_sandbox_review_observation(text,uuid,uuid,bigint,bigint)','bb79b280061273371377e8bfba918662')
), routines as (
 select e.*,p.* from expected e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.signature)
), issues(code) as (
 select 'routine_missing_or_changed' from routines where oid is null or md5(prosrc)<>body_md5 or not prosecdef
  or proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
  or proowner is distinct from (select oid from pg_catalog.pg_roles where rolname='postgres' and not rolsuper)
  or prolang is distinct from (select oid from pg_catalog.pg_language where lanname='plpgsql')
 union all select 'unexpected_routine_grant' from routines r cross join lateral pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) a
  where a.grantee<>r.proowner and not (a.grantee=(select oid from pg_catalog.pg_roles where rolname='still_entitlement_writer') and a.privilege_type='EXECUTE' and not a.is_grantable)
 union all select 'writer_grant_missing' from routines where not coalesce(pg_catalog.has_function_privilege('still_entitlement_writer',oid,'execute'),false)
 union all select 'table_missing_or_unprotected' where not exists(select 1 from pg_catalog.pg_class where oid=to_regclass('private.apple_sandbox_review_access') and relrowsecurity
  and relowner=(select oid from pg_catalog.pg_roles where rolname='postgres'))
 union all select 'unexpected_table_grant' from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  where c.oid=to_regclass('private.apple_sandbox_review_access') and a.grantee<>c.relowner
 union all select 'unexpected_table_policy' where exists(select 1 from pg_catalog.pg_policy where polrelid=to_regclass('private.apple_sandbox_review_access'))
 union all select 'unexpected_table_trigger' where exists(select 1 from pg_catalog.pg_trigger where tgrelid=to_regclass('private.apple_sandbox_review_access') and not tgisinternal)
 union all select 'account_or_ledger_reference' where exists(select 1 from pg_catalog.pg_constraint where conrelid=to_regclass('private.apple_sandbox_review_access') and contype='f')
 union all select 'unexpected_columns' where (select array_agg(attname::text order by attname) from pg_catalog.pg_attribute
  where attrelid=to_regclass('private.apple_sandbox_review_access') and attnum>0 and not attisdropped)
  is distinct from array['active','bundle_id','deadline','original_transaction_id','product_id','provider_key','revision','revoked','right_id','token','verified_at']::text[]
 union all select 'migration_version' where not exists(select 1 from supabase_migrations.schema_migrations where version='0027')
)
select coalesce(json_agg(distinct code order by code),'[]'::json) as issues from issues;
