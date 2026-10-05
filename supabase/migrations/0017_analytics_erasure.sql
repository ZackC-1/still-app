-- Per-device analytics identities and device-slice erasure (U5-W2, part 1). Dormant: no client
-- sends anything to these routes until V3 analytics is switched on, and nothing here calls PostHog.
--
-- HARD GATE. The per-device identity path in analytics-identify stays behind its own switch
-- (ANALYTICS_SUBJECTS_ENABLED, off by default). It must not be switched on until account deletion
-- has been reordered so the analytics fence is recorded before the account is deleted (the
-- delete-user change planned for part 2) and the subject snapshot below has been verified on the
-- deployed database. Until then no subject is ever issued, so there is nothing for an account
-- deletion to leave behind.
--
-- What this adds. One narrow role, `still_analytics_eraser`, that the analytics-identify and
-- analytics-erasure functions log in as, and three owner-only tables in schema `private`:
--   * private.analytics_subjects        one PostHog identity ("subject") per signed-in account per
--                                        device. The server knows a device only by the SHA-256 of
--                                        the origin proof it sends when it signs in; it never sees
--                                        the device's private consent handle or its erasure key.
--                                        One row per (account, device, epoch), ever: a subject
--                                        retired by an erasure is never reissued and the pair never
--                                        receives another;
--   * private.analytics_erasure_jobs    erasure jobs and their provider-deletion stage. No
--                                        reference to auth.users, so a job survives account deletion;
--   * private.analytics_erasure_targets the distinct ids a job deletes. This is also the fence list
--                                        the worker re-sweeps for late-arriving events.
-- The subject is a random UUID. The account UUID is never a subject.
--
-- Device keys. On the device, a private origin handle O (never sent anywhere) gives an erasure key
-- E = HMAC-SHA256(O, "still:analytics:erasure"), the origin proof P = SHA-256(E), and the anonymous
-- ids anon(k) = UUID(HMAC-SHA256(E, "still:analytics:anon:0:" || k)). Signing in sends only P. A
-- device erasure sends E and the last index k it used; this database computes P from E, finds the
-- device's subjects by SHA-256(P), and derives anon(0..k) itself. The request names no id at all,
-- so knowing someone's anonymous id or account id gives no power to delete it, and P (which crosses
-- the network at every sign-in) does not either: deleting needs E, its preimage. E reaches the
-- server only when that device asks to erase itself; it is a bearer value for that one device's
-- erasure and is never stored (bind parameters are kept out of the logs).
--
-- Account deletion. Deleting an account cascades to its subjects; a trigger snapshots each deleted
-- subject into its own `account_deleted` job, keyed by random bytes, so its PostHog person is still
-- deleted afterwards and no erasure row can be matched back to the account.
--
-- Subject issuance is limited to 5 new devices per account per day (issued subjects raise a job's
-- claim priority, so they must not be mintable at scale). Each Share starts a new device identity,
-- so this also allows five Share-after-stop cycles per account per day; past that, that day's
-- signed-in events on the device wait unattributed (and anything older than 30 days is dropped).
--
-- Routes (SECURITY DEFINER, EXECUTE only for still_analytics_eraser):
--   analytics_issue_subject           issue or return the subject for (account, device); "stopped"
--                                     once the device has been erased;
--   analytics_subject_active          whether a subject may still receive writes (identify's
--                                     post-check);
--   analytics_begin_device_erasure    from the erasure key: retire the device's subjects and open
--                                     (or reuse) its job; never refused for volume (past a global
--                                     cap, anonymous-only jobs are recorded at the lowest priority);
--   analytics_erasure_status          the stage of the device's latest job, from the erasure key;
--   analytics_claim_erasure_work      lease due jobs to the worker (per-claim token): a fifth of
--                                     each claim for the oldest past-the-cap jobs, the rest in indexed
--                                     priority order, jobs that delete issued subjects first;
--   analytics_record_erasure_outcome  advance or back off a leased job by a fixed outcome word.
-- The limiter learns three buckets, `analytics-erasure-submit`, `analytics-erasure-status` and
-- `analytics-identify`, and the eraser may call it. Its body is otherwise byte-identical to 0015's.
--
-- Deploy order. 0016 must be deployed and verified on its own before 0017. 0016's post-apply check
-- enumerates schema private and its grants exactly, and 0015's pins the limiter body; section 5
-- revokes on every function in schema private and section 4 replaces the limiter, so the deploy
-- planner's `verification-overlap` rule refuses any plan listing 0015 or 0016 together with 0017.
-- Re-running 0016's check after 0017 reports the eraser's USAGE on private; that is expected and not
-- a regression.
--
-- Authority and idempotence. Applied by the hosted migration role `postgres` (non-superuser) and
-- nothing else. Every statement is guarded or replace-in-place, so applying the file twice leaves the
-- catalog as it was. No existing row is read, rewritten or deleted.
--
-- Not done here, on purpose: the eraser's LOGIN and password, the function deployments and secrets,
-- any schedule for the worker (owner question 7 is open), account-wide erasure and the account
-- deletion reorder (later parts), and any fence cleanup (U5-W3 owns retention).

-- ── 0. Preconditions: fail before any DDL ─────────────────────────────────────────────────────
do $$
begin
  if current_user <> 'postgres'
     or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'analytics erasure migration role precondition' using errcode = '42501';
  end if;
  if pg_catalog.current_setting('server_version_num')::int < 160000 then
    raise exception 'analytics erasure server version precondition' using errcode = '0A000';
  end if;
  -- 0016 created the policy routes in the postgres-owned private schema; 0013 the limiter tables.
  if pg_catalog.to_regnamespace('private') is null
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'private')
        <> (select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres')
     or pg_catalog.to_regprocedure('private.read_product_policy(text,text)') is null
     or pg_catalog.to_regprocedure('public.consume_rate_limit(text,integer,integer)') is null then
    raise exception 'analytics erasure requires 0016' using errcode = '55000';
  end if;
end
$$;

-- ── 1. The narrow role ────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'still_analytics_eraser') then
    create role still_analytics_eraser nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;
