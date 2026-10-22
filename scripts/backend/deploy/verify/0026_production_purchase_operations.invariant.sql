-- Read-only structural and source gate; returns issue categories only, never customer data.
with expected(signature,body_md5,is_definer,writer_allowed) as (values
 ('private.production_checkout_session()','73116c33ade474eef03ae34cf1ea84b1',false,false),
 ('private.production_checkout_account(uuid,boolean)','3ced652dde9ab5b077f6b1212d7e7772',false,false),
 ('private.production_checkout_admission(text,text)','ec987c037788c9538145b3156f933db6',false,false),
 ('public.production_prepare_checkout_operation(uuid,uuid,text,text,text)','7b578eabab3c3d2bd0fe5598cf8c614c',true,true),
 ('public.production_claim_checkout_creation(uuid,uuid,text,text,text)','936ddcc137f101c8464b4f9e510d062d',true,true),
 ('public.production_bind_checkout_session(uuid,uuid,text,text)','d549a016ddb2981d4592d50d036d71cc',true,true),
 ('public.production_read_checkout_operation(uuid,uuid)','381e90dc15fff01d55acad2d639982c1',true,true),
 ('public.production_record_checkout_status(uuid,text,text)','6a0f483d39e7a02ac2b27194040aa788',true,true)
), routines as (
 select e.*,p.* from expected e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.signature)
), issues(code) as (
 select 'routine_missing_or_changed' from routines where oid is null or md5(prosrc)<>body_md5
  or prosecdef is distinct from is_definer or proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
  or proowner is distinct from (select oid from pg_catalog.pg_roles where rolname='postgres' and not rolsuper)
  or prolang is distinct from (select oid from pg_catalog.pg_language where lanname='plpgsql')
 union all select 'unexpected_routine_grant' from routines r cross join lateral pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) a
  where a.grantee<>r.proowner and not (r.writer_allowed and a.grantee=(select oid from pg_catalog.pg_roles where rolname='still_entitlement_writer') and a.privilege_type='EXECUTE' and not a.is_grantable)
 union all select 'writer_grant_missing' from routines where writer_allowed and not coalesce(pg_catalog.has_function_privilege('still_entitlement_writer',oid,'execute'),false)
 union all select 'table_missing_or_unprotected' where not exists(select 1 from pg_catalog.pg_class where oid=to_regclass('private.production_purchase_operations') and relrowsecurity
  and relowner=(select oid from pg_catalog.pg_roles where rolname='postgres'))
 union all select 'unexpected_table_grant' from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  where c.oid=to_regclass('private.production_purchase_operations') and a.grantee<>c.relowner
 union all select 'unexpected_table_policy' where exists(select 1 from pg_catalog.pg_policy where polrelid=to_regclass('private.production_purchase_operations'))
 union all select 'account_retention' where not exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=to_regclass('private.production_purchase_operations')
  and c.contype='f' and c.confrelid=to_regclass('auth.users') and c.confdeltype='n' and c.convalidated
  and c.conkey=array[(select attnum from pg_catalog.pg_attribute where attrelid=to_regclass('private.production_purchase_operations') and attname='holder' and not attnotnull)]::int2[])
 union all select 'environment_constraint' where not exists(select 1 from pg_catalog.pg_constraint where conrelid=to_regclass('private.production_purchase_operations')
  and conname='production_purchase_operations_environment_check' and convalidated and pg_get_constraintdef(oid)=$check$CHECK ((environment = 'production'::text))$check$)
 union all select 'session_constraint' where not exists(select 1 from pg_catalog.pg_constraint where conrelid=to_regclass('private.production_purchase_operations')
  and conname='production_purchase_operations_stripe_session_id_check' and convalidated and pg_get_constraintdef(oid)=$check$CHECK ((stripe_session_id ~ '^cs_live_[A-Za-z0-9_]{1,240}$'::text))$check$)
 union all select 'one_open_operation_index' where not exists(select 1 from pg_catalog.pg_index where indexrelid=to_regclass('private.production_one_open_checkout')
  and indrelid=to_regclass('private.production_purchase_operations') and indisunique and indisvalid and indnkeyatts=1 and indnatts=1
  and pg_get_indexdef(indexrelid,1,true)='holder'
  and pg_get_expr(indpred,indrelid)=$predicate$(status <> ALL (ARRAY['refunded'::text, 'closed_unpaid'::text]))$predicate$)
)
select coalesce(json_agg(distinct code order by code),'[]'::json) as issues from issues;
