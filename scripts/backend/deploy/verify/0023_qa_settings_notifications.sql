-- Read-only end-state proof; no user data returned.
with expected(sig,body_hash) as (values ('public.qa_settings_notifications_enabled()','111652a7a212a3f9a76635265b2e9277'),('private.notify_qa_settings_changed()','1c41d362e8f0e46fce3027b9d39419ed')), routines as (
 select e.*,p.* from expected e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.sig)
), issues(code) as (
 select 'migration_version' where not exists(select 1 from supabase_migrations.schema_migrations where version='0023')
 union all select 'routine_missing_or_changed' from routines where oid is null or pg_catalog.md5(prosrc)<>body_hash
 union all select 'routine_security' from routines where not prosecdef or proowner<>(select oid from pg_catalog.pg_roles where rolname='postgres')
  or proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
 union all select 'routine_grant' from routines r cross join lateral pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) acl
  where acl.grantee<>r.proowner and not (r.sig='public.qa_settings_notifications_enabled()' and acl.grantee=(select oid from pg_catalog.pg_roles where rolname='authenticated') and acl.privilege_type='EXECUTE' and not acl.is_grantable)
 union all select 'receive_grant_missing' where not coalesce(pg_catalog.has_function_privilege('authenticated',pg_catalog.to_regprocedure('public.qa_settings_notifications_enabled()'),'execute'),false)
 union all select 'realtime_rls' where not (select relrowsecurity from pg_catalog.pg_class where oid='realtime.messages'::regclass)
 union all select 'realtime_policy_count' where (select count(*) from pg_catalog.pg_policy where polrelid='realtime.messages'::regclass)<>1
 union all select 'receive_policy' where not exists(select 1 from pg_catalog.pg_policies where schemaname='realtime' and tablename='messages' and policyname='qa_settings_notifications_receive' and cmd='SELECT' and roles=array['authenticated']::name[] and with_check is null and permissive='PERMISSIVE' and pg_catalog.md5(qual)='930e439267875f587bcf981bd4d81caf')
 union all select 'notify_trigger' where not exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.profiles'::regclass and tgname='qa_settings_changed' and tgfoid=pg_catalog.to_regprocedure('private.notify_qa_settings_changed()') and tgtype=21 and tgenabled='O' and not tgisinternal and tgqual is null and tgnargs=0 and tgattr::text=(select attnum::text from pg_catalog.pg_attribute where attrelid='public.profiles'::regclass and attname='settings_version'))
)
select coalesce(pg_catalog.json_agg(distinct code order by code),'[]'::json) as issues from issues;
