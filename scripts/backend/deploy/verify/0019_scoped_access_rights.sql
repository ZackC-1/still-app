-- Read-only end-state gate for 0019_scoped_access_rights.sql; run at EXACTLY 0019.
-- Body pins bind the reviewed server correction. ACL checks enumerate every grantee,
-- including PUBLIC, inherited client roles and column grants. No ledger rows are exposed.
with recursive
client_reach(oid) as (
 select oid from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role')
 union select m.roleid from pg_catalog.pg_auth_members m join client_reach r on r.oid=m.member
),
expected_tables(name,columns_json) as (values
  ('access_observations', '[["holder","uuid",true],["environment","text",true],["token","uuid",true],["deadline","timestamp with time zone",true],["snapshot","jsonb",false],["result","jsonb",false]]'),
  ('access_rights', '[["right_id","uuid",true],["environment","text",true],["provider_key","text",true],["provider_product","text",true],["holder","uuid",false],["ownership_revision","bigint",true],["active","boolean",true],["verified_at","bigint",true]]'),
  ('access_revocations', '[["holder","uuid",true],["environment","text",true],["right_id","uuid",true],["revision","bigint",true]]'),
  ('access_transfer_operations', '[["operation_id","uuid",true],["right_id","uuid",true],["environment","text",true],["source_holder","uuid",false],["target_holder","uuid",false],["expected_revision","bigint",true],["result","jsonb",true]]')
),
expected_constraints(table_name,kind,columns_text,foreign_name,delete_rule) as (values
  ('access_observations', 'p', 'holder,environment', '', ''),
  ('access_observations', 'f', 'holder', 'auth.users', 'c'),
  ('access_observations', 'c', 'environment', '', ''),
  ('access_rights', 'p', 'right_id', '', ''),
  ('access_rights', 'u', 'environment,provider_key', '', ''),
  ('access_rights', 'f', 'holder', 'auth.users', 'n'),
  ('access_rights', 'c', 'environment', '', ''),
  ('access_rights', 'c', 'provider_key', '', ''),
  ('access_rights', 'c', 'provider_product', '', ''),
  ('access_rights', 'c', 'ownership_revision', '', ''),
  ('access_rights', 'c', 'verified_at', '', ''),
  ('access_revocations', 'p', 'holder,environment,right_id', '', ''),
  ('access_revocations', 'f', 'holder', 'auth.users', 'c'),
  ('access_revocations', 'f', 'right_id', 'private.access_rights', 'a'),
  ('access_revocations', 'c', 'environment', '', ''),
  ('access_revocations', 'c', 'revision', '', ''),
  ('access_transfer_operations', 'p', 'operation_id', '', ''),
  ('access_transfer_operations', 'f', 'right_id', 'private.access_rights', 'a'),
  ('access_transfer_operations', 'f', 'source_holder', 'auth.users', 'n'),
  ('access_transfer_operations', 'f', 'target_holder', 'auth.users', 'n'),
  ('access_transfer_operations', 'c', 'environment', '', '')
),
expected_checks(table_name,columns_text,expression) as (values
  ('access_observations','environment','environment=anyarray[''sandbox'',''production'']'),
  ('access_rights','environment','environment=anyarray[''sandbox'',''production'']'),
  ('access_rights','provider_key','provider_key~''^[0-9a-f]{64}$'''),
  ('access_rights','provider_product','provider_product=anyarray[''still_pro_v3'',''still_sync'']'),
  ('access_rights','ownership_revision','ownership_revision>=0andownership_revision<=9007199254740991'),
  ('access_rights','verified_at','verified_at>=0andverified_at<=9007196662740991'),
  ('access_revocations','environment','environment=anyarray[''sandbox'',''production'']'),
  ('access_revocations','revision','revision>=0andrevision<=9007199254740991'),
  ('access_transfer_operations','environment','environment=anyarray[''sandbox'',''production'']')
),
expected_defaults(table_name,column_name,expression) as (values
  ('access_rights','right_id','gen_random_uuid()'),
  ('access_rights','ownership_revision','0')
),
expected_routines(sig,body_md5) as (values
  ('public.begin_access_observation(uuid,text)', 'c9b28453703a3fcb2fafd57e8c01d6f4'),
  ('public.commit_access_observation(uuid,text,uuid,jsonb)', 'c3e28d73ef0d9e09904ef4db035ceec1'),
  ('public.confirm_access_observation(uuid,text,uuid)', '111cb91a48bf198a20f971a6f5a1a97a'),
  ('public.transfer_access_right(uuid,uuid,text,uuid,uuid,bigint)', 'ea7feb8fdd7b6f42cd2dc39c0dac2cfb')
),
tables as (
 select e.*,c.oid,c.relowner,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl,
  (select coalesce(jsonb_agg(jsonb_build_array(a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull) order by a.attnum),'[]'::jsonb)
   from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as actual_columns
 from expected_tables e left join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass('private.'||e.name)
),
constraints as (
 select t.name as table_name,c.contype::text as kind,
  (select pg_catalog.string_agg(a.attname,',' order by k.ord) from unnest(c.conkey) with ordinality k(num,ord)
   join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num) as columns_text,
  case when c.contype='f' then c.confrelid::pg_catalog.regclass::text else '' end as foreign_name,
  case when c.contype='f' then c.confdeltype::text else '' end as delete_rule,
  c.convalidated,c.condeferrable,c.condeferred,c.confupdtype,c.confmatchtype,
  (select pg_catalog.string_agg(a.attname,',' order by k.ord) from unnest(c.confkey) with ordinality k(num,ord)
   join pg_catalog.pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num) as foreign_columns,
  lower(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),
   '''([0-9]+)''::bigint','\1','g'),'::text|::bigint','','g'),'[[:space:]()]','','g')) as check_expression
 from tables t join pg_catalog.pg_constraint c on c.conrelid=t.oid
),
routines as (
 select e.*,p.*,pg_catalog.to_regprocedure(e.sig) as routine_oid
 from expected_routines e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.sig)
),
issues(code) as (
 select 'migration_version' where not exists(select 1 from supabase_migrations.schema_migrations where version='0019')
 union all select 'unexpected_later_migration' where exists(select 1 from supabase_migrations.schema_migrations where version>'0019')
 union all select 'missing_table:'||name from tables where oid is null
 union all select 'table_owner:'||name from tables where relowner is distinct from (select oid from pg_catalog.pg_roles where rolname='postgres')
 union all select 'table_shape:'||name from tables where oid is not null and (relkind<>'r' or actual_columns<>columns_json::jsonb)
 union all select 'column_default:'||t.name||':'||a.attname from tables t join pg_catalog.pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
  left join pg_catalog.pg_attrdef d on d.adrelid=t.oid and d.adnum=a.attnum
  left join expected_defaults e on e.table_name=t.name and e.column_name=a.attname
  where pg_catalog.pg_get_expr(d.adbin,d.adrelid) is distinct from e.expression
 union all select 'table_rls:' ||name from tables where oid is not null and (not relrowsecurity or relforcerowsecurity)
 union all select 'table_policy:'||t.name from tables t where exists(select 1 from pg_catalog.pg_policy p where p.polrelid=t.oid)
 union all select 'table_trigger:'||t.name from tables t where exists(select 1 from pg_catalog.pg_trigger p where p.tgrelid=t.oid and not p.tgisinternal)
 union all select 'table_acl:'||t.name from tables t, lateral pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) a where a.grantee<>t.relowner
 union all select 'column_acl:'||t.name from tables t join pg_catalog.pg_attribute col on col.attrelid=t.oid,
  lateral pg_catalog.aclexplode(col.attacl) a where a.grantee<>t.relowner
 union all select 'missing_constraint:'||e.table_name||':'||e.kind||':'||e.columns_text from expected_constraints e
  where not exists(select 1 from constraints c where (c.table_name,c.kind,c.columns_text,c.foreign_name,c.delete_rule)=
   (e.table_name,e.kind,e.columns_text,e.foreign_name,e.delete_rule))
 union all select 'unexpected_constraint:'||c.table_name||':'||c.kind||':'||c.columns_text from constraints c
  where not exists(select 1 from expected_constraints e where (c.table_name,c.kind,c.columns_text,c.foreign_name,c.delete_rule)=
   (e.table_name,e.kind,e.columns_text,e.foreign_name,e.delete_rule))
 union all select 'constraint_count:'||t.name from tables t where
  (select count(*) from constraints c where c.table_name=t.name)<>(select count(*) from expected_constraints e where e.table_name=t.name)
 union all select 'check_expression:'||e.table_name||':'||e.columns_text from expected_checks e
  where not exists(select 1 from constraints c where c.table_name=e.table_name and c.kind='c' and c.columns_text=e.columns_text and c.check_expression=e.expression)
 union all select 'foreign_key_state:'||c.table_name||':'||c.columns_text from constraints c where c.kind='f' and
  (c.confupdtype<>'a' or c.confmatchtype<>'s' or c.foreign_columns<>case when c.foreign_name='auth.users' then 'id' else 'right_id' end)
 union all select 'invalid_index:'||t.name from tables t join pg_catalog.pg_index i on i.indrelid=t.oid where not i.indisvalid or not i.indisready
 union all select 'constraint_state:' ||table_name from constraints where not convalidated or condeferrable or condeferred
 union all select 'missing_routine:'||sig from routines where routine_oid is null
 union all select 'routine_owner:'||sig from routines where routine_oid is not null and proowner is distinct from (select oid from pg_catalog.pg_roles where rolname='postgres')
 union all select 'routine_definer:'||sig from routines where routine_oid is not null and not prosecdef
 union all select 'routine_language:'||sig from routines where routine_oid is not null and prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql')
 union all select 'routine_path:'||sig from routines where routine_oid is not null and proconfig is distinct from array['search_path=""']::text[]
 union all select 'routine_body:'||sig from routines where routine_oid is not null and pg_catalog.md5(prosrc)<>body_md5
 union all select 'routine_acl:'||r.sig from routines r where r.routine_oid is not null and
  (select coalesce(array_agg(a.grantee order by a.grantee),array[]::oid[]) from pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) a where a.privilege_type='EXECUTE')
  is distinct from (select array_agg(p.oid order by p.oid) from pg_catalog.pg_roles p where p.rolname in ('postgres','still_entitlement_writer'))
 union all select 'routine_grant_option:'||r.sig from routines r,lateral pg_catalog.aclexplode(r.proacl) a where a.grantee<>r.proowner and a.is_grantable
 union all select 'client_writer_reach' where exists(select 1 from client_reach r join pg_catalog.pg_roles p on p.oid=r.oid where p.rolname='still_entitlement_writer')
 union all select 'unsafe_writer_role' where not exists(select 1 from pg_catalog.pg_roles where rolname='still_entitlement_writer' and not rolsuper and not rolcreaterole and not rolcreatedb and not rolreplication and not rolbypassrls)
 union all select 'writer_membership' where exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles p on p.oid=m.member where p.rolname='still_entitlement_writer')
 union all select 'client_table_reach:'||t.name from tables t where exists(select 1 from client_reach r
  where pg_catalog.has_table_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or pg_catalog.has_any_column_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
)
select coalesce(pg_catalog.json_agg(code order by code),'[]'::json) from (select distinct code from issues) sorted;
