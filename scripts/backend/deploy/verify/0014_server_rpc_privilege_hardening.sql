-- Post-apply verification for 0014_server_rpc_privilege_hardening.sql.
--
-- Read-only: a single SELECT, executed by the deploy runner inside a read-only session with a
-- statement timeout. It returns one row, one column: a JSON array of issue codes. An empty array
-- ([]) means the hosted catalog is in the state 0014 promises. Any code, any error, or any other
-- output fails the deploy loudly. The codes name only repository objects and the two client
-- roles, so they are safe to show in a public job log.
--
-- It re-checks, without writing anything, the same end state as the migration's own self-check
-- (section 7), plus the presence of each in-function caller guard:
--   * the five purchase RPCs and consume_rate_limit: executable by still_entitlement_writer,
--     not by service_role, not by any role reachable from anon/authenticated;
--   * no other client-reachable SECURITY DEFINER routine in public except the two client RPCs;
--   * write_profile_settings: authenticated only (free sync kept); get_current_rule_set: anon,
--     authenticated and service_role;
--   * every SECURITY DEFINER routine in public pins search_path to empty;
--   * the five purchase RPCs keep their caller guard;
--   * the seven application tables keep RLS, give clients no write of any kind and only the
--     intended reads, and give the writer nothing;
--   * clients cannot CREATE in schema public;
--   * postgres-creator default privileges hand nothing to PUBLIC or the client roles.
-- The supabase_admin default privileges are the one documented residual and are not inspected.
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
server_rpcs(sig) as (
  values
    ('public.set_entitlement(uuid,boolean,text,text)'),
    ('public.record_revenuecat_event(text,text,jsonb)'),
    ('public.claim_revenuecat_event(text,text,jsonb)'),
    ('public.complete_revenuecat_event(text,uuid)'),
    ('public.release_revenuecat_event(text,uuid)'),
    ('public.consume_rate_limit(text,integer,integer)')
),
guarded_rpcs(sig) as (
  select sig from server_rpcs where sig <> 'public.consume_rate_limit(text,integer,integer)'
),
protected_tables(relname) as (
  values ('profiles'), ('entitlements'), ('revenuecat_events'), ('rule_sets'),
         ('rate_limit_counters'), ('rate_limit_window_keys'), ('canary_state')
),
settings as (
  select case when pg_catalog.current_setting('server_version_num')::int >= 170000
    then 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    else 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' end as write_privileges
),
issues(issue) as (
  -- Server RPCs: writer only.
  select 'writer_missing:' || s.sig from server_rpcs s
  where not pg_catalog.has_function_privilege('still_entitlement_writer', s.sig, 'EXECUTE')
  union all
  select 'service_role_execute:' || s.sig from server_rpcs s
  where pg_catalog.has_function_privilege('service_role', s.sig, 'EXECUTE')
  union all
  -- No client-reachable SECURITY DEFINER in public except the two client RPCs.
  select distinct 'client_execute:' || c.rolname || ':' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join clients c
  where n.nspname = 'public' and p.prosecdef
    and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                             'pg_catalog.event_trigger'::pg_catalog.regtype)
    and p.oid not in ('public.write_profile_settings(jsonb,uuid)'::pg_catalog.regprocedure,
                      'public.get_current_rule_set()'::pg_catalog.regprocedure)
    and pg_catalog.has_function_privilege(c.oid, p.oid, 'EXECUTE')
  union all
  -- Client RPC reachability is exactly the intended one.
  select 'write_profile_settings_beyond_authenticated'
  where pg_catalog.has_function_privilege('anon', 'public.write_profile_settings(jsonb,uuid)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'public.write_profile_settings(jsonb,uuid)', 'EXECUTE')
  union all
  select 'free_sync_missing'
  where not pg_catalog.has_function_privilege('authenticated', 'public.write_profile_settings(jsonb,uuid)', 'EXECUTE')
  union all
  select 'rule_read_missing'
  where not (pg_catalog.has_function_privilege('anon', 'public.get_current_rule_set()', 'EXECUTE')
         and pg_catalog.has_function_privilege('authenticated', 'public.get_current_rule_set()', 'EXECUTE')
         and pg_catalog.has_function_privilege('service_role', 'public.get_current_rule_set()', 'EXECUTE'))
  union all
  -- Every SECURITY DEFINER routine in public pins an empty search_path.
  select 'unpinned_search_path:' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
    and not coalesce(p.proconfig @> array['search_path=""']::text[], false)
  union all
  -- The purchase RPCs keep their in-function caller guard (second layer behind the revokes).
  select 'guard_missing:' || g.sig
  from guarded_rpcs g
  join pg_catalog.pg_proc p on p.oid = g.sig::pg_catalog.regprocedure
  where pg_catalog.strpos(p.prosrc, 'server role required') = 0
     or pg_catalog.strpos(p.prosrc, 'still_entitlement_writer') = 0
  union all
  -- Tables: RLS on and nothing for the writer.
  select 'rls_disabled:' || t.relname
  from protected_tables t
  join pg_catalog.pg_class c on c.oid = pg_catalog.format('public.%I', t.relname)::pg_catalog.regclass
  where not c.relrowsecurity
  union all
  select 'writer_table_privilege:' || t.relname
  from protected_tables t cross join settings s
  where pg_catalog.has_table_privilege('still_entitlement_writer',
          pg_catalog.format('public.%I', t.relname), 'SELECT,' || s.write_privileges)
     or pg_catalog.has_any_column_privilege('still_entitlement_writer',
          pg_catalog.format('public.%I', t.relname), 'SELECT,INSERT,UPDATE,REFERENCES')
  union all
  -- Tables: no client write of any kind, and only the intended client reads.
  select distinct 'client_write:' || c.rolname || ':' || t.relname
  from protected_tables t
  join pg_catalog.pg_class tc on tc.oid = pg_catalog.format('public.%I', t.relname)::pg_catalog.regclass
  join pg_catalog.pg_attribute a on a.attrelid = tc.oid and a.attnum > 0 and not a.attisdropped
  cross join clients c cross join settings s
  where pg_catalog.has_column_privilege(c.oid, tc.oid, a.attnum, 'INSERT,UPDATE,REFERENCES')
     or pg_catalog.has_table_privilege(c.oid, tc.oid, s.write_privileges)
  union all
  select 'client_read:' || c.rolname || ':' || t.relname || '.' || a.attname
  from protected_tables t
  join pg_catalog.pg_class tc on tc.oid = pg_catalog.format('public.%I', t.relname)::pg_catalog.regclass
  join pg_catalog.pg_attribute a on a.attrelid = tc.oid and a.attnum > 0 and not a.attisdropped
  cross join clients c
  where pg_catalog.has_column_privilege(c.oid, tc.oid, a.attnum, 'SELECT')
    and not ((t.relname = 'profiles' and c.rolname = 'authenticated')
          or (t.relname = 'entitlements' and c.rolname = 'authenticated'
              and a.attname in ('user_id', 'still_sync'))
          or (t.relname in ('revenuecat_events', 'rule_sets')
              and c.rolname in ('anon', 'authenticated')))
  union all
  -- No client CREATE on schema public.
  select 'client_schema_create'
  where exists (select 1 from clients c where pg_catalog.has_schema_privilege(c.oid, 'public', 'CREATE'))
  union all
  -- postgres-creator defaults: nothing for PUBLIC or the client roles.
  select 'postgres_global_function_default'
  where exists (
    select 1 from pg_catalog.pg_roles o
    left join pg_catalog.pg_default_acl d
      on d.defaclrole = o.oid and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
    cross join lateral pg_catalog.aclexplode(coalesce(d.defaclacl, pg_catalog.acldefault('f', o.oid))) a
    where o.rolname = 'postgres' and a.privilege_type = 'EXECUTE'
      and (a.grantee = 0 or a.grantee in (select oid from clients)))
  union all
  select 'postgres_public_schema_default'
  where exists (
    select 1 from pg_catalog.pg_default_acl d
    join pg_catalog.pg_roles o on o.oid = d.defaclrole
    join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where o.rolname = 'postgres' and n.nspname = 'public'
      and (a.grantee = 0 or a.grantee in (select oid from clients)))
  union all
  select 'postgres_global_relation_default'
  where exists (
    select 1 from pg_catalog.pg_default_acl d
    join pg_catalog.pg_roles o on o.oid = d.defaclrole
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where o.rolname = 'postgres' and d.defaclnamespace = 0 and d.defaclobjtype in ('r', 'S')
      and (a.grantee = 0 or a.grantee in (select oid from clients)))
)
select coalesce(pg_catalog.json_agg(i.issue order by i.issue), '[]'::json)::text
from (select distinct issue from issues) i;
