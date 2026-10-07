-- Source-only preparation. Deployment requires the existing protected backend operation gate.
-- No sales policy, paid cutoff, owner allowance, protected-free grant or existing row is changed.
-- Only the narrow server writer may observe canonical provider state or transfer a right.
create table private.access_observations (
  holder uuid not null references auth.users(id) on delete cascade,
  environment text not null check (environment in ('sandbox', 'production')),
  token uuid not null,
  deadline timestamptz not null,
  snapshot jsonb,
  result jsonb,
  primary key (holder, environment)
);

create table private.access_rights (
  right_id uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('sandbox', 'production')),
  -- A server hash of the provider's transaction identity, never a client/device identifier.
  provider_key text not null check (provider_key ~ '^[0-9a-f]{64}$'),
  provider_product text not null check (provider_product in ('still_pro_v3', 'still_sync')),
  holder uuid references auth.users(id) on delete set null,
  ownership_revision bigint not null default 0 check (ownership_revision between 0 and 9007199254740991),
  active boolean not null,
  verified_at bigint not null check (verified_at between 0 and 9007196662740991),
  unique (environment, provider_key)
);
alter table private.access_observations enable row level security;
alter table private.access_rights enable row level security;
create table private.access_revocations (
  holder uuid not null references auth.users(id) on delete cascade,
  environment text not null check(environment in ('sandbox', 'production')),
  right_id uuid not null references private.access_rights(right_id),
  revision bigint not null check(revision between 0 and 9007199254740991),
  primary key(holder, environment, right_id)
);
alter table private.access_revocations enable row level security;
create table private.access_transfer_operations (
  operation_id uuid primary key,
  right_id uuid not null references private.access_rights(right_id),
  environment text not null check(environment in ('sandbox', 'production')),
  source_holder uuid references auth.users(id) on delete set null,
  target_holder uuid references auth.users(id) on delete set null,
  expected_revision bigint not null,
  result jsonb not null
);
alter table private.access_transfer_operations enable row level security;
revoke all on table private.access_observations, private.access_rights, private.access_revocations, private.access_transfer_operations
  from public, anon, authenticated, service_role, still_entitlement_writer;

create function public.begin_access_observation(p_holder uuid, p_environment text)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_token uuid := gen_random_uuid();
begin
  if session_user <> 'still_entitlement_writer'
     and not pg_catalog.pg_has_role(session_user, current_user, 'USAGE') then
    raise exception 'server role required' using errcode = '42501';
  end if;
  if p_environment not in ('sandbox', 'production') or p_environment is null then
    raise exception 'invalid access environment';
  end if;
  insert into private.access_observations(holder, environment, token, deadline)
    values(p_holder, p_environment, v_token, clock_timestamp() + interval '20 seconds')
    on conflict(holder, environment) do update
      set token = excluded.token, deadline = excluded.deadline, snapshot = null, result = null;
  return v_token;
end;
$$;

