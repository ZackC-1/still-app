-- Unnumbered candidate. Deploy only with separately reviewed target/authority approval.
-- Private helper grants distinguish the dedicated edge adapter from the retained trusted RPC.
-- The retained legacy RPC has a separately trusted managed owner. Refuse owner drift;
-- granting private helper execution must not bless whichever role a target happens to expose.
do $$ declare legacy pg_catalog.pg_proc%rowtype; begin
  select * into legacy from pg_catalog.pg_proc
    where oid='public.write_profile_settings(jsonb,uuid)'::regprocedure;
  if not found or not legacy.prosecdef or legacy.proowner is distinct from (
    select oid from pg_catalog.pg_roles where rolname='postgres' and not rolsuper
  ) then raise exception 'legacy settings owner precondition' using errcode='42501'; end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'still_settings_writer') then
    create role still_settings_writer nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
alter role still_settings_writer set lock_timeout = '1s';
alter role still_settings_writer set statement_timeout = '2s';
alter role still_settings_writer set idle_in_transaction_session_timeout = '5s';
-- The private anchor key is a bind parameter; normal/error logs must suppress parameters.
alter role still_settings_writer set log_parameter_max_length = 0;
alter role still_settings_writer set log_parameter_max_length_on_error = 0;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role, still_settings_writer;
grant usage on schema private, public to still_settings_writer;
alter default privileges revoke execute on functions from public, anon, authenticated, service_role, still_settings_writer;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated, service_role, still_settings_writer;
alter default privileges in schema private revoke all on tables from public, anon, authenticated, service_role, still_settings_writer;
create table private.settings_anchors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  lineage uuid not null unique,
  secret bytea not null check (pg_catalog.octet_length(secret) = 32),
  modern_used boolean not null default false
);
create table private.settings_writes (
  user_id uuid not null references auth.users(id) on delete cascade,
  write_id uuid not null,
  body jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_id, write_id)
);
create index settings_writes_expiry on private.settings_writes(user_id,created_at);
create index settings_writes_global_expiry on private.settings_writes(created_at);
revoke all on private.settings_anchors, private.settings_writes from public, anon, authenticated, service_role, still_settings_writer;

-- Mirrored structural bounds are source-checked against the maintained migrator.
create function private.settings_json_bounded(p_value jsonb) returns boolean
language sql immutable set search_path = '' as $$
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

create function private.settings_fields() returns text[] language sql immutable set search_path = '' as $$
  select array['globalOn','services.youtube','services.instagram','services.tiktok','services.facebook','sites.youtube.shorts','sites.youtube.related','sites.youtube.endscreen','sites.youtube.autoplay','sites.youtube.comments','sites.youtube.livechat','sites.instagram.reels','sites.instagram.explore','sites.instagram.stories','sites.instagram.suggested','sites.instagram.threads','sites.facebook.reels','sites.facebook.stories','sites.facebook.videos','sites.facebook.sponsored'];
$$;

-- Complete supported canonical validation before a legacy mutation; unknown members survive.
create function private.settings_canonical_valid(v jsonb,revision bigint) returns boolean
language plpgsql immutable set search_path = '' as $$
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

create function private.cleanup_settings_writes() returns void language sql security definer set search_path = '' as $$
  delete from private.settings_writes where (user_id,write_id) in (
    select user_id,write_id from private.settings_writes
    where created_at < pg_catalog.clock_timestamp()-interval '30 days'
    order by created_at limit 4096 for update skip locked
  );
$$;
revoke all on function private.cleanup_settings_writes() from public, anon, authenticated, service_role, still_settings_writer;
select cron.schedule('still-settings-write-retention','* * * * *',
  $$set statement_timeout = '5s'; select private.cleanup_settings_writes();$$);

