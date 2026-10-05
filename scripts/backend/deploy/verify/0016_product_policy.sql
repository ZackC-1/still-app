-- Post-apply verification for 0016_product_policy.sql.
--
-- Read-only: a single SELECT, run by the deploy runner inside a read-only session with a statement
-- timeout, before the apply (baseline) and after it (gate). It returns one row, one column: a JSON
-- array of issue codes ordered with collate "C". An empty array means the catalog is in the state
-- 0016 promises and every product policy is still Off. Before the apply most codes are expected (the
-- objects do not exist yet); nothing here errors on a missing object, role or table. The only rows
-- read are the migration history and the four product policy tables, none of which holds customer
-- data; the output names catalog objects and fixed codes only. On the production target the runner
-- prints only counts per issue class.
--
-- Covers the 0016 end state:
--  (1) version 0016 is recorded in the migration history;
--  (2) roles still_policy_reader and still_policy_admin: not superuser, no inherit/createrole/
--      createdb/replication/bypassrls; their three session settings; member of nothing; the only
--      membership in them is the automatic non-inheriting, non-SET admin grant to postgres; not
--      reachable from a client role;
--  (3) schema private: only still_settings_writer and the two policy roles hold anything (USAGE);
--  (4) the four policy tables: owned by postgres, RLS on, no table or column grant to anyone, every
--      column the routes use with its exact type and NOT NULL, the primary keys, and the owner
--      allowlist cascading from auth.users on delete;
--  (5) the write-once triggers on product_policy_revisions and paid_cutoff: present, enabled, row
--      level before update or delete and statement level before truncate;
--  (6) the eight 0016 routines: owned by postgres, search_path pg_temp-last, SECURITY DEFINER
--      exactly for the four routes, EXECUTE only for the owner plus each route's one narrow role,
--      bodies byte-identical to the migration;
--  (7) the policy roles reach no other SECURITY DEFINER routine and no table in public or private;
--  (8) no SECURITY DEFINER in public or private executable by a client role (closure over every
--      membership edge) except the two client RPCs, and nothing in private for service_role;
--  (9) every SECURITY DEFINER in public and private has exactly search_path=pg_catalog, pg_temp;
--  (10) no default privilege for schema private reaches PUBLIC, a client role, service_role or a
--      narrow role;
--  (11) initial Off: the owner allowlist is empty (no self-grant), no current rating or sales policy
--      has its master switch on, and no paid cutoff exists (counts only, read through query_to_xml
--      so the query also parses before the tables exist). After the owner's own separately approved
--      operations, re-running this check reports owner_present, policy_on or cutoff_present; that is
--      expected then and not a regression.
-- Note 0015's check enumerates schema private exactly, so it reports 0016's objects if it is re-run
-- after 0016; deploy and verify 0015 alone first.
-- Row-count invariance is the separate 0016_product_policy.invariant.sql.
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
ids as (
  select
    (select oid from pg_catalog.pg_roles where rolname = 'postgres') as owner_oid,
    (select oid from pg_catalog.pg_roles where rolname = 'still_policy_reader') as reader_oid,
    (select oid from pg_catalog.pg_roles where rolname = 'still_policy_admin') as admin_oid,
    (select oid from pg_catalog.pg_roles where rolname = 'still_settings_writer') as settings_writer_oid,
    (select oid from pg_catalog.pg_roles where rolname = 'service_role') as service_oid,
    pg_catalog.to_regnamespace('private')::oid as private_oid
),
names as (
  select 0::oid as oid, 'PUBLIC'::text as name
  union all
  select r.oid, r.rolname::text from pg_catalog.pg_roles r
),
narrow as (
  select r.oid, r.rolname::text as rolname from pg_catalog.pg_roles r
  where r.rolname in ('still_settings_writer', 'still_policy_reader', 'still_policy_admin')
),
restricted as (
  select oid from clients
  union select service_oid from ids where service_oid is not null
  union select 0::oid
),
policy_roles(rolname) as (values ('still_policy_reader'), ('still_policy_admin')),
role_settings(setting) as (
  values ('lock_timeout=1s'), ('statement_timeout=2s'), ('idle_in_transaction_session_timeout=5s')
),
policy_tables(relname) as (
  values ('product_policy_owners'), ('product_policy_operations'), ('product_policy_revisions'), ('paid_cutoff')
),
relations as (
  select t.relname, c.oid, c.relkind, c.relowner, c.relrowsecurity, c.relacl
  from policy_tables t
  left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass('private.' || t.relname)
),
-- Routine, whether SECURITY DEFINER, its one grantee besides the owner, and the md5 of its body.
expected_routines(sig, definer, grantee, body_md5) as (
  values
    ('private.product_policy_refuse_change()', false, null, 'b0631183cc93b985018962948328ecb2'),
    ('private.product_policy_render(text,jsonb)', false, null, '9d94051b02d7bf402ad2c4affcdd853c'),
    ('private.product_policy_body_valid(text,text,bigint,text)', false, null, '9dbbc09386ee714f755b59acbd9e716c'),
    ('private.product_policy_sales_activates(text)', false, null, '4a8eb3802b26f46c7fe24d63def0e2bf'),
    ('private.read_product_policy(text,text)', true, 'still_policy_reader', 'ad421f64810e24473d75c15d3ea0c053'),
    ('private.read_product_policy_state(uuid,text,text)', true, 'still_policy_admin', '2a1de40e3d9e718c86387e9205ca70d2'),
    ('private.preview_product_policy(uuid,text,text,bigint,text,bigint)', true, 'still_policy_admin', 'd8ccd612daf98806810c07d3135d5892'),
    ('private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])', true, 'still_policy_admin', 'ba726b725d139a12a3651fe1a4566cec')
),
routines as (
  select e.sig, e.definer, e.grantee, e.body_md5, pg_catalog.to_regprocedure(e.sig)::oid as oid
  from expected_routines e
),
routine_state as (
  select r.sig, r.definer, r.grantee, r.body_md5, p.oid, p.proowner, p.prosecdef, p.proconfig, p.prosrc,
    (select pg_catalog.array_agg(n.name order by n.name collate "C")
       from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       join names n on n.oid = a.grantee
      where a.grantee <> p.proowner) as grantees
  from routines r
  left join pg_catalog.pg_proc p on p.oid = r.oid
),
-- Initial Off reads the policy tables only once they exist: before the apply they do not, and a
-- static reference would fail to parse. query_to_xml runs the fixed read-only count text below.
off_state as (
  select
    case when pg_catalog.to_regclass('private.product_policy_owners') is not null then
      (pg_catalog.xpath('/row/n/text()', pg_catalog.query_to_xml(
        'select pg_catalog.count(*) as n from private.product_policy_owners', false, true, '')))[1]::text::int
    end as owners,
    case when pg_catalog.to_regclass('private.product_policy_revisions') is not null then
      (pg_catalog.xpath('/row/n/text()', pg_catalog.query_to_xml(
        'select pg_catalog.count(*) as n from (select distinct on (r.namespace, r.environment) r.body '
        || 'from private.product_policy_revisions r order by r.namespace, r.environment, r.revision desc) h '
        || 'where h.body::jsonb->''master'' = ''true''::jsonb or h.body::jsonb->''salesEnabled'' = ''true''::jsonb',
        false, true, '')))[1]::text::int
    end as policies_on,
    case when pg_catalog.to_regclass('private.paid_cutoff') is not null then
      (pg_catalog.xpath('/row/n/text()', pg_catalog.query_to_xml(
        'select pg_catalog.count(*) as n from private.paid_cutoff', false, true, '')))[1]::text::int
    end as cutoffs
),
issues(issue) as (
  -- (1) migration recorded.
  select 'migration_missing:0016'
  where not exists (select 1 from supabase_migrations.schema_migrations m where m.version = '0016')
  union all
  -- (2) the two roles.
  select 'role_missing:' || p.rolname
  from policy_roles p where not exists (select 1 from pg_catalog.pg_roles r where r.rolname = p.rolname)
  union all
  select 'role_attributes:' || r.rolname
  from pg_catalog.pg_roles r join policy_roles p on p.rolname = r.rolname
  where r.rolsuper or r.rolinherit or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls
  union all
  select 'role_setting_missing:' || r.rolname || ':' || s.setting
  from pg_catalog.pg_roles r join policy_roles p on p.rolname = r.rolname cross join role_settings s
  where not exists (select 1 from pg_catalog.pg_db_role_setting d
                    where d.setrole = r.oid and d.setdatabase = 0 and s.setting = any (d.setconfig))
  union all
  select distinct 'role_member_of_role:' || r.rolname
  from pg_catalog.pg_roles r join policy_roles p on p.rolname = r.rolname
  join pg_catalog.pg_auth_members m on m.member = r.oid
  union all
  select distinct 'role_granted_to_other:' || r.rolname
  from pg_catalog.pg_roles r join policy_roles p on p.rolname = r.rolname
  join pg_catalog.pg_auth_members m on m.roleid = r.oid cross join ids
  where not (m.member = ids.owner_oid and not m.inherit_option and not m.set_option)
  union all
  select 'role_client_reachable:' || c.rolname
  from clients c join policy_roles p on p.rolname = c.rolname
  union all
  -- (3) schema private.
  select 'private_schema_grant:' || g.name || ':' || a.privilege_type
  from pg_catalog.pg_namespace n cross join ids
  cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
  join names g on g.oid = a.grantee
  where n.oid = ids.private_oid and a.grantee <> n.nspowner
    and not (a.grantee in (select oid from narrow) and a.privilege_type = 'USAGE')
  union all
  select 'private_usage_missing:' || r.rolname
  from pg_catalog.pg_roles r join policy_roles p on p.rolname = r.rolname cross join ids
  where ids.private_oid is not null and not pg_catalog.has_schema_privilege(r.oid, ids.private_oid, 'USAGE')
  union all
  -- (4) the four tables.
  select 'policy_relation_missing:' || x.relname from relations x where x.oid is null or x.relkind <> 'r'
  union all
  select 'policy_relation_owner:' || x.relname from relations x cross join ids where x.relowner <> ids.owner_oid
  union all
  select 'policy_rls_disabled:' || x.relname from relations x where x.oid is not null and not x.relrowsecurity
  union all
  select distinct 'policy_relation_grant:' || x.relname
  from relations x
  where x.oid is not null and (
    exists (select 1 from pg_catalog.aclexplode(coalesce(x.relacl, pg_catalog.acldefault('r', x.relowner))) a
            where a.grantee <> x.relowner)
    or exists (select 1 from pg_catalog.pg_attribute att
               where att.attrelid = x.oid and att.attnum > 0 and not att.attisdropped and att.attacl is not null))
  union all
  select 'policy_column:' || c.relname || '.' || c.attname
  from (values
    ('product_policy_owners', 'user_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('product_policy_operations', 'operation_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('product_policy_operations', 'kind', 'pg_catalog.text'::pg_catalog.regtype),
    ('product_policy_operations', 'namespace', 'pg_catalog.text'::pg_catalog.regtype),
    ('product_policy_operations', 'environment', 'pg_catalog.text'::pg_catalog.regtype),
    ('product_policy_operations', 'owner_subject', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('product_policy_operations', 'expected_revision', 'pg_catalog.int8'::pg_catalog.regtype),
    ('product_policy_operations', 'body', 'pg_catalog.text'::pg_catalog.regtype),
    ('product_policy_operations', 'preview_hash', 'pg_catalog.text'::pg_catalog.regtype),
    ('product_policy_operations', 'created_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
    ('product_policy_operations', 'expires_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
    ('product_policy_operations', 'status', 'pg_catalog.text'::pg_catalog.regtype),
    ('product_policy_revisions', 'namespace', 'pg_catalog.text'::pg_catalog.regtype),
    ('product_policy_revisions', 'environment', 'pg_catalog.text'::pg_catalog.regtype),
    ('product_policy_revisions', 'revision', 'pg_catalog.int8'::pg_catalog.regtype),
    ('product_policy_revisions', 'body', 'pg_catalog.text'::pg_catalog.regtype),
    ('product_policy_revisions', 'operation_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('product_policy_revisions', 'published_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
    ('paid_cutoff', 'environment', 'pg_catalog.text'::pg_catalog.regtype),
    ('paid_cutoff', 'product', 'pg_catalog.text'::pg_catalog.regtype),
    ('paid_cutoff', 'benefits', 'pg_catalog._text'::pg_catalog.regtype),
    ('paid_cutoff', 'sales_revision', 'pg_catalog.int8'::pg_catalog.regtype),
    ('paid_cutoff', 'operation_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('paid_cutoff', 'activated_at', 'pg_catalog.timestamptz'::pg_catalog.regtype)
  ) c(relname, attname, typ)
  join relations x on x.relname = c.relname and x.oid is not null
  where not exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = x.oid and a.attname = c.attname and not a.attisdropped
                      and a.attnotnull and a.atttypid = c.typ::pg_catalog.oid)
  union all
  select 'policy_key:' || k.relname
  from (values
    ('product_policy_owners', array['user_id']),
    ('product_policy_operations', array['operation_id']),
    ('product_policy_revisions', array['namespace', 'environment', 'revision']),
    ('paid_cutoff', array['environment'])
  ) k(relname, cols)
  join relations x on x.relname = k.relname and x.oid is not null
  where not exists (
    select 1 from pg_catalog.pg_index i
    where i.indrelid = x.oid and i.indisprimary and i.indpred is null and i.indexprs is null
      and (select pg_catalog.array_agg(a.attname::text order by o.ord)
           from pg_catalog.unnest(i.indkey) with ordinality o(attnum, ord)
           join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = o.attnum) = k.cols)
  union all
  select 'policy_owner_no_account_cascade'
  from relations x
  where x.relname = 'product_policy_owners' and x.oid is not null
    and not exists (select 1 from pg_catalog.pg_constraint k
                    where k.conrelid = x.oid and k.contype = 'f'
                      and k.confrelid = pg_catalog.to_regclass('auth.users')::oid and k.confdeltype = 'c')
  union all
  -- (5) write-once triggers. tgtype 27 = row, before, update or delete; 34 = statement, before, truncate.
  select 'write_once_trigger:' || t.tgname
  from (values
    ('product_policy_revisions', 'product_policy_revisions_write_once', 27),
    ('product_policy_revisions', 'product_policy_revisions_no_truncate', 34),
    ('paid_cutoff', 'paid_cutoff_write_once', 27),
    ('paid_cutoff', 'paid_cutoff_no_truncate', 34)
  ) t(relname, tgname, tgtype)
  where not exists (
    select 1 from pg_catalog.pg_trigger g
    where g.tgrelid = pg_catalog.to_regclass('private.' || t.relname) and g.tgname = t.tgname
      and g.tgtype = t.tgtype and g.tgenabled = 'O' and not g.tgisinternal
      and g.tgfoid = pg_catalog.to_regprocedure('private.product_policy_refuse_change()'))
  union all
  -- (6) the eight routines.
  select 'policy_function_missing:' || s.sig from routine_state s where s.oid is null
  union all
  select 'policy_function_owner:' || s.sig from routine_state s cross join ids
  where s.oid is not null and s.proowner <> ids.owner_oid
  union all
  select 'policy_function_definer:' || s.sig from routine_state s
  where s.oid is not null and s.prosecdef is distinct from s.definer
  union all
  select 'unsafe_search_path:' || s.sig from routine_state s
  where s.oid is not null and not coalesce(s.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
  union all
  select 'policy_function_body_changed:' || s.sig from routine_state s
  where s.oid is not null and pg_catalog.md5(s.prosrc) <> s.body_md5
  union all
  select 'policy_function_grant:' || s.sig from routine_state s
  where s.oid is not null
    and s.grantees is distinct from (case when s.grantee is null then null else array[s.grantee] end)
  union all
  -- (7) the policy roles reach nothing else.
  select distinct 'policy_role_execute:' || r.rolname || ':' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join pg_catalog.pg_roles r join policy_roles x on x.rolname = r.rolname
  where n.nspname in ('public', 'private') and p.prosecdef
    and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                             'pg_catalog.event_trigger'::pg_catalog.regtype)
    and not exists (select 1 from routines e where e.oid = p.oid and e.grantee = r.rolname)
    and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
  union all
  select distinct 'policy_role_table:' || r.rolname || ':' || n.nspname || '.' || c.relname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  cross join pg_catalog.pg_roles r join policy_roles x on x.rolname = r.rolname
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or pg_catalog.has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
  union all
  -- (8) client reach to SECURITY DEFINER routines in public and private.
  select distinct 'client_execute:' || c.rolname || ':' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join (select oid, rolname from clients
              union all
              select r.oid, r.rolname::text from pg_catalog.pg_roles r where r.rolname = 'service_role') c
  where n.nspname in ('public', 'private') and p.prosecdef
    and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                             'pg_catalog.event_trigger'::pg_catalog.regtype)
    and p.oid is distinct from pg_catalog.to_regprocedure('public.write_profile_settings(jsonb,uuid)')
    and p.oid is distinct from pg_catalog.to_regprocedure('public.get_current_rule_set()')
    and (n.nspname = 'private' or c.rolname <> 'service_role')
    and pg_catalog.has_function_privilege(c.oid, p.oid, 'EXECUTE')
  union all
  -- (9) pg_temp last for every SECURITY DEFINER in public and private.
  select 'unsafe_search_path:' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
    and not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
    and not exists (select 1 from routines e where e.oid = p.oid)
  union all
  -- (10) default privileges for schema private.
  select distinct 'private_default:' || o.name || ':' || d.defaclobjtype::text
  from pg_catalog.pg_default_acl d cross join ids
  join names o on o.oid = d.defaclrole
  cross join lateral pg_catalog.aclexplode(d.defaclacl) a
  where d.defaclnamespace = ids.private_oid
    and (a.grantee in (select oid from restricted) or a.grantee in (select oid from narrow))
  union all
  -- (11) initial Off.
  select 'owner_present' from off_state where owners > 0
  union all
  select 'policy_on' from off_state where policies_on > 0
  union all
  select 'cutoff_present' from off_state where cutoffs > 0
)
select coalesce(pg_catalog.json_agg(i.issue order by i.issue collate "C"), '[]'::json)::text
from (select distinct issue from issues) i;
