-- Read-only role check for qa-sandbox-secrets (apply, rotate and disable). Run before the change
-- and after it. One row, one column: a JSON array of "<role>:<fact>" strings ordered with
-- collate "C", for exactly the three function roles below.
--
--   <role>:missing                 the role does not exist (no other fact follows for it)
--   <role>:login / <role>:nologin  pg_roles.rolcanlogin
--   <role>:password-scram          the stored password is a SCRAM-SHA-256 verifier
--   <role>:password-other          some other stored form (MD5 or plaintext)
--   <role>:password-none           no password at all
--   <role>:password-unreadable     this session may not read pg_authid (on hosted Supabase the
--                                  postgres role is not a superuser); the runner then relies on
--                                  its sign-in probe with the generated password instead
--
-- Only the stored value's form is classified inside the database; the value never leaves it.
-- Every other role attribute (inherit, membership, per-role settings, ...) is compared by the
-- runner with role-facts.sql before and after the change, and may not differ.
with
targets(name) as (
  values ('still_policy_reader'), ('still_settings_writer'), ('still_qa_sandbox_writer')
),
readable as (
  select pg_catalog.has_table_privilege('pg_catalog.pg_authid', 'select') as ok
),
stored as (
  select (pg_catalog.xpath('/row/name/text()', x.r))[1]::text as name,
         (pg_catalog.xpath('/row/kind/text()', x.r))[1]::text as kind
  from readable p
  cross join lateral pg_catalog.unnest(
    case when p.ok then pg_catalog.xpath('/table/row', pg_catalog.query_to_xml(
      'select a.rolname::text as name, case when a.rolpassword is null then ''none'' when a.rolpassword like ''SCRAM-SHA-256$%'' then ''scram'' else ''other'' end as kind from pg_catalog.pg_authid a where a.rolname in (''still_policy_reader'', ''still_settings_writer'', ''still_qa_sandbox_writer'')',
      false, false, ''))
    else array[]::xml[] end
  ) x(r)
),
facts(fact) as (
  select t.name || ':missing'
  from targets t
  where not exists (select 1 from pg_catalog.pg_roles r where r.rolname = t.name)
  union all
  select t.name || case when r.rolcanlogin then ':login' else ':nologin' end
  from targets t
  join pg_catalog.pg_roles r on r.rolname = t.name
  union all
  select t.name || ':password-' ||
         case when not p.ok then 'unreadable' else coalesce(s.kind, 'none') end
  from targets t
  join pg_catalog.pg_roles r on r.rolname = t.name
  cross join readable p
  left join stored s on s.name = t.name
)
select coalesce(pg_catalog.json_agg(f.fact order by f.fact collate "C"), '[]'::json)::text
from facts f;
