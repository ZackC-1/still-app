-- Read-only end-state gate for 0024_legacy_settings_guard_non_retryable.sql; no user data returned.
-- Returns [] only when the released apps' settings RPC holds the reviewed 0024 body (the 0015 body
-- with the guard raising PT409, never a retryable 40001/40P01), is still an owner-postgres
-- SECURITY DEFINER with the pg_temp-last search_path and the same arguments and result columns,
-- and only signed-in users may execute it.
with routine as (
 select p.oid,p.proowner,p.prosecdef,p.prolang,p.proconfig,p.prosrc,p.proacl,p.proretset,p.proargnames,p.proargmodes::text as modes
 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure('public.write_profile_settings(jsonb,uuid)')
), issues(code) as (
 select 'migration_version' where not exists(select 1 from supabase_migrations.schema_migrations where version='0024')
 union all select 'routine_missing' where not exists(select 1 from routine)
 union all select 'routine_body' from routine where pg_catalog.md5(prosrc)<>'4a0d205e2d0a57d4677a60c01c26c344'
 union all select 'routine_retryable_sqlstate' from routine where prosrc ~* '40001|40P01|serialization_failure|deadlock_detected'
 union all select 'routine_owner' from routine where proowner is distinct from (select oid from pg_catalog.pg_roles where rolname='postgres' and not rolsuper)
 union all select 'routine_definer' from routine where not prosecdef
 union all select 'routine_language' from routine where prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql')
 union all select 'routine_path' from routine where proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
 union all select 'routine_result' from routine where not proretset
  or proargnames is distinct from array['p_settings','p_write_id','settings','settings_version','settings_server_updated_at','settings_last_write_id']::text[]
  or modes is distinct from '{i,i,t,t,t,t}'
 union all select 'routine_grant' from routine r cross join lateral pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) acl
  where acl.grantee<>r.proowner and not (acl.grantee=(select oid from pg_catalog.pg_roles where rolname='authenticated') and acl.privilege_type='EXECUTE' and not acl.is_grantable)
 union all select 'signed_in_grant_missing' where not coalesce(pg_catalog.has_function_privilege('authenticated',pg_catalog.to_regprocedure('public.write_profile_settings(jsonb,uuid)'),'execute'),false)
 union all select 'anon_reach' where coalesce(pg_catalog.has_function_privilege('anon',pg_catalog.to_regprocedure('public.write_profile_settings(jsonb,uuid)'),'execute'),false)
)
select coalesce(pg_catalog.json_agg(distinct code order by code),'[]'::json) as issues from issues;
