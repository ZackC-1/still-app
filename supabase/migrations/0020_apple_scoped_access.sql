-- Source preparation only. Canonical Apple identity is server verified before these narrow RPCs.
-- Accountless Apple rights survive linking/transfer/account deletion. Client roles cannot call RPCs.
alter table private.access_rights add column provider_source text not null default 'revenuecat'
  check (provider_source in ('revenuecat','apple'));
create table private.apple_access_observations (
  environment text not null check(environment in ('sandbox','production')),
  provider_key text not null check(provider_key ~ '^[0-9a-f]{64}$'),
  right_id uuid not null unique references private.access_rights(right_id),
  bundle_id text not null,
  product_id text not null check(product_id = 'still_pro_v3'),
  original_transaction_id text not null check(original_transaction_id ~ '^[1-9][0-9]{0,39}$'),
  token uuid not null,
  deadline timestamptz not null,
  primary key(environment,provider_key)
);
create table private.apple_access_link_operations (
  operation_id uuid primary key,
  environment text not null check(environment in ('sandbox','production')),
  provider_key text not null,
  target_holder uuid references auth.users(id) on delete set null,
  source_holder uuid references auth.users(id) on delete set null,
  expected_revision bigint not null,
  resulting_revision bigint not null,
  status text not null check(status in ('linked','already_linked'))
);
alter table private.apple_access_observations enable row level security;
alter table private.apple_access_link_operations enable row level security;
revoke all on private.apple_access_observations, private.apple_access_link_operations
 from public, anon, authenticated, service_role, still_entitlement_writer;

create function public.begin_apple_access_observation(
 p_key text,p_environment text,p_bundle text,p_product text,p_original text
) returns uuid language plpgsql security definer set search_path=pg_catalog, pg_temp as $$
declare v_token uuid := gen_random_uuid(); v_right uuid; stored private.apple_access_observations%rowtype;
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 if p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_environment is null or p_environment not in ('sandbox','production')
   or p_bundle is null or length(p_bundle)>160 or p_bundle !~ '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$'
   or p_product is distinct from 'still_pro_v3' or p_original is null or p_original !~ '^[1-9][0-9]{0,39}$' then
  raise exception 'invalid Apple identity';
 end if;
 -- Stable random right, independent of auth users; deleting an account cannot destroy local access.
 insert into private.access_rights(environment,provider_key,provider_product,provider_source,active,verified_at)
  values(p_environment,p_key,p_product,'apple',false,0) on conflict(environment,provider_key) do nothing;
 select right_id into v_right from private.access_rights where environment=p_environment and provider_key=p_key and provider_source='apple';
 if v_right is null then raise exception 'Apple identity source conflict'; end if;
 insert into private.apple_access_observations(environment,provider_key,right_id,bundle_id,product_id,original_transaction_id,token,deadline)
  values(p_environment,p_key,v_right,p_bundle,p_product,p_original,v_token,clock_timestamp()+interval '90 seconds')
  on conflict(environment,provider_key) do nothing;
 select * into stored from private.apple_access_observations where environment=p_environment and provider_key=p_key for update;
 if stored.bundle_id<>p_bundle or stored.product_id<>p_product or stored.original_transaction_id<>p_original then
  raise exception 'Apple identity changed';
 end if;
 update private.apple_access_observations set token=v_token,deadline=clock_timestamp()+interval '90 seconds'
  where environment=p_environment and provider_key=p_key;
 return v_token;
end;
$$;

