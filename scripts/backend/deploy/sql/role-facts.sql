-- Read-only. One row, one column: a sorted JSON array of plain-text facts about every database role:
-- each attribute (login, superuser, inherit, createrole, createdb, replication, bypassrls,
-- connection limit, expiry), its per-role settings, and every membership edge with its
-- admin/inherit/set options. Passwords are not visible in pg_roles and are not read. Catalog only,
-- never customer rows.
--
-- Used by the owner-approved operations (pause/resume settings sync) before and after the change.
-- The runner compares the two lists in memory and requires that the only difference is the one
-- the operation promises (still_settings_writer's login). On production it prints only counts,
-- never the facts themselves.
with
roles as (
  select r.oid, r.rolname::text as name, r.rolcanlogin, r.rolsuper, r.rolinherit, r.rolcreaterole,
         r.rolcreatedb, r.rolreplication, r.rolbypassrls, r.rolconnlimit, r.rolvaliduntil, r.rolconfig
  from pg_catalog.pg_roles r
),
facts(fact) as (
  select 'role ' || r.name || ' | login ' || r.rolcanlogin::text from roles r
  union all
  select 'role ' || r.name || ' | superuser ' || r.rolsuper::text from roles r
  union all
  select 'role ' || r.name || ' | inherit ' || r.rolinherit::text from roles r
  union all
  select 'role ' || r.name || ' | createrole ' || r.rolcreaterole::text from roles r
  union all
  select 'role ' || r.name || ' | createdb ' || r.rolcreatedb::text from roles r
  union all
  select 'role ' || r.name || ' | replication ' || r.rolreplication::text from roles r
  union all
  select 'role ' || r.name || ' | bypassrls ' || r.rolbypassrls::text from roles r
  union all
  select 'role ' || r.name || ' | connection limit ' || r.rolconnlimit::text from roles r
  union all
  select 'role ' || r.name || ' | valid until ' || coalesce(r.rolvaliduntil::text, 'none') from roles r
  union all
  select 'role ' || r.name || ' | config ' || c.setting
  from roles r cross join lateral pg_catalog.unnest(r.rolconfig) c(setting)
  union all
  select 'member ' || m.name || ' of ' || g.name || ' | admin ' || a.admin_option::text ||
         ' inherit ' || a.inherit_option::text || ' set ' || a.set_option::text
  from pg_catalog.pg_auth_members a
  join roles m on m.oid = a.member
  join roles g on g.oid = a.roleid
)
select coalesce(pg_catalog.json_agg(f.fact order by f.fact collate "C"), '[]'::json)::text
from (select distinct fact from facts) f;
