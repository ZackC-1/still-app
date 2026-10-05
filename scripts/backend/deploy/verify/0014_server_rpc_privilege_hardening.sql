-- Post-apply verification for 0014_server_rpc_privilege_hardening.sql.
--
-- Read-only: a single SELECT, executed by the deploy runner inside a read-only session with a
-- statement timeout, before the apply (baseline) and after it (gate). It returns one row, one
-- column: a JSON array of issue codes ordered with collate "C". An empty array means the catalog
-- is in the state 0014 promises. Codes starting with "residual:" are the one reviewed residual
-- (supabase_admin public-schema default privileges, which postgres cannot change); they are
-- reported, never fatal. Any other code, any error, or any other output fails the deploy.
-- On the production target the runner prints only counts per issue class, never the codes;
-- full codes appear only in the plan job's throwaway-database rehearsal.
--
-- Covers the 0014 author's end-state list:
--  (1) version 0014 is recorded in the migration history (not necessarily last);
--  (2) the five purchase RPCs: EXECUTE only for still_entitlement_writer and the owner postgres;
--      plpgsql, SECURITY DEFINER, owned by postgres, body keeps the caller guard;
--  (3) consume_rate_limit writer only; cleanup_rate_limit_counters and sync_rate_limit_account
--      owner only;
--  (4) write_profile_settings authenticated only, body byte-identical to 0012 (free sync);
--  (5) get_current_rule_set for anon, authenticated and service_role, not PUBLIC;
--  (6) every SECURITY DEFINER in public pins search_path="" except event-trigger functions
--      (excluded by return type);
--  (7) no other SECURITY DEFINER in public executable by anon/authenticated or any role reachable
--      from them over any membership edge (trigger and event-trigger functions excluded);
--  (8) the seven tables: RLS on; PUBLIC, the client roles and the writer hold no write privilege at
--      table or column level; exactly the intended client reads; the writer holds nothing;
--      service_role unchanged (arwdDxtm on five tables, nothing on the two rate-limit tables);
--  (9) no CREATE on schema public for PUBLIC or the client roles;
--  (10) postgres default privileges: explicit global function entry without PUBLIC EXECUTE;
--      public-schema table/sequence/function entries reach no client and keep service_role;
--      no global table/sequence entry reaches clients;
--  (11) any other default privilege reaching PUBLIC or the client roles fails, except the exact
--      residual supabase_admin / schema public / types S, f, r.
-- Row-count invariance (item 12) is the separate 0014_server_rpc_privilege_hardening.invariant.sql.
with recursive
client_reach(oid) as (
  select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
  union
  select m.roleid from pg_catalog.pg_auth_members m join client_reach c on m.member = c.oid
),
clients as (
  select r.oid, r.rolname::text as rolname
  from client_reach x join pg_catalog.pg_roles r on r.oid = x.oid
),
names as (
  select 0::oid as oid, 'PUBLIC'::text as name
  union all
  select r.oid, r.rolname::text from pg_catalog.pg_roles r
),
settings as (
  select case when pg_catalog.current_setting('server_version_num')::int >= 170000
    then 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    else 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' end as write_privileges,
  case when pg_catalog.current_setting('server_version_num')::int >= 170000
    then array['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']
    else array['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'] end as all_table_privileges
),
-- Routines whose exact EXECUTE grantee set is fixed: role names allowed besides nothing else.
fixed_routines(sig, allowed, kind) as (
  values
    ('public.set_entitlement(uuid,boolean,text,text)', array['still_entitlement_writer', 'postgres'], 'purchase'),
    ('public.record_revenuecat_event(text,text,jsonb)', array['still_entitlement_writer', 'postgres'], 'purchase'),
    ('public.claim_revenuecat_event(text,text,jsonb)', array['still_entitlement_writer', 'postgres'], 'purchase'),
    ('public.complete_revenuecat_event(text,uuid)', array['still_entitlement_writer', 'postgres'], 'purchase'),
    ('public.release_revenuecat_event(text,uuid)', array['still_entitlement_writer', 'postgres'], 'purchase'),
    ('public.consume_rate_limit(text,integer,integer)', array['still_entitlement_writer', 'postgres'], 'writer'),
    ('public.cleanup_rate_limit_counters()', array['postgres'], 'owner'),
    ('public.sync_rate_limit_account()', array['postgres'], 'owner'),
    ('public.write_profile_settings(jsonb,uuid)', array['authenticated', 'postgres'], 'client'),
    ('public.get_current_rule_set()', array['anon', 'authenticated', 'service_role', 'postgres'], 'client')
),
routines as (
  select f.sig, f.allowed, f.kind, pg_catalog.to_regprocedure(f.sig) as oid from fixed_routines f
),
routine_acl as (
  select r.sig, g.name as grantee
  from routines r
  join pg_catalog.pg_proc p on p.oid = r.oid
  cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  join names g on g.oid = a.grantee
  where a.privilege_type = 'EXECUTE'
),
protected_tables(relname, service_role_full) as (
  values ('profiles', true), ('entitlements', true), ('revenuecat_events', true), ('rule_sets', true),
         ('canary_state', true), ('rate_limit_counters', false), ('rate_limit_window_keys', false)
),
tables as (
  select t.relname, t.service_role_full, c.oid, c.relacl, c.relowner, c.relrowsecurity
  from protected_tables t
  join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', t.relname))
),
table_acl as (
  select t.relname, g.name as grantee, a.privilege_type
  from tables t
  cross join lateral pg_catalog.aclexplode(coalesce(t.relacl, pg_catalog.acldefault('r', t.relowner))) a
  join names g on g.oid = a.grantee
),
-- Roles that must hold no write of any kind on the protected tables.
denied_writers as (
  select oid, rolname from clients
  union
  select r.oid, r.rolname::text from pg_catalog.pg_roles r where r.rolname = 'still_entitlement_writer'
),
default_entries as (
  select o.name as creator, d.defaclnamespace, n.nspname::text as nspname, d.defaclobjtype::text as objtype,
         a.grantee, a.privilege_type, g.name as grantee_name
  from pg_catalog.pg_default_acl d
  join names o on o.oid = d.defaclrole
  left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral pg_catalog.aclexplode(d.defaclacl) a
  join names g on g.oid = a.grantee
  where d.defaclnamespace = 0 or n.nspname = 'public'
),
issues(issue) as (
  -- (1) migration recorded.
  select 'migration_missing:0014'
  where not exists (select 1 from supabase_migrations.schema_migrations m where m.version = '0014')
  union all
  -- (2)-(5) exact routine reachability.
  select 'routine_missing:' || r.sig from routines r where r.oid is null
  union all
  select 'routine_extra_grantee:' || a.sig || ':' || a.grantee
  from routine_acl a join routines r on r.sig = a.sig
  where not (a.grantee = any (r.allowed))
  union all
  select 'routine_grantee_missing:' || r.sig || ':' || role_name
  from routines r cross join lateral pg_catalog.unnest(r.allowed) role_name
  where r.oid is not null and role_name <> 'postgres'
    and not exists (select 1 from routine_acl a where a.sig = r.sig and a.grantee = role_name)
  union all
  select 'routine_reachable:' || r.sig || ':' || role_name
  from routines r
  cross join lateral pg_catalog.unnest(array['anon', 'authenticated', 'service_role']) role_name
  where r.oid is not null and not (role_name = any (r.allowed))
    and pg_catalog.has_function_privilege(role_name, r.oid, 'EXECUTE')
  union all
  select 'purchase_rpc_not_plpgsql:' || r.sig
  from routines r join pg_catalog.pg_proc p on p.oid = r.oid
  join pg_catalog.pg_language l on l.oid = p.prolang
  where r.kind = 'purchase' and l.lanname <> 'plpgsql'
  union all
  select 'purchase_rpc_not_definer:' || r.sig
  from routines r join pg_catalog.pg_proc p on p.oid = r.oid
  where r.kind = 'purchase' and not p.prosecdef
  union all
  select 'routine_owner:' || r.sig
  from routines r join pg_catalog.pg_proc p on p.oid = r.oid
  where pg_catalog.pg_get_userbyid(p.proowner) <> 'postgres'
  union all
  select 'guard_missing:' || r.sig
  from routines r join pg_catalog.pg_proc p on p.oid = r.oid
  where r.kind = 'purchase' and pg_catalog.strpos(p.prosrc, 'server role required') = 0
  union all
  select 'free_sync_body_changed'
  from routines r join pg_catalog.pg_proc p on p.oid = r.oid
  where r.sig = 'public.write_profile_settings(jsonb,uuid)'
    and pg_catalog.md5(p.prosrc) <> '49f7638439e019b627adcb004bcd473a'
  union all
  -- (6) search_path pinned on every SECURITY DEFINER except event-trigger functions.
  select 'unpinned_search_path:' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
    and not coalesce(p.proconfig @> array['search_path=""']::text[], false)
  union all
  -- (7) no other client-reachable SECURITY DEFINER in public.
  select distinct 'client_execute:' || c.rolname || ':' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join clients c
  where n.nspname = 'public' and p.prosecdef
    and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                             'pg_catalog.event_trigger'::pg_catalog.regtype)
    and p.oid is distinct from pg_catalog.to_regprocedure('public.write_profile_settings(jsonb,uuid)')
    and p.oid is distinct from pg_catalog.to_regprocedure('public.get_current_rule_set()')
    and pg_catalog.has_function_privilege(c.oid, p.oid, 'EXECUTE')
  union all
  -- (8) tables.
  select 'table_missing:' || t.relname
  from protected_tables t where pg_catalog.to_regclass(pg_catalog.format('public.%I', t.relname)) is null
  union all
  select 'rls_disabled:' || t.relname from tables t where not t.relrowsecurity
  union all
  select 'public_write:' || a.relname || ':' || a.privilege_type
  from table_acl a cross join settings s
  where a.grantee = 'PUBLIC' and a.privilege_type = any (pg_catalog.string_to_array(s.write_privileges, ','))
  union all
  select distinct 'role_write:' || w.rolname || ':' || t.relname
  from tables t
  join pg_catalog.pg_attribute att on att.attrelid = t.oid and att.attnum > 0 and not att.attisdropped
  cross join denied_writers w cross join settings s
  where pg_catalog.has_column_privilege(w.oid, t.oid, att.attnum, 'INSERT,UPDATE,REFERENCES')
     or pg_catalog.has_table_privilege(w.oid, t.oid, s.write_privileges)
  union all
  select 'writer_table_privilege:' || t.relname
  from tables t
  where pg_catalog.has_table_privilege('still_entitlement_writer', t.oid, 'SELECT')
     or pg_catalog.has_any_column_privilege('still_entitlement_writer', t.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
  union all
  select 'client_read:' || c.rolname || ':' || t.relname || '.' || att.attname
  from tables t
  join pg_catalog.pg_attribute att on att.attrelid = t.oid and att.attnum > 0 and not att.attisdropped
  cross join clients c
  where pg_catalog.has_column_privilege(c.oid, t.oid, att.attnum, 'SELECT')
    and not ((t.relname = 'profiles' and c.rolname = 'authenticated')
          or (t.relname = 'entitlements' and c.rolname = 'authenticated'
              and att.attname in ('user_id', 'still_sync'))
          or (t.relname in ('revenuecat_events', 'rule_sets')
              and c.rolname in ('anon', 'authenticated')))
  union all
  select 'client_read_missing:' || x.rolname || ':' || x.relname || coalesce('.' || x.attname, '')
  from (values ('authenticated', 'profiles', null::text), ('authenticated', 'entitlements', 'user_id'),
               ('authenticated', 'entitlements', 'still_sync'), ('anon', 'revenuecat_events', null),
               ('authenticated', 'revenuecat_events', null), ('anon', 'rule_sets', null),
               ('authenticated', 'rule_sets', null)) x(rolname, relname, attname)
  join tables t on t.relname = x.relname
  where (x.attname is null and not pg_catalog.has_table_privilege(x.rolname, t.oid, 'SELECT'))
     or (x.attname is not null and not pg_catalog.has_column_privilege(x.rolname, t.oid, x.attname, 'SELECT'))
  union all
  select 'entitlements_table_select:' || a.grantee
  from table_acl a
  where a.relname = 'entitlements' and a.privilege_type = 'SELECT'
    and a.grantee in ('PUBLIC', 'anon', 'authenticated')
  union all
  select 'service_role_changed:' || t.relname
  from tables t cross join settings s
  where coalesce((select pg_catalog.array_agg(a.privilege_type order by a.privilege_type collate "C")
                  from table_acl a where a.relname = t.relname and a.grantee = 'service_role'), '{}')
        <> case when t.service_role_full then s.all_table_privileges else '{}'::text[] end
  union all
  -- (9) schema public.
  select 'client_schema_create'
  where exists (select 1 from clients c where pg_catalog.has_schema_privilege(c.oid, 'public', 'CREATE'))
  union all
  -- (10) postgres-creator defaults.
  select 'postgres_global_function_default_missing'
  where not exists (
    select 1 from pg_catalog.pg_default_acl d join pg_catalog.pg_roles o on o.oid = d.defaclrole
    where o.rolname = 'postgres' and d.defaclnamespace = 0 and d.defaclobjtype = 'f')
  union all
  select 'postgres_global_function_default'
  where exists (
    select 1 from pg_catalog.pg_roles o
    left join pg_catalog.pg_default_acl d
      on d.defaclrole = o.oid and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
    cross join lateral pg_catalog.aclexplode(coalesce(d.defaclacl, pg_catalog.acldefault('f', o.oid))) a
    where o.rolname = 'postgres' and a.privilege_type = 'EXECUTE'
      and (a.grantee = 0 or a.grantee in (select oid from clients)))
  union all
  select 'postgres_public_default_service_role_missing:' || x.objtype
  from (values ('r'), ('S'), ('f')) x(objtype)
  where not exists (
    select 1 from default_entries e
    where e.creator = 'postgres' and e.nspname = 'public' and e.objtype = x.objtype
      and e.grantee_name = 'service_role')
  union all
  -- (10)+(11) every explicit default entry (global or schema public) reaching PUBLIC or a client
  -- role fails, except the exact reviewed residual, which is reported.
  select distinct
    case when e.creator = 'supabase_admin' and e.nspname = 'public' and e.objtype in ('S', 'f', 'r')
      then 'residual:supabase_admin_public_default:' || e.objtype
      else 'default_reaches_client:' || e.creator || ':' || coalesce(e.nspname, 'global') || ':' || e.objtype
    end
  from default_entries e
  where e.grantee = 0 or e.grantee in (select oid from clients)
)
select coalesce(pg_catalog.json_agg(i.issue order by i.issue collate "C"), '[]'::json)::text
from (select distinct issue from issues) i;