-- Begin happens BEFORE the provider GET. A newer lookup invalidates older in-flight completions.
-- The snapshot contains only fully verified, active, environment-bound lifetime transactions.
create function public.commit_access_observation(
  p_holder uuid, p_environment text, p_token uuid, p_snapshot jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  observation private.access_observations%rowtype;
  item jsonb;
  v_key text;
  stored private.access_rights%rowtype;
  v_verified bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_conflict boolean := false;
  v_rights jsonb;
  v_revocations jsonb;
  v_result jsonb;
begin
  if session_user <> 'still_entitlement_writer'
     and not pg_catalog.pg_has_role(session_user, current_user, 'USAGE') then
    raise exception 'server role required' using errcode = '42501';
  end if;
  select * into observation from private.access_observations
    where holder = p_holder and environment = p_environment for update;
  if not found or p_token is null or observation.token <> p_token then return '{"status":"stale"}'::jsonb; end if;
  if observation.result is not null then
    if observation.snapshot = p_snapshot then return observation.result; end if;
    raise exception 'observation retry changed';
  end if;
  if observation.deadline <= clock_timestamp() then return '{"status":"stale"}'::jsonb; end if;
  if jsonb_typeof(p_snapshot) is distinct from 'array' or jsonb_array_length(p_snapshot) > 16 then
    raise exception 'invalid access snapshot';
  end if;
  for item in select value from jsonb_array_elements(p_snapshot) loop
    if jsonb_typeof(item) is distinct from 'object'
       or (select count(*) from jsonb_object_keys(item)) <> 2
       or jsonb_typeof(item->'key') is distinct from 'string'
       or item->>'key' !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(item->'product') is distinct from 'string'
       or item->>'product' not in ('still_pro_v3', 'still_sync') then
      raise exception 'invalid access transaction';
    end if;
  end loop;
  if (select count(distinct value->>'key') from jsonb_array_elements(p_snapshot)) <> jsonb_array_length(p_snapshot) then
    raise exception 'duplicate access transaction';
  end if;
  -- Lock or insert one sorted union of snapshot and owned keys. Snapshot keys that appear
  -- mid-call must not be locked after a higher owned key. The observation lock fences transfers.
  for v_key in
    select key from (
      select value->>'key' as key from jsonb_array_elements(p_snapshot)
      union
      select r.provider_key from private.access_rights r
        where r.environment = p_environment and r.holder = p_holder
    ) keys order by key
  loop
    select value into item from jsonb_array_elements(p_snapshot) where value->>'key' = v_key;
    if item is not null then
      insert into private.access_rights(environment, provider_key, provider_product, holder, active, verified_at)
        values(p_environment, v_key, item->>'product', p_holder, true, v_verified)
        on conflict(environment, provider_key) do nothing;
    end if;
    select * into stored from private.access_rights
      where environment = p_environment and provider_key = v_key for update;
    if item is null then continue; end if;
    if stored.holder is distinct from p_holder or stored.provider_product <> item->>'product' then
      v_conflict := true;
      -- A different/deleted account is never silently adopted. Explicit transfer is separate.
    else
      update private.access_rights set active = true, verified_at = v_verified,
        ownership_revision = ownership_revision + case when active then 0 else 1 end
        where right_id = stored.right_id;
    end if;
  end loop;
  insert into private.access_revocations(holder, environment, right_id, revision)
    select r.holder, r.environment, r.right_id, r.ownership_revision + 1 from private.access_rights r
    where r.holder = p_holder and r.environment = p_environment and r.active
      and not exists(select 1 from jsonb_array_elements(p_snapshot) s where s->>'key' = r.provider_key)
    on conflict(holder, environment, right_id) do update
      set revision = greatest(private.access_revocations.revision, excluded.revision);
  update private.access_rights r set active = false, ownership_revision = ownership_revision + 1,
    verified_at = v_verified
    where r.holder = p_holder and r.environment = p_environment and r.active
      and not exists(select 1 from jsonb_array_elements(p_snapshot) s where s->>'key' = r.provider_key);
  select coalesce(jsonb_agg(jsonb_build_object(
    'right', right_id, 'holder', holder, 'revision', ownership_revision, 'verified_at', verified_at
  ) order by right_id), '[]'::jsonb) into v_rights
    from private.access_rights where holder = p_holder and environment = p_environment and active;
  select coalesce(jsonb_agg(jsonb_build_object('right', right_id, 'revision', revision) order by right_id), '[]'::jsonb)
    into v_revocations from private.access_revocations where holder = p_holder and environment = p_environment;
  v_result := jsonb_build_object('status', case when v_conflict then 'conflict' else 'committed' end,
    'rights', v_rights, 'revocations', v_revocations, 'issuer_time', v_verified);
  update private.access_observations set snapshot = p_snapshot, result = v_result
    where holder = p_holder and environment = p_environment;
  return v_result;
end;
$$;

-- Final response fence: a refund, newer lookup, transfer or deletion while signing discards reply.
create function public.confirm_access_observation(p_holder uuid, p_environment text, p_token uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare observation private.access_observations%rowtype; item jsonb;
begin
  if session_user <> 'still_entitlement_writer'
     and not pg_catalog.pg_has_role(session_user, current_user, 'USAGE') then
    raise exception 'server role required' using errcode = '42501';
  end if;
  select * into observation from private.access_observations
    where holder = p_holder and environment = p_environment;
  if not found or p_token is null or observation.token <> p_token or observation.result is null
     or observation.deadline <= clock_timestamp() then return false; end if;
  for item in select value from jsonb_array_elements(observation.result->'rights') loop
    if not exists(select 1 from private.access_rights where right_id = (item->>'right')::uuid
      and holder = p_holder and environment = p_environment and active
      and ownership_revision = (item->>'revision')::bigint) then return false; end if;
  end loop;
  return true;
end;
$$;

-- Trusted server primitive only. A future transfer handler must freshly prove both account
-- authorities and the canonical provider association before calling this CAS. No client route.
create function public.transfer_access_right(
  p_operation uuid, p_right uuid, p_environment text, p_from uuid, p_to uuid, p_revision bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare stored private.access_rights%rowtype; operation private.access_transfer_operations%rowtype; result jsonb;
begin
  if session_user <> 'still_entitlement_writer'
     and not pg_catalog.pg_has_role(session_user, current_user, 'USAGE') then
    raise exception 'server role required' using errcode = '42501';
  end if;
  if p_operation is null or p_from is null or p_to is null or p_from = p_to or p_revision is null then
    raise exception 'invalid transfer scope';
  end if;
  -- Operation scope and result are committed in the same transaction as ownership.
  select * into operation from private.access_transfer_operations where operation_id = p_operation;
  if found then
    if operation.right_id is distinct from p_right or operation.environment is distinct from p_environment
       or operation.source_holder is distinct from p_from or operation.target_holder is distinct from p_to
       or operation.expected_revision is distinct from p_revision then raise exception 'transfer retry changed'; end if;
    return operation.result;
  end if;
  -- Same lock order as commit: observation before transaction. Invalidate both callers' lookups.
  perform 1 from private.access_observations where environment = p_environment
    and holder in (p_from, p_to) order by holder for update;
  select * into stored from private.access_rights
    where right_id = p_right and environment = p_environment for update;
  if not found or not stored.active then return '{"status":"unavailable"}'::jsonb; end if;
  -- A concurrent identical retry may have waited for the first mutation's right lock.
  select * into operation from private.access_transfer_operations where operation_id = p_operation;
  if found then
    if operation.right_id is distinct from p_right or operation.environment is distinct from p_environment
       or operation.source_holder is distinct from p_from or operation.target_holder is distinct from p_to
       or operation.expected_revision is distinct from p_revision then raise exception 'transfer retry changed'; end if;
    return operation.result;
  end if;
  if stored.holder is distinct from p_from or stored.ownership_revision <> p_revision then
    return '{"status":"conflict"}'::jsonb;
  end if;
  update private.access_rights set holder = p_to, ownership_revision = ownership_revision + 1
    where right_id = p_right;
  insert into private.access_revocations(holder, environment, right_id, revision)
    values(p_from, p_environment, p_right, p_revision + 1)
    on conflict(holder, environment, right_id) do update
      set revision = greatest(private.access_revocations.revision, excluded.revision);
  update private.access_observations set token = gen_random_uuid(), snapshot = null, result = null
    where environment = p_environment and holder in (p_from, p_to);
  result := jsonb_build_object('status','transferred','revision',p_revision + 1);
  -- Concurrent reuse of an operation id for another request aborts/rolls back the entire mutation.
  insert into private.access_transfer_operations(operation_id, right_id, environment, source_holder, target_holder, expected_revision, result)
    values(p_operation, p_right, p_environment, p_from, p_to, p_revision, result);
  return result;
end;
$$;

revoke all on function public.begin_access_observation(uuid, text),
  public.commit_access_observation(uuid, text, uuid, jsonb),
  public.confirm_access_observation(uuid, text, uuid),
  public.transfer_access_right(uuid, uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_access_observation(uuid, text),
  public.commit_access_observation(uuid, text, uuid, jsonb),
  public.confirm_access_observation(uuid, text, uuid),
  public.transfer_access_right(uuid, uuid, text, uuid, uuid, bigint)
  to still_entitlement_writer;

-- Catch direct default grants and accidental client/role reachability at application time.
do $$
declare role_name text; signature text; table_name text;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    foreach signature in array array[
      'public.begin_access_observation(uuid,text)',
      'public.commit_access_observation(uuid,text,uuid,jsonb)',
      'public.confirm_access_observation(uuid,text,uuid)',
      'public.transfer_access_right(uuid,uuid,text,uuid,uuid,bigint)'
    ] loop
      if pg_catalog.has_function_privilege(role_name, signature, 'EXECUTE') then
        raise exception 'client access RPC privilege' using errcode = '42501';
      end if;
    end loop;
  end loop;
  foreach role_name in array array['anon','authenticated','service_role','still_entitlement_writer'] loop
    foreach table_name in array array['private.access_observations','private.access_rights','private.access_revocations','private.access_transfer_operations'] loop
      if pg_catalog.has_table_privilege(role_name, table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or pg_catalog.has_any_column_privilege(role_name, table_name, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'direct access ledger privilege' using errcode = '42501';
      end if;
    end loop;
  end loop;
end;
$$;
