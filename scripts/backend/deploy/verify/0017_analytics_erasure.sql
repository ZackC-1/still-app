-- Post-apply verification for 0017_analytics_erasure.sql.
--
-- Read-only: a single SELECT, run by the deploy runner inside a read-only session with a statement
-- timeout, before the apply (baseline) and after it (gate). It returns one row, one column: a JSON
-- array of issue codes ordered with collate "C". An empty array means the catalog is in the state
-- 0017 promises and no erasure state exists yet. Before the apply most codes are expected (the
-- objects do not exist yet); nothing here errors on a missing object, role or table. The only rows
-- read are the migration history and counts of the three erasure tables (random ids and hashes only,
-- never printed); the output names catalog objects and fixed codes only. On the production target
-- the runner prints only counts per issue class.
--
-- Covers the 0017 end state:
--  (1) version 0017 is recorded in the migration history;
--  (2) role still_analytics_eraser: not superuser, no inherit/createrole/createdb/replication/
--      bypassrls; its five session settings; member of nothing; the only membership in it is the
--      automatic non-inheriting, non-SET admin grant to postgres; not reachable from a client role;
--  (3) schema private: only the four narrow roles hold anything (USAGE); the eraser has USAGE on
--      private and public and no CREATE on public;
--  (4) the three erasure tables: owned by postgres, RLS on, no table or column grant to anyone,
--      every column the routes use with its exact type and NOT NULL, the primary keys, one subject
--      per (account, device, epoch) for all time, at most one open job per device, subjects
--      cascading from auth.users, jobs referencing nothing, targets cascading from their job;
--  (4b) the account-deletion snapshot trigger on analytics_subjects: present, ALWAYS enabled,
--      unconditional, after delete for each row;
--  (5) the nine 0017 routines and the retained limiter: owned by postgres, search_path
--      pg_temp-last, SECURITY DEFINER exactly for the six routes, the snapshot trigger function and
--      the limiter, EXECUTE only for the owner plus the eraser on each route (nobody on the two
--      helpers or the trigger function; the three server roles on the limiter), bodies
--      byte-identical to the migration;
--  (6) the eraser reaches no other SECURITY DEFINER routine and no table in public or private;
--  (7) no SECURITY DEFINER in public or private executable by a client role (closure over every
--      membership edge) except the two client RPCs, and nothing in private for service_role;
--  (8) every SECURITY DEFINER in public and private has exactly search_path=pg_catalog, pg_temp;
--  (9) no default privilege for schema private reaches PUBLIC, a client role, service_role or a
--      narrow role;
--  (10) initially empty: no subject, job or target (read through query_to_xml so the query also
--      parses before the tables exist). After the functions are live, re-running this check reports
--      subjects_present or jobs_present; that is expected then and not a regression.
-- Note 0016's check enumerates schema private's grants exactly and 0015's pins the limiter body, so
-- both report 0017's changes if re-run after it; deploy and verify 0016 alone first.
-- Row-count invariance is the separate 0017_analytics_erasure.invariant.sql.
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
    (select oid from pg_catalog.pg_roles where rolname = 'still_analytics_eraser') as eraser_oid,
    (select oid from pg_catalog.pg_roles where rolname = 'service_role') as service_oid,
    pg_catalog.to_regnamespace('private')::oid as private_oid,
    pg_catalog.to_regnamespace('public')::oid as public_oid
),
names as (
  select 0::oid as oid, 'PUBLIC'::text as name
  union all
  select r.oid, r.rolname::text from pg_catalog.pg_roles r
),
narrow as (
  select r.oid, r.rolname::text as rolname from pg_catalog.pg_roles r
  where r.rolname in ('still_settings_writer', 'still_policy_reader', 'still_policy_admin', 'still_analytics_eraser')
),
restricted as (
  select oid from clients
  union select service_oid from ids where service_oid is not null
  union select 0::oid
),
eraser as (
  select r.oid, r.rolname::text as rolname from pg_catalog.pg_roles r where r.rolname = 'still_analytics_eraser'
),
role_settings(setting) as (
  values ('lock_timeout=1s'), ('statement_timeout=2s'), ('idle_in_transaction_session_timeout=5s'),
         ('log_parameter_max_length=0'), ('log_parameter_max_length_on_error=0')
),
erasure_tables(relname) as (
  values ('analytics_subjects'), ('analytics_erasure_jobs'), ('analytics_erasure_targets')
),
relations as (
  select t.relname, c.oid, c.relkind, c.relowner, c.relrowsecurity, c.relacl
  from erasure_tables t
  left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass('private.' || t.relname)
),
-- Routine, whether SECURITY DEFINER, its grantees besides the owner, and the md5 of its body.
expected_routines(sig, definer, grantees, body_md5) as (
  values
    ('private.analytics_anonymous_ids(bytea,integer)', false, null::text[], '802d9ff62ba093a50ca0daaaf3d79d87'),
    ('private.analytics_snapshot_deleted_subject()', true, null::text[], '6f22d7e7bdefbd04143dad6149b7b8e6'),
    ('private.analytics_origin_key(bytea)', false, null::text[], 'ac796e926ecfc284200f0cf1938a5590'),
    ('private.analytics_issue_subject(uuid,bytea)', true, array['still_analytics_eraser'], '582be9980419fba06e58ec2be9b1f78f'),
    ('private.analytics_subject_active(uuid)', true, array['still_analytics_eraser'], '2c8ec961a28dca52ed1fac79154ed5d3'),
    ('private.analytics_begin_device_erasure(bytea,integer)', true, array['still_analytics_eraser'], '55d057d77baf7f6541ea43ff1eabfbbb'),
    ('private.analytics_erasure_status(bytea)', true, array['still_analytics_eraser'], '326f30ea0193051673fedd681e647299'),
    ('private.analytics_claim_erasure_work(integer,integer)', true, array['still_analytics_eraser'], '783661928f3fffb56a03a8e621f1f2e1'),
    ('private.analytics_record_erasure_outcome(uuid,uuid,text)', true, array['still_analytics_eraser'], 'df1bcbcf879ce239064a0be1b5c028b0'),
    ('public.consume_rate_limit(text,integer,integer)', true,
     array['still_analytics_eraser', 'still_entitlement_writer', 'still_settings_writer'], '45da64e1167f825c831bbdf05b7b09be')
),
routines as (
  select e.sig, e.definer, e.grantees, e.body_md5, pg_catalog.to_regprocedure(e.sig)::oid as oid
  from expected_routines e
),
routine_state as (
  select r.sig, r.definer, r.grantees as expected_grantees, r.body_md5, p.oid, p.proowner, p.prosecdef,
    p.proconfig, p.prosrc,
    (select pg_catalog.array_agg(n.name order by n.name collate "C")
       from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       join names n on n.oid = a.grantee
      where a.grantee <> p.proowner) as grantees
  from routines r
  left join pg_catalog.pg_proc p on p.oid = r.oid
),
-- The eraser's own routes (the limiter included): anything else it can execute is an issue.
eraser_routes as (
  select r.oid from routines r where r.definer
),
index_columns as (
  select i.indexrelid, i.indrelid, i.indisunique, i.indisprimary, i.indpred, i.indexprs,
    (select pg_catalog.array_agg(a.attname::text order by o.ord)
     from pg_catalog.unnest(i.indkey) with ordinality o(attnum, ord)
     join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = o.attnum) as cols
  from pg_catalog.pg_index i
  where i.indrelid in (select oid from relations where oid is not null)
),
empty_state as (
  select
    case when pg_catalog.to_regclass('private.analytics_subjects') is not null then
      (pg_catalog.xpath('/row/n/text()', pg_catalog.query_to_xml(
        'select pg_catalog.count(*) as n from private.analytics_subjects', false, true, '')))[1]::text::int
    end as subjects,
    case when pg_catalog.to_regclass('private.analytics_erasure_jobs') is not null then
      (pg_catalog.xpath('/row/n/text()', pg_catalog.query_to_xml(
        'select pg_catalog.count(*) as n from private.analytics_erasure_jobs', false, true, '')))[1]::text::int
    end as jobs
),
issues(issue) as (
  -- (1) migration recorded.
  select 'migration_missing:0017'
  where not exists (select 1 from supabase_migrations.schema_migrations m where m.version = '0017')
  union all
  -- (2) the role.
  select 'role_missing:still_analytics_eraser' where not exists (select 1 from eraser)
  union all
  select 'role_attributes:' || r.rolname
  from pg_catalog.pg_roles r join eraser e on e.oid = r.oid
  where r.rolsuper or r.rolinherit or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls
  union all
  select 'role_setting_missing:' || e.rolname || ':' || s.setting
  from eraser e cross join role_settings s
  where not exists (select 1 from pg_catalog.pg_db_role_setting d
                    where d.setrole = e.oid and d.setdatabase = 0 and s.setting = any (d.setconfig))
  union all
  select distinct 'role_member_of_role:' || e.rolname
  from eraser e join pg_catalog.pg_auth_members m on m.member = e.oid
  union all
  select distinct 'role_granted_to_other:' || e.rolname
  from eraser e join pg_catalog.pg_auth_members m on m.roleid = e.oid cross join ids
  where not (m.member = ids.owner_oid and not m.inherit_option and not m.set_option)
  union all
  select 'role_client_reachable:' || c.rolname
  from clients c join eraser e on e.oid = c.oid
  union all
  -- (3) schemas.
  select 'private_schema_grant:' || g.name || ':' || a.privilege_type
  from pg_catalog.pg_namespace n cross join ids
  cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
  join names g on g.oid = a.grantee
  where n.oid = ids.private_oid and a.grantee <> n.nspowner
    and not (a.grantee in (select oid from narrow) and a.privilege_type = 'USAGE')
  union all
  select 'private_usage_missing:' || e.rolname
  from eraser e cross join ids
  where ids.private_oid is not null and not pg_catalog.has_schema_privilege(e.oid, ids.private_oid, 'USAGE')
  union all
  select 'public_schema_access:' || e.rolname
  from eraser e cross join ids
  where not pg_catalog.has_schema_privilege(e.oid, ids.public_oid, 'USAGE')
     or pg_catalog.has_schema_privilege(e.oid, ids.public_oid, 'CREATE')
  union all
  -- (4) the three tables.
  select 'erasure_relation_missing:' || x.relname from relations x where x.oid is null or x.relkind <> 'r'
  union all
  select 'erasure_relation_owner:' || x.relname from relations x cross join ids where x.relowner <> ids.owner_oid
  union all
  select 'erasure_rls_disabled:' || x.relname from relations x where x.oid is not null and not x.relrowsecurity
  union all
  select distinct 'erasure_relation_grant:' || x.relname
  from relations x
  where x.oid is not null and (
    exists (select 1 from pg_catalog.aclexplode(coalesce(x.relacl, pg_catalog.acldefault('r', x.relowner))) a
            where a.grantee <> x.relowner)
    or exists (select 1 from pg_catalog.pg_attribute att
               where att.attrelid = x.oid and att.attnum > 0 and not att.attisdropped and att.attacl is not null))
  union all
  select 'erasure_column:' || c.relname || '.' || c.attname
  from (values
    ('analytics_subjects', 'subject_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('analytics_subjects', 'user_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('analytics_subjects', 'origin_key', 'pg_catalog.bytea'::pg_catalog.regtype),
    ('analytics_subjects', 'epoch', 'pg_catalog.int4'::pg_catalog.regtype),
    ('analytics_subjects', 'created_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
    ('analytics_subjects', 'last_activity_month', 'pg_catalog.date'::pg_catalog.regtype),
    ('analytics_erasure_jobs', 'job_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('analytics_erasure_jobs', 'scope', 'pg_catalog.text'::pg_catalog.regtype),
    ('analytics_erasure_jobs', 'scope_key', 'pg_catalog.bytea'::pg_catalog.regtype),
    ('analytics_erasure_jobs', 'stage', 'pg_catalog.text'::pg_catalog.regtype),
    ('analytics_erasure_jobs', 'sweeps', 'pg_catalog.int4'::pg_catalog.regtype),
    ('analytics_erasure_jobs', 'attempts', 'pg_catalog.int4'::pg_catalog.regtype),
    ('analytics_erasure_jobs', 'next_attempt_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
    ('analytics_erasure_jobs', 'created_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
    ('analytics_erasure_targets', 'job_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('analytics_erasure_targets', 'distinct_id', 'pg_catalog.uuid'::pg_catalog.regtype),
    ('analytics_erasure_targets', 'kind', 'pg_catalog.text'::pg_catalog.regtype)
  ) c(relname, attname, typ)
  join relations x on x.relname = c.relname and x.oid is not null
  where not exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = x.oid and a.attname = c.attname and not a.attisdropped
                      and a.attnotnull and a.atttypid = c.typ::pg_catalog.oid)
  union all
  select 'erasure_key:' || k.relname
  from (values
    ('analytics_subjects', array['subject_id']),
    ('analytics_erasure_jobs', array['job_id']),
    ('analytics_erasure_targets', array['job_id', 'distinct_id'])
  ) k(relname, cols)
  join relations x on x.relname = k.relname and x.oid is not null
  where not exists (select 1 from index_columns i
                    where i.indrelid = x.oid and i.indisprimary and i.indpred is null
                      and i.indexprs is null and i.cols = k.cols)
  union all
  select 'subject_reissue_guard'
  from relations x
  where x.relname = 'analytics_subjects' and x.oid is not null
    and not exists (select 1 from index_columns i
                    where i.indrelid = x.oid and i.indisunique and i.indpred is null and i.indexprs is null
                      and i.cols = array['user_id', 'origin_key', 'epoch'])
  union all
  select 'erasure_job_open_guard'
  from relations x
  where x.relname = 'analytics_erasure_jobs' and x.oid is not null
    and not exists (select 1 from index_columns i
                    where i.indrelid = x.oid and i.indisunique and i.indexprs is null
                      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) = '(completed_at IS NULL)'
                      and i.cols = array['scope', 'scope_key'])
  union all
  select 'subject_no_account_cascade'
  from relations x
  where x.relname = 'analytics_subjects' and x.oid is not null
    and not exists (select 1 from pg_catalog.pg_constraint k
                    where k.conrelid = x.oid and k.contype = 'f'
                      and k.confrelid = pg_catalog.to_regclass('auth.users')::oid and k.confdeltype = 'c')
  union all
  select 'erasure_job_references'
  from relations x
  where x.relname = 'analytics_erasure_jobs' and x.oid is not null
    and exists (select 1 from pg_catalog.pg_constraint k where k.conrelid = x.oid and k.contype = 'f')
  union all
  select 'erasure_target_job_link'
  from relations x
  where x.relname = 'analytics_erasure_targets' and x.oid is not null
    and not exists (select 1 from pg_catalog.pg_constraint k
                    where k.conrelid = x.oid and k.contype = 'f'
                      and k.confrelid = pg_catalog.to_regclass('private.analytics_erasure_jobs')::oid
                      and k.confdeltype = 'c' and k.convalidated)
  union all
  -- (4b) the account-deletion snapshot trigger: ALWAYS enabled, unconditional, row level after
  -- delete (tgtype 9), calling the snapshot function.
  select 'subject_snapshot_trigger'
  from relations x
  where x.relname = 'analytics_subjects' and x.oid is not null
    and not exists (select 1 from pg_catalog.pg_trigger g
                    where g.tgrelid = x.oid and g.tgname = 'analytics_subjects_snapshot' and g.tgtype = 9
                      and g.tgenabled = 'A' and not g.tgisinternal and g.tgqual is null
                      and g.tgattr = ''::pg_catalog.int2vector
                      and g.tgfoid = pg_catalog.to_regprocedure('private.analytics_snapshot_deleted_subject()'))
  union all
  -- (5) the routines and the limiter.
  select 'erasure_function_missing:' || s.sig from routine_state s where s.oid is null
  union all
  select 'erasure_function_owner:' || s.sig from routine_state s cross join ids
  where s.oid is not null and s.proowner <> ids.owner_oid
  union all
  select 'erasure_function_definer:' || s.sig from routine_state s
  where s.oid is not null and s.prosecdef is distinct from s.definer
  union all
  select 'unsafe_search_path:' || s.sig from routine_state s
  where s.oid is not null and not coalesce(s.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
  union all
  select 'erasure_function_body_changed:' || s.sig from routine_state s
  where s.oid is not null and pg_catalog.md5(s.prosrc) <> s.body_md5
  union all
  select 'erasure_function_grant:' || s.sig from routine_state s
  where s.oid is not null and s.grantees is distinct from s.expected_grantees
  union all
  -- (6) the eraser reaches nothing else.
  select distinct 'eraser_execute:' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join eraser e
  where n.nspname in ('public', 'private') and p.prosecdef
    and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                             'pg_catalog.event_trigger'::pg_catalog.regtype)
    and p.oid not in (select oid from eraser_routes where oid is not null)
    and pg_catalog.has_function_privilege(e.oid, p.oid, 'EXECUTE')
  union all
  select distinct 'eraser_table:' || n.nspname || '.' || c.relname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  cross join eraser e
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (pg_catalog.has_table_privilege(e.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or pg_catalog.has_any_column_privilege(e.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
  union all
  -- (7) client reach to SECURITY DEFINER routines in public and private.
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
  -- (8) pg_temp last for every SECURITY DEFINER in public and private.
  select 'unsafe_search_path:' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
    and not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
    and not exists (select 1 from routines e where e.oid = p.oid)
  union all
  -- (9) default privileges for schema private.
  select distinct 'private_default:' || o.name || ':' || d.defaclobjtype::text
  from pg_catalog.pg_default_acl d cross join ids
  join names o on o.oid = d.defaclrole
  cross join lateral pg_catalog.aclexplode(d.defaclacl) a
  where d.defaclnamespace = ids.private_oid
    and (a.grantee in (select oid from restricted) or a.grantee in (select oid from narrow))
  union all
  -- (10) initially empty.
  select 'subjects_present' from empty_state where subjects > 0
  union all
  select 'jobs_present' from empty_state where jobs > 0
)
select coalesce(pg_catalog.json_agg(i.issue order by i.issue collate "C"), '[]'::json)::text
from (select distinct issue from issues) i;