alter role still_analytics_eraser set lock_timeout = '1s';
alter role still_analytics_eraser set statement_timeout = '2s';
alter role still_analytics_eraser set idle_in_transaction_session_timeout = '5s';
-- The origin proof is a bearer value for its own device's erasure; keep bind parameters out of logs.
alter role still_analytics_eraser set log_parameter_max_length = 0;
alter role still_analytics_eraser set log_parameter_max_length_on_error = 0;

grant usage on schema private to still_analytics_eraser;
-- The eraser calls the retained limiter in public; it gets no table or other function there.
grant usage on schema public to still_analytics_eraser;

-- ── 2. Tables: owner-only ─────────────────────────────────────────────────────────────────────
create table if not exists private.analytics_subjects (
  subject_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  origin_key bytea not null check (pg_catalog.octet_length(origin_key) = 32),
  epoch integer not null check (epoch = 0),
  created_at timestamptz not null,
  last_activity_month date not null,
  retired_at timestamptz,
  retired_reason text check (retired_reason in ('device_erasure')),
  check ((retired_at is null) = (retired_reason is null))
);
-- One subject per (account, device, epoch) for all time: a retired row blocks every reissue.
create unique index if not exists analytics_subjects_one_per_device
  on private.analytics_subjects(user_id, origin_key, epoch);
create index if not exists analytics_subjects_origin on private.analytics_subjects(origin_key);

create table if not exists private.analytics_erasure_jobs (
  job_id uuid primary key,
  scope text not null check (scope in ('device', 'account_deleted')),
  scope_key bytea not null check (pg_catalog.octet_length(scope_key) = 32),
  stage text not null check (stage in ('stop_recorded', 'provider_delete_accepted',
                                        'provider_delete_confirmed', 'complete')),
  sweeps integer not null check (sweeps >= 0 and sweeps <= 3),
  attempts integer not null check (attempts >= 0),
  -- Claim order: 2 deletes issued subjects (signed-in history), 1 anonymous only, 0 submitted past
  -- the global new-job cap (recorded, never refused, worked after everything else).
  priority smallint not null check (priority between 0 and 2),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  last_error text check (last_error in ('provider_unavailable', 'provider_rejected',
                                        'provider_partial', 'provider_shape')),
  created_at timestamptz not null,
  accepted_at timestamptz,
  -- The last time PostHog queued a person of this job for deletion: the 8-day floor counts from it.
  last_queued_at timestamptz,
  confirmed_at timestamptz,
  completed_at timestamptz,
  fence_until timestamptz,
  check ((lease_token is null) = (lease_until is null)),
  check ((stage = 'complete') = (completed_at is not null)),
  check ((completed_at is null) = (fence_until is null)),
  check ((stage = 'stop_recorded') = (accepted_at is null)),
  check (next_attempt_at is not null or stage = 'complete')
);
-- At most one open job per device: two tabs, a retry after a lost reply, or both, reach one job.
create unique index if not exists analytics_erasure_jobs_open
  on private.analytics_erasure_jobs(scope, scope_key) where completed_at is null;
-- The claim walks this index in claim order, so a large backlog stays within the role's 2 s limit.
create index if not exists analytics_erasure_jobs_due
  on private.analytics_erasure_jobs(priority desc, next_attempt_at, job_id) where next_attempt_at is not null;
-- The second scan: the oldest due priority-0 jobs, for the share of each claim reserved for them.
create index if not exists analytics_erasure_jobs_backlog
  on private.analytics_erasure_jobs(next_attempt_at, job_id) where priority = 0;
create index if not exists analytics_erasure_jobs_created on private.analytics_erasure_jobs(created_at);
create index if not exists analytics_erasure_jobs_key
  on private.analytics_erasure_jobs(scope_key, created_at);

create table if not exists private.analytics_erasure_targets (
  job_id uuid not null references private.analytics_erasure_jobs(job_id) on delete cascade,
  distinct_id uuid not null,
  kind text not null check (kind in ('anonymous', 'subject')),
  primary key (job_id, distinct_id)
);

-- Owner-only. RLS with no policy is a second barrier: a future stray grant still returns no rows.
alter table private.analytics_subjects enable row level security;
alter table private.analytics_erasure_jobs enable row level security;
alter table private.analytics_erasure_targets enable row level security;
revoke all on table private.analytics_subjects, private.analytics_erasure_jobs,
  private.analytics_erasure_targets
  from public, anon, authenticated, service_role, still_entitlement_writer, still_settings_writer,
       still_policy_reader, still_policy_admin, still_analytics_eraser;

-- ── 3. The server-only routes ─────────────────────────────────────────────────────────────────
-- The device key: SHA-256 of the 32-byte origin proof, so the database never stores the proof.
create or replace function private.analytics_origin_key(p_proof bytea) returns bytea
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if p_proof is null or pg_catalog.octet_length(p_proof) <> 32 then
    raise exception 'analytics origin proof shape' using errcode = '22023';
  end if;
  return extensions.digest(p_proof, 'sha256');
end $$;

-- anon(0..p_last) from the erasure key, exactly as the device derives them (derive.ts): the first
-- 16 bytes of HMAC-SHA256(E, "still:analytics:anon:0:" || k) with the RFC 9562 version-4 and
-- variant bits set. Reference vectors shared with the client: analytics_erasure_migration_test.ts
-- and packages/core/src/analytics/__tests__/derive.test.ts.
create or replace function private.analytics_anonymous_ids(p_key bytea, p_last integer) returns uuid[]
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  ids uuid[] := '{}';
  h bytea;
  i integer;
begin
  if p_key is null or pg_catalog.octet_length(p_key) <> 32
     or p_last is null or p_last < 0 or p_last > 255 then
    raise exception 'analytics erasure request shape' using errcode = '22023';
  end if;
  for i in 0 .. p_last loop
    h := pg_catalog.substr(
      extensions.hmac(pg_catalog.convert_to('still:analytics:anon:0:' || i::text, 'UTF8'), p_key, 'sha256'), 1, 16);
    h := pg_catalog.set_byte(h, 6, (pg_catalog.get_byte(h, 6) & 15) | 64);
    h := pg_catalog.set_byte(h, 8, (pg_catalog.get_byte(h, 8) & 63) | 128);
    ids := ids || pg_catalog.encode(h, 'hex')::uuid;
  end loop;
  return ids;
end $$;

