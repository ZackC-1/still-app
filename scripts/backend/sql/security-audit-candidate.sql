-- UNNUMBERED candidate: assign a unique migration only after actual owner inventory/review.
-- Catalog-only routine. No customer table is queried or returned, no repair or mutation occurs.
create schema if not exists still_security;
revoke all on schema still_security from public, anon, authenticated, service_role, still_entitlement_writer;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'still_security_auditor') then
    create role still_security_auditor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;

create or replace function still_security.audit() returns table (issue text)
language sql security definer set search_path = '' stable
as $$
with recursive clients as (
  select oid, rolname from pg_catalog.pg_roles where rolname in ('anon', 'authenticated')
), reachable as (
  select oid, rolname from clients
  union
  -- Close mixed inheritance, SET and ADMIN paths: a reachable role with ADMIN can
  -- re-grant membership with inheritance/SET, even if its current membership has neither.
  select r.oid, r.rolname from pg_catalog.pg_roles r, reachable c
  where pg_catalog.pg_has_role(c.oid, r.oid, 'USAGE')
     or pg_catalog.pg_has_role(c.oid, r.oid, 'SET')
     or pg_catalog.pg_has_role(c.oid, r.oid, 'MEMBER WITH ADMIN OPTION')
), protected_tables as (
  select c.* from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in
    ('profiles', 'entitlements', 'revenuecat_events', 'rule_sets', 'rate_limit_counters', 'rate_limit_window_keys')
), customer_relations as (
  -- Auditor narrowness has a broader boundary than the client-write table allowlist.
  -- Catalog privilege inquiries never read customer rows, including views/foreign tables.
  select c.* from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('auth', 'public', 'storage') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
), creators as (
  select distinct c.relowner as oid from protected_tables c
  union select distinct p.proowner from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
), violations as (
  select 'privileged_client_role'::text as issue where exists (
    select 1 from reachable r join pg_catalog.pg_roles pr on pr.oid = r.oid
    where pr.rolsuper or pr.rolbypassrls or pr.rolcreaterole or pr.rolcreatedb)
  union all select 'client_schema_create' where exists (
    select 1 from reachable r where pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE'))
  union all select 'client_server_rpc' where exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, reachable r
    where n.nspname = 'public' and p.prosecdef
      and p.proname not in ('write_profile_settings', 'get_current_rule_set')
      and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
  union all select 'client_audit_rpc' where exists (
    select 1 from reachable r where pg_catalog.has_function_privilege(r.oid, 'still_security.audit()', 'EXECUTE'))
  union all select 'anonymous_settings_rpc' where exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'write_profile_settings'
      and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'))
  union all select 'client_table_write' where exists (
    select 1 from protected_tables c, reachable r where
      pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE,REFERENCES'))
  union all select 'private_entitlement_column' where exists (
    select 1 from pg_catalog.pg_attribute a join protected_tables c on c.oid = a.attrelid, reachable r
    where c.relname = 'entitlements' and a.attnum > 0 and not a.attisdropped
      and (a.attname not in ('user_id', 'still_sync') or r.rolname = 'anon')
      and pg_catalog.has_column_privilege(r.oid, c.oid, a.attnum, 'SELECT'))
  union all select 'rls_disabled' where exists (select 1 from protected_tables where not relrowsecurity)
  union all select 'unpinned_definer' where exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'still_security') and p.prosecdef
      and not coalesce(p.proconfig @> array['search_path=""']::text[], false))
  union all select 'global_default_execute' where exists (
    select 1 from creators c
    left join pg_catalog.pg_default_acl d on d.defaclrole = c.oid and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
    cross join lateral pg_catalog.aclexplode(coalesce(d.defaclacl, pg_catalog.acldefault('f', c.oid))) a
    where a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee in (select oid from reachable)))
  union all select 'schema_default_client_privilege' where exists (
    select 1 from pg_catalog.pg_default_acl d join creators c on c.oid = d.defaclrole
    join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where n.nspname = 'public' and (a.grantee = 0 or a.grantee in (select oid from reachable))
      and ((d.defaclobjtype = 'f' and a.privilege_type = 'EXECUTE')
        or (d.defaclobjtype in ('r', 'S'))))
  union all select 'global_default_client_write' where exists (
    select 1 from pg_catalog.pg_default_acl d join creators c on c.oid = d.defaclrole
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where d.defaclnamespace = 0 and d.defaclobjtype in ('r', 'S')
      and (a.grantee = 0 or a.grantee in (select oid from reachable)))
  union all select 'audit_role_not_narrow' where exists (
    select 1 from pg_catalog.pg_roles r where r.rolname = 'still_security_auditor'
      and (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb
        or exists (select 1 from pg_catalog.pg_auth_members m where m.member = r.oid)
        or exists (select 1 from pg_catalog.pg_namespace n where n.nspname in ('auth', 'public', 'storage')
          and pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE'))
        or exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
          where n.nspname in ('auth', 'public', 'storage') and p.prosecdef
            and pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'))
        or exists (select 1 from customer_relations c where c.relkind <> 'S' and (
          pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          or pg_catalog.has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
        or exists (select 1 from customer_relations c where c.relkind = 'S'
          and pg_catalog.has_sequence_privilege(r.oid, c.oid, 'USAGE,SELECT,UPDATE'))))
) select distinct issue from violations order by issue;
$$;
revoke all on function still_security.audit() from public, anon, authenticated, service_role, still_entitlement_writer;
grant usage on schema still_security to still_security_auditor;
grant execute on function still_security.audit() to still_security_auditor;
