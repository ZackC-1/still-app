-- Account-level analytics erasure (U5-W3, packet A). Dormant: no client reaches these routes, and
-- nothing here calls PostHog.
--
-- What this adds. One route the delete-user function calls BEFORE it asks GoTrue to delete the
-- account, so the account's per-device analytics identities ("subjects", 0017) are recorded for
-- deletion first, in one transaction:
--   private.analytics_begin_account_erasure(account, reason)
--       retires every active subject of the account and opens one erasure job per subject, each
--       keyed by 32 random bytes with that subject as its only target. No erasure row can be matched
--       back to the account, and one account's subjects share no key (exactly the shape of 0017's
--       account-deletion snapshot). `account_deleted` is the delete-user pre-step; `account_erasure`
--       is the later account-wide "delete what we shared" action (packet B, dormant until then).
--       Called again it captures nothing new. For `account_deleted` an account that is already gone
--       answers "gone" (a retry after a lost reply: 0017's snapshot captured everything then).
--   private.analytics_account_erasure_status(account)
--       the least advanced stage among the account-wide jobs (packet B). It is found through the
--       account's subjects, so it stops resolving once the account is deleted, which is the intent.
-- It also widens two checks so those values are accepted: a subject's retired reason gains
-- `account_erasure` and `account_deleted`, and a job's scope gains `account`. Both only widen, so
-- every existing row stays valid. And it adds one index, on the erasure targets' ids, for the
-- status route.
--
-- 0017's account-deletion snapshot trigger is NOT changed. It stays the atomic backstop for a
-- subject issued between this pre-step and the delete, and for a deletion that does not come
-- through delete-user. A subject this pre-step already retired is snapshotted a second time when the
-- cascade removes it; that duplicate job is deliberate (PostHog deletion is idempotent, account
-- deletions are rare, and deduplicating would make the backstop depend on an invariant later
-- retention work will break).
--
-- Locks. The pre-step takes the per-account advisory lock 0017's issue_subject takes before it mints
-- a new device (so no new subject appears while the account's subjects are captured), then KEY
-- SHARE on the account row, then the account's active subjects FOR UPDATE in subject_id order, so
-- two concurrent calls cannot deadlock. It never takes a device (origin) lock, so it cannot form a
-- cycle with device erasure, which contends with it on single subject rows only.
--
-- Deploy order. 0017 must be deployed and verified on its own before 0018. 0017's post-apply check
-- enumerates exactly what the eraser may execute, so re-running it after 0018 reports the two new
-- routes; that is expected and not a regression. Section 4 revokes on every function in schema
-- private, so the deploy planner's `verification-overlap` rule refuses any plan listing 0015, 0016
-- or 0017 together with 0018.
--
-- Authority and idempotence. Applied by the hosted migration role `postgres` (non-superuser) and
-- nothing else. Every statement is guarded or replace-in-place, so applying the file twice leaves the
-- catalog as it was. No existing row is read, rewritten or deleted.

-- ── 0. Preconditions: fail before any DDL ─────────────────────────────────────────────────────
do $$
begin
  if current_user <> 'postgres'
     or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'analytics account erasure migration role precondition' using errcode = '42501';
  end if;
  if pg_catalog.current_setting('server_version_num')::int < 160000 then
    raise exception 'analytics account erasure server version precondition' using errcode = '0A000';
  end if;
  if pg_catalog.to_regrole('still_analytics_eraser') is null
     or pg_catalog.to_regclass('private.analytics_subjects') is null
     or pg_catalog.to_regclass('private.analytics_erasure_jobs') is null
     or pg_catalog.to_regclass('private.analytics_erasure_targets') is null
     or pg_catalog.to_regprocedure('private.analytics_snapshot_deleted_subject()') is null
     or pg_catalog.to_regprocedure('private.analytics_issue_subject(uuid,bytea)') is null
     or not exists (select 1 from pg_catalog.pg_trigger t
                    where t.tgrelid = pg_catalog.to_regclass('private.analytics_subjects')
                      and t.tgname = 'analytics_subjects_snapshot') then
    raise exception 'analytics account erasure requires 0017' using errcode = '55000';
  end if;
end
$$;

-- ── 1. Widen two checks (located by what they constrain, never by an assumed name) ─────────────
do $$
declare
  c record;
  reason_check constant text := 'CHECK ((retired_reason = ANY (ARRAY[''device_erasure''::text, ''account_erasure''::text, ''account_deleted''::text])))';
  scope_check constant text := 'CHECK ((scope = ANY (ARRAY[''device''::text, ''account''::text, ''account_deleted''::text])))';
begin
  -- Every check on exactly the one column is replaced by the wider one (0017 created one each).
  for c in
    select k.conname from pg_catalog.pg_constraint k
    join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attname = 'retired_reason'
    where k.conrelid = 'private.analytics_subjects'::pg_catalog.regclass and k.contype = 'c'
      and k.conkey = array[a.attnum] and pg_catalog.pg_get_constraintdef(k.oid) <> reason_check
  loop
    execute pg_catalog.format('alter table private.analytics_subjects drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_catalog.pg_constraint k
                 where k.conrelid = 'private.analytics_subjects'::pg_catalog.regclass and k.contype = 'c'
                   and pg_catalog.pg_get_constraintdef(k.oid) = reason_check) then
    alter table private.analytics_subjects add constraint analytics_subjects_retired_reason_check
      check (retired_reason in ('device_erasure', 'account_erasure', 'account_deleted'));
  end if;
  for c in
    select k.conname from pg_catalog.pg_constraint k
    join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attname = 'scope'
    where k.conrelid = 'private.analytics_erasure_jobs'::pg_catalog.regclass and k.contype = 'c'
      and k.conkey = array[a.attnum] and pg_catalog.pg_get_constraintdef(k.oid) <> scope_check
  loop
    execute pg_catalog.format('alter table private.analytics_erasure_jobs drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_catalog.pg_constraint k
                 where k.conrelid = 'private.analytics_erasure_jobs'::pg_catalog.regclass and k.contype = 'c'
                   and pg_catalog.pg_get_constraintdef(k.oid) = scope_check) then
    alter table private.analytics_erasure_jobs add constraint analytics_erasure_jobs_scope_check
      check (scope in ('device', 'account', 'account_deleted'));
  end if;
end
$$;

-- The status route finds a subject's jobs by the target id.
create index if not exists analytics_erasure_targets_distinct
  on private.analytics_erasure_targets(distinct_id);

-- ── 2. The account pre-step ───────────────────────────────────────────────────────────────────
create or replace function private.analytics_begin_account_erasure(p_user uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  moment timestamptz := pg_catalog.now();
  subj record;
  job_ref uuid;
  n integer := 0;
begin
  if p_user is null or p_reason is null or p_reason not in ('account_erasure', 'account_deleted') then
    raise exception 'analytics account erasure request shape' using errcode = '22023';
  end if;
  -- The lock issue_subject takes before it mints a new device: no new subject is created for this
  -- account while its subjects are captured.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text, 170019));
  perform 1 from auth.users u where u.id = p_user for key share;
  if not found then
    -- Already deleted (a retry after a lost reply): 0017's snapshot captured everything then.
    if p_reason = 'account_deleted' then
      return pg_catalog.jsonb_build_object('state', 'gone');
    end if;
    raise exception 'analytics account unavailable' using errcode = 'P0002';
  end if;
  for subj in
    select s.subject_id from private.analytics_subjects s
    where s.user_id = p_user and s.retired_at is null
    order by s.subject_id -- one lock order: two concurrent calls cannot deadlock
    for update
  loop
    update private.analytics_subjects set retired_at = moment, retired_reason = p_reason
      where subject_id = subj.subject_id;
    -- One job per subject under 32 random key bytes, exactly the snapshot's shape.
    job_ref := pg_catalog.gen_random_uuid();
    insert into private.analytics_erasure_jobs(job_id, scope, scope_key, stage, sweeps, attempts, priority,
                                               next_attempt_at, created_at)
      values (job_ref, case p_reason when 'account_deleted' then 'account_deleted' else 'account' end,
              extensions.gen_random_bytes(32), 'stop_recorded', 0, 0, 2, moment, moment);
    insert into private.analytics_erasure_targets(job_id, distinct_id, kind)
      values (job_ref, subj.subject_id, 'subject');
    n := n + 1;
  end loop;
  return pg_catalog.jsonb_build_object('state', 'captured', 'subjects', n);
end $$;

-- The least advanced stage among the account-wide jobs for this account's subjects (packet B).
create or replace function private.analytics_account_erasure_status(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  stages constant text[] := array['stop_recorded', 'provider_delete_accepted', 'provider_delete_confirmed', 'complete'];
  lowest integer;
begin
  if p_user is null then
    raise exception 'analytics account erasure request shape' using errcode = '22023';
  end if;
  select pg_catalog.min(pg_catalog.array_position(stages, j.stage)) into lowest
    from private.analytics_subjects s
    join private.analytics_erasure_targets t on t.distinct_id = s.subject_id and t.kind = 'subject'
    join private.analytics_erasure_jobs j on j.job_id = t.job_id
    where s.user_id = p_user and s.retired_reason = 'account_erasure' and j.scope = 'account';
  if lowest is null then
    return pg_catalog.jsonb_build_object('stage', null);
  end if;
  return pg_catalog.jsonb_build_object('stage', stages[lowest]);
end $$;

-- ── 3. Grants: explicit, and nothing else ─────────────────────────────────────────────────────
revoke all on all functions in schema private from public, anon, authenticated, service_role;
revoke all on function private.analytics_begin_account_erasure(uuid, text),
  private.analytics_account_erasure_status(uuid)
  from public, anon, authenticated, service_role, still_entitlement_writer, still_settings_writer,
       still_policy_reader, still_policy_admin, still_analytics_eraser;
grant execute on function private.analytics_begin_account_erasure(uuid, text),
  private.analytics_account_erasure_status(uuid)
  to still_analytics_eraser;

-- ── 4. Self-check: abort the whole migration unless the final state is the intended one ───────
do $$
declare
  issues text[] := '{}';
  owner_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'postgres');
  eraser_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_analytics_eraser');
  service_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'service_role');
  private_oid oid := (select oid from pg_catalog.pg_namespace where nspname = 'private');
  narrow oid[] := array(select oid from pg_catalog.pg_roles
                        where rolname in ('still_settings_writer', 'still_policy_reader', 'still_policy_admin',
                                          'still_analytics_eraser'));
  clients oid[];
  restricted oid[];
  -- Every route the eraser may execute after 0018: 0017's six and these two (plus the limiter).
  routes text[] := array[
    'private.analytics_issue_subject(uuid,bytea)',
    'private.analytics_subject_active(uuid)',
    'private.analytics_begin_device_erasure(bytea,integer)',
    'private.analytics_erasure_status(bytea)',
    'private.analytics_claim_erasure_work(integer,integer)',
    'private.analytics_record_erasure_outcome(uuid,uuid,text)',
    'private.analytics_begin_account_erasure(uuid,text)',
    'private.analytics_account_erasure_status(uuid)'];
  route text;
  item record;