-- Issue (or return) the subject for one account on one device. "stopped" once that device has asked
-- for erasure, under this account or any other: a stopped device never gets an identity again.
create or replace function private.analytics_issue_subject(p_user uuid, p_proof bytea)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  k bytea := private.analytics_origin_key(p_proof);
  this_month date := pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'UTC')::date;
  subj private.analytics_subjects%rowtype;
begin
  if p_user is null then
    raise exception 'analytics subject request shape' using errcode = '22023';
  end if;
  -- Serialize with device erasure for the same device, then pin the account against deletion.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.encode(k, 'hex'), 170017));
  perform 1 from auth.users u where u.id = p_user for key share;
  if not found then
    raise exception 'analytics subject account unavailable' using errcode = 'P0002';
  end if;
  if exists (select 1 from private.analytics_erasure_jobs j where j.scope = 'device' and j.scope_key = k) then
    return pg_catalog.jsonb_build_object('state', 'stopped');
  end if;
  select * into subj from private.analytics_subjects s
    where s.user_id = p_user and s.origin_key = k and s.epoch = 0 for update;
  if found then
    if subj.retired_at is not null then
      return pg_catalog.jsonb_build_object('state', 'stopped');
    end if;
    if subj.last_activity_month <> this_month then
      update private.analytics_subjects set last_activity_month = this_month where subject_id = subj.subject_id;
    end if;
    return pg_catalog.jsonb_build_object('state', 'active', 'subject', subj.subject_id);
  end if;
  -- At most 5 new devices per account per day: issued subjects decide claim priority, so they must
  -- not be mintable at scale. Serialized per account, so concurrent requests cannot pass together.
  -- Every Share starts a new device identity, so this also allows five Share-after-stop cycles per
  -- account per day; past that the device's signed-in events wait unattributed until the next day.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text, 170019));
  if (select pg_catalog.count(*) from private.analytics_subjects s
      where s.user_id = p_user and s.created_at > pg_catalog.now() - interval '1 day') >= 5 then
    return pg_catalog.jsonb_build_object('state', 'limited');
  end if;
  insert into private.analytics_subjects(subject_id, user_id, origin_key, epoch, created_at, last_activity_month)
    values (pg_catalog.gen_random_uuid(), p_user, k, 0, pg_catalog.now(), this_month)
    returning * into subj;
  return pg_catalog.jsonb_build_object('state', 'active', 'subject', subj.subject_id);
end $$;

create or replace function private.analytics_subject_active(p_subject uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_subject is null then
    raise exception 'analytics subject request shape' using errcode = '22023';
  end if;
  return exists (select 1 from private.analytics_subjects s
                 where s.subject_id = p_subject and s.retired_at is null);
end $$;

-- Device erasure from the erasure key E and the last anonymous index k the device used. The
-- database derives every target itself: anon(0..k) from E, and every subject issued for this
-- device (found by SHA-256(SHA-256(E))). It retires those subjects, then opens (or reuses) the
-- device's job. A job that gains targets after its first provider call starts again from the top,
-- so nothing reads as deleted before the new targets are. A request is never refused for volume:
-- past 200 new device jobs in 10 minutes, a job with no issued subject is recorded at the lowest
-- claim priority instead.
create or replace function private.analytics_begin_device_erasure(p_key bytea, p_anon_index integer)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  ids uuid[] := private.analytics_anonymous_ids(p_key, p_anon_index);
  k bytea := private.analytics_origin_key(extensions.digest(p_key, 'sha256'));
  moment timestamptz := pg_catalog.now();
  job private.analytics_erasure_jobs%rowtype;
  added integer := 0;
  n integer;
  has_subjects boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.encode(k, 'hex'), 170017));
  has_subjects := exists (select 1 from private.analytics_subjects s where s.origin_key = k);
  update private.analytics_subjects set retired_at = moment, retired_reason = 'device_erasure'
    where origin_key = k and retired_at is null;

  select * into job from private.analytics_erasure_jobs j
    where j.scope = 'device' and j.scope_key = k and j.completed_at is null for update;
  if not found then
    -- A finished job for the same device is reused when this request adds nothing new to it.
    select * into job from private.analytics_erasure_jobs j
      where j.scope = 'device' and j.scope_key = k
      order by j.created_at desc limit 1;
    if found and not exists (
         select 1 from pg_catalog.unnest(ids) a
         where not exists (select 1 from private.analytics_erasure_targets t
                           where t.job_id = job.job_id and t.distinct_id = a))
       and not exists (
         select 1 from private.analytics_subjects s
         where s.origin_key = k and not exists (select 1 from private.analytics_erasure_targets t
                                                where t.job_id = job.job_id and t.distinct_id = s.subject_id)) then
      return pg_catalog.jsonb_build_object('job', job.job_id, 'stage', job.stage);
    end if;
    -- Past the global cap, a job with no issued subject still records the obligation, at priority
    -- 0: a flood of made-up keys can only queue behind genuine work, never displace or block it.
    insert into private.analytics_erasure_jobs(job_id, scope, scope_key, stage, sweeps, attempts, priority,
                                               next_attempt_at, created_at)
      values (pg_catalog.gen_random_uuid(), 'device', k, 'stop_recorded', 0, 0,
              case when has_subjects then 2
                   when (select pg_catalog.count(*) from private.analytics_erasure_jobs j
                         where j.scope = 'device' and j.created_at > moment - interval '10 minutes') >= 200 then 0
                   else 1 end,
              moment, moment)
      returning * into job;
  end if;
  insert into private.analytics_erasure_targets(job_id, distinct_id, kind)
    select job.job_id, a, 'anonymous' from pg_catalog.unnest(ids) a
    on conflict do nothing;
  get diagnostics n = row_count;
  added := added + n;
  insert into private.analytics_erasure_targets(job_id, distinct_id, kind)
    select job.job_id, s.subject_id, 'subject' from private.analytics_subjects s where s.origin_key = k
    on conflict do nothing;
  get diagnostics n = row_count;
  added := added + n;
  if has_subjects and job.priority < 2 then
    update private.analytics_erasure_jobs set priority = 2 where job_id = job.job_id;
  end if;
  if added > 0 and job.stage <> 'stop_recorded' then
    update private.analytics_erasure_jobs set stage = 'stop_recorded', sweeps = 0, accepted_at = null,
      confirmed_at = null, next_attempt_at = moment
      where job_id = job.job_id;
    job.stage := 'stop_recorded';
  end if;
  return pg_catalog.jsonb_build_object('job', job.job_id, 'stage', job.stage);
