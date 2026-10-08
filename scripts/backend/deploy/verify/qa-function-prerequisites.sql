-- Current modern prerequisites for the fixed QA function operation, after 0021.
-- One read-only SELECT. Private catalog facts are hashed in memory, never printed.
-- Complements the 0021 gate; does not rerun the initial-Off/exact-era 0015/0016 gates.
with recursive
client_reach(oid) as (
 select oid from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role')
 union select m.roleid from pg_catalog.pg_auth_members m join client_reach c on c.oid=m.member
), expected(sig,definer,grantees,body_md5) as (values
 ('private.settings_json_bounded(jsonb)',false,null,'e99b02a89aa25ec9d56d6337e4811810'),
 ('private.settings_fields()',false,null,'47c187b1f877e847202bc6bfc213cbb6'),
 ('private.settings_canonical_valid(jsonb,bigint)',false,null,'0a4e8e6748473ab0506fad1727381177'),
 ('private.cleanup_settings_writes()',true,null,'6732b8b458b8e33f0489c85ebfbe50eb'),
 ('private.lock_settings(uuid,uuid,text)',true,'still_settings_writer','02da2d37f0a0c885d01f9314326c0fa7'),
 ('private.claim_settings_write(uuid,uuid,jsonb)',true,'still_settings_writer','3b307d1e3d7260efa61344a8c611ac00'),
 ('private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb)',true,'still_settings_writer','6ac2ddb3d69dc0b50e7714555d1c71b3'),
 ('private.product_policy_refuse_change()',false,null,'b0631183cc93b985018962948328ecb2'),
 ('private.product_policy_render(text,jsonb)',false,null,'9d94051b02d7bf402ad2c4affcdd853c'),
 ('private.product_policy_body_valid(text,text,bigint,text)',false,null,'9dbbc09386ee714f755b59acbd9e716c'),
 ('private.product_policy_sales_activates(text)',false,null,'4a8eb3802b26f46c7fe24d63def0e2bf'),
 ('private.read_product_policy(text,text)',true,'still_policy_reader','ad421f64810e24473d75c15d3ea0c053'),
 ('private.read_product_policy_state(uuid,text,text)',true,'still_policy_admin','2a1de40e3d9e718c86387e9205ca70d2'),
 ('private.preview_product_policy(uuid,text,text,bigint,text,bigint)',true,'still_policy_admin','d8ccd612daf98806810c07d3135d5892'),
 ('private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])',true,'still_policy_admin','24cd12ae029693fd59ff3e6e5054f4ca'),
 ('public.write_profile_settings(jsonb,uuid)',true,'authenticated','a77f3d44e9cd733e57d24aedcdebddfd'),
 ('public.consume_rate_limit(text,integer,integer)',true,'still_analytics_eraser,still_entitlement_writer,still_settings_writer','2b78affbf6ca0102c1e2cdcc08f1196e')
), prerequisite_routines as (
 select e.*,p.oid,p.proowner,p.prosecdef,p.prosrc,p.proacl,p.proconfig
 from expected e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.sig)
), issues(code) as (
 select 'missing_history:'||v from unnest(array['0015','0016','0019','0020','0021']) v
 where not exists(select 1 from supabase_migrations.schema_migrations m where m.version=v)
 union all select 'missing_routine:'||sig from prerequisite_routines where oid is null
 union all select 'routine_owner:'||sig from prerequisite_routines where proowner is distinct from
  (select oid from pg_catalog.pg_roles where rolname='postgres')
 union all select 'routine_definer:'||sig from prerequisite_routines where prosecdef is distinct from definer
 union all select 'routine_body:'||sig from prerequisite_routines where md5(prosrc) is distinct from body_md5
 union all select 'routine_path:'||sig from prerequisite_routines where proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
 union all select 'routine_acl:'||sig from prerequisite_routines r where
  (select array_agg(n.rolname::text order by n.rolname::text collate "C")
   from pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) a
   left join pg_catalog.pg_roles n on n.oid=a.grantee where a.grantee<>r.proowner)
  is distinct from (select array_agg(g order by g collate "C") from unnest(string_to_array(r.grantees,',')) g)
 union all select 'routine_grantable:'||sig from prerequisite_routines r,
  lateral pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) a
  where a.grantee<>r.proowner and (a.grantee=0 or a.is_grantable or a.privilege_type<>'EXECUTE')
 union all select 'missing_role:'||name from unnest(array['still_settings_writer','still_policy_reader','still_policy_admin','still_entitlement_writer','still_qa_sandbox_writer']) name
  where not exists(select 1 from pg_catalog.pg_roles r where r.rolname=name)
 union all select 'unsafe_role:'||r.rolname from pg_catalog.pg_roles r
  where r.rolname in ('still_settings_writer','still_policy_reader','still_policy_admin','still_entitlement_writer','still_qa_sandbox_writer')
  -- The legacy entitlement role was created INHERIT in 0001. Its membership gate below
  -- refuses inherited authority; modern narrow roles additionally require NOINHERIT.
  and (r.rolsuper or (r.rolinherit and r.rolname<>'still_entitlement_writer') or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls)
 union all select 'role_membership:'||r.rolname from pg_catalog.pg_roles r
  join pg_catalog.pg_auth_members m on m.member=r.oid or m.roleid=r.oid
  where r.rolname in ('still_settings_writer','still_policy_reader','still_policy_admin','still_entitlement_writer')
   and not (m.roleid=r.oid and m.member=(select oid from pg_catalog.pg_roles where rolname='postgres')
    and m.admin_option and not m.inherit_option and not m.set_option)
 union all select 'role_not_login:'||r.rolname from pg_catalog.pg_roles r
  where r.rolname in ('still_settings_writer','still_policy_reader','still_qa_sandbox_writer') and not r.rolcanlogin
 union all select 'private_schema' where not exists(select 1 from pg_catalog.pg_namespace
  where nspname='private' and nspowner=(select oid from pg_catalog.pg_roles where rolname='postgres'))
 union all select 'missing_private_usage:'||r.rolname from pg_catalog.pg_roles r
  where r.rolname in ('still_settings_writer','still_policy_reader')
   and not pg_catalog.has_schema_privilege(r.oid,'private','USAGE')
 union all select 'missing_relation:'||name from unnest(array['settings_anchors','settings_writes','product_policy_revisions','access_rights','apple_access_observations']) name
  where not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='private' and c.relname=name and c.relkind='r' and c.relrowsecurity
    and c.relowner=(select oid from pg_catalog.pg_roles where rolname='postgres'))
 union all select 'direct_table_grant:'||r.rolname from pg_catalog.pg_roles r
  cross join pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where r.rolname in ('still_settings_writer','still_policy_reader') and n.nspname in ('public','private')
   and c.relkind in ('r','p','v','m','f') and
    (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
 union all select 'client_private_grant' from client_reach r cross join prerequisite_routines p
  where p.sig like 'private.%' and p.oid is not null and pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')
 union all select 'sandbox_sales_policy_missing' where not exists(
  select 1 from private.product_policy_revisions where namespace='sales' and environment='sandbox')
),
grantee_names as (
  select 0::oid as oid, 'PUBLIC'::text as name
  union all
  select r.oid, r.rolname::text from pg_catalog.pg_roles r
),
routines as (
  select p.oid, n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as sig,
         p.prosecdef, p.proconfig, p.prosrc,
         p.proowner, p.proacl
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private')
),
relations as (
  select c.oid, (n.nspname||'.'||c.relname)::text as relname, c.relkind, c.relowner, c.relacl,
         c.relrowsecurity, c.relforcerowsecurity
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','private') and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
facts(fact) as (
  select 'function ' || r.sig || ' | security ' ||
         case when r.prosecdef then 'definer' else 'invoker' end
  from routines r
  union all
  select 'function ' || r.sig || ' | config ' || pg_catalog.array_to_string(r.proconfig, ',')
  from routines r where r.proconfig is not null
  union all
  select 'function ' || r.sig || ' | body md5 ' || pg_catalog.md5(coalesce(r.prosrc, ''))
  from routines r
  union all
  select 'function ' || r.sig || ' | result ' || pg_catalog.pg_get_function_result(r.oid) ||
    ' | language ' || l.lanname || ' | volatility ' || p.provolatile::text ||
    ' | parallel ' || p.proparallel::text || ' | strict ' || p.proisstrict::text ||
    ' | leakproof ' || p.proleakproof::text
  from routines r join pg_catalog.pg_proc p on p.oid=r.oid
  join pg_catalog.pg_language l on l.oid=p.prolang
  union all
  select 'function ' || r.sig || ' | owner ' || g.name
  from routines r join grantee_names g on g.oid = r.proowner
  union all
  select 'function ' || r.sig || ' | ' || a.privilege_type || ' to ' || g.name ||
         case when a.is_grantable then ' (grantable)' else '' end
  from routines r
  cross join lateral pg_catalog.aclexplode(coalesce(r.proacl, pg_catalog.acldefault('f', r.proowner))) a
  join grantee_names g on g.oid = a.grantee
  union all
  select 'table ' || t.relname || ' | ' || a.privilege_type || ' to ' || g.name ||
         case when a.is_grantable then ' (grantable)' else '' end
  from relations t
  cross join lateral pg_catalog.aclexplode(coalesce(t.relacl, pg_catalog.acldefault(
    case when t.relkind = 'S' then 's'::"char" else 'r'::"char" end, t.relowner))) a
  join grantee_names g on g.oid = a.grantee
  union all
  select 'table ' || t.relname || ' | row level security ' ||
         case when t.relrowsecurity then 'on' else 'off' end ||
         case when t.relforcerowsecurity then ' (forced)' else '' end
  from relations t where t.relkind in ('r', 'p')
  union all
  select 'column ' || t.relname || '.' || att.attname || ' | ' || a.privilege_type ||
         ' to ' || g.name || case when a.is_grantable then ' (grantable)' else '' end
  from relations t
  join pg_catalog.pg_attribute att
    on att.attrelid = t.oid and att.attnum > 0 and not att.attisdropped and att.attacl is not null
  cross join lateral pg_catalog.aclexplode(att.attacl) a
  join grantee_names g on g.oid = a.grantee
  union all
  select 'policy ' || p.schemaname || '.' || p.tablename || '.' || p.policyname || ' | ' || p.permissive || ' ' ||
         p.cmd || ' to ' || pg_catalog.array_to_string(p.roles, ',') ||
         ' using md5 ' || pg_catalog.md5(coalesce(p.qual, '')) ||
         ' check md5 ' || pg_catalog.md5(coalesce(p.with_check, ''))
  from pg_catalog.pg_policies p where p.schemaname in ('public','private')
  union all
  select 'default privileges for ' || o.name || ' in ' || coalesce(n.nspname::text, 'all schemas') ||
         ' on ' || case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
                   when 'f' then 'functions' when 'T' then 'types' when 'n' then 'schemas'
                   else d.defaclobjtype::text end ||
         ' | ' || a.privilege_type || ' to ' || g.name ||
         case when a.is_grantable then ' (grantable)' else '' end
  from pg_catalog.pg_default_acl d
  join grantee_names o on o.oid = d.defaclrole
  left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral pg_catalog.aclexplode(d.defaclacl) a
  join grantee_names g on g.oid = a.grantee
  where d.defaclnamespace = 0 or n.nspname in ('public','private')
  union all
  select 'schema ' || n.nspname || ' | ' || a.privilege_type || ' to ' || g.name ||
         case when a.is_grantable then ' (grantable)' else '' end
  from pg_catalog.pg_namespace n
  cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
  join grantee_names g on g.oid = a.grantee
  where n.nspname in ('public','private')
  union all
  select 'schema ' || n.nspname || ' | owner ' || g.name
  from pg_catalog.pg_namespace n join grantee_names g on g.oid=n.nspowner
  where n.nspname in ('public','private')
  union all
  select 'relation ' || t.relname || ' | kind ' || t.relkind::text || ' | owner ' || g.name
  from relations t join grantee_names g on g.oid=t.relowner
  union all
  select 'column ' || t.relname || '.' || a.attname || ' | definition ' ||
    a.attnum::text || ' ' || pg_catalog.format_type(a.atttypid,a.atttypmod) ||
    ' not-null ' || a.attnotnull::text || ' identity ' || a.attidentity::text ||
    ' generated ' || a.attgenerated::text || ' collation ' || a.attcollation::text ||
    ' default md5 ' || md5(coalesce(pg_catalog.pg_get_expr(d.adbin,d.adrelid),''))
  from relations t join pg_catalog.pg_attribute a on a.attrelid=t.oid
  left join pg_catalog.pg_attrdef d on d.adrelid=t.oid and d.adnum=a.attnum
  where a.attnum>0 and not a.attisdropped
  union all
  select 'constraint ' || t.relname || '.' || c.conname || ' | definition md5 ' ||
    md5(pg_catalog.pg_get_constraintdef(c.oid)) || ' validated ' || c.convalidated::text
  from relations t join pg_catalog.pg_constraint c on c.conrelid=t.oid
  union all
  select 'index ' || t.relname || '.' || c.relname || ' | definition md5 ' ||
    md5(pg_catalog.pg_get_indexdef(i.indexrelid)) || ' valid ' || i.indisvalid::text
  from relations t join pg_catalog.pg_index i on i.indrelid=t.oid
  join pg_catalog.pg_class c on c.oid=i.indexrelid
  union all
  select 'trigger ' || t.relname || '.' || tr.tgname || ' | definition md5 ' ||
    md5(pg_catalog.pg_get_triggerdef(tr.oid)) || ' enabled ' || tr.tgenabled::text
  from relations t join pg_catalog.pg_trigger tr on tr.tgrelid=t.oid and not tr.tgisinternal
  union all
  select 'view ' || t.relname || ' | definition md5 ' || md5(pg_catalog.pg_get_viewdef(t.oid))
  from relations t where t.relkind in ('v','m')
  union all
  select 'migration ' || m.version || ' ' || coalesce(m.name, '')
  from supabase_migrations.schema_migrations m
), policy as (
 select md5(coalesce(string_agg(namespace||':'||environment||':'||revision::text||':'||body,E'\n'
  order by namespace collate "C",environment collate "C",revision),'')) as digest
 from private.product_policy_revisions
), history as (
 select coalesce(json_agg(json_build_object('version',version,'name',name) order by length(version),version), '[]'::json) as value
 from supabase_migrations.schema_migrations
)
select json_build_array(json_build_object(
 'issues',(select coalesce(json_agg(code order by code collate "C"),'[]'::json) from issues),
 'facts',(select coalesce(json_agg(fact order by fact collate "C"),'[]'::json) from (select distinct fact from facts) f),
 'history',history.value,'policyDigest',policy.digest))::text from history,policy;
