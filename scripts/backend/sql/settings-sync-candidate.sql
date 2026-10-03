-- Unnumbered candidate. Deploy only with separately reviewed target/authority approval.
-- Private helpers trust ONLY the authenticated edge adapter, on the dedicated role.
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'still_settings_writer') then
    create role still_settings_writer nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
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
revoke all on private.settings_anchors, private.settings_writes from public, anon, authenticated, service_role, still_settings_writer;

create function private.lock_settings(p_subject uuid, p_lineage uuid, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.profiles%rowtype; a private.settings_anchors%rowtype; found_profile boolean;
begin
  if p_subject is null or p_subject::text is distinct from pg_catalog.current_setting('request.jwt.claim.sub', true) then
    raise exception 'subject mismatch' using errcode = '28000';
  end if;
  -- The auth row serializes even missing profiles/anchors and blocks deletion throughout MAC verification.
  perform 1 from auth.users where id = p_subject for update;
  if not found then raise exception 'missing account' using errcode = '28000'; end if;
  insert into private.settings_anchors(user_id,lineage,secret)
    values(p_subject,p_lineage,pg_catalog.decode(p_key,'hex')) on conflict(user_id) do nothing;
  select * into a from private.settings_anchors where user_id=p_subject for update;
  select * into p from public.profiles where id=p_subject for update;
  found_profile := found;
  return pg_catalog.jsonb_build_object('lineage',a.lineage,'key',pg_catalog.encode(a.secret,'hex'),
    'revision',case when not found_profile then 0 else case when p.settings->'schemaVersion'='2'::jsonb then p.settings_version else greatest(1,p.settings_version) end end,
    'settings',case when found_profile then p.settings else null end,'empty',not found_profile,
    'updated_at',p.settings_server_updated_at,'write_id',p.settings_last_write_id,
    'now',pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000));
end $$;

-- Thirty-day identity retention is a settings-only engineering bound. Expired retries retain their original stamps.
create function private.claim_settings_write(p_subject uuid,p_id uuid,p_body jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare prior jsonb;
begin
  if p_subject::text is distinct from pg_catalog.current_setting('request.jwt.claim.sub',true) or p_id is null then
    raise exception 'subject mismatch' using errcode='28000';
  end if;
  perform 1 from auth.users where id=p_subject for update;
  if not found then raise exception 'missing account' using errcode='28000'; end if;
  delete from private.settings_writes where user_id=p_subject and created_at < pg_catalog.clock_timestamp()-interval '30 days';
  select body into prior from private.settings_writes where user_id=p_subject and write_id=p_id;
  if found then return case when prior=p_body then 'duplicate' else 'conflict' end; end if;
  insert into private.settings_writes(user_id,write_id,body) values(p_subject,p_id,p_body);
  return 'new';
end $$;

create function private.commit_settings(p_subject uuid,p_lineage uuid,p_revision bigint,p_raw jsonb,p_next jsonb,p_id uuid,p_receipt_revision bigint,p_operations jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare a private.settings_anchors%rowtype; p public.profiles%rowtype; revision bigint; op jsonb; t timestamptz;
begin
  if p_subject::text is distinct from pg_catalog.current_setting('request.jwt.claim.sub',true) then
    raise exception 'subject mismatch' using errcode='28000';
  end if;
  perform 1 from auth.users where id=p_subject for update;
  if not found then raise exception 'missing account' using errcode='28000'; end if;
  select * into a from private.settings_anchors where user_id=p_subject for update;
  if not found or a.lineage is distinct from p_lineage then raise exception 'lineage changed' using errcode='40001'; end if;
  select * into p from public.profiles where id=p_subject for update;
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
grant execute on function public.consume_rate_limit(text,integer,integer) to still_settings_writer;

-- Retain legacy return columns and free authenticated access. Recognized coarse data only.
create or replace function public.write_profile_settings(p_settings jsonb,p_write_id uuid)
returns table(settings jsonb,settings_version bigint,settings_server_updated_at timestamptz,settings_last_write_id uuid)
language plpgsql security definer set search_path = '' as $$
declare subject uuid := auth.uid(); p public.profiles%rowtype; next_settings jsonb; t timestamptz := pg_catalog.clock_timestamp(); ms numeric; prior_ms numeric; id_status text; entry record; supplied text[];
begin
  if subject is null then raise exception 'auth required' using errcode='28000'; end if;
  perform 1 from auth.users where id=subject for update;
  if not found then raise exception 'missing account' using errcode='28000'; end if;
  select * into p from public.profiles where id=subject for update;
  if p_write_id is null or p_settings is null or pg_catalog.jsonb_typeof(p_settings)<>'object' or pg_catalog.octet_length(p_settings::text)>65536 then
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
  if exists(select 1 from private.settings_anchors where user_id=subject and modern_used)
    or (p.settings->'schemaVersion'='2'::jsonb and exists(select 1 from pg_catalog.jsonb_each(p.settings->'clocks') c where (c.value->>'localStep')::bigint>0)) then
    raise exception 'settings client upgrade required' using errcode='40001'; end if;
  if ms=0 and p.id is not null then raise exception 'legacy timestamp invalid' using errcode='22023'; end if;
  if p.id is not null then
    if pg_catalog.jsonb_typeof(p.settings)<>'object' or pg_catalog.octet_length(p.settings::text)>65536
      or (p.settings ? 'schemaVersion' and p.settings->'schemaVersion' not in ('1'::jsonb,'2'::jsonb))
      or pg_catalog.jsonb_typeof(p.settings->'globalOn') is distinct from 'boolean'
      or pg_catalog.jsonb_typeof(p.settings->'services') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p.settings->'updatedAt') is distinct from 'number' then
      raise exception 'settings recovery required' using errcode='40001'; end if;
    if exists(select 1 from pg_catalog.jsonb_each(p.settings->'services') e where e.key in ('youtube','instagram','facebook','tiktok') and pg_catalog.jsonb_typeof(e.value)<>'boolean')
      or (p.settings ? 'sites' and pg_catalog.jsonb_typeof(p.settings->'sites')<>'object')
      or (p.settings->'schemaVersion'='2'::jsonb and pg_catalog.jsonb_typeof(p.settings->'clocks') is distinct from 'object') then
      raise exception 'settings recovery required' using errcode='40001'; end if;
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
      next_settings := pg_catalog.jsonb_set(next_settings,array['clocks',entry.field],coalesce(p.settings->'clocks'->entry.field,'{}'::jsonb) || pg_catalog.jsonb_build_object('baseRevision',p.settings_version+1,'localStep',0));
    end loop;
  end if;
  insert into public.profiles(id,settings,updated_at,settings_version,settings_server_updated_at,settings_last_write_id)
    values(subject,next_settings,t,1,t,p_write_id)
    on conflict(id) do update set settings=excluded.settings,updated_at=t,settings_version=greatest(1,public.profiles.settings_version)+1,settings_server_updated_at=t,settings_last_write_id=p_write_id;
  return query select q.settings,q.settings_version,q.settings_server_updated_at,q.settings_last_write_id from public.profiles q where q.id=subject;
end $$;
revoke execute on function public.write_profile_settings(jsonb,uuid) from public, anon, service_role;
grant execute on function public.write_profile_settings(jsonb,uuid) to authenticated;
