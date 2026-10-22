-- Read-only structural, source and privilege check. Returns fixed issue codes only.
with expected(signature,body_md5,is_definer,allowed_role) as (values
 ('public.production_claim_checkout_with_analytics(uuid,uuid,text,text,text,text)','7b0ee89d26a0e3fd26f05e19ddff1b8b',true,'still_entitlement_writer'),
 ('private.purchase_analytics_refund_time()','34a31377aedb489c6c118c7364491795',true,'none'),
 ('private.purchase_analytics_session()','0f9f4dac6b16e0f7b2748cc0a3bf31f7',false,'none'),
 ('private.analytics_claim_purchase(uuid,text)','46192816821f6f6137c1852b042169f0',true,'still_analytics_eraser'),
 ('private.analytics_purchase_current(uuid,text,uuid,uuid)','e4d47e428925b70855905dbeab7af56b',true,'still_analytics_eraser'),
 ('private.analytics_finish_purchase(uuid,uuid,boolean)','41ba93b8dd3ed4c7692935cc3aecc44b',true,'still_analytics_eraser')
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
 union all select 'table_missing_or_unprotected' where not exists(select 1 from pg_catalog.pg_class where oid=to_regclass('private.purchase_analytics_attribution') and relrowsecurity
  and relowner=(select oid from pg_catalog.pg_roles where rolname='postgres'))
 union all select 'unexpected_table_grant' from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  where c.oid=to_regclass('private.purchase_analytics_attribution') and a.grantee<>c.relowner
 union all select 'unexpected_table_policy' where exists(select 1 from pg_catalog.pg_policy where polrelid=to_regclass('private.purchase_analytics_attribution'))
 union all select 'unexpected_table_trigger' where exists(select 1 from pg_catalog.pg_trigger where tgrelid=to_regclass('private.purchase_analytics_attribution') and not tgisinternal)
 union all select 'refund_trigger_missing_or_changed' where not exists(select 1 from pg_catalog.pg_trigger
  where tgrelid=to_regclass('private.production_purchase_operations') and tgname='purchase_analytics_refund_time'
   and tgfoid=to_regprocedure('private.purchase_analytics_refund_time()') and tgtype=17 and tgenabled='O' and not tgisinternal
   and pg_get_triggerdef(oid) ~ 'AFTER UPDATE OF status .*FOR EACH ROW WHEN .*new.status.*refunded.*old.status.*IS DISTINCT FROM.*refunded')
 union all select 'erasure_cascade' where not exists(select 1 from pg_catalog.pg_constraint c
  where c.conrelid=to_regclass('private.purchase_analytics_attribution') and c.contype='f' and c.convalidated and c.confdeltype='c'
  and c.confrelid=to_regclass('private.analytics_subjects') and c.conkey=array[(select attnum from pg_catalog.pg_attribute where attrelid=c.conrelid and attname='subject_id')]::int2[])
 union all select 'operation_reference' where not exists(select 1 from pg_catalog.pg_constraint c
  where c.conrelid=to_regclass('private.purchase_analytics_attribution') and c.contype='f' and c.convalidated and c.confdeltype='c'
  and c.confrelid=to_regclass('private.production_purchase_operations') and c.conkey=array[(select attnum from pg_catalog.pg_attribute where attrelid=c.conrelid and attname='operation_id')]::int2[])
 union all select 'unexpected_columns' where (select array_agg(attname::text order by attname) from pg_catalog.pg_attribute
  where attrelid=to_regclass('private.purchase_analytics_attribution') and attnum>0 and not attisdropped)
  is distinct from array['app_version','claim_event','claim_token','claim_until','operation_id','refund_id','refund_reported_at','refunded_at','sale_id','sale_reported_at','subject_id','surface']::text[]
 union all select 'original_claim_changed' where (select md5(prosrc) from pg_catalog.pg_proc where oid=to_regprocedure('public.production_claim_checkout_creation(uuid,uuid,text,text,text)')) is distinct from '936ddcc137f101c8464b4f9e510d062d'
 union all select 'migration_version' where not exists(select 1 from supabase_migrations.schema_migrations where version='0028')
)
select coalesce(json_agg(distinct code order by code),'[]'::json) as issues from issues;