create function public.commit_apple_access_observation(
 p_key text,p_environment text,p_token uuid,p_active boolean,p_target uuid,p_operation uuid,p_revision bigint,p_source uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog, pg_temp as $$
declare observation private.apple_access_observations%rowtype; stored private.access_rights%rowtype;
 operation private.apple_access_link_operations%rowtype; v_status text:='verified';
 v_now bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint; v_previous uuid;
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 select * into observation from private.apple_access_observations where environment=p_environment and provider_key=p_key for update;
 if not found or p_token is null or observation.token<>p_token or observation.deadline<=clock_timestamp() then return '{"status":"stale"}'; end if;
 if p_active is null or (p_target is null and (p_operation is not null or p_revision is not null or p_source is not null))
   or (p_target is not null and (p_operation is null or p_revision is null or p_revision<0 or p_revision>9007199254740990))
   or (p_source is not null and p_source=p_target) then raise exception 'invalid Apple link scope'; end if;
 select * into stored from private.access_rights where right_id=observation.right_id for update;
 -- Refund is authoritative even when an attempted link has stale/conflicting account authority.
 if not p_active or (not stored.active and stored.verified_at>0) then
  if stored.active then
   update private.access_rights set active=false,ownership_revision=ownership_revision+1,verified_at=v_now where right_id=stored.right_id;
   if stored.holder is not null then
    insert into private.access_revocations(holder,environment,right_id,revision) values(stored.holder,p_environment,stored.right_id,stored.ownership_revision+1)
     on conflict(holder,environment,right_id) do update set revision=greatest(private.access_revocations.revision,excluded.revision);
   end if;
  elsif stored.verified_at=0 then
   -- The first canonical observation can already be refunded. Persist that negative fact so
   -- a later stale active receipt cannot activate the otherwise unvalidated placeholder row.
   update private.access_rights set verified_at=v_now where right_id=stored.right_id;
  end if;
  return '{"status":"revoked"}';
 end if;
 if p_target is not null then
  -- Current database account confirmation guards deletion/confirmation races after JWT verification.
  if not exists(select 1 from auth.users where id=p_target and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=clock_timestamp()))
   or (p_source is not null and not exists(select 1 from auth.users where id=p_source and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=clock_timestamp()))) then
   return '{"status":"stale"}';
  end if;
  select * into operation from private.apple_access_link_operations where operation_id=p_operation;
  if found then
   if operation.environment is distinct from p_environment or operation.provider_key is distinct from p_key
     or operation.target_holder is distinct from p_target or operation.source_holder is distinct from p_source
     or operation.expected_revision is distinct from p_revision then raise exception 'Apple retry changed'; end if;
   if stored.holder is distinct from p_target or stored.ownership_revision<>operation.resulting_revision or not stored.active then
    return '{"status":"stale"}';
   end if;
   v_status:=operation.status;
  else
   if stored.holder is not null and stored.holder<>p_target and stored.holder is distinct from p_source then return '{"status":"owned_elsewhere"}'; end if;
   if p_source is not null and stored.holder is distinct from p_source then return '{"status":"stale"}'; end if;
   if stored.ownership_revision<>p_revision then return '{"status":"stale"}'; end if;
   -- A deleted former holder is not silently reclaimed. Revocations preserve historical ownership.
   if stored.holder is null and stored.ownership_revision>0 then return '{"status":"owned_elsewhere"}'; end if;
   if stored.holder=p_target then v_status:='already_linked';
   else
    v_status:='linked';v_previous:=stored.holder;
    update private.access_rights set holder=p_target,ownership_revision=ownership_revision+1 where right_id=stored.right_id returning * into stored;
    if v_previous is not null then
     insert into private.access_revocations(holder,environment,right_id,revision) values(v_previous,p_environment,stored.right_id,stored.ownership_revision)
      on conflict(holder,environment,right_id) do update set revision=greatest(private.access_revocations.revision,excluded.revision);
    end if;
   end if;
   -- Operation collision rolls back the whole mutation; exact replay is checked above.
   insert into private.apple_access_link_operations(operation_id,environment,provider_key,target_holder,source_holder,expected_revision,resulting_revision,status)
    values(p_operation,p_environment,p_key,p_target,p_source,p_revision,stored.ownership_revision,v_status);
  end if;
 end if;
 -- A refunded transaction cannot be resurrected; a new purchase has a new original identity.
 update private.access_rights set active=true,verified_at=v_now where right_id=stored.right_id returning * into stored;
 return jsonb_build_object('status',v_status,'issuer_time',v_now,'right',jsonb_build_object(
  'right',stored.right_id,'holder',coalesce(p_target,stored.right_id),'revision',stored.ownership_revision,'verified_at',v_now));
end;
$$;

create function public.confirm_apple_access_observation(p_key text,p_environment text,p_token uuid,p_right uuid,p_holder uuid,p_revision bigint,p_verified bigint)
returns boolean language plpgsql security definer set search_path=pg_catalog, pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return exists(select 1 from private.apple_access_observations o join private.access_rights r on r.right_id=o.right_id
  where o.provider_key=p_key and o.environment=p_environment and o.token=p_token and o.deadline>clock_timestamp()
   and r.active and r.right_id=p_right and r.ownership_revision=p_revision and r.verified_at=p_verified
   and (p_holder=r.right_id or p_holder=r.holder));