end $$;

create or replace function private.analytics_erasure_status(p_key bytea)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  k bytea;
  job private.analytics_erasure_jobs%rowtype;
begin
  if p_key is null or pg_catalog.octet_length(p_key) <> 32 then
    raise exception 'analytics erasure request shape' using errcode = '22023';
  end if;
  k := private.analytics_origin_key(extensions.digest(p_key, 'sha256'));
  select * into job from private.analytics_erasure_jobs j
    where j.scope = 'device' and j.scope_key = k order by j.created_at desc limit 1;
  if not found then
    return pg_catalog.jsonb_build_object('stage', null);
  end if;
  return pg_catalog.jsonb_build_object('job', job.job_id, 'stage', job.stage);
end $$;

-- A deleted subject (an account deletion cascades here) is snapshotted into its own
-- `account_deleted` job before the row goes, so its PostHog person is still deleted. The job's key is
-- 32 random bytes and the job references nothing: no erasure row can be matched to the account it
-- came from, and one account's subjects share no key.
create or replace function private.analytics_snapshot_deleted_subject()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  moment timestamptz := pg_catalog.now();
  job_ref uuid := pg_catalog.gen_random_uuid();
begin
  insert into private.analytics_erasure_jobs(job_id, scope, scope_key, stage, sweeps, attempts, priority,
                                             next_attempt_at, created_at)
    values (job_ref, 'account_deleted', extensions.gen_random_bytes(32), 'stop_recorded', 0, 0, 2, moment, moment);
  insert into private.analytics_erasure_targets(job_id, distinct_id, kind)
    values (job_ref, old.subject_id, 'subject');
  return null;
end $$;
create or replace trigger analytics_subjects_snapshot
  after delete on private.analytics_subjects
  for each row execute function private.analytics_snapshot_deleted_subject();
alter table private.analytics_subjects enable always trigger analytics_subjects_snapshot;

-- Lease up to p_limit due jobs. Each claim gets a fresh token; only its holder records the outcome.
-- A fifth of each claim (10 of 50) is reserved for the oldest due priority-0 jobs (second indexed
-- scan), so jobs recorded past the cap always make progress; the rest follow the indexed priority
-- (issued subjects first), then due time.
create or replace function private.analytics_claim_erasure_work(p_limit integer, p_lease_seconds integer)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  moment timestamptz := pg_catalog.clock_timestamp();
  claimed jsonb := '[]'::jsonb;
  job private.analytics_erasure_jobs%rowtype;
  token uuid;
  taken integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100
     or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'analytics erasure claim shape' using errcode = '22023';
  end if;
  for job in
    select * from private.analytics_erasure_jobs j
    where j.priority = 0 and j.next_attempt_at <= moment
      and (j.lease_until is null or j.lease_until < moment)
    order by j.next_attempt_at, j.job_id
    limit p_limit / 5
    for update skip locked
  loop
    token := pg_catalog.gen_random_uuid();
    update private.analytics_erasure_jobs
      set lease_token = token, lease_until = moment + p_lease_seconds * interval '1 second'
      where job_id = job.job_id;
    taken := taken + 1;
    claimed := claimed || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'job', job.job_id, 'lease', token, 'stage', job.stage, 'sweeps', job.sweeps, 'attempts', job.attempts,
      'targets', coalesce((select pg_catalog.jsonb_agg(t.distinct_id order by t.distinct_id)
                  from private.analytics_erasure_targets t where t.job_id = job.job_id), '[]'::jsonb)));
  end loop;
  for job in
    select * from private.analytics_erasure_jobs j
    where j.next_attempt_at is not null and j.next_attempt_at <= moment
      and (j.lease_until is null or j.lease_until < moment)
    order by j.priority desc, j.next_attempt_at, j.job_id
    limit p_limit - taken
    for update skip locked
  loop
    token := pg_catalog.gen_random_uuid();
    update private.analytics_erasure_jobs
      set lease_token = token, lease_until = moment + p_lease_seconds * interval '1 second'
      where job_id = job.job_id;
    claimed := claimed || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'job', job.job_id, 'lease', token, 'stage', job.stage, 'sweeps', job.sweeps, 'attempts', job.attempts,
      'targets', coalesce((select pg_catalog.jsonb_agg(t.distinct_id order by t.distinct_id)
                  from private.analytics_erasure_targets t where t.job_id = job.job_id), '[]'::jsonb)));
  end loop;
  return claimed;
end $$;

