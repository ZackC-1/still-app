-- Post-apply verification for 0015_settings_sync_per_field.sql.
--
-- Read-only: a single SELECT, run by the deploy runner inside a read-only session with a statement
-- timeout, before the apply (baseline) and after it (gate). It returns one row, one column: a JSON
-- array of issue codes ordered with collate "C". An empty array means the catalog is in the state
-- 0015 promises. Before the apply most codes are expected (the objects do not exist yet); nothing
-- here errors on a missing object, role or schema. No row of any table is read except the
-- migration history and the pg_cron job list; the output names catalog objects only. On the
-- production target the runner prints only counts per issue class.
--
-- Covers the 0015 end state:
--  (1) version 0015 is recorded in the migration history;
--  (2) role still_settings_writer: not superuser, no inherit/createrole/createdb/replication/
--      bypassrls; its five session settings; member of nothing; the only membership in it is the
--      automatic non-inheriting, non-SET admin grant to postgres; not reachable from a client role;
--  (3) schema private: owned by postgres; only the writer holds anything (USAGE);
--  (4) relations in private: exactly settings_anchors and settings_writes, owned by postgres, RLS
--      on, no table or column grant to anyone, both cascading from auth.users on delete, every
--      required column present with its exact type and NOT NULL, and the primary/unique keys;
--  (5) functions in private: exactly the seven, owned by postgres, search_path pg_temp-last, SECURITY
--      DEFINER exactly for lock/claim/commit/cleanup, EXECUTE only for the owner plus (lock, claim,
--      commit) the writer, bodies byte-identical to the migration;
--  (6) write_profile_settings: owner postgres, definer, pg_temp-last, EXECUTE only authenticated besides
--      the owner, body byte-identical to 0015 (the 0012 body plus the per-account guard);
--  (7) consume_rate_limit: definer, pg_temp-last, EXECUTE only still_entitlement_writer and
--      still_settings_writer besides the owner, body byte-identical to 0015 (0013 plus one bucket);
--  (8) no SECURITY DEFINER in public or private executable by a client role (closure over every
--      membership edge) except the two client RPCs, and nothing in private for service_role;
--  (9) no default privilege for schema private reaches PUBLIC, a client role, service_role or the
--      writer;
--  (10) exactly one active retention job, run as postgres, calling only the cleanup helper;
--  (11) every SECURITY DEFINER in public and private (event-trigger functions excluded, as in 0014)
--      has exactly search_path=pg_catalog, pg_temp. An empty path fails: PostgreSQL then searches the
--      caller's pg_temp first for type names. Note 0014's own check expects the empty path, so it
--      reports these functions if it is ever re-run after 0015.
-- Row-count invariance is the separate 0015_settings_sync_per_field.invariant.sql.
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
    (select oid from pg_catalog.pg_roles where rolname = 'still_settings_writer') as writer_oid,
    (select oid from pg_catalog.pg_roles where rolname = 'still_entitlement_writer') as entitlement_writer_oid,
    (select oid from pg_catalog.pg_roles where rolname = 'service_role') as service_oid,
    (select oid from pg_catalog.pg_roles where rolname = 'authenticated') as authenticated_oid,
    pg_catalog.to_regnamespace('private')::oid as private_oid
),
restricted as (
  select oid from clients
  union select service_oid from ids where service_oid is not null
  union select 0::oid
),
names as (
  select 0::oid as oid, 'PUBLIC'::text as name
  union all
  select r.oid, r.rolname::text from pg_catalog.pg_roles r
),
writer_settings(setting) as (
  values ('lock_timeout=1s'), ('statement_timeout=2s'), ('idle_in_transaction_session_timeout=5s'),
         ('log_parameter_max_length=0'), ('log_parameter_max_length_on_error=0')
),
-- Routine, whether SECURITY DEFINER, whether the writer may execute it, and the md5 of its body.
expected_routines(sig, definer, writer, body_md5) as (
  values
    ('private.settings_json_bounded(jsonb)', false, false, 'e99b02a89aa25ec9d56d6337e4811810'),
    ('private.settings_fields()', false, false, '47c187b1f877e847202bc6bfc213cbb6'),
    ('private.settings_canonical_valid(jsonb,bigint)', false, false, '0a4e8e6748473ab0506fad1727381177'),
    ('private.cleanup_settings_writes()', true, false, '6732b8b458b8e33f0489c85ebfbe50eb'),
    ('private.lock_settings(uuid,uuid,text)', true, true, '02da2d37f0a0c885d01f9314326c0fa7'),
    ('private.claim_settings_write(uuid,uuid,jsonb)', true, true, '3b307d1e3d7260efa61344a8c611ac00'),
    ('private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb)', true, true, '6ac2ddb3d69dc0b50e7714555d1c71b3')
),
routines as (
  select e.sig, e.definer, e.writer, e.body_md5, pg_catalog.to_regprocedure(e.sig)::oid as oid
  from expected_routines e
),
private_functions as (
  select p.oid, p.oid::pg_catalog.regprocedure::text as routine, p.proowner, p.prosecdef,
         p.proconfig, p.proacl, p.prosrc
  from pg_catalog.pg_proc p cross join ids
  where p.pronamespace = ids.private_oid
),
private_relations as (
  select c.oid, c.relname::text as relname, c.relkind, c.relowner, c.relrowsecurity, c.relacl
  from pg_catalog.pg_class c cross join ids
  where c.relnamespace = ids.private_oid and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
-- The two public routines 0015 replaces, with their expected grantees besides the owner.
public_routines(sig, kind, body_md5) as (
  values
    ('public.write_profile_settings(jsonb,uuid)', 'free_sync', 'a77f3d44e9cd733e57d24aedcdebddfd'),
    ('public.consume_rate_limit(text,integer,integer)', 'limiter', 'e9f68d6d07c3497e53eed3495a01200e')
),
public_state as (
  select r.kind, r.body_md5, p.oid, p.proowner, p.prosecdef, p.proconfig, p.prosrc,
    (select pg_catalog.array_agg(n.name order by n.name collate "C")
       from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       join names n on n.oid = a.grantee
      where a.grantee <> p.proowner and a.privilege_type = 'EXECUTE') as grantees
  from public_routines r
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(r.sig)
),
issues(issue) as (
  -- (1) migration recorded.
  select 'migration_missing:0015'
  where not exists (select 1 from supabase_migrations.schema_migrations m where m.version = '0015')
  union all
  -- (2) writer role.
  select 'writer_missing' from ids where writer_oid is null
  union all
  select 'writer_attributes'
  from pg_catalog.pg_roles r cross join ids
  where r.oid = ids.writer_oid
    and (r.rolsuper or r.rolinherit or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls)
  union all
  select 'writer_setting_missing:' || w.setting
  from writer_settings w cross join ids
  where ids.writer_oid is not null and not exists (
    select 1 from pg_catalog.pg_db_role_setting s
    where s.setrole = ids.writer_oid and s.setdatabase = 0 and w.setting = any (s.setconfig))
  union all
  select 'writer_member_of_role'
  from ids where exists (select 1 from pg_catalog.pg_auth_members m where m.member = ids.writer_oid)
  union all
  select 'writer_granted_to:' || n.name
  from pg_catalog.pg_auth_members m cross join ids join names n on n.oid = m.member
  where m.roleid = ids.writer_oid
    and not (m.member = ids.owner_oid and not m.inherit_option and not m.set_option)
  union all
  select 'writer_client_reachable'
  from ids where ids.writer_oid in (select oid from clients)
  union all
  -- (3) schema private.
  select 'private_schema_missing' from ids where private_oid is null
  union all
  select 'private_schema_owner'
  from pg_catalog.pg_namespace n cross join ids
  where n.oid = ids.private_oid and n.nspowner <> ids.owner_oid
  union all
  select 'private_schema_grant:' || g.name || ':' || a.privilege_type
  from pg_catalog.pg_namespace n cross join ids
  cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
  join names g on g.oid = a.grantee
  where n.oid = ids.private_oid and a.grantee <> n.nspowner
    and not (a.grantee = ids.writer_oid and a.privilege_type = 'USAGE')
  union all
  select 'writer_private_usage_missing'
  from ids where ids.private_oid is not null and ids.writer_oid is not null
    and not pg_catalog.has_schema_privilege(ids.writer_oid, ids.private_oid, 'USAGE')
  union all
  -- (4) relations in private.
  select 'private_relation_missing:' || x.relname
  from (values ('settings_anchors'), ('settings_writes')) x(relname)
  where not exists (select 1 from private_relations r where r.relname = x.relname and r.relkind = 'r')
  union all
  select 'private_relation_unexpected:' || r.relname
  from private_relations r
  where r.relname not in ('settings_anchors', 'settings_writes') or r.relkind <> 'r'
  union all
  select 'private_relation_owner:' || r.relname
  from private_relations r cross join ids where r.relowner <> ids.owner_oid
  union all
  select 'private_rls_disabled:' || r.relname from private_relations r where not r.relrowsecurity
  union all
  select distinct 'private_relation_grant:' || r.relname
  from private_relations r
  where exists (select 1 from pg_catalog.aclexplode(coalesce(r.relacl, pg_catalog.acldefault('r', r.relowner))) a
                where a.grantee <> r.relowner)
     or exists (select 1 from pg_catalog.pg_attribute att
                where att.attrelid = r.oid and att.attnum > 0 and not att.attisdropped
                  and att.attacl is not null)
  union all
  select 'private_relation_no_account_cascade:' || r.relname
  from private_relations r
  where not exists (select 1 from pg_catalog.pg_constraint k
                    where k.conrelid = r.oid and k.contype = 'f'
                      and k.confrelid = pg_catalog.to_regclass('auth.users')::oid and k.confdeltype = 'c')
  union all
  select 'private_column:' || x.relname || '.' || x.attname
  from (values
    ('settings_anchors', 'user_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('settings_anchors', 'lineage', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('settings_anchors', 'secret', 'pg_catalog.bytea'::pg_catalog.regtype),
    ('settings_anchors', 'modern_used', 'pg_catalog.bool'::pg_catalog.regtype),
    ('settings_writes', 'user_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('settings_writes', 'write_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('settings_writes', 'body', 'pg_catalog.jsonb'::pg_catalog.regtype),
    ('settings_writes', 'created_at', 'pg_catalog.timestamptz'::pg_catalog.regtype)
  ) x(relname, attname, typ)
  join private_relations r on r.relname = x.relname
  where not exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = r.oid and a.attname = x.attname and not a.attisdropped
                      and a.attnotnull and a.atttypid = x.typ::pg_catalog.oid)
  union all
  select 'private_key:' || x.relname || '.' || x.kind || ':' || pg_catalog.array_to_string(x.cols, ',')
  from (values
    ('settings_anchors', 'primary', array['user_id']),
    ('settings_anchors', 'unique', array['lineage']),
    ('settings_writes', 'primary', array['user_id', 'write_id'])
  ) x(relname, kind, cols)
  join private_relations r on r.relname = x.relname
  where not exists (
    select 1 from pg_catalog.pg_index i
    where i.indrelid = r.oid and i.indisunique and (x.kind = 'unique' or i.indisprimary)
      and i.indpred is null and i.indexprs is null
      and (select pg_catalog.array_agg(a.attname::text order by k.ord)
           from pg_catalog.unnest(i.indkey) with ordinality k(attnum, ord)
           join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = x.cols)
  union all
  -- (5) functions in private.
  select 'private_function_missing:' || r.sig from routines r where r.oid is null
  union all
  select 'private_function_unexpected:' || f.routine
  from private_functions f where f.oid not in (select oid from routines where oid is not null)
  union all
  select 'private_function_owner:' || f.routine
  from private_functions f cross join ids where f.proowner <> ids.owner_oid
  union all
  select 'unsafe_search_path:' || f.routine
  from private_functions f
  where not coalesce(f.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
  union all
  select 'private_function_definer:' || f.routine
  from private_functions f join routines r on r.oid = f.oid
  where f.prosecdef is distinct from r.definer
  union all
  select 'private_function_body_changed:' || f.routine
  from private_functions f join routines r on r.oid = f.oid
  where pg_catalog.md5(f.prosrc) <> r.body_md5
  union all
  select 'private_function_grant:' || g.name || ':' || f.routine
  from private_functions f cross join ids
  left join routines r on r.oid = f.oid
  cross join lateral pg_catalog.aclexplode(coalesce(f.proacl, pg_catalog.acldefault('f', f.proowner))) a
  join names g on g.oid = a.grantee
  where a.grantee <> f.proowner
    and not (a.grantee = ids.writer_oid and coalesce(r.writer, false))
  union all
  select 'writer_execute_missing:' || r.sig
  from routines r cross join ids
  where r.writer and r.oid is not null and ids.writer_oid is not null
    and not pg_catalog.has_function_privilege(ids.writer_oid, r.oid, 'EXECUTE')
  union all
  -- (6)-(7) the two public routines 0015 replaces.
  select s.kind || '_missing' from public_state s where s.oid is null
  union all
  select s.kind || '_definition'
  from public_state s cross join ids
  where s.oid is not null
    and (s.proowner <> ids.owner_oid or not s.prosecdef
         or not coalesce(s.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false))
  union all
  select s.kind || '_body_changed'
  from public_state s where s.oid is not null and pg_catalog.md5(s.prosrc) <> s.body_md5
  union all
  select s.kind || '_grantees'
  from public_state s
  where s.oid is not null
    and s.grantees is distinct from (case s.kind
      when 'free_sync' then array['authenticated']
      else array['still_entitlement_writer', 'still_settings_writer'] end)
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
  -- (9) default privileges for schema private.
  select distinct 'private_default:' || o.name || ':' || d.defaclobjtype::text
  from pg_catalog.pg_default_acl d cross join ids
  join names o on o.oid = d.defaclrole
  cross join lateral pg_catalog.aclexplode(d.defaclacl) a
  where d.defaclnamespace = ids.private_oid
    and (a.grantee in (select oid from restricted) or a.grantee = ids.writer_oid)
  union all
  -- (11) pg_temp last for every SECURITY DEFINER in public and private.
  select 'unsafe_search_path:' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
    and not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
  union all
  -- (10) retention job.
  select 'retention_job'
  where (select pg_catalog.count(*) from cron.job j
         where j.jobname = 'still-settings-write-retention' and j.username = 'postgres' and j.active
           and j.schedule = '* * * * *'
           and j.command = 'set statement_timeout = ''5s''; select private.cleanup_settings_writes();') <> 1
)
select coalesce(pg_catalog.json_agg(i.issue order by i.issue collate "C"), '[]'::json)::text
from (select distinct issue from issues) i;