create function private.lock_settings(p_subject uuid, p_lineage uuid, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
create function private.claim_settings_write(p_subject uuid,p_id uuid,p_body jsonb)
returns text language plpgsql security definer set search_path = '' as $$
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
  -- Shared database admission covers both modern and direct authenticated legacy writes.
  -- Do not evict unexpired accepted identities to admit another request.
  if p_body is null or pg_catalog.octet_length(p_body::text)>65536 then raise exception 'settings write bounds' using errcode='22023'; end if;
  if recent_count>=120 then raise exception 'settings new write rate limited' using errcode='P0001'; end if;
  if retained_count>=4096 or retained_bytes+pg_catalog.octet_length(p_body::text)>4194304 then
    raise exception 'settings identity storage full' using errcode='P0001'; end if;
  insert into private.settings_writes(user_id,write_id,body) values(p_subject,p_id,p_body);
  return 'new';
end $$;

create function private.commit_settings(p_subject uuid,p_lineage uuid,p_revision bigint,p_raw jsonb,p_next jsonb,p_id uuid,p_receipt_revision bigint,p_operations jsonb)
returns void language plpgsql security definer set search_path = '' as $$
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
language plpgsql security definer set search_path = ''
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

-- Retain legacy return columns and free authenticated access. Recognized coarse data only.
create or replace function public.write_profile_settings(p_settings jsonb,p_write_id uuid)
returns table(settings jsonb,settings_version bigint,settings_server_updated_at timestamptz,settings_last_write_id uuid)
language plpgsql security definer set search_path = '' as $$
declare subject uuid := auth.uid(); p public.profiles%rowtype; next_settings jsonb; t timestamptz := pg_catalog.clock_timestamp(); ms numeric; prior_ms numeric; id_status text; entry record; supplied text[]; next_revision bigint;
begin
  if subject is null then raise exception 'auth required' using errcode='28000'; end if;
  perform pg_catalog.set_config('lock_timeout','1s',true);
  perform 1 from auth.users where id=subject for no key update;
  if not found then raise exception 'missing account' using errcode='28000'; end if;
  select * into p from public.profiles where id=subject for no key update;
  if p_write_id is null or not private.settings_json_bounded(p_settings) or pg_catalog.jsonb_typeof(p_settings)<>'object' then
    raise exception 'invalid legacy settings' using errcode='22023'; end if;
  if exists(select 1 from pg_catalog.jsonb_object_keys(p_settings) k where k not in ('schemaVersion','globalOn','services','pauses','updatedAt'))
    or (p_settings ? 'schemaVersion' and p_settings->'schemaVersion'<>'1'::jsonb)
    or pg_catalog.jsonb_typeof(p_settings->'globalOn') is distinct from 'boolean'
    or pg_catalog.jsonb_typeof(p_settings->'services') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_settings->'updatedAt') is distinct from 'number' then
    raise exception 'unrecognized legacy settings' using errcode='22023'; end if;
  if (select count(*) from pg_catalog.jsonb_object_keys(p_settings->'services'))<>4 or
    exists(select 1 from pg_catalog.jsonb_each(p_settings->'services') e where e.key not in ('youtube','instagram','facebook','tiktok') or pg_catalog.jsonb_typeof(e.value)<>'boolean') then
    raise exception 'invalid legacy services' using errcode='22023'; end if;
  if p_settings ? 'pauses' and (pg_catalog.jsonb_typeof(p_settings->'pauses')<>'array') then raise exception 'invalid pauses' using errcode='22023'; end if;
  if p_settings ? 'pauses' then
    if exists(select 1 from pg_catalog.jsonb_array_elements(p_settings->'pauses') e where pg_catalog.jsonb_typeof(e)<>'string') then raise exception 'invalid pauses' using errcode='22023'; end if;
  end if;
  ms := (p_settings->>'updatedAt')::numeric;
  if ms<>pg_catalog.trunc(ms) or ms<0 or ms>9007199254740991 or ms>pg_catalog.floor(extract(epoch from t)*1000) then
    raise exception 'legacy timestamp invalid' using errcode='22023'; end if;
  perform pg_catalog.set_config('request.jwt.claim.sub',subject::text,true);
  id_status := private.claim_settings_write(subject,p_write_id,pg_catalog.jsonb_build_object('legacy',p_settings));
  if id_status='conflict' then raise exception 'write id conflict' using errcode='40001'; end if;
  if id_status='duplicate' then
    return query select q.settings,q.settings_version,q.settings_server_updated_at,q.settings_last_write_id from public.profiles q where q.id=subject;
    return;
  end if;
  if p.id is not null and (p.settings_version<0 or p.settings_version>=9007199254740991
    or not private.settings_canonical_valid(p.settings,case when p.settings->'schemaVersion'='2'::jsonb then p.settings_version else greatest(1,p.settings_version) end)) then
    raise exception 'settings recovery required' using errcode='40001'; end if;
  next_revision := case when p.id is null then 1 else greatest(1,p.settings_version)+1 end;
  if exists(select 1 from private.settings_anchors where user_id=subject and modern_used)
    or (p.settings->'schemaVersion'='2'::jsonb and exists(select 1 from pg_catalog.jsonb_each(p.settings->'clocks') c where (c.value->>'localStep')::numeric>0)) then
    raise exception 'settings client upgrade required' using errcode='40001'; end if;
  if ms=0 and p.id is not null then raise exception 'legacy timestamp invalid' using errcode='22023'; end if;
  if p.id is not null then
    prior_ms := (p.settings->>'updatedAt')::numeric;
    if prior_ms<>pg_catalog.trunc(prior_ms) or prior_ms<0 or prior_ms>9007199254740991 then raise exception 'settings recovery required' using errcode='40001'; end if;
    prior_ms := greatest(prior_ms,coalesce(pg_catalog.floor(extract(epoch from p.settings_server_updated_at)*1000),0));
    if ms<=prior_ms then raise exception 'legacy timestamp conflict' using errcode='40001'; end if;
  end if;
  next_settings := coalesce(p.settings,'{}'::jsonb) || (p_settings - 'schemaVersion' - 'pauses');
  if ms=0 then next_settings := pg_catalog.jsonb_set(next_settings,'{updatedAt}',pg_catalog.to_jsonb(pg_catalog.floor(extract(epoch from t)*1000))); end if;
  -- Preserve opaque services, expanded sites and clocks; only genuine supplied fields get baseline.
  next_settings := pg_catalog.jsonb_set(next_settings,'{services}',coalesce(p.settings->'services','{}'::jsonb) || (p_settings->'services'));
  if p.settings->'schemaVersion'='2'::jsonb then
    supplied := array['globalOn','services.youtube','services.instagram','services.facebook','services.tiktok'];
    for entry in select unnest(supplied) as field loop
      next_settings := pg_catalog.jsonb_set(next_settings,array['clocks',entry.field],coalesce(p.settings->'clocks'->entry.field,'{}'::jsonb) || pg_catalog.jsonb_build_object('baseRevision',next_revision,'localStep',0));
    end loop;
  end if;
  if not private.settings_canonical_valid(next_settings,next_revision) then
    raise exception 'settings recovery required' using errcode='40001'; end if;
  insert into public.profiles(id,settings,updated_at,settings_version,settings_server_updated_at,settings_last_write_id)
    values(subject,next_settings,t,next_revision,t,p_write_id)
    on conflict(id) do update set settings=excluded.settings,updated_at=t,settings_version=next_revision,settings_server_updated_at=t,settings_last_write_id=p_write_id;
  return query select q.settings,q.settings_version,q.settings_server_updated_at,q.settings_last_write_id from public.profiles q where q.id=subject;
end $$;
revoke execute on function public.write_profile_settings(jsonb,uuid) from public, anon, service_role;
grant execute on function public.write_profile_settings(jsonb,uuid) to authenticated;

-- CREATE OR REPLACE preserves the retained RPC's postgres owner. Helpers created by the
-- candidate execution role need explicit owner execution across that boundary. No table/key,
-- cleanup, role membership, or client grants are added here.
do $$ declare helper text; begin
  foreach helper in array array[
    'private.settings_json_bounded(jsonb)', 'private.settings_fields()',
    'private.settings_canonical_valid(jsonb,bigint)', 'private.claim_settings_write(uuid,uuid,jsonb)'
  ] loop
    if (select proowner from pg_catalog.pg_proc where oid=helper::regprocedure) is distinct from (
      select oid from pg_catalog.pg_roles where rolname=current_user
    ) then raise exception 'settings helper creator precondition' using errcode='42501'; end if;
  end loop;
  grant usage on schema private to postgres;
  grant execute on function private.settings_json_bounded(jsonb), private.settings_fields(),
    private.settings_canonical_valid(jsonb,bigint), private.claim_settings_write(uuid,uuid,jsonb) to postgres;
end $$;
