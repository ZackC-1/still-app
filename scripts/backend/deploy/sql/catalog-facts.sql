-- Read-only. One row, one column: a sorted JSON array of plain-text facts describing the
-- privilege surface of schema public (routine security/config/body hash/owner/EXECUTE grants,
-- table and column grants, row level security, policies, default privileges, the schema's own
-- grants) plus the applied migration history. Catalog only, never customer rows.
--
-- Used ONLY on the disposable replay database inside the plan job, before and after the listed
-- migrations, so the owner sees exactly what the change does. It is never run against
-- production: hosted catalog detail stays private (a public repository's job logs are public).
with
grantee_names as (
  select 0::oid as oid, 'PUBLIC'::text as name
  union all
  select r.oid, r.rolname::text from pg_catalog.pg_roles r
),
routines as (
  select p.oid, p.oid::pg_catalog.regprocedure::text as sig, p.prosecdef, p.proconfig, p.prosrc,
         p.proowner, p.proacl
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
relations as (
  select c.oid, c.relname::text as relname, c.relkind, c.relowner, c.relacl,
         c.relrowsecurity, c.relforcerowsecurity
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
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
  select 'function ' || r.sig || ' | owner ' || g.name
  from routines r join grantee_names g on g.oid = r.proowner
  union all
  select 'function ' || r.sig || ' | ' || a.privilege_type || ' to ' || g.name ||
         case when a.is_grantable then ' (grantable)' else '' end
  from routines r
  cross join lateral pg_catalog.aclexplode(coalesce(r.proacl, pg_catalog.acldefault('f', r.proowner))) a
  join grantee_names g on g.oid = a.grantee
  union all
  select 'table public.' || t.relname || ' | ' || a.privilege_type || ' to ' || g.name ||
         case when a.is_grantable then ' (grantable)' else '' end
  from relations t
  cross join lateral pg_catalog.aclexplode(coalesce(t.relacl, pg_catalog.acldefault(
    case when t.relkind = 'S' then 's'::"char" else 'r'::"char" end, t.relowner))) a
  join grantee_names g on g.oid = a.grantee
  union all
  select 'table public.' || t.relname || ' | row level security ' ||
         case when t.relrowsecurity then 'on' else 'off' end ||
         case when t.relforcerowsecurity then ' (forced)' else '' end
  from relations t where t.relkind in ('r', 'p')
  union all
  select 'column public.' || t.relname || '.' || att.attname || ' | ' || a.privilege_type ||
         ' to ' || g.name || case when a.is_grantable then ' (grantable)' else '' end
  from relations t
  join pg_catalog.pg_attribute att
    on att.attrelid = t.oid and att.attnum > 0 and not att.attisdropped and att.attacl is not null
  cross join lateral pg_catalog.aclexplode(att.attacl) a
  join grantee_names g on g.oid = a.grantee
  union all
  select 'policy public.' || p.tablename || '.' || p.policyname || ' | ' || p.permissive || ' ' ||
         p.cmd || ' to ' || pg_catalog.array_to_string(p.roles, ',') ||
         ' using md5 ' || pg_catalog.md5(coalesce(p.qual, '')) ||
         ' check md5 ' || pg_catalog.md5(coalesce(p.with_check, ''))
  from pg_catalog.pg_policies p where p.schemaname = 'public'
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
  where d.defaclnamespace = 0 or n.nspname = 'public'
  union all
  select 'schema public | ' || a.privilege_type || ' to ' || g.name ||
         case when a.is_grantable then ' (grantable)' else '' end
  from pg_catalog.pg_namespace n
  cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
  join grantee_names g on g.oid = a.grantee
  where n.nspname = 'public'
  union all
  select 'migration ' || m.version || ' ' || coalesce(m.name, '')
  from supabase_migrations.schema_migrations m
)
select coalesce(pg_catalog.json_agg(f.fact order by f.fact), '[]'::json)::text
from (select distinct fact from facts) f;
