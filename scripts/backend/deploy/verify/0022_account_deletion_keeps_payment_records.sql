-- Read-only end-state gate for 0022_account_deletion_keeps_payment_records.sql; run at EXACTLY 0022.
-- Returns [] only when QA checkout operations outlive account deletion (account id cleared),
-- the reviewed BEFORE-delete trigger deactivates the account's RevenueCat-sourced rights, its
-- routine is owner-only, and no orphaned RevenueCat-sourced right is still active.
-- No account, transaction identity or ledger row is returned: only fixed issue codes.
with expected_routine(sig,body_md5) as (values
 ('private.deactivate_deleted_account_rights()','63073a9934ab4cfeb882f223e854016f')
), routine as (
 select e.*,p.oid,p.proowner,p.prosecdef,p.prolang,p.proconfig,p.prosrc,p.proacl,p.prorettype,p.prokind,p.proretset
 from expected_routine e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.sig)
), purchase_operations as (
 select pg_catalog.to_regclass('private.qa_sandbox_purchase_operations') as oid
), holder_column as (
 select a.attnum,a.attnotnull from pg_catalog.pg_attribute a,purchase_operations t
 where a.attrelid=t.oid and a.attname='holder' and not a.attisdropped
), account_references as (
 select c.conname,c.confdeltype,c.confupdtype,c.confmatchtype,c.convalidated,c.condeferrable,c.conkey,c.confkey
 from pg_catalog.pg_constraint c,purchase_operations t
 where c.conrelid=t.oid and c.contype='f' and c.confrelid='auth.users'::pg_catalog.regclass
), deletion_triggers as (
 select t.tgname,t.tgtype,t.tgenabled,t.tgqual,t.tgnargs,t.tgattr,t.tgfoid
 from pg_catalog.pg_trigger t where t.tgrelid='auth.users'::pg_catalog.regclass and not t.tgisinternal
  and t.tgfoid=pg_catalog.to_regprocedure('private.deactivate_deleted_account_rights()')
), issues(code) as (
 select 'migration_version' where not exists(select 1 from supabase_migrations.schema_migrations where version='0022')
 union all select 'unexpected_later_migration' where exists(select 1 from supabase_migrations.schema_migrations where version>'0022')
 union all select 'missing_routine' from routine where oid is null
 union all select 'routine_owner' from routine where oid is not null and proowner is distinct from (select oid from pg_catalog.pg_roles where rolname='postgres')
 union all select 'routine_definer' from routine where oid is not null and not prosecdef
 union all select 'routine_language' from routine where oid is not null and prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql')
 union all select 'routine_result' from routine where oid is not null and (prorettype<>'pg_catalog.trigger'::pg_catalog.regtype or prokind<>'f' or proretset)
 union all select 'routine_path' from routine where oid is not null and proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
 union all select 'routine_body' from routine where oid is not null and pg_catalog.md5(prosrc) is distinct from body_md5
 union all select 'routine_acl' from routine r where r.oid is not null and exists(
  select 1 from pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) a where a.grantee<>r.proowner)
 union all select 'missing_trigger' where (select count(*) from deletion_triggers)<>1
 union all select 'trigger_shape' from deletion_triggers where tgname<>'access_rights_account_deleted' or tgtype<>11
  or tgenabled<>'O' or tgqual is not null or tgnargs<>0 or not (tgattr=''::pg_catalog.int2vector)
 union all select 'missing_purchase_operations' from purchase_operations where oid is null
 union all select 'purchase_operation_holder_column' where not exists(select 1 from holder_column)
 union all select 'purchase_operation_holder_required' from holder_column where attnotnull
 union all select 'purchase_operation_account_reference_count' where (select count(*) from account_references)<>1
 union all select 'purchase_operation_account_reference_shape' from account_references
  where conname<>'qa_sandbox_purchase_operations_holder_fkey' or confdeltype<>'n' or confupdtype<>'a' or confmatchtype<>'s'
   or not convalidated or condeferrable or conkey is distinct from array[(select attnum from holder_column)]::int2[]
   or confkey is distinct from array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid='auth.users'::pg_catalog.regclass and a.attname='id')]::int2[]
 union all select 'orphaned_active_right' where exists(select 1 from private.access_rights
  where holder is null and active and provider_source='revenuecat')
)
select coalesce(pg_catalog.json_agg(code order by code),'[]'::json) from (select distinct code from issues) sorted;
