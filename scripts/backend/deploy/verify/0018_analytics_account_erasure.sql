-- Post-apply verification for 0018_analytics_account_erasure.sql.
--
-- Read-only: a single SELECT, run by the deploy runner inside a read-only session with a statement
-- timeout, before the apply (baseline) and after it (gate). It returns one row, one column: a JSON
-- array of issue codes ordered with collate "C". An empty array means the catalog is in the state
-- 0018 promises. Before the apply some codes are expected (the objects do not exist yet); nothing
-- here errors on a missing object or role. The only row read is the migration history; the output
-- names catalog objects and fixed codes only.
--
-- Covers the 0018 end state:
--  (1) version 0018 is recorded in the migration history;
--  (2) the widened checks: exactly one check on analytics_subjects.retired_reason, accepting
--      device_erasure, account_erasure and account_deleted, and exactly one on
--      analytics_erasure_jobs.scope, accepting device, account and account_deleted; the btree index
--      on the erasure targets' ids;
--  (3) 0017's account-deletion snapshot, unchanged: the trigger present, ALWAYS enabled,
--      unconditional, after delete for each row, calling 0017's function, whose body md5 is still
--      0017's pin (re-pinned here, so a later change to the safety net is reported by this check
--      too);
--  (4) the two 0018 routes, 0017's six routes, 0017's snapshot function and the limiter: owned by
--      postgres, search_path pg_temp-last, SECURITY DEFINER, EXECUTE for the owner plus exactly the
--      eraser on each route (nobody on the snapshot function; the three server roles on the
--      limiter), bodies byte-identical to their migrations (analytics_begin_device_erasure to
--      0018's replacement, which locks a device's subjects in subject_id order);
--  (4b) the eraser role, as 0017 left it: not superuser, no inherit/createrole/createdb/replication/
--      bypassrls; its five session settings (lock_timeout 1s, statement_timeout 2s, the idle
--      limit, and both log_parameter_max_length settings at 0); member of nothing; the only
--      membership in it is the automatic non-inheriting, non-SET admin grant to postgres; not
--      reachable from a client role;
--  (5) the eraser reaches no other SECURITY DEFINER routine and no table in public or private;
--  (6) no SECURITY DEFINER in public or private executable by a client role (closure over every
--      membership edge) except the two client RPCs, and nothing in private for service_role;
--  (7) every SECURITY DEFINER in public and private has exactly search_path=pg_catalog, pg_temp;
--  (8) no default privilege for schema private reaches PUBLIC, a client role, service_role or a
--      narrow role.
-- Note 0017's check enumerates exactly what the eraser may execute, so it reports the two new routes
-- if re-run after 0018; deploy and verify 0017 alone first.
-- Row-count invariance is the separate 0018_analytics_account_erasure.invariant.sql.
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
    (select oid from pg_catalog.pg_roles where rolname = 'service_role') as service_oid,
    pg_catalog.to_regnamespace('private')::oid as private_oid
),
names as (
  select 0::oid as oid, 'PUBLIC'::text as name
  union all
  select r.oid, r.rolname::text from pg_catalog.pg_roles r
),
narrow as (
  select r.oid from pg_catalog.pg_roles r
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
-- Routine, whether SECURITY DEFINER, its grantees besides the owner, and the md5 of its body.
expected_routines(sig, definer, grantees, body_md5) as (
  values
    ('private.analytics_begin_account_erasure(uuid,text)', true, array['still_analytics_eraser'], '6005d5e1952bc90c90c42c091940d0c7'),
    ('private.analytics_account_erasure_status(uuid)', true, array['still_analytics_eraser'], 'd8691762a87a9304da554b9eb3642d1f'),
    ('private.analytics_snapshot_deleted_subject()', true, null::text[], '5bbbec70399c1ac78f1eb39255c418c2'),
    ('private.analytics_issue_subject(uuid,bytea)', true, array['still_analytics_eraser'], 'fb43fd91c51d5cf0af0e91f010d85cbb'),
    ('private.analytics_subject_active(uuid)', true, array['still_analytics_eraser'], '2c8ec961a28dca52ed1fac79154ed5d3'),
    ('private.analytics_begin_device_erasure(bytea,integer)', true, array['still_analytics_eraser'], '516501768aab4393e1a3f45fa21682a0'),
    ('private.analytics_erasure_status(bytea)', true, array['still_analytics_eraser'], '326f30ea0193051673fedd681e647299'),
    ('private.analytics_claim_erasure_work(integer,integer)', true, array['still_analytics_eraser'], '962379ffd2faf7024f13b883ef2e9b1d'),
    ('private.analytics_record_erasure_outcome(uuid,uuid,text)', true, array['still_analytics_eraser'], '56e8c9ef75f290c5d2b3dbc234a11824'),
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
-- Single-column checks on the two widened columns.
column_checks as (
  select x.code, x.want,
    (select pg_catalog.array_agg(pg_catalog.pg_get_constraintdef(k.oid) order by pg_catalog.pg_get_constraintdef(k.oid) collate "C")
       from pg_catalog.pg_constraint k
       join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attname = x.attname
      where k.conrelid = pg_catalog.to_regclass(x.rel) and k.contype = 'c' and k.conkey = array[a.attnum]) as defs
  from (values
    ('subject_retired_reason_check', 'private.analytics_subjects', 'retired_reason',
     'CHECK ((retired_reason = ANY (ARRAY[''device_erasure''::text, ''account_erasure''::text, ''account_deleted''::text])))'),
    ('erasure_scope_check', 'private.analytics_erasure_jobs', 'scope',
     'CHECK ((scope = ANY (ARRAY[''device''::text, ''account''::text, ''account_deleted''::text])))')
  ) x(code, rel, attname, want)
),
issues(issue) as (
  -- (1) migration recorded.
  select 'migration_missing:0018'
  where not exists (select 1 from supabase_migrations.schema_migrations m where m.version = '0018')
  union all
  -- (2) the widened checks and the target index.
  select c.code from column_checks c where c.defs is distinct from array[c.want]
  union all
  select 'erasure_target_index'
  where not exists (
    select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_am am on am.oid = c.relam
    where i.indexrelid = pg_catalog.to_regclass('private.analytics_erasure_targets_distinct')
      and i.indrelid = pg_catalog.to_regclass('private.analytics_erasure_targets')
      and i.indisvalid and i.indisready and am.amname = 'btree' and i.indpred is null and i.indexprs is null
      and (select pg_catalog.array_agg(a.attname::text order by k.ord)
           from pg_catalog.unnest(i.indkey) with ordinality k(attnum, ord)
           join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
          = array['distinct_id'])
  union all
  -- (3) 0017's snapshot trigger (its function's body is pinned in (4)).
  select 'subject_snapshot_trigger'
  where not exists (select 1 from pg_catalog.pg_trigger g
                    where g.tgrelid = pg_catalog.to_regclass('private.analytics_subjects')
                      and g.tgname = 'analytics_subjects_snapshot' and g.tgtype = 9
                      and g.tgenabled = 'A' and not g.tgisinternal and g.tgqual is null
                      and g.tgattr = ''::pg_catalog.int2vector
                      and g.tgfoid = pg_catalog.to_regprocedure('private.analytics_snapshot_deleted_subject()'))
  union all
  -- (4) the routines.
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
  -- (4b) the eraser role.
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
  -- (5) the eraser reaches nothing else.
  select distinct 'eraser_execute:' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join eraser e
  where n.nspname in ('public', 'private') and p.prosecdef
    and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                             'pg_catalog.event_trigger'::pg_catalog.regtype)
    and p.oid not in (select oid from routines where oid is not null)
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
  -- (6) client reach to SECURITY DEFINER routines in public and private.
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
  -- (7) pg_temp last for every SECURITY DEFINER in public and private.
  select 'unsafe_search_path:' || p.oid::pg_catalog.regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
    and not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
    and not exists (select 1 from routines e where e.oid = p.oid)
  union all
  -- (8) default privileges for schema private.
  select distinct 'private_default:' || o.name || ':' || d.defaclobjtype::text
  from pg_catalog.pg_default_acl d cross join ids
  join names o on o.oid = d.defaclrole
  cross join lateral pg_catalog.aclexplode(d.defaclacl) a
  where d.defaclnamespace = ids.private_oid
    and (a.grantee in (select oid from restricted) or a.grantee in (select oid from narrow))
)
select coalesce(pg_catalog.json_agg(i.issue order by i.issue collate "C"), '[]'::json)::text
from (select distinct issue from issues) i;
