-- Per-field settings sync: the server side of the authenticated `sync-settings` Edge Function.
--
-- What this adds. A narrow database role, `still_settings_writer`, that the sync-settings function
-- logs in as, and a `private` schema that no client role can see. The schema holds one secret
-- anchor per account (the key the function uses to sign settings receipts, plus a lineage id that
-- changes if the account is deleted and recreated) and a 30-day log of accepted write ids so a
-- retried request is answered from the log instead of being applied twice. Three SECURITY DEFINER
-- helpers (lock, claim, commit) are the only way to touch those tables or to write a per-field
-- settings document, and only `still_settings_writer` may execute them. The existing request
-- limiter learns one more bucket name, `settings-sync`.
--
-- Free settings sync for released apps is unchanged. `write_profile_settings` (migration 0012) keeps
-- its behaviour, arguments, result columns and callers: any signed-in account may write any JSON
-- object, the row is replaced, the version goes up by one and database time is stamped. The single
-- addition takes the same per-account lock the new path takes and then refuses, with
-- `settings client upgrade required` (SQLSTATE 40001) and no change to the row, an account that has
-- already saved settings through the new per-field path or whose stored document was written by a
-- newer client (`schemaVersion` present and not 1). Replacing that document wholesale would erase
-- per-field history that other devices rely on. Accounts that have only ever used released apps
-- never reach that branch.
--
-- Authority. Applied by the hosted migration role `postgres` (non-superuser) and nothing else; the
-- first block refuses any other executing role. Every object below is created and owned by
-- `postgres`. `postgres` holds CREATEROLE, so PostgreSQL 16+ records an automatic, non-inheriting
-- admin membership of `postgres` in the new role (granted by the platform administrator, not
-- removable here); the self-check allows exactly that one membership and nothing else.
--
-- Rules carried from 0014. Nothing created by `postgres` is client-reachable by default any more,
-- and this migration still grants and revokes explicitly: every new function is revoked from
-- PUBLIC, anon, authenticated and service_role, the three writer helpers are granted only to
-- `still_settings_writer`, bodies are fully qualified, and the client read surface is unchanged (no
-- new client SELECT or EXECUTE). One rule is tightened: an empty search_path still looks up type
-- names in the caller's own temporary schema (pg_temp) first, so a session holding any credential
-- that can call a SECURITY DEFINER function could plant a pg_temp domain named, say, `text` whose
-- CHECK then runs with the owner's rights. Every function 0015 creates or replaces, and every other
-- SECURITY DEFINER function in public, is therefore pinned to `search_path = pg_catalog, pg_temp`
-- (pg_temp searched last, as the PostgreSQL documentation for SECURITY DEFINER prescribes). Later
-- migrations must use the same form.
--
-- Idempotence. Every statement is guarded or replace-in-place (`if not exists`, `create or replace`,
-- `alter role ... set`, `cron.schedule` by job name, revoke/grant), so applying the file a second
-- time leaves the catalog as it was. No profile, entitlement, purchase-event, rule-set or limiter
-- row is read, rewritten or deleted by the migration itself.
--
-- Not done here, on purpose: the writer's LOGIN and password (a separate secret operation before the
-- function is deployed), the function deployment itself, and any change to rule sets, purchases,
-- entitlements or profile data.

-- ── 0. Preconditions: fail before any DDL ─────────────────────────────────────────────────────
do $$
declare
  legacy pg_catalog.pg_proc%rowtype;
begin
  if current_user <> 'postgres'
     or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'settings sync migration role precondition' using errcode = '42501';
  end if;
  if pg_catalog.current_setting('server_version_num')::int < 160000 then
    raise exception 'settings sync server version precondition' using errcode = '0A000';
  end if;
  -- The retained free-sync RPC keeps its owner. CREATE OR REPLACE below never changes an owner,
  -- so refuse drift rather than blessing whichever role a target happens to expose.
  select * into legacy from pg_catalog.pg_proc
    where oid = 'public.write_profile_settings(jsonb,uuid)'::regprocedure;
  if not found or not legacy.prosecdef
     or legacy.proowner is distinct from (
       select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres' and not r.rolsuper) then
    raise exception 'legacy settings owner precondition' using errcode = '42501';
  end if;
  -- An existing schema named private must already belong to postgres.
  if exists (select 1 from pg_catalog.pg_namespace n
             where n.nspname = 'private'
               and n.nspowner <> (select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres')) then
    raise exception 'private schema owner precondition' using errcode = '42501';
  end if;
end
$$;

-- ── 1. The narrow writer role ─────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'still_settings_writer') then
    create role still_settings_writer nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;
alter role still_settings_writer set lock_timeout = '1s';
alter role still_settings_writer set statement_timeout = '2s';
alter role still_settings_writer set idle_in_transaction_session_timeout = '5s';
-- The private anchor key is a bind parameter; normal/error logs must suppress parameters.
alter role still_settings_writer set log_parameter_max_length = 0;
alter role still_settings_writer set log_parameter_max_length_on_error = 0;

-- ── 2. Private schema and tables: owner-only ──────────────────────────────────────────────────
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role, still_settings_writer;
grant usage on schema private to still_settings_writer;
-- The writer calls the retained limiter in public; it gets no table or other function there.
grant usage on schema public to still_settings_writer;

create table if not exists private.settings_anchors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  lineage uuid not null unique,
  secret bytea not null check (pg_catalog.octet_length(secret) = 32),
  modern_used boolean not null default false
);
create table if not exists private.settings_writes (
  user_id uuid not null references auth.users(id) on delete cascade,
  write_id uuid not null,
  body jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_id, write_id)
);
create index if not exists settings_writes_expiry on private.settings_writes(user_id, created_at);
create index if not exists settings_writes_global_expiry on private.settings_writes(created_at);
-- Owner-only. RLS with no policy is a second barrier: a future stray grant still returns no rows.
-- The owner (and so every SECURITY DEFINER helper below) is not subject to it.
alter table private.settings_anchors enable row level security;
alter table private.settings_writes enable row level security;
revoke all on table private.settings_anchors, private.settings_writes
  from public, anon, authenticated, service_role, still_settings_writer;