end;
$$;
revoke all on function public.begin_apple_access_observation(text,text,text,text,text),
 public.commit_apple_access_observation(text,text,uuid,boolean,uuid,uuid,bigint,uuid),
 public.confirm_apple_access_observation(text,text,uuid,uuid,uuid,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.begin_apple_access_observation(text,text,text,text,text),
 public.commit_apple_access_observation(text,text,uuid,boolean,uuid,uuid,bigint,uuid),
 public.confirm_apple_access_observation(text,text,uuid,uuid,uuid,bigint,bigint) to still_entitlement_writer;

-- RevenueCat snapshots cannot revoke independent Apple transactions.
create or replace function public.commit_access_observation(
  p_holder uuid, p_environment text, p_token uuid, p_snapshot jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog, pg_temp as $$
declare
  observation private.access_observations%rowtype;
  item jsonb;
  stored private.access_rights%rowtype;
  v_verified bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_conflict boolean := false;
  v_rights jsonb;
  v_observed jsonb;
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
       or (select count(*) from jsonb_object_keys(item)) not between 2 and 3
       or exists(select 1 from jsonb_object_keys(item) k where k not in ('key','product','state'))
       or (item ? 'state' and item->>'state' is distinct from 'revoked')
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
  -- Lock identities in deterministic order; two accounts cannot both claim the same transaction.
  for item in select value from jsonb_array_elements(p_snapshot) order by value->>'key' loop
    if not (item ? 'state') then
      insert into private.access_rights(environment, provider_key, provider_product, holder, active, verified_at)
        values(p_environment, item->>'key', item->>'product', p_holder, true, v_verified)
        on conflict(environment, provider_key) do nothing;
    end if;
    select * into stored from private.access_rights
      where environment = p_environment and provider_key = item->>'key' for update;
    if not found then continue; end if;
    if stored.provider_product <> item->>'product' or stored.provider_source <> 'revenuecat' then
      v_conflict := true;
    elsif item ? 'state' then
      if stored.active and stored.holder is not null then
        insert into private.access_revocations(holder,environment,right_id,revision)
          values(stored.holder,p_environment,stored.right_id,stored.ownership_revision+1)
          on conflict(holder,environment,right_id) do update set revision=greatest(private.access_revocations.revision,excluded.revision);
      end if;
      update private.access_rights set active=false,verified_at=v_verified,
        ownership_revision=ownership_revision+case when active then 1 else 0 end where right_id=stored.right_id;
    elsif stored.holder is distinct from p_holder then
      v_conflict := true;
      -- A different/deleted account is never silently adopted. Explicit transfer is separate.
    else
      update private.access_rights set active = true, verified_at = v_verified,
        ownership_revision = ownership_revision + case when active then 0 else 1 end
        where right_id = stored.right_id;
    end if;
  end loop;
  -- Only explicit canonical refund observations revoke RC rights. A missing/partial listing
  -- cannot erase independent rights or refresh their original offline deadline.
  select coalesce(jsonb_agg(jsonb_build_object(
    'right', right_id, 'holder', holder, 'revision', ownership_revision, 'verified_at', verified_at
  ) order by right_id), '[]'::jsonb) into v_rights
    from private.access_rights where holder = p_holder and environment = p_environment and active;
  select coalesce(jsonb_agg(jsonb_build_object(
    'right',r.right_id,'holder',r.holder,'revision',r.ownership_revision,'verified_at',r.verified_at
  ) order by r.right_id),'[]'::jsonb) into v_observed from private.access_rights r
    where r.holder=p_holder and r.environment=p_environment and r.active and r.provider_source='revenuecat'
      and exists(select 1 from jsonb_array_elements(p_snapshot) as observed_entry(value)
        where observed_entry.value->>'key'=r.provider_key and not (observed_entry.value ? 'state'));
  select coalesce(jsonb_agg(jsonb_build_object('right', right_id, 'revision', revision) order by right_id), '[]'::jsonb)
    into v_revocations from private.access_revocations where holder = p_holder and environment = p_environment;
  v_result := jsonb_build_object('status', case when v_conflict then 'conflict' else 'committed' end,
    'rights', v_rights, 'observed_rights', v_observed, 'revocations', v_revocations, 'issuer_time', v_verified);
  update private.access_observations set snapshot = p_snapshot, result = v_result
    where holder = p_holder and environment = p_environment;
  return v_result;
end;
$$;


-- Generic dual-account transfer remains RevenueCat-only. Apple ownership must pass its
-- transaction-bound link operation ledger, including exact retries of historical operations.
create or replace function public.transfer_access_right(
  p_operation uuid, p_right uuid, p_environment text, p_from uuid, p_to uuid, p_revision bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog, pg_temp as $$
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
    if not exists(select 1 from private.access_rights where right_id=p_right and environment=p_environment and provider_source='revenuecat') then
      return '{"status":"unavailable"}'::jsonb;
    end if;
    return operation.result;
  end if;
  -- Same lock order as commit: observation before transaction. Invalidate both callers' lookups.
  perform 1 from private.access_observations where environment = p_environment
    and holder in (p_from, p_to) order by holder for update;
  select * into stored from private.access_rights
    where right_id = p_right and environment = p_environment for update;
  if not found or not stored.active or stored.provider_source <> 'revenuecat' then return '{"status":"unavailable"}'::jsonb; end if;
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

-- Account reconciliation can refresh only identities previously linked with account authority.
-- Output is private provider identity metadata, never a user-visible or client-callable endpoint.
create function public.read_linked_apple_transactions(p_holder uuid,p_environment text)
returns jsonb language plpgsql security definer set search_path=pg_catalog, pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 if p_holder is null or p_environment is null or p_environment not in ('sandbox','production') then raise exception 'invalid Apple account scope'; end if;
 return coalesce((select jsonb_agg(item) from (select jsonb_build_object(
  'key',o.provider_key,'environment',o.environment,'bundleId',o.bundle_id,'productId',o.product_id,
  'originalTransactionId',o.original_transaction_id,'transactionId',o.original_transaction_id,'active',true) as item
  from private.apple_access_observations o join private.access_rights r on r.right_id=o.right_id
  where r.holder=p_holder and r.environment=p_environment and r.active and r.provider_source='apple'
  order by r.right_id limit 17) source),'[]'::jsonb);
end;
$$;
revoke all on function public.read_linked_apple_transactions(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.read_linked_apple_transactions(uuid,text) to still_entitlement_writer;

-- Removal-only read. A positive observation deadline cannot hide a known refund:
-- no grants, clock renewal, provider absence or account reassociation occurs here.
-- The exact current token still fences superseded requests; historical transfer
-- revocations remain scoped to their independently authenticated former holder.
create function public.read_access_removals(p_holder uuid,p_environment text,p_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog, pg_temp as $$
declare v_token uuid; v_revocations jsonb;
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 if p_holder is null or p_environment is null or p_environment not in ('sandbox','production') or p_token is null then return null; end if;
 if not exists(select 1 from auth.users where id=p_holder and email_confirmed_at is not null and deleted_at is null
   and (banned_until is null or banned_until<=clock_timestamp())) then return null; end if;
 select token into v_token from private.access_observations where holder=p_holder and environment=p_environment for share;
 if not found or v_token<>p_token then return null; end if;
 select coalesce(jsonb_agg(jsonb_build_object('right',right_id,'revision',revision) order by right_id),'[]'::jsonb)
  into v_revocations from (select v.right_id,v.revision from private.access_revocations v
   join private.access_rights r on r.right_id=v.right_id and r.environment=p_environment
   where v.holder=p_holder and v.environment=p_environment order by v.right_id limit 65) scoped;
 if jsonb_array_length(v_revocations)=0 or jsonb_array_length(v_revocations)>64 then return null; end if;
 return jsonb_build_object('holder',p_holder,'environment',p_environment,'revocations',v_revocations,
   'issuer_time',floor(extract(epoch from clock_timestamp())*1000)::bigint);
end;
$$;
revoke all on function public.read_access_removals(uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_access_removals(uuid,text,uuid) to still_entitlement_writer;

-- Retain the exact privacy-preserving limiter policy and ACLs; add only the Apple bucket.
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
  if parts is null or parts[1] not in ('checkout', 'reconcile', 'review-signin:request', 'review-signin:verify', 'settings-sync', 'analytics-erasure-submit', 'analytics-erasure-status', 'analytics-identify', 'apple-access') then
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

-- Fail migration if default ACLs accidentally expose a route or private transaction metadata.
do $$
declare v_role text; v_signature text; v_table text;
begin
 foreach v_role in array array['anon','authenticated','service_role'] loop
  foreach v_signature in array array[
   'public.begin_apple_access_observation(text,text,text,text,text)',
   'public.commit_apple_access_observation(text,text,uuid,boolean,uuid,uuid,bigint,uuid)',
   'public.confirm_apple_access_observation(text,text,uuid,uuid,uuid,bigint,bigint)',
   'public.read_linked_apple_transactions(uuid,text)',
   'public.read_access_removals(uuid,text,uuid)',
   'public.consume_rate_limit(text,integer,integer)',
   'public.transfer_access_right(uuid,uuid,text,uuid,uuid,bigint)'
  ] loop
   if pg_catalog.has_function_privilege(v_role,v_signature,'EXECUTE') then raise exception 'client Apple RPC privilege' using errcode='42501'; end if;
  end loop;
 end loop;
 foreach v_role in array array['anon','authenticated','service_role','still_entitlement_writer'] loop
  foreach v_table in array array['private.apple_access_observations','private.apple_access_link_operations'] loop
   if pg_catalog.has_table_privilege(v_role,v_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_any_column_privilege(v_role,v_table,'SELECT,INSERT,UPDATE,REFERENCES') then
    raise exception 'direct Apple ledger privilege' using errcode='42501';
   end if;
  end loop;
 end loop;
end;
$$;