-- One outcome for a leased job, by fixed word: `queued` (persons queued for deletion with their
-- events), `none_found` (no person matched), or a failure category. A failure never advances
-- anything and backs off from 1 minute, doubling, to 24 hours; from the fifth failure in a row the
-- job is reported overdue. Stages:
--   stop_recorded             -> provider_delete_accepted  on the first accepted deletion;
--   provider_delete_accepted  -> provider_delete_confirmed when the +1 day sweep finds nobody;
--   provider_delete_confirmed -> complete                  when a sweep at least 8 days after
--                                PostHog last queued a deletion for this job (or after acceptance,
--                                if it never had to) finds nobody. PostHog deletes events in a later batch
--                                (weekends on PostHog Cloud), and a person that is gone says nothing
--                                about its events, so 8 days covers one full weekly batch before a
--                                device is told its data is deleted;
--   complete                  -> no more work               after a last sweep 35 days after
--                                acceptance finds nobody.
-- A sweep that finds someone again (a late event) deletes again and re-checks a day later.
create or replace function private.analytics_record_erasure_outcome(p_job uuid, p_lease uuid, p_outcome text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  moment timestamptz := pg_catalog.clock_timestamp();
  job private.analytics_erasure_jobs%rowtype;
begin
  if p_job is null or p_lease is null or p_outcome is null or p_outcome not in (
       'queued', 'none_found', 'provider_unavailable', 'provider_rejected', 'provider_partial', 'provider_shape') then
    raise exception 'analytics erasure outcome shape' using errcode = '22023';
  end if;
  select * into job from private.analytics_erasure_jobs j where j.job_id = p_job for update;
  if not found or job.lease_token is distinct from p_lease then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;
  if p_outcome not in ('queued', 'none_found') then
    update private.analytics_erasure_jobs set
      attempts = least(job.attempts + 1, 1000000),
      last_error = p_outcome,
      next_attempt_at = moment + least(interval '24 hours',
                                       interval '1 minute' * pg_catalog.power(2, least(job.attempts, 11))),
      lease_token = null, lease_until = null
      where job_id = job.job_id;
    return pg_catalog.jsonb_build_object('recorded', true, 'stage', job.stage, 'overdue', job.attempts + 1 >= 5);
  end if;
  if p_outcome = 'queued' then
    update private.analytics_erasure_jobs set last_queued_at = moment where job_id = job.job_id;
    job.last_queued_at := moment;
  end if;
  if job.stage = 'stop_recorded' then
    update private.analytics_erasure_jobs set stage = 'provider_delete_accepted', accepted_at = moment,
      sweeps = 0, next_attempt_at = moment + interval '1 day'
      where job_id = job.job_id;
    job.stage := 'provider_delete_accepted';
  elsif p_outcome = 'queued' then
    update private.analytics_erasure_jobs set next_attempt_at = moment + interval '1 day'
      where job_id = job.job_id;
  elsif job.stage = 'provider_delete_accepted' then
    update private.analytics_erasure_jobs set stage = 'provider_delete_confirmed', confirmed_at = moment,
      sweeps = 1, next_attempt_at = greatest(moment, coalesce(job.last_queued_at, job.accepted_at) + interval '8 days')
      where job_id = job.job_id;
    job.stage := 'provider_delete_confirmed';
  elsif job.stage = 'provider_delete_confirmed' then
    if moment < coalesce(job.last_queued_at, job.accepted_at) + interval '8 days' then
      update private.analytics_erasure_jobs set next_attempt_at = coalesce(job.last_queued_at, job.accepted_at) + interval '8 days'
        where job_id = job.job_id;
    else
      update private.analytics_erasure_jobs set stage = 'complete', sweeps = 2, completed_at = moment,
        fence_until = moment + interval '13 months',
        next_attempt_at = greatest(moment, job.accepted_at + interval '35 days')
        where job_id = job.job_id;
      job.stage := 'complete';
    end if;
  else
    update private.analytics_erasure_jobs set sweeps = 3, next_attempt_at = null where job_id = job.job_id;
  end if;
  update private.analytics_erasure_jobs set attempts = 0, last_error = null,
    lease_token = null, lease_until = null
    where job_id = job.job_id;
  return pg_catalog.jsonb_build_object('recorded', true, 'stage', job.stage, 'overdue', false);
end $$;

-- ── 4. The retained limiter: 0015's body plus three bucket names ────────────────────────────────
create or replace function public.consume_rate_limit(
  p_bucket_key text, p_max_requests integer, p_window_seconds integer
) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  moment timestamptz;
  w_start timestamptz;
  w_end timestamptz;
  parts text[];
  derived_key text;
  window_secret bytea;
  owner_id uuid;
  new_count integer;
begin
  if p_window_seconds is null or p_window_seconds not in (60, 600)
    or p_max_requests is null or p_max_requests < 1 or p_max_requests > 10000
    or p_bucket_key is null or length(p_bucket_key) > 1024 then
    raise exception 'Invalid rate limit policy';
  end if;
  parts := regexp_match(p_bucket_key, '^(.+):(user|ip):(.+)$');
  if parts is null or parts[1] not in ('checkout', 'reconcile', 'review-signin:request', 'review-signin:verify', 'settings-sync', 'analytics-erasure-submit', 'analytics-erasure-status', 'analytics-identify') then
    raise exception 'Invalid rate limit bucket';
  end if;
  perform public.cleanup_rate_limit_counters();

  if parts[2] = 'user' then
    if parts[1] in ('review-signin:request', 'review-signin:verify') then
      perform pg_advisory_xact_lock(hashtextextended(lower(parts[3]), 152));
      select id into owner_id from auth.users where lower(email) = lower(parts[3]) for key share;
    else
      select id into owner_id from auth.users where id = parts[3]::uuid for key share;
      if owner_id is null then raise exception 'Rate limit account unavailable'; end if;
    end if;
  end if;

  -- Resolve time after waiting on account locks so delayed traffic uses the current window.
  moment := clock_timestamp();
  w_start := to_timestamp(floor(extract(epoch from moment) / p_window_seconds) * p_window_seconds);
  w_end := w_start + p_window_seconds * interval '1 second';
  insert into public.rate_limit_window_keys(window_start, window_seconds, secret, expires_at)
    values (w_start, p_window_seconds, extensions.gen_random_bytes(32), w_end)
    on conflict do nothing;
  select secret into strict window_secret from public.rate_limit_window_keys
    where window_start = w_start and window_seconds = p_window_seconds for key share;
  derived_key := parts[1] || ':' || parts[2] || ':' ||
    encode(extensions.hmac(p_bucket_key::bytea, window_secret, 'sha256'), 'hex');
  insert into public.rate_limit_counters(bucket_key, window_start, window_seconds, expires_at, account_id, count)
    values (derived_key, w_start, p_window_seconds, w_end, owner_id, 1)
    on conflict (bucket_key, window_start) do update
      set count = least(public.rate_limit_counters.count + 1, p_max_requests + 1),
          account_id = coalesce(public.rate_limit_counters.account_id, excluded.account_id)
    returning count into new_count;
  if new_count <= p_max_requests then return 0; end if;
  return greatest(1, ceil(extract(epoch from w_end - moment))::integer);
end;
$$;
grant execute on function public.consume_rate_limit(text,integer,integer)
  to still_entitlement_writer, still_settings_writer, still_analytics_eraser;
revoke all on function public.consume_rate_limit(text,integer,integer)
  from public, anon, authenticated, service_role;

-- ── 5. Grants: explicit, and nothing else ─────────────────────────────────────────────────────
revoke all on all functions in schema private from public, anon, authenticated, service_role;
revoke all on function private.analytics_origin_key(bytea),
  private.analytics_anonymous_ids(bytea, integer),
  private.analytics_snapshot_deleted_subject(),
  private.analytics_issue_subject(uuid, bytea),
  private.analytics_subject_active(uuid),
  private.analytics_begin_device_erasure(bytea, integer),
  private.analytics_erasure_status(bytea),
  private.analytics_claim_erasure_work(integer, integer),
  private.analytics_record_erasure_outcome(uuid, uuid, text)
  from public, anon, authenticated, service_role, still_entitlement_writer, still_settings_writer,
       still_policy_reader, still_policy_admin, still_analytics_eraser;
grant execute on function private.analytics_issue_subject(uuid, bytea),
  private.analytics_subject_active(uuid),
  private.analytics_begin_device_erasure(bytea, integer),
  private.analytics_erasure_status(bytea),
  private.analytics_claim_erasure_work(integer, integer),
  private.analytics_record_erasure_outcome(uuid, uuid, text)
  to still_analytics_eraser;

-- ── 6. Self-check: abort the whole migration unless the final state is the intended one ───────
-- Client reach is the closure of anon and authenticated over every membership edge, as in 0014-0016.
-- "Restricted" means PUBLIC, that closure and service_role.
do $$
declare
  issues text[] := '{}';
  owner_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'postgres');
  eraser_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_analytics_eraser');
  entitlement_writer_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_entitlement_writer');
  settings_writer_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_settings_writer');
  reader_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_policy_reader');
  admin_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_policy_admin');
  service_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'service_role');
  private_oid oid := (select oid from pg_catalog.pg_namespace where nspname = 'private');
  public_oid oid := (select oid from pg_catalog.pg_namespace where nspname = 'public');
  clients oid[];
  restricted oid[];
  role_settings text[] := array['lock_timeout=1s', 'statement_timeout=2s', 'idle_in_transaction_session_timeout=5s',
    'log_parameter_max_length=0', 'log_parameter_max_length_on_error=0'];
  erasure_tables text[] := array['analytics_subjects', 'analytics_erasure_jobs', 'analytics_erasure_targets'];
  routes text[] := array[
    'private.analytics_issue_subject(uuid,bytea)',
    'private.analytics_subject_active(uuid)',
    'private.analytics_begin_device_erasure(bytea,integer)',
    'private.analytics_erasure_status(bytea)',
    'private.analytics_claim_erasure_work(integer,integer)',
    'private.analytics_record_erasure_outcome(uuid,uuid,text)'];
  setting text;
  item record;
  routine record;