-- ── 3. Helpers and the server-only writer path (reviewed candidate bodies) ────────────────────
-- Mirrored structural bounds are source-checked against the maintained migrator.
create or replace function private.settings_json_bounded(p_value jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  with recursive nodes(value,depth) as (
    -- JSONB adds at most two formatting spaces per node to compact JSON.
    select p_value,0 where pg_catalog.octet_length(p_value::text)<=65536+2*4096
    union all
    select c.value,n.depth+1 from nodes n cross join lateral (
      select e.value from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end) e
      union all
      select e.value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(n.value)='array' then n.value else '[]'::jsonb end) e
    ) c where n.depth<=8
  ), sizes as (
    select sum(case pg_catalog.jsonb_typeof(value)
      when 'object' then 2+(select greatest(count(*)-1,0)+coalesce(sum(pg_catalog.octet_length(pg_catalog.to_jsonb(k)::text)+1),0) from pg_catalog.jsonb_object_keys(value) k)
      when 'array' then 2+greatest(pg_catalog.jsonb_array_length(value)-1,0)
      else pg_catalog.octet_length(value::text) end) as bytes from nodes
  )
  select p_value is not null and (select bytes from sizes)<=65536
    and count(*)<=4096 and coalesce(bool_and(depth<=8 and case pg_catalog.jsonb_typeof(value)
      when 'string' then pg_catalog.octet_length(value#>>'{}')<=8192
      when 'number' then abs((value#>>'{}')::numeric)<=9007199254740991
      when 'array' then pg_catalog.jsonb_array_length(value)<=128
      when 'object' then (select count(*)<=128 and coalesce(bool_and(pg_catalog.octet_length(k)<=128 and k not in ('__proto__','prototype','constructor')),true) from pg_catalog.jsonb_object_keys(value) k)
      else true end),false) from nodes;
$$;

create or replace function private.settings_fields() returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['globalOn','services.youtube','services.instagram','services.tiktok','services.facebook','sites.youtube.shorts','sites.youtube.related','sites.youtube.endscreen','sites.youtube.autoplay','sites.youtube.comments','sites.youtube.livechat','sites.instagram.reels','sites.instagram.explore','sites.instagram.stories','sites.instagram.suggested','sites.instagram.threads','sites.facebook.reels','sites.facebook.stories','sites.facebook.videos','sites.facebook.sponsored'];
$$;

-- Complete supported canonical validation of a stored document; unknown members survive.
create or replace function private.settings_canonical_valid(v jsonb,revision bigint) returns boolean
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare field text; group_name text; member text; stamp record; n numeric; modern boolean;
  core_sites constant text[] := array['youtube.shorts','instagram.reels','facebook.reels'];
  services jsonb; sites jsonb; clocks jsonb; projected jsonb; supplied boolean;
begin
  if not private.settings_json_bounded(v) or pg_catalog.jsonb_typeof(v)<>'object'
    or (v ? 'schemaVersion' and v->'schemaVersion' not in ('1'::jsonb,'2'::jsonb))
    or pg_catalog.jsonb_typeof(v->'globalOn') is distinct from 'boolean'
    or pg_catalog.jsonb_typeof(v->'services') is distinct from 'object'
    or pg_catalog.jsonb_typeof(v->'updatedAt') is distinct from 'number' then return false; end if;
  n := (v->>'updatedAt')::numeric;
  if n<=0 or n<>pg_catalog.trunc(n) or n>9007199254740991 then return false; end if;
  if v ? 'pauses' then
    if pg_catalog.jsonb_typeof(v->'pauses')<>'array' then return false; end if;
    if exists(select 1 from pg_catalog.jsonb_array_elements(v->'pauses') p where pg_catalog.jsonb_typeof(p)<>'string') then return false; end if;
  end if;
  if v ? 'sites' and pg_catalog.jsonb_typeof(v->'sites')<>'object' then return false; end if;
  if coalesce(v->'sites','{}'::jsonb) ?| array['tiktok','tiktok.all'] then return false; end if;
  modern := v->'schemaVersion'='2'::jsonb;
  foreach field in array private.settings_fields() loop
    if field='globalOn' then continue; end if;
    group_name := pg_catalog.split_part(field,'.',1);
    member := pg_catalog.substr(field,pg_catalog.length(group_name)+2);
    if (v->group_name ? member and pg_catalog.jsonb_typeof(v->group_name->member)<>'boolean')
      or (modern and not coalesce(v->group_name ? member,false)) then return false; end if;
  end loop;
  if modern then
    if pg_catalog.jsonb_typeof(v->'clocks') is distinct from 'object'
      or v->'clocks' ?| array['sites.tiktok','sites.tiktok.all'] then return false; end if;
    foreach field in array private.settings_fields() loop
      if not (v->'clocks' ? field) then return false; end if;
    end loop;
    for stamp in select key,value from pg_catalog.jsonb_each(v->'clocks') loop
      if not (stamp.key=any(private.settings_fields()) or stamp.key like 'services.%' or stamp.key like 'sites.%')
        or pg_catalog.jsonb_typeof(stamp.value)<>'object'
        or pg_catalog.jsonb_typeof(stamp.value->'baseRevision') is distinct from 'number'
        or pg_catalog.jsonb_typeof(stamp.value->'localStep') is distinct from 'number' then return false; end if;
      n := (stamp.value->>'baseRevision')::numeric;
      if n<0 or n>9007199254740991 or n<>pg_catalog.trunc(n) then return false; end if;
      if stamp.key=any(private.settings_fields()) and n>revision then return false; end if;
      n := (stamp.value->>'localStep')::numeric;
      if n<0 or n>1048575 or n<>pg_catalog.trunc(n) then return false; end if;
    end loop;
  elsif v ? 'clocks' then return false;
  else
    -- Match the maintained lazy legacy migration's expansion when checking its
    -- resulting bounds. This is validation only, never a stored reset/migration.
    services := v->'services'; sites := coalesce(v->'sites','{}'::jsonb); clocks := '{}'::jsonb;
    foreach field in array private.settings_fields() loop
      if field='globalOn' then supplied := true;
      else
        group_name := pg_catalog.split_part(field,'.',1);
        member := pg_catalog.substr(field,pg_catalog.length(group_name)+2);
        supplied := coalesce(v->group_name ? member,false);
        if group_name='services' and not supplied then
          services := services || pg_catalog.jsonb_build_object(member,false);
        elsif group_name='sites' and not supplied then
          sites := sites || pg_catalog.jsonb_build_object(member,
            case when member=any(core_sites) then services->pg_catalog.split_part(member,'.',1) else 'false'::jsonb end);
        end if;
      end if;
      clocks := clocks || pg_catalog.jsonb_build_object(field,pg_catalog.jsonb_build_object(
        'baseRevision',case when supplied then greatest(1,revision) else 0 end,'localStep',0));
    end loop;
    projected := (v - 'pauses') || pg_catalog.jsonb_build_object('schemaVersion',2,'services',services,'sites',sites,'clocks',clocks);
    if not private.settings_json_bounded(projected) then return false; end if;
  end if;
  return true;
end $$;
revoke all on function private.settings_json_bounded(jsonb), private.settings_fields(), private.settings_canonical_valid(jsonb,bigint) from public, anon, authenticated, service_role, still_settings_writer;

create or replace function private.cleanup_settings_writes() returns void language sql security definer set search_path = pg_catalog, pg_temp as $$
  delete from private.settings_writes where (user_id,write_id) in (
    select user_id,write_id from private.settings_writes
    where created_at < pg_catalog.clock_timestamp()-interval '30 days'
    order by created_at limit 4096 for update skip locked
  );
$$;
revoke all on function private.cleanup_settings_writes() from public, anon, authenticated, service_role, still_settings_writer;
-- Scheduled by job name: re-applying updates the same job instead of adding another.
select cron.schedule('still-settings-write-retention','* * * * *',
  $$set statement_timeout = '5s'; select private.cleanup_settings_writes();$$);

create or replace function private.lock_settings(p_subject uuid, p_lineage uuid, p_key text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare p public.profiles%rowtype; a private.settings_anchors%rowtype; found_profile boolean;
begin
  if p_subject is null or p_subject::text is distinct from pg_catalog.current_setting('request.jwt.claim.sub', true) then
    raise exception 'subject mismatch' using errcode = '28000';
  end if;
  -- The auth row serializes even missing profiles/anchors and blocks deletion throughout MAC verification.
  perform 1 from auth.users where id = p_subject for no key update;
  if not found then raise exception 'missing account' using errcode = '28000'; end if;
  insert into private.settings_anchors(user_id,lineage,secret)
    values(p_subject,p_lineage,pg_catalog.decode(p_key,'hex')) on conflict(user_id) do nothing;
  select * into a from private.settings_anchors where user_id=p_subject for update;
  select * into p from public.profiles where id=p_subject for no key update;
  found_profile := found;
  return pg_catalog.jsonb_build_object('lineage',a.lineage,'key',pg_catalog.encode(a.secret,'hex'),
    'revision',case when not found_profile then 0 else case when p.settings->'schemaVersion'='2'::jsonb then p.settings_version else greatest(1,p.settings_version) end end,
    'settings',case when found_profile then p.settings else null end,
    'settings_text',coalesce(p.settings::text,'null'),'empty',not found_profile,
    'numeric_supported',not exists(select 1 from pg_catalog.jsonb_path_query(p.settings,'strict $.** ? (@.type() == "number")') n where abs(n::text::numeric)>9007199254740991),
    'updated_at',p.settings_server_updated_at,'write_id',p.settings_last_write_id,
    'now',pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000));
end $$;

-- Thirty-day identity retention is a settings-only engineering bound. Expired retries retain their original stamps.
create or replace function private.claim_settings_write(p_subject uuid,p_id uuid,p_body jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare prior jsonb; retained_count bigint; retained_bytes bigint; recent_count bigint;
begin
  if p_subject::text is distinct from pg_catalog.current_setting('request.jwt.claim.sub',true) or p_id is null then
    raise exception 'subject mismatch' using errcode='28000';
  end if;
  perform 1 from auth.users where id=p_subject for no key update;
  if not found then raise exception 'missing account' using errcode='28000'; end if;
  delete from private.settings_writes where user_id=p_subject and created_at < pg_catalog.clock_timestamp()-interval '30 days';
  select body into prior from private.settings_writes where user_id=p_subject and write_id=p_id;
  if found then return case when prior=p_body then 'duplicate' else 'conflict' end; end if;
  select count(*),coalesce(sum(pg_catalog.octet_length(body::text)),0),
    count(*) filter (where created_at>pg_catalog.clock_timestamp()-interval '60 seconds')
    into retained_count,retained_bytes,recent_count from private.settings_writes where user_id=p_subject;
  -- Database admission for every per-field write through the writer path.
  -- Do not evict unexpired accepted identities to admit another request.
  if p_body is null or pg_catalog.octet_length(p_body::text)>65536 then raise exception 'settings write bounds' using errcode='22023'; end if;
  if recent_count>=120 then raise exception 'settings new write rate limited' using errcode='P0001'; end if;
  if retained_count>=4096 or retained_bytes+pg_catalog.octet_length(p_body::text)>4194304 then
    raise exception 'settings identity storage full' using errcode='P0001'; end if;
  insert into private.settings_writes(user_id,write_id,body) values(p_subject,p_id,p_body);
  return 'new';
end $$;

create or replace function private.commit_settings(p_subject uuid,p_lineage uuid,p_revision bigint,p_raw jsonb,p_next jsonb,p_id uuid,p_receipt_revision bigint,p_operations jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a private.settings_anchors%rowtype; p public.profiles%rowtype; revision bigint; op jsonb; t timestamptz; field text; path text[]; raw_next jsonb; stamps jsonb;
begin
  if p_subject::text is distinct from pg_catalog.current_setting('request.jwt.claim.sub',true) then
    raise exception 'subject mismatch' using errcode='28000';
  end if;
  perform 1 from auth.users where id=p_subject for no key update;
  if not found then raise exception 'missing account' using errcode='28000'; end if;
  select * into a from private.settings_anchors where user_id=p_subject for update;
  if not found or a.lineage is distinct from p_lineage then raise exception 'lineage changed' using errcode='40001'; end if;
  select * into p from public.profiles where id=p_subject for no key update;
  revision := case when found then case when p.settings->'schemaVersion'='2'::jsonb then p.settings_version else greatest(1,p.settings_version) end else 0 end;
  if revision <> p_revision or coalesce(p.settings,'null'::jsonb) is distinct from p_raw then raise exception 'canonical changed' using errcode='40001'; end if;
  if p_revision < 0 or p_revision >= 9007199254740991 or p_receipt_revision < 0 or p_receipt_revision > p_revision then
    raise exception 'revision bounds' using errcode='22023';
  end if;
  -- Recheck admitted immutable bases while locked; only the narrow server verifier may call this helper.
  for op in select value from pg_catalog.jsonb_array_elements(p_operations) loop
    if (op->>'baseRevision')::bigint not in (0,p_receipt_revision) or (op->>'localStep')::bigint not between 1 and 1048575 then
      raise exception 'operation bounds' using errcode='22023';
    end if;
  end loop;
  if not exists(select 1 from private.settings_writes where user_id=p_subject and write_id=p_id) then
    raise exception 'unclaimed write' using errcode='22023';
  end if;
  -- The driver decoder rounds JSON numbers. Overlay only maintained known fields onto
  -- PostgreSQL's original raw JSON, including each original opaque stamp member.
  raw_next := coalesce(nullif(p_raw,'null'::jsonb),'{}'::jsonb) || pg_catalog.jsonb_build_object(
    'schemaVersion',2,'globalOn',p_next->'globalOn','updatedAt',p_next->'updatedAt',
    'services',coalesce(p_raw->'services','{}'::jsonb),
    'sites',coalesce(p_raw->'sites','{}'::jsonb));
  stamps := case when p_raw->'schemaVersion'='2'::jsonb then p_raw->'clocks' else '{}'::jsonb end;
  foreach field in array private.settings_fields() loop
    if field<>'globalOn' then
      path := array[pg_catalog.split_part(field,'.',1),pg_catalog.substr(field,pg_catalog.strpos(field,'.')+1)];
      raw_next := pg_catalog.jsonb_set(raw_next,path,p_next#>path);
    end if;
    stamps := stamps || pg_catalog.jsonb_build_object(field,coalesce(stamps->field,'{}'::jsonb) ||
      pg_catalog.jsonb_build_object('baseRevision',p_next->'clocks'->field->'baseRevision','localStep',p_next->'clocks'->field->'localStep'));
  end loop;
  p_next := pg_catalog.jsonb_set(raw_next - 'pauses','{clocks}',stamps);
  -- Raw opaque numerics can be longer than the driver's rounded view. Validate
  -- the final preserving document before any profile write; caller rolls back
  -- the identity claim and exposes only the trusted typed bounds signal.
  if not private.settings_canonical_valid(p_next,p_revision+1) then
    raise exception 'settings write bounds' using errcode='PST01';
  end if;
  t := pg_catalog.to_timestamp((p_next->>'updatedAt')::double precision/1000);
  insert into public.profiles(id,settings,updated_at,settings_version,settings_server_updated_at,settings_last_write_id)
    values(p_subject,p_next,t,p_revision+1,t,p_id)
    on conflict(id) do update set settings=excluded.settings,updated_at=excluded.updated_at,
      settings_version=excluded.settings_version,settings_server_updated_at=excluded.settings_server_updated_at,
      settings_last_write_id=excluded.settings_last_write_id;
  update private.settings_anchors set modern_used=true where user_id=p_subject;
end $$;
revoke all on function private.lock_settings(uuid,uuid,text), private.claim_settings_write(uuid,uuid,jsonb), private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb) from public, anon, authenticated, service_role;
grant execute on function private.lock_settings(uuid,uuid,text), private.claim_settings_write(uuid,uuid,jsonb), private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb) to still_settings_writer;
-- Extend the retained single limiter surface allowlist only. Keep its counter, expiry,
-- account/IP partitioning, privacy retention, owner and existing callers unchanged.
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
  if parts is null or parts[1] not in ('checkout', 'reconcile', 'review-signin:request', 'review-signin:verify', 'settings-sync') then
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
grant execute on function public.consume_rate_limit(text,integer,integer) to still_settings_writer;
revoke all on function public.consume_rate_limit(text,integer,integer)
  from public, anon, authenticated, service_role;

-- ── 4. Free settings sync: the 0012 body plus one guard ───────────────────────────────────────
-- Everything outside the marked block is the 0012 body, with built-ins and tables written fully
-- qualified; the search_path is the pg_temp-last form described in the header.
create or replace function public.write_profile_settings(
  p_settings jsonb,
  p_write_id uuid
) returns table (
  settings jsonb,
  settings_version bigint,
  settings_server_updated_at timestamptz,
  settings_last_write_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_server_time timestamptz;
begin
  if v_user_id is null then
    raise exception 'auth required' using errcode = '28000';
  end if;

  if p_write_id is null then
    raise exception 'write id required' using errcode = '22023';
  end if;

  if p_settings is null or pg_catalog.jsonb_typeof(p_settings) <> 'object' then
    raise exception 'settings must be a json object' using errcode = '22023';
  end if;

  -- ── 0015 guard ──
  -- Take the per-account lock the per-field writer path holds for its whole transaction, then
  -- decide. A per-field commit in flight therefore finishes first and this check sees it.
  perform 1 from auth.users u where u.id = v_user_id for no key update;
  if exists (select 1 from private.settings_anchors a
             where a.user_id = v_user_id and a.modern_used)
     or exists (select 1 from public.profiles p
                where p.id = v_user_id and p.settings ? 'schemaVersion'
                  and p.settings -> 'schemaVersion' <> '1'::jsonb) then
    raise exception 'settings client upgrade required' using errcode = '40001';
  end if;
  -- ── end 0015 guard ──

  v_server_time := pg_catalog.clock_timestamp();

  insert into public.profiles (
    id,
    settings,
    updated_at,
    settings_version,
    settings_server_updated_at,
    settings_last_write_id
  )
  values (
    v_user_id,
    p_settings,
    v_server_time,
    1,
    v_server_time,
    p_write_id
  )
  on conflict (id) do update
    set settings = excluded.settings,
        updated_at = v_server_time,
        settings_version = public.profiles.settings_version + 1,
        settings_server_updated_at = v_server_time,
        settings_last_write_id = excluded.settings_last_write_id;

  return query
    select p.settings,
           p.settings_version,
           p.settings_server_updated_at,
           p.settings_last_write_id
    from public.profiles p
    where p.id = v_user_id;
end;
$$;
-- Grants restated from 0014: signed-in users only.
revoke all on function public.write_profile_settings(jsonb, uuid) from public, anon, service_role;
grant execute on function public.write_profile_settings(jsonb, uuid) to authenticated;

-- ── 4b. pg_temp last for the SECURITY DEFINER functions 0015 does not replace ─────────────────
-- Bodies untouched (they already qualify every table); only the configured search_path changes.
-- These are every other SECURITY DEFINER function in public that a writer role, a client role or
-- an auth.users trigger can reach. Event-trigger functions are excluded as in 0014: no caller can
-- invoke them directly and they are not owned by this migration's role.
alter function public.set_entitlement(uuid, boolean, text, text) set search_path = pg_catalog, pg_temp;
alter function public.record_revenuecat_event(text, text, jsonb) set search_path = pg_catalog, pg_temp;
alter function public.claim_revenuecat_event(text, text, jsonb) set search_path = pg_catalog, pg_temp;
alter function public.complete_revenuecat_event(text, uuid) set search_path = pg_catalog, pg_temp;
alter function public.release_revenuecat_event(text, uuid) set search_path = pg_catalog, pg_temp;
alter function public.get_current_rule_set() set search_path = pg_catalog, pg_temp;
alter function public.cleanup_rate_limit_counters() set search_path = pg_catalog, pg_temp;
alter function public.sync_rate_limit_account() set search_path = pg_catalog, pg_temp;

-- ── 5. Self-check: abort the whole migration unless the final state is the intended one ───────
-- Client reach is the closure of anon and authenticated over every membership edge, as in 0014.
-- "Restricted" below means PUBLIC, that closure and service_role.
do $$
declare
  issues text[] := '{}';
  owner_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'postgres');
  writer_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_settings_writer');
  entitlement_writer_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_entitlement_writer');
  service_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'service_role');
  clients oid[];
  restricted oid[];
  private_oid oid := (select oid from pg_catalog.pg_namespace where nspname = 'private');
  expected_functions text[] := array[
    'private.claim_settings_write(uuid,uuid,jsonb)',
    'private.cleanup_settings_writes()',
    'private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb)',
    'private.lock_settings(uuid,uuid,text)',
    'private.settings_canonical_valid(jsonb,bigint)',
    'private.settings_fields()',
    'private.settings_json_bounded(jsonb)'
  ];
  writer_functions text[] := array[
    'private.claim_settings_write(uuid,uuid,jsonb)',
    'private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb)',
    'private.lock_settings(uuid,uuid,text)'
  ];
  definer_functions text[] := array[
    'private.claim_settings_write(uuid,uuid,jsonb)',
    'private.cleanup_settings_writes()',
    'private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb)',
    'private.lock_settings(uuid,uuid,text)'
  ];
  writer_settings text[] := array[
    'lock_timeout=1s', 'statement_timeout=2s', 'idle_in_transaction_session_timeout=5s',
    'log_parameter_max_length=0', 'log_parameter_max_length_on_error=0'
  ];
  expected_oids oid[];
  writer_oids oid[];
  definer_oids oid[];
  setting text;
  item record;
begin
  -- Compare routines by oid: to_regprocedure reads the qualified names whatever the search_path.
  select pg_catalog.array_agg(pg_catalog.to_regprocedure(x)) into expected_oids from pg_catalog.unnest(expected_functions) x;
  select pg_catalog.array_agg(pg_catalog.to_regprocedure(x)) into writer_oids from pg_catalog.unnest(writer_functions) x;
  select pg_catalog.array_agg(pg_catalog.to_regprocedure(x)) into definer_oids from pg_catalog.unnest(definer_functions) x;
  with recursive reach(oid) as (
    select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
    union
    select m.roleid from pg_catalog.pg_auth_members m join reach c on m.member = c.oid
  ) select pg_catalog.array_agg(oid) into clients from reach;
  restricted := clients || service_oid || 0::oid;

  -- Writer role: narrow attributes, the five session limits, no membership it can use.
  if writer_oid is null then
    issues := issues || 'writer_missing'::text;
  else
    if exists (select 1 from pg_catalog.pg_roles r where r.oid = writer_oid
               and (r.rolsuper or r.rolinherit or r.rolcreaterole or r.rolcreatedb
                    or r.rolreplication or r.rolbypassrls)) then
      issues := issues || 'writer_attributes'::text;
    end if;
    foreach setting in array writer_settings loop
      if not exists (select 1 from pg_catalog.pg_db_role_setting s
                     where s.setrole = writer_oid and s.setdatabase = 0
                       and setting = any (s.setconfig)) then
        issues := issues || ('writer_setting_missing:' || setting);
      end if;
    end loop;
    if exists (select 1 from pg_catalog.pg_auth_members m where m.member = writer_oid) then
      issues := issues || 'writer_member_of_role'::text;
    end if;
    for item in
      select m.member::regrole::text as member from pg_catalog.pg_auth_members m
      where m.roleid = writer_oid
        and not (m.member = owner_oid and not m.inherit_option and not m.set_option)
    loop
      issues := issues || ('writer_granted_to:' || item.member);
    end loop;
    if writer_oid = any (clients) then
      issues := issues || 'writer_client_reachable'::text;
    end if;
  end if;

  -- Schema private: owned by postgres; the writer may only look up names in it.
  if private_oid is null or (select n.nspowner from pg_catalog.pg_namespace n where n.oid = private_oid) <> owner_oid then
    issues := issues || 'private_schema_owner'::text;
  else
    for item in
      select a.grantee, a.privilege_type from pg_catalog.pg_namespace n
      cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      where n.oid = private_oid and a.grantee <> owner_oid
        and not (a.grantee = writer_oid and a.privilege_type = 'USAGE')
    loop
      issues := issues || ('private_schema_grant:' || case when item.grantee = 0 then 'PUBLIC'
        else item.grantee::regrole::text end || ':' || item.privilege_type);
    end loop;
    if not pg_catalog.has_schema_privilege('still_settings_writer', 'private', 'USAGE') then
      issues := issues || 'writer_private_usage_missing'::text;
    end if;
  end if;

  -- Relations in private: exactly the two tables, owner-only, RLS on, account deletion cascades.
  for item in
    select c.oid, c.relname::text as relname, c.relkind, c.relowner, c.relrowsecurity, c.relacl
    from pg_catalog.pg_class c
    where c.relnamespace = private_oid and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  loop
    if item.relname not in ('settings_anchors', 'settings_writes') or item.relkind <> 'r' then
      issues := issues || ('private_relation_unexpected:' || item.relname);
    end if;
    if item.relowner <> owner_oid then
      issues := issues || ('private_relation_owner:' || item.relname);
    end if;
    if not item.relrowsecurity then
      issues := issues || ('private_rls_disabled:' || item.relname);
    end if;
    if exists (select 1 from pg_catalog.aclexplode(coalesce(item.relacl, pg_catalog.acldefault('r', item.relowner))) a
               where a.grantee <> owner_oid)
       or exists (select 1 from pg_catalog.pg_attribute att
                  where att.attrelid = item.oid and att.attnum > 0 and not att.attisdropped
                    and att.attacl is not null) then
      issues := issues || ('private_relation_grant:' || item.relname);
    end if;
    if not exists (select 1 from pg_catalog.pg_constraint k
                   where k.conrelid = item.oid and k.contype = 'f'
                     and k.confrelid = 'auth.users'::pg_catalog.regclass and k.confdeltype = 'c') then
      issues := issues || ('private_relation_no_account_cascade:' || item.relname);
    end if;
  end loop;
  foreach setting in array array['settings_anchors', 'settings_writes'] loop
    if pg_catalog.to_regclass('private.' || setting) is null then
      issues := issues || ('private_relation_missing:' || setting);
    end if;
  end loop;

  -- Functions in private: exactly the expected set, owned by postgres, pg_temp-last search_path, and
  -- EXECUTE for the owner plus (writer helpers only) the writer. Nothing else, PUBLIC included.
  for item in
    select p.oid, p.oid::regprocedure::text as routine, p.proowner, p.prosecdef, p.proconfig, p.proacl
    from pg_catalog.pg_proc p where p.pronamespace = private_oid
  loop
    if not (item.oid = any (expected_oids)) then
      issues := issues || ('private_function_unexpected:' || item.routine);
    end if;
    if item.proowner <> owner_oid then
      issues := issues || ('private_function_owner:' || item.routine);
    end if;
    if not coalesce(item.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false) then
      issues := issues || ('unsafe_search_path:' || item.routine);
    end if;
    if item.prosecdef is distinct from (item.oid = any (definer_oids)) then
      issues := issues || ('private_function_definer:' || item.routine);
    end if;
    for setting in
      select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
      from pg_catalog.aclexplode(coalesce(item.proacl, pg_catalog.acldefault('f', item.proowner))) a
      where a.grantee <> owner_oid
        and not (a.grantee = writer_oid and item.oid = any (writer_oids))
    loop
      issues := issues || ('private_function_grant:' || setting || ':' || item.routine);
    end loop;
    if item.oid = any (writer_oids)
       and not pg_catalog.has_function_privilege('still_settings_writer', item.oid, 'EXECUTE') then
      issues := issues || ('writer_execute_missing:' || item.routine);
    end if;
  end loop;
  foreach setting in array expected_functions loop
    if pg_catalog.to_regprocedure(setting) is null then
      issues := issues || ('private_function_missing:' || setting);
    end if;
  end loop;

  -- No default privilege, from any creator, hands future objects in private to anyone restricted
  -- or to the writer.
  for item in
    select d.defaclrole::regrole::text as creator, d.defaclobjtype::text as objtype
    from pg_catalog.pg_default_acl d
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where d.defaclnamespace = private_oid and (a.grantee = any (restricted) or a.grantee = writer_oid)
  loop
    issues := issues || ('private_default:' || item.creator || ':' || item.objtype);
  end loop;

  -- The free-sync RPC: owner postgres, definer, pinned, signed-in users only.
  select p.proowner, p.prosecdef, p.proconfig, p.proacl into item
  from pg_catalog.pg_proc p where p.oid = 'public.write_profile_settings(jsonb,uuid)'::regprocedure;
  if item.proowner <> owner_oid or not item.prosecdef
     or not coalesce(item.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false) then
    issues := issues || 'free_sync_definition'::text;
  end if;
  if (select pg_catalog.array_agg(a.grantee order by a.grantee)
      from pg_catalog.aclexplode(coalesce(item.proacl, pg_catalog.acldefault('f', item.proowner))) a
      where a.grantee <> owner_oid)
     is distinct from array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')] then
    issues := issues || 'free_sync_grantees'::text;
  end if;

  -- The retained limiter: exactly the two server writers besides its owner.
  select p.proowner, p.prosecdef, p.proconfig, p.proacl into item
  from pg_catalog.pg_proc p where p.oid = 'public.consume_rate_limit(text,integer,integer)'::regprocedure;
  if item.proowner <> owner_oid or not item.prosecdef
     or not coalesce(item.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false) then
    issues := issues || 'limiter_definition'::text;
  end if;
  if (select pg_catalog.array_agg(a.grantee order by a.grantee)
      from pg_catalog.aclexplode(coalesce(item.proacl, pg_catalog.acldefault('f', item.proowner))) a
      where a.grantee <> owner_oid)
     is distinct from (select pg_catalog.array_agg(x order by x) from pg_catalog.unnest(array[entitlement_writer_oid, writer_oid]) x) then
    issues := issues || 'limiter_grantees'::text;
  end if;

  -- 0014's client boundary, extended to private: no client-reachable SECURITY DEFINER except the
  -- two client RPCs, and service_role reaches nothing in private.
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

  -- Every SECURITY DEFINER function in public and private searches pg_temp last. An empty path,
  -- an absent pg_temp or any other form fails: pg_temp is then searched first for type names.
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

  -- The identity-retention job exists once, runs as postgres and calls only the cleanup helper.
  if (select pg_catalog.count(*) from cron.job j
      where j.jobname = 'still-settings-write-retention' and j.username = 'postgres' and j.active
        and j.schedule = '* * * * *'
        and j.command = $cmd$set statement_timeout = '5s'; select private.cleanup_settings_writes();$cmd$) <> 1 then
    issues := issues || 'retention_job'::text;
  end if;

  if pg_catalog.cardinality(issues) > 0 then
    raise exception 'settings sync privilege self-check failed: %',
      pg_catalog.array_to_string(issues, ', ') using errcode = '42501';
  end if;
end
$$;

-- ── FIX-FORWARD (manual, never a re-grant) ─────────────────────────────────────────────────────
-- Do not grant any private helper, table or schema to a client role or to service_role to make a
-- failure go away. If the writer path misbehaves in production, stop deploying the sync-settings
-- function (released apps keep using free sync), then ship a NEW forward migration. Do not drop
-- private.settings_anchors or private.settings_writes: the anchors are what keep old receipts from
-- being replayed after an account is recreated, and the write log is what makes retries safe.
-- Rolling back client code never permits removing the free-sync guard above; that would let a
-- released app overwrite per-field history.