begin
  with recursive reach(oid) as (
    select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
    union
    select m.roleid from pg_catalog.pg_auth_members m join reach c on m.member = c.oid
  ) select pg_catalog.array_agg(oid) into clients from reach;
  restricted := clients || service_oid || 0::oid;

  -- The widened checks: exactly one check on each column, with exactly the wider definition.
  if (select pg_catalog.array_agg(pg_catalog.pg_get_constraintdef(k.oid))
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attname = 'retired_reason'
      where k.conrelid = 'private.analytics_subjects'::pg_catalog.regclass and k.contype = 'c'
        and k.conkey = array[a.attnum])
     is distinct from array['CHECK ((retired_reason = ANY (ARRAY[''device_erasure''::text, ''account_erasure''::text, ''account_deleted''::text])))'] then
    issues := issues || 'subject_retired_reason_check'::text;
  end if;
  if (select pg_catalog.array_agg(pg_catalog.pg_get_constraintdef(k.oid))
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attname = 'scope'
      where k.conrelid = 'private.analytics_erasure_jobs'::pg_catalog.regclass and k.contype = 'c'
        and k.conkey = array[a.attnum])
     is distinct from array['CHECK ((scope = ANY (ARRAY[''device''::text, ''account''::text, ''account_deleted''::text])))'] then
    issues := issues || 'erasure_scope_check'::text;
  end if;
  if not exists (
       select 1 from pg_catalog.pg_index i
       join pg_catalog.pg_class c on c.oid = i.indexrelid
       join pg_catalog.pg_am am on am.oid = c.relam
       where i.indexrelid = pg_catalog.to_regclass('private.analytics_erasure_targets_distinct')
         and i.indrelid = 'private.analytics_erasure_targets'::pg_catalog.regclass
         and i.indisvalid and i.indisready and am.amname = 'btree' and i.indpred is null and i.indexprs is null
         and (select pg_catalog.array_agg(a.attname::text order by k.ord)
              from pg_catalog.unnest(i.indkey) with ordinality k(attnum, ord)
              join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
             = array['distinct_id']) then
    issues := issues || 'erasure_target_index'::text;
  end if;

  -- 0017's account-deletion snapshot, unchanged: present, ALWAYS enabled, unconditional, row level
  -- after delete (tgtype 9), calling 0017's function, whose body is byte-identical to 0017's.
  if not exists (
       select 1 from pg_catalog.pg_trigger t
       where t.tgrelid = 'private.analytics_subjects'::pg_catalog.regclass
         and t.tgname = 'analytics_subjects_snapshot' and t.tgtype = 9 and t.tgenabled = 'A'
         and not t.tgisinternal and t.tgqual is null and t.tgattr = ''::pg_catalog.int2vector
         and t.tgfoid = pg_catalog.to_regprocedure('private.analytics_snapshot_deleted_subject()')) then
    issues := issues || 'subject_snapshot_trigger'::text;
  end if;
  select p.proowner, p.prosecdef, p.proconfig, p.proacl, p.prosrc into item from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.analytics_snapshot_deleted_subject()');
  if item.proowner is distinct from owner_oid or item.prosecdef is distinct from true
     or not coalesce(item.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
     or pg_catalog.md5(item.prosrc) is distinct from '5bbbec70399c1ac78f1eb39255c418c2'
     or exists (select 1 from pg_catalog.aclexplode(coalesce(item.proacl, pg_catalog.acldefault('f', item.proowner))) a
                where a.grantee <> owner_oid) then
    issues := issues || 'subject_snapshot_function'::text;
  end if;

  -- The two new routes: owned by postgres, SECURITY DEFINER, pg_temp last, EXECUTE for exactly the
  -- eraser besides the owner.
  foreach route in array routes[7:8] loop
    select p.proowner, p.prosecdef, p.proconfig, p.proacl into item
      from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(route);
    if item.proowner is null then
      issues := issues || ('account_erasure_function_missing:' || route);
      continue;
    end if;
    if item.proowner <> owner_oid then
      issues := issues || ('account_erasure_function_owner:' || route);
    end if;
    if not item.prosecdef then
      issues := issues || ('account_erasure_function_definer:' || route);
    end if;
    if not coalesce(item.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false) then
      issues := issues || ('unsafe_search_path:' || route);
    end if;
    if (select pg_catalog.array_agg(a.grantee order by a.grantee)
        from pg_catalog.aclexplode(coalesce(item.proacl, pg_catalog.acldefault('f', item.proowner))) a
        where a.grantee <> owner_oid) is distinct from array[eraser_oid] then
      issues := issues || ('account_erasure_function_grant:' || route);
    end if;
  end loop;

  -- The eraser reaches exactly its eight routes and the limiter, and no table in public or private.
  foreach route in array routes loop
    if pg_catalog.to_regprocedure(route) is null
       or not pg_catalog.has_function_privilege(eraser_oid, pg_catalog.to_regprocedure(route), 'EXECUTE') then
      issues := issues || ('eraser_route_missing:' || route);
    end if;
  end loop;
  for item in
    select distinct p.oid::regprocedure::text as routine
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                               'pg_catalog.event_trigger'::pg_catalog.regtype)
      and not (p.oid::regprocedure::text = any (routes))
      and p.oid <> 'public.consume_rate_limit(text,integer,integer)'::regprocedure
      and pg_catalog.has_function_privilege(eraser_oid, p.oid, 'EXECUTE')
  loop
    issues := issues || ('eraser_execute:' || item.routine);
  end loop;
  for item in
    select distinct n.nspname || '.' || c.relname as relation
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (pg_catalog.has_table_privilege(eraser_oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or pg_catalog.has_any_column_privilege(eraser_oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
  loop
    issues := issues || ('eraser_table:' || item.relation);
  end loop;

  -- 0014-0017's client boundary still holds: no client-reachable SECURITY DEFINER except the two
  -- client RPCs, and service_role reaches nothing in private.
  for item in
    select distinct c.oid::regrole::text as rolname, p.oid::regprocedure::text as routine
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join pg_catalog.unnest(clients || service_oid) c(oid)
    where n.nspname in ('public', 'private') and p.prosecdef
      and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                               'pg_catalog.event_trigger'::pg_catalog.regtype)
      and p.oid not in ('public.write_profile_settings(jsonb,uuid)'::regprocedure,
                        'public.get_current_rule_set()'::regprocedure)
      and (n.nspname = 'private' or c.oid <> service_oid)
      and pg_catalog.has_function_privilege(c.oid, p.oid, 'EXECUTE')
  loop
    issues := issues || ('client_execute:' || item.rolname || ':' || item.routine);
  end loop;

  -- Every SECURITY DEFINER in public and private searches pg_temp last.
  for item in
    select p.oid::regprocedure::text as routine
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
      and not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
  loop
    issues := issues || ('unsafe_search_path:' || item.routine);
  end loop;

  -- No default privilege, from any creator, hands future objects in private to anyone restricted or
  -- to a narrow role.
  for item in
    select d.defaclrole::regrole::text as creator, d.defaclobjtype::text as objtype
    from pg_catalog.pg_default_acl d
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where d.defaclnamespace = private_oid
      and (a.grantee = any (restricted) or a.grantee = any (narrow))
  loop
    issues := issues || ('private_default:' || item.creator || ':' || item.objtype);
  end loop;

  if pg_catalog.cardinality(issues) > 0 then
    raise exception 'analytics account erasure self-check failed: %',
      pg_catalog.array_to_string(issues, ', ') using errcode = '42501';
  end if;
end
$$;

-- ── FIX-FORWARD (manual, never a re-grant) ─────────────────────────────────────────────────────
-- Do not grant either route, or any private table, to a client role or to service_role to make a
-- failure go away. If the pre-step misbehaves, redeploy the previous delete-user: 0017's snapshot
-- still captures every subject inside the account deletion itself. Ship a NEW forward migration for
-- any correction. Never narrow the widened checks while any row carries the new values.
--
-- ── RULES FOR LATER MIGRATIONS ─────────────────────────────────────────────────────────────────
-- 0014-0017's rules still apply. In addition: never change 0017's snapshot trigger or its function
-- without re-proving it on GoTrue's own deletion path, and never add a check or constraint the
-- snapshot's inserts could violate: they run inside GoTrue's transaction, so any failure there
-- blocks the account deletion itself.