begin
  with recursive reach(oid) as (
    select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
    union
    select m.roleid from pg_catalog.pg_auth_members m join reach c on m.member = c.oid
  ) select pg_catalog.array_agg(oid) into clients from reach;
  restricted := clients || service_oid || 0::oid;

  -- The role: narrow attributes, its five session settings, member of nothing, and the only
  -- membership in it is postgres's automatic non-inheriting, non-SET admin grant.
  if eraser_oid is null then
    issues := issues || 'role_missing:still_analytics_eraser'::text;
  else
    if exists (select 1 from pg_catalog.pg_roles r where r.oid = eraser_oid
               and (r.rolsuper or r.rolinherit or r.rolcreaterole or r.rolcreatedb
                    or r.rolreplication or r.rolbypassrls)) then
      issues := issues || 'role_attributes:still_analytics_eraser'::text;
    end if;
    foreach setting in array role_settings loop
      if not exists (select 1 from pg_catalog.pg_db_role_setting s
                     where s.setrole = eraser_oid and s.setdatabase = 0 and setting = any (s.setconfig)) then
        issues := issues || ('role_setting_missing:still_analytics_eraser:' || setting);
      end if;
    end loop;
    if exists (select 1 from pg_catalog.pg_auth_members m where m.member = eraser_oid) then
      issues := issues || 'role_member_of_role:still_analytics_eraser'::text;
    end if;
    if exists (select 1 from pg_catalog.pg_auth_members m where m.roleid = eraser_oid
               and not (m.member = owner_oid and not m.inherit_option and not m.set_option)) then
      issues := issues || 'role_granted_to_other:still_analytics_eraser'::text;
    end if;
    if eraser_oid = any (clients) then
      issues := issues || 'role_client_reachable:still_analytics_eraser'::text;
    end if;
  end if;

  -- Schema private: owned by postgres; only the four narrow roles may look up names in it.
  if private_oid is null or (select n.nspowner from pg_catalog.pg_namespace n where n.oid = private_oid) <> owner_oid then
    issues := issues || 'private_schema_owner'::text;
  else
    for item in
      select a.grantee, a.privilege_type from pg_catalog.pg_namespace n
      cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      where n.oid = private_oid and a.grantee <> owner_oid
        and not (a.grantee = any (array[settings_writer_oid, reader_oid, admin_oid, eraser_oid])
                 and a.privilege_type = 'USAGE')
    loop
      issues := issues || ('private_schema_grant:' || case when item.grantee = 0 then 'PUBLIC'
        else item.grantee::regrole::text end || ':' || item.privilege_type);
    end loop;
    if eraser_oid is not null and not pg_catalog.has_schema_privilege(eraser_oid, private_oid, 'USAGE') then
      issues := issues || 'private_usage_missing:still_analytics_eraser'::text;
    end if;
  end if;
  if eraser_oid is not null and (not pg_catalog.has_schema_privilege(eraser_oid, public_oid, 'USAGE')
                                 or pg_catalog.has_schema_privilege(eraser_oid, public_oid, 'CREATE')) then
    issues := issues || 'public_schema_access:still_analytics_eraser'::text;
  end if;

  -- The three tables: present, owned by postgres, RLS on, no table or column grant to anyone.
  foreach setting in array erasure_tables loop
    select c.oid, c.relkind, c.relowner, c.relrowsecurity, c.relacl into item
      from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('private.' || setting);
    if item.oid is null or item.relkind <> 'r' then
      issues := issues || ('erasure_relation_missing:' || setting);
      continue;
    end if;
    if item.relowner <> owner_oid then
      issues := issues || ('erasure_relation_owner:' || setting);
    end if;
    if not item.relrowsecurity then
      issues := issues || ('erasure_rls_disabled:' || setting);
    end if;
    if exists (select 1 from pg_catalog.aclexplode(coalesce(item.relacl, pg_catalog.acldefault('r', item.relowner))) a
               where a.grantee <> owner_oid)
       or exists (select 1 from pg_catalog.pg_attribute att
                  where att.attrelid = item.oid and att.attnum > 0 and not att.attisdropped
                    and att.attacl is not null) then
      issues := issues || ('erasure_relation_grant:' || setting);
    end if;
  end loop;
  -- `create table if not exists` keeps a pre-existing table: prove the columns the routes use.
  for item in
    select x.relname, x.attname from (values
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
      ('analytics_erasure_jobs', 'priority', 'pg_catalog.int2'::pg_catalog.regtype),
      ('analytics_erasure_jobs', 'created_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
      ('analytics_erasure_targets', 'job_id', 'pg_catalog.uuid'::pg_catalog.regtype),
      ('analytics_erasure_targets', 'distinct_id', 'pg_catalog.uuid'::pg_catalog.regtype),
      ('analytics_erasure_targets', 'kind', 'pg_catalog.text'::pg_catalog.regtype)
    ) x(relname, attname, typ)
    where pg_catalog.to_regclass('private.' || x.relname) is not null
      and not exists (select 1 from pg_catalog.pg_attribute a
                      where a.attrelid = pg_catalog.to_regclass('private.' || x.relname)
                        and a.attname = x.attname and not a.attisdropped and a.attnotnull
                        and a.atttypid = x.typ::pg_catalog.oid)
  loop
    issues := issues || ('erasure_column:' || item.relname || '.' || item.attname);
  end loop;
  for item in
    select x.relname, x.cols from (values
      ('analytics_subjects', array['subject_id']),
      ('analytics_erasure_jobs', array['job_id']),
      ('analytics_erasure_targets', array['job_id', 'distinct_id'])
    ) x(relname, cols)
    where pg_catalog.to_regclass('private.' || x.relname) is not null
      and not exists (
        select 1 from pg_catalog.pg_index i
        where i.indrelid = pg_catalog.to_regclass('private.' || x.relname) and i.indisprimary
          and i.indpred is null and i.indexprs is null
          and (select pg_catalog.array_agg(a.attname::text order by k.ord)
               from pg_catalog.unnest(i.indkey) with ordinality k(attnum, ord)
               join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = x.cols)
  loop
    issues := issues || ('erasure_key:' || item.relname);
  end loop;
  -- One subject per (account, device, epoch) for all time, retired rows included: no reissue.
  if pg_catalog.to_regclass('private.analytics_subjects') is not null and not exists (
       select 1 from pg_catalog.pg_index i
       where i.indrelid = 'private.analytics_subjects'::pg_catalog.regclass and i.indisunique
         and i.indpred is null and i.indexprs is null
         and (select pg_catalog.array_agg(a.attname::text order by k.ord)
              from pg_catalog.unnest(i.indkey) with ordinality k(attnum, ord)
              join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
             = array['user_id', 'origin_key', 'epoch']) then
    issues := issues || 'subject_reissue_guard'::text;
  end if;
  -- At most one open job per device.
  if pg_catalog.to_regclass('private.analytics_erasure_jobs') is not null and not exists (
       select 1 from pg_catalog.pg_index i
       where i.indrelid = 'private.analytics_erasure_jobs'::pg_catalog.regclass and i.indisunique
         and i.indexprs is null
         and pg_catalog.pg_get_expr(i.indpred, i.indrelid) = '(completed_at IS NULL)'
         and (select pg_catalog.array_agg(a.attname::text order by k.ord)
              from pg_catalog.unnest(i.indkey) with ordinality k(attnum, ord)
              join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
             = array['scope', 'scope_key']) then
    issues := issues || 'erasure_job_open_guard'::text;
  end if;
  -- The claim indexes: the due index in claim order, and the priority-0 backlog index.
  if pg_catalog.to_regclass('private.analytics_erasure_jobs') is not null and not exists (
       select 1 from pg_catalog.pg_index i
       where i.indrelid = 'private.analytics_erasure_jobs'::pg_catalog.regclass and i.indexprs is null
         and pg_catalog.pg_get_expr(i.indpred, i.indrelid) = '(next_attempt_at IS NOT NULL)'
         and (i.indoption[0] & 1) = 1 and (i.indoption[1] & 1) = 0 and (i.indoption[2] & 1) = 0
         and (select pg_catalog.array_agg(a.attname::text order by k.ord)
              from pg_catalog.unnest(i.indkey) with ordinality k(attnum, ord)
              join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
             = array['priority', 'next_attempt_at', 'job_id']) then
    issues := issues || 'erasure_claim_index'::text;
  end if;
  if pg_catalog.to_regclass('private.analytics_erasure_jobs') is not null and not exists (
       select 1 from pg_catalog.pg_index i
       where i.indrelid = 'private.analytics_erasure_jobs'::pg_catalog.regclass and i.indexprs is null
         and pg_catalog.pg_get_expr(i.indpred, i.indrelid) = '(priority = 0)'
         and (select pg_catalog.array_agg(a.attname::text order by k.ord)
              from pg_catalog.unnest(i.indkey) with ordinality k(attnum, ord)
              join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
             = array['next_attempt_at', 'job_id']) then
    issues := issues || 'erasure_backlog_index'::text;
  end if;
  -- Subjects cascade away with their account; jobs never reference an account (they must survive
  -- its deletion); targets cascade with their job.
  if pg_catalog.to_regclass('private.analytics_subjects') is not null and not exists (
       select 1 from pg_catalog.pg_constraint k
       where k.conrelid = 'private.analytics_subjects'::pg_catalog.regclass and k.contype = 'f'
         and k.confrelid = 'auth.users'::pg_catalog.regclass and k.confdeltype = 'c') then
    issues := issues || 'subject_no_account_cascade'::text;
  end if;
  if exists (select 1 from pg_catalog.pg_constraint k
             where k.conrelid = pg_catalog.to_regclass('private.analytics_erasure_jobs') and k.contype = 'f') then
    issues := issues || 'erasure_job_references'::text;
  end if;
  if pg_catalog.to_regclass('private.analytics_erasure_targets') is not null and not exists (
       select 1 from pg_catalog.pg_constraint k
       where k.conrelid = 'private.analytics_erasure_targets'::pg_catalog.regclass and k.contype = 'f'
         and k.confrelid = pg_catalog.to_regclass('private.analytics_erasure_jobs')
         and k.confdeltype = 'c' and k.convalidated) then
    issues := issues || 'erasure_target_job_link'::text;
  end if;

  -- The account-deletion snapshot: present, ALWAYS enabled (replica mode cannot skip it),
  -- unconditional, row level after delete (tgtype 9), calling the snapshot function.
  if not exists (
       select 1 from pg_catalog.pg_trigger t
       where t.tgrelid = pg_catalog.to_regclass('private.analytics_subjects')
         and t.tgname = 'analytics_subjects_snapshot' and t.tgtype = 9 and t.tgenabled = 'A'
         and not t.tgisinternal and t.tgqual is null and t.tgattr = ''::pg_catalog.int2vector
         and t.tgfoid = pg_catalog.to_regprocedure('private.analytics_snapshot_deleted_subject()')) then
    issues := issues || 'subject_snapshot_trigger'::text;
  end if;

  -- The 0017 routines: present, owned by postgres, pg_temp-last, SECURITY DEFINER exactly for the
  -- routes, EXECUTE for the owner plus exactly the eraser on each route, nobody on the helper.
  for routine in
    select x.sig, x.definer, x.grantee, pg_catalog.to_regprocedure(x.sig) as oid from (values
      ('private.analytics_origin_key(bytea)', false, null::oid),
      ('private.analytics_anonymous_ids(bytea,integer)', false, null::oid),
      ('private.analytics_snapshot_deleted_subject()', true, null::oid),
      ('private.analytics_issue_subject(uuid,bytea)', true, eraser_oid),
      ('private.analytics_subject_active(uuid)', true, eraser_oid),
      ('private.analytics_begin_device_erasure(bytea,integer)', true, eraser_oid),
      ('private.analytics_erasure_status(bytea)', true, eraser_oid),
      ('private.analytics_claim_erasure_work(integer,integer)', true, eraser_oid),
      ('private.analytics_record_erasure_outcome(uuid,uuid,text)', true, eraser_oid)
    ) x(sig, definer, grantee)
  loop
    if routine.oid is null then
      issues := issues || ('erasure_function_missing:' || routine.sig);
      continue;
    end if;
    select p.proowner, p.prosecdef, p.proconfig, p.proacl into item from pg_catalog.pg_proc p where p.oid = routine.oid;
    if item.proowner <> owner_oid then
      issues := issues || ('erasure_function_owner:' || routine.sig);
    end if;
    if item.prosecdef is distinct from routine.definer then
      issues := issues || ('erasure_function_definer:' || routine.sig);
    end if;
    if not coalesce(item.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false) then
      issues := issues || ('unsafe_search_path:' || routine.sig);
    end if;
    if (select pg_catalog.array_agg(a.grantee order by a.grantee)
        from pg_catalog.aclexplode(coalesce(item.proacl, pg_catalog.acldefault('f', item.proowner))) a
        where a.grantee <> owner_oid) is distinct from
       (case when routine.grantee is null then null else array[routine.grantee] end) then
      issues := issues || ('erasure_function_grant:' || routine.sig);
    end if;
  end loop;

  -- The retained limiter: exactly the three server roles besides its owner.
  select p.proowner, p.prosecdef, p.proconfig, p.proacl into item
  from pg_catalog.pg_proc p where p.oid = 'public.consume_rate_limit(text,integer,integer)'::regprocedure;
  if item.proowner <> owner_oid or not item.prosecdef
     or not coalesce(item.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false) then
    issues := issues || 'limiter_definition'::text;
  end if;
  if (select pg_catalog.array_agg(a.grantee order by a.grantee)
      from pg_catalog.aclexplode(coalesce(item.proacl, pg_catalog.acldefault('f', item.proowner))) a
      where a.grantee <> owner_oid)
     is distinct from (select pg_catalog.array_agg(x order by x)
                       from pg_catalog.unnest(array[entitlement_writer_oid, settings_writer_oid, eraser_oid]) x) then
    issues := issues || 'limiter_grantees'::text;
  end if;

  -- The eraser reaches no other SECURITY DEFINER routine and no table in public or private.
  for item in
    select distinct p.oid::regprocedure::text as routine
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where eraser_oid is not null and n.nspname in ('public', 'private') and p.prosecdef
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
    where eraser_oid is not null and n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (pg_catalog.has_table_privilege(eraser_oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or pg_catalog.has_any_column_privilege(eraser_oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
  loop
    issues := issues || ('eraser_table:' || item.relation);
  end loop;

  -- 0014-0016's client boundary still holds: no client-reachable SECURITY DEFINER except the two
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
      and (a.grantee = any (restricted)
           or a.grantee = any (array[settings_writer_oid, reader_oid, admin_oid, eraser_oid]))
  loop
    issues := issues || ('private_default:' || item.creator || ':' || item.objtype);
  end loop;

  if pg_catalog.cardinality(issues) > 0 then
    raise exception 'analytics erasure self-check failed: %',
      pg_catalog.array_to_string(issues, ', ') using errcode = '42501';
  end if;
end
$$;

-- ── FIX-FORWARD (manual, never a re-grant) ─────────────────────────────────────────────────────
-- Do not grant any private table or route to a client role or to service_role to make a failure go
-- away. If either function misbehaves, stop deploying it: V3 analytics stays held on every client
-- until the erasure capabilities are verified. Ship a NEW forward migration for any correction.
-- Never delete a retired subject (it is what stops a reissue) or an unexpired erasure target (it is
-- the fence list), and never reopen a completed job by hand.
--
-- ── RULES FOR LATER MIGRATIONS ─────────────────────────────────────────────────────────────────
-- 0014-0016's rules still apply (explicit grants, revokes from public, anon, authenticated and
-- service_role, `set search_path = pg_catalog, pg_temp` on every SECURITY DEFINER, schema-qualified
-- bodies). In addition: account-wide erasure and retention add their scopes, retirement reasons and
-- routes in a new migration that keeps the one-subject-per-device index and never lets a retired
-- subject become active again.
