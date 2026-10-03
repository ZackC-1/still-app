-- One catalog-only SELECT for the hosted SQL editor; no customer rows, bodies or migration statements.
-- Keep the result private. Observed definition hashes do NOT prove historical applied SQL bytes.
-- LIMITs bound accidental output. Any truncated=true section requires a narrower private follow-up.
with migrations as (
  select version, name from supabase_migrations.schema_migrations order by version limit 200
), routines as (
  select n.nspname as schema, p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
         r.rolname as owner, p.prosecdef, p.proconfig, p.proacl,
         md5(pg_get_functiondef(p.oid)) as observed_definition_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname in ('public', 'still_security') and p.prokind in ('f', 'p')
  order by 1, 2, 3 limit 300
), tables as (
  select n.nspname as schema, c.relname, r.rolname as owner, c.relrowsecurity,
         c.relforcerowsecurity, c.relacl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_roles r on r.oid = c.relowner
  where n.nspname in ('public', 'still_security') and c.relkind in ('r', 'p', 'v', 'S')
  order by 1, 2 limit 300
), columns as (
  select n.nspname as schema, c.relname, a.attname, a.attacl
  from pg_attribute a join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'still_security') and a.attacl is not null
  order by 1, 2, 3 limit 500
), defaults as (
  select r.rolname as creator, coalesce(n.nspname, '<global>') as scope,
         d.defaclobjtype, d.defaclacl
  from pg_default_acl d join pg_roles r on r.oid = d.defaclrole
  left join pg_namespace n on n.oid = d.defaclnamespace order by 1, 2, 3 limit 500
), roles as (
  select r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb,
         r.rolcanlogin, r.rolbypassrls from pg_roles r order by 1 limit 200
), memberships as (
  select parent.rolname as granted_role, child.rolname as member, m.admin_option,
         -- PostgreSQL <16 has role-level inheritance and no per-edge SET/INHERIT fields.
         coalesce((to_jsonb(m)->>'inherit_option')::boolean, child.rolinherit) as inherit_option,
         coalesce((to_jsonb(m)->>'set_option')::boolean, true) as set_option
  from pg_auth_members m join pg_roles parent on parent.oid = m.roleid
  join pg_roles child on child.oid = m.member order by 1, 2 limit 500
), schemas as (
  select nspname, nspacl from pg_namespace where nspname in ('public', 'still_security')
)
select jsonb_build_object(
  'server_version', current_setting('server_version'),
  'migration_history', coalesce((select jsonb_agg(to_jsonb(m)) from migrations m), '[]'::jsonb),
  'routines', coalesce((select jsonb_agg(to_jsonb(r)) from routines r), '[]'::jsonb),
  'tables', coalesce((select jsonb_agg(to_jsonb(t)) from tables t), '[]'::jsonb),
  'column_grants', coalesce((select jsonb_agg(to_jsonb(c)) from columns c), '[]'::jsonb),
  'default_grants', coalesce((select jsonb_agg(to_jsonb(d)) from defaults d), '[]'::jsonb),
  'roles', coalesce((select jsonb_agg(to_jsonb(r)) from roles r), '[]'::jsonb),
  'memberships', coalesce((select jsonb_agg(to_jsonb(m)) from memberships m), '[]'::jsonb),
  'schema_grants', coalesce((select jsonb_agg(to_jsonb(s)) from schemas s), '[]'::jsonb),
  'possibly_truncated', jsonb_build_object(
    'migrations', (select count(*) = 200 from migrations),
    'routines', (select count(*) = 300 from routines),
    'tables', (select count(*) = 300 from tables),
    'columns', (select count(*) = 500 from columns),
    'defaults', (select count(*) = 500 from defaults),
    'roles', (select count(*) = 200 from roles),
    'memberships', (select count(*) = 500 from memberships)
  )
) as still_security_inventory;
