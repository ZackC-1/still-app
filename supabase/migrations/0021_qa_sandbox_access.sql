-- Forward source preparation ONLY: reviewed protected apply and real cloud rehearsal required.
-- Public live RPC bodies change to compatibility wrappers; disabling QA is not a rollback.
-- Exact prior definitions/ACL rollback lives in scripts/backend/deploy/rollback/0021_qa_sandbox_access.sql.
-- No existing row, sales policy, legacy entitlement projection or historical provider mapping changes.
begin;
-- Rehearse/apply as the same ordinary PG17 postgres CREATEROLE operator as hosted Supabase.
do $$
begin
 if current_user<>'postgres' or session_user<>'postgres' or current_setting('server_version_num')::integer<170000
  or not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and not rolsuper and rolcreaterole) then
  raise exception 'ordinary PostgreSQL17 postgres operator required';
 end if;
end;
$$;
create role still_qa_sandbox_writer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role still_qa_sandbox_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role still_qa_sandbox_writer set lock_timeout='1s';
alter role still_qa_sandbox_writer set statement_timeout='2s';
alter role still_qa_sandbox_writer set idle_in_transaction_session_timeout='5s';
alter role still_qa_sandbox_writer set log_parameter_max_length=0;
alter role still_qa_sandbox_writer set log_parameter_max_length_on_error=0;
grant usage on schema public to still_qa_sandbox_writer;
grant usage on schema public, private, extensions to still_qa_sandbox_owner;
-- No login inherits or can SET ROLE to the wrapper owner. Provision only writer LOGIN later.
-- Auth is Supabase-owned: narrowly delegated status reads use the existing postgres-definer helper.
-- No attempted direct Auth schema/table grant to the QA wrapper owner.

create table private.qa_sandbox_subjects (
 holder uuid primary key references auth.users(id) on delete cascade,
 enabled boolean not null default false,
 revision bigint not null default 0 check(revision between 0 and 9007199254740991)
);
-- Operator updates acquire the same subject row lock as positive wrappers. Never delete a
-- membership as a disable operation: existing bound negative recovery must remain reachable.
create table private.qa_sandbox_negative_rights (
 right_id uuid primary key references private.access_rights(right_id),
 environment text not null default 'sandbox' check(environment='sandbox'),
 revoked_at timestamptz not null default clock_timestamp()
);
create table private.qa_sandbox_purchase_operations (
 operation_id uuid primary key,
 holder uuid not null references auth.users(id) on delete cascade,
 environment text not null default 'sandbox' check(environment='sandbox'),
 configuration_hash text not null check(configuration_hash ~ '^[0-9a-f]{64}$'),
 stripe_session_id text unique check(stripe_session_id ~ '^cs_test_[A-Za-z0-9_]{1,240}$'),
 status text not null default 'prepared' check(status in ('prepared','session_bound','paid_verified','import_pending','imported','access_observed','recovery_required','refunded','closed_unpaid')),
 creation_started_at timestamptz,
 paid_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
-- Unknown create/import outcomes retain the original operation: no second-charge permission.
create unique index qa_sandbox_one_open_checkout on private.qa_sandbox_purchase_operations(holder)
 where status not in ('refunded','closed_unpaid');
create table private.qa_sandbox_rate_windows (
 window_start timestamptz primary key,
 secret bytea not null check(octet_length(secret)=32),
 expires_at timestamptz not null
);
create table private.qa_sandbox_rate_counters (
 bucket_key text not null,
 window_start timestamptz not null references private.qa_sandbox_rate_windows(window_start) on delete cascade,
 count integer not null check(count between 1 and 61),
 primary key(bucket_key,window_start)
);
grant select,insert,update(token,deadline,snapshot,result) on private.access_observations to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.access_observations to still_qa_sandbox_owner using(environment='sandbox') with check(environment='sandbox');
grant select,insert,update(holder,ownership_revision,active,verified_at) on private.access_rights to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.access_rights to still_qa_sandbox_owner using(environment='sandbox') with check(environment='sandbox');
grant select,insert,update(revision) on private.access_revocations to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.access_revocations to still_qa_sandbox_owner using(environment='sandbox') with check(environment='sandbox');
grant select,insert on private.access_transfer_operations to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.access_transfer_operations to still_qa_sandbox_owner using(environment='sandbox') with check(environment='sandbox');
grant select,insert,update(token,deadline) on private.apple_access_observations to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.apple_access_observations to still_qa_sandbox_owner using(environment='sandbox') with check(environment='sandbox');
grant select,insert on private.apple_access_link_operations to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.apple_access_link_operations to still_qa_sandbox_owner using(environment='sandbox') with check(environment='sandbox');
alter table private.qa_sandbox_subjects enable row level security;
revoke all on private.qa_sandbox_subjects from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant select,update(revision) on private.qa_sandbox_subjects to still_qa_sandbox_owner; -- UPDATE privilege required for FOR UPDATE; no RPC mutates membership.
create policy qa_sandbox_owner on private.qa_sandbox_subjects to still_qa_sandbox_owner using(true) with check(true);
alter table private.qa_sandbox_negative_rights enable row level security;
revoke all on private.qa_sandbox_negative_rights from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant select,insert on private.qa_sandbox_negative_rights to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.qa_sandbox_negative_rights to still_qa_sandbox_owner using(true) with check(true);
alter table private.qa_sandbox_purchase_operations enable row level security;
revoke all on private.qa_sandbox_purchase_operations from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant select,insert,update on private.qa_sandbox_purchase_operations to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.qa_sandbox_purchase_operations to still_qa_sandbox_owner using(true) with check(true);
alter table private.qa_sandbox_rate_windows enable row level security;
revoke all on private.qa_sandbox_rate_windows from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant select,insert,delete,update(expires_at) on private.qa_sandbox_rate_windows to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.qa_sandbox_rate_windows to still_qa_sandbox_owner using(true) with check(true);
alter table private.qa_sandbox_rate_counters enable row level security;
revoke all on private.qa_sandbox_rate_counters from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant select,insert,update(count) on private.qa_sandbox_rate_counters to still_qa_sandbox_owner;
create policy qa_sandbox_owner on private.qa_sandbox_rate_counters to still_qa_sandbox_owner using(true) with check(true);

-- Shared literal body from latest 0019/0020 begin_access_observation; no catalog/body rewrite at apply.
create function private.begin_access_observation_core(p_holder uuid, p_environment text) returns uuid
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare v_token uuid := gen_random_uuid();
begin
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
revoke all on function private.begin_access_observation_core(uuid, text) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.begin_access_observation_core(uuid, text) to still_qa_sandbox_owner;
create or replace function public.begin_access_observation(p_holder uuid, p_environment text) returns uuid
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return private.begin_access_observation_core(p_holder, p_environment);
end;
$$;

-- Shared literal body from latest 0019/0020 commit_access_observation; no catalog/body rewrite at apply.
create function private.commit_access_observation_core(
  p_holder uuid, p_environment text, p_token uuid, p_snapshot jsonb
) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
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
revoke all on function private.commit_access_observation_core(uuid, text, uuid, jsonb) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.commit_access_observation_core(uuid, text, uuid, jsonb) to still_qa_sandbox_owner;
create or replace function public.commit_access_observation(
  p_holder uuid, p_environment text, p_token uuid, p_snapshot jsonb
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return private.commit_access_observation_core(p_holder, p_environment, p_token, p_snapshot);
end;
$$;

-- Shared literal body from latest 0019/0020 confirm_access_observation; no catalog/body rewrite at apply.
create function private.confirm_access_observation_core(p_holder uuid, p_environment text, p_token uuid) returns boolean
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare observation private.access_observations%rowtype; item jsonb;
begin
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
revoke all on function private.confirm_access_observation_core(uuid, text, uuid) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.confirm_access_observation_core(uuid, text, uuid) to still_qa_sandbox_owner;
create or replace function public.confirm_access_observation(p_holder uuid, p_environment text, p_token uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return private.confirm_access_observation_core(p_holder, p_environment, p_token);
end;
$$;

-- Shared literal body from latest 0019/0020 transfer_access_right; no catalog/body rewrite at apply.
create function private.transfer_access_right_core(
  p_operation uuid, p_right uuid, p_environment text, p_from uuid, p_to uuid, p_revision bigint
) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare stored private.access_rights%rowtype; operation private.access_transfer_operations%rowtype; result jsonb;
begin
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
revoke all on function private.transfer_access_right_core(uuid, uuid, text, uuid, uuid, bigint) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.transfer_access_right_core(uuid, uuid, text, uuid, uuid, bigint) to still_qa_sandbox_owner;
create or replace function public.transfer_access_right(
  p_operation uuid, p_right uuid, p_environment text, p_from uuid, p_to uuid, p_revision bigint
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return private.transfer_access_right_core(p_operation, p_right, p_environment, p_from, p_to, p_revision);
end;
$$;

-- Shared literal body from latest 0019/0020 begin_apple_access_observation; no catalog/body rewrite at apply.
create function private.begin_apple_access_observation_core(
 p_key text,p_environment text,p_bundle text,p_product text,p_original text
) returns uuid
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare v_token uuid := gen_random_uuid(); v_right uuid; stored private.apple_access_observations%rowtype;
begin
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
revoke all on function private.begin_apple_access_observation_core(text, text, text, text, text) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.begin_apple_access_observation_core(text, text, text, text, text) to still_qa_sandbox_owner;
create or replace function public.begin_apple_access_observation(
 p_key text,p_environment text,p_bundle text,p_product text,p_original text
) returns uuid
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return private.begin_apple_access_observation_core(p_key, p_environment, p_bundle, p_product, p_original);
end;
$$;

-- Shared literal body from latest 0019/0020 commit_apple_access_observation; no catalog/body rewrite at apply.
create function private.commit_apple_access_observation_core(
 p_key text,p_environment text,p_token uuid,p_active boolean,p_target uuid,p_operation uuid,p_revision bigint,p_source uuid
) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare observation private.apple_access_observations%rowtype; stored private.access_rights%rowtype;
 operation private.apple_access_link_operations%rowtype; v_status text:='verified';
 v_now bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint; v_previous uuid;
begin
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
  if not private.qa_sandbox_confirmed_account(p_target,true,false)
   or (p_source is not null and not private.qa_sandbox_confirmed_account(p_source,true,false)) then
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
revoke all on function private.commit_apple_access_observation_core(text, text, uuid, boolean, uuid, uuid, bigint, uuid) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.commit_apple_access_observation_core(text, text, uuid, boolean, uuid, uuid, bigint, uuid) to still_qa_sandbox_owner;
create or replace function public.commit_apple_access_observation(
 p_key text,p_environment text,p_token uuid,p_active boolean,p_target uuid,p_operation uuid,p_revision bigint,p_source uuid
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return private.commit_apple_access_observation_core(p_key, p_environment, p_token, p_active, p_target, p_operation, p_revision, p_source);
end;
$$;

-- Shared literal body from latest 0019/0020 confirm_apple_access_observation; no catalog/body rewrite at apply.
create function private.confirm_apple_access_observation_core(p_key text,p_environment text,p_token uuid,p_right uuid,p_holder uuid,p_revision bigint,p_verified bigint) returns boolean
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
begin
 return exists(select 1 from private.apple_access_observations o join private.access_rights r on r.right_id=o.right_id
  where o.provider_key=p_key and o.environment=p_environment and o.token=p_token and o.deadline>clock_timestamp()
   and r.active and r.right_id=p_right and r.ownership_revision=p_revision and r.verified_at=p_verified
   and (p_holder=r.right_id or p_holder=r.holder));
end;
$$;
revoke all on function private.confirm_apple_access_observation_core(text, text, uuid, uuid, uuid, bigint, bigint) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.confirm_apple_access_observation_core(text, text, uuid, uuid, uuid, bigint, bigint) to still_qa_sandbox_owner;
create or replace function public.confirm_apple_access_observation(p_key text,p_environment text,p_token uuid,p_right uuid,p_holder uuid,p_revision bigint,p_verified bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return private.confirm_apple_access_observation_core(p_key, p_environment, p_token, p_right, p_holder, p_revision, p_verified);
end;
$$;

-- Shared literal body from latest 0019/0020 read_linked_apple_transactions; no catalog/body rewrite at apply.
create function private.read_linked_apple_transactions_core(p_holder uuid,p_environment text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
begin
 if p_holder is null or p_environment is null or p_environment not in ('sandbox','production') then raise exception 'invalid Apple account scope'; end if;
 return coalesce((select jsonb_agg(item) from (select jsonb_build_object(
  'key',o.provider_key,'environment',o.environment,'bundleId',o.bundle_id,'productId',o.product_id,
  'originalTransactionId',o.original_transaction_id,'transactionId',o.original_transaction_id,'active',true) as item
  from private.apple_access_observations o join private.access_rights r on r.right_id=o.right_id
  where r.holder=p_holder and r.environment=p_environment and r.active and r.provider_source='apple'
  order by r.right_id limit 17) source),'[]'::jsonb);
end;
$$;
revoke all on function private.read_linked_apple_transactions_core(uuid, text) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.read_linked_apple_transactions_core(uuid, text) to still_qa_sandbox_owner;
create or replace function public.read_linked_apple_transactions(p_holder uuid,p_environment text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return private.read_linked_apple_transactions_core(p_holder, p_environment);
end;
$$;

-- Shared literal body from latest 0019/0020 read_access_removals; no catalog/body rewrite at apply.
create function private.read_access_removals_core(p_holder uuid,p_environment text,p_token uuid,p_confirmed_required boolean default true) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare v_token uuid; v_revocations jsonb;
begin
 if p_holder is null or p_environment is null or p_environment not in ('sandbox','production') or p_token is null then return null; end if;
 if p_confirmed_required and not private.qa_sandbox_confirmed_account(p_holder,true,false) then return null; end if;
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
revoke all on function private.read_access_removals_core(uuid, text, uuid, boolean) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.read_access_removals_core(uuid, text, uuid, boolean) to still_qa_sandbox_owner;
create or replace function public.read_access_removals(p_holder uuid,p_environment text,p_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 return private.read_access_removals_core(p_holder, p_environment, p_token);
end;
$$;

-- Internal helpers execute as the nonlogin wrapper owner; the QA login cannot invoke them.
create function private.qa_sandbox_session() returns void
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
begin
 if session_user <> 'still_qa_sandbox_writer' then
  raise exception 'QA server role required' using errcode='42501';
 end if;
end;
$$;
revoke all on function private.qa_sandbox_session() from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.qa_sandbox_session() to still_qa_sandbox_owner;

-- Managed Auth reads stay under postgres; no direct Auth grant to the QA owner is needed.
-- QA admission requires an existing locked row by default. Production compatibility calls
-- explicitly permit a missing row and keep their previous nonlocking status-read behavior.
create function private.qa_sandbox_confirmed_account(p_holder uuid,p_allow_missing boolean default false,p_lock boolean default true) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare confirmed boolean;
begin
 if session_user not in ('still_qa_sandbox_writer','still_entitlement_writer') and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'server role required' using errcode='42501';
 end if;
 if p_allow_missing is null or p_lock is null then raise exception 'invalid account read scope'; end if;
 if p_lock then
  select email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=clock_timestamp())
   into confirmed from auth.users where id=p_holder for share;
 else
  select email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=clock_timestamp())
   into confirmed from auth.users where id=p_holder;
 end if;
 if not found and not p_allow_missing then raise exception 'QA account unavailable' using errcode='42501'; end if;
 return coalesce(confirmed,false);
end;
$$;
revoke all on function private.qa_sandbox_confirmed_account(uuid,boolean,boolean) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.qa_sandbox_confirmed_account(uuid,boolean,boolean) to still_qa_sandbox_owner;

create function private.qa_sandbox_subject(p_holder uuid,p_positive boolean) returns boolean
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare admitted boolean; confirmed boolean;
begin
 perform private.qa_sandbox_session();
 -- Auth row before membership: deletion's auth FK cascades use the same order.
 confirmed:=private.qa_sandbox_confirmed_account(p_holder);
 select enabled into admitted from private.qa_sandbox_subjects where holder=p_holder for update;
 if not found then
  raise exception 'QA account unavailable' using errcode='42501';
 end if;
 admitted:=admitted and confirmed;
 if p_positive and not admitted then raise exception 'QA membership disabled' using errcode='42501'; end if;
 return admitted;
end;
$$;
revoke all on function private.qa_sandbox_subject(uuid,boolean) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer;
grant execute on function private.qa_sandbox_subject(uuid,boolean) to still_qa_sandbox_owner;

create function public.qa_sandbox_account_enabled(p_holder uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform private.qa_sandbox_session();
 return exists(select 1 from private.qa_sandbox_subjects q where q.holder=p_holder and q.enabled)
  and private.qa_sandbox_confirmed_account(p_holder,true,false);
end;
$$;

-- Disabled registered subjects can acquire a current negative-read fence. This grants no right.
create function public.qa_sandbox_begin_access_observation(p_holder uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform private.qa_sandbox_subject(p_holder,false);
 return private.begin_access_observation_core(p_holder,'sandbox');
end;
$$;

create function public.qa_sandbox_commit_access_observation(p_holder uuid,p_token uuid,p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare admitted boolean; observation private.access_observations%rowtype; item jsonb;
 stored private.access_rights%rowtype; filtered jsonb:='[]'; result jsonb;
begin
 admitted:=private.qa_sandbox_subject(p_holder,false);
 select * into observation from private.access_observations where holder=p_holder and environment='sandbox' for update;
 if not found or p_token is null or observation.token<>p_token or observation.deadline<=clock_timestamp() then return '{"status":"stale"}'; end if;
 if jsonb_typeof(p_snapshot) is distinct from 'array' or jsonb_array_length(p_snapshot)>16 then raise exception 'invalid access snapshot'; end if;
 for item in select value from jsonb_array_elements(p_snapshot) order by value->>'key' loop
  -- Lock existing transaction identity before checking the permanent QA-only negative fence.
  select * into stored from private.access_rights where environment='sandbox' and provider_key=item->>'key' for update;
  if item ? 'state' then
   if item->>'state' is distinct from 'revoked' or stored.right_id is null or (stored.holder is distinct from p_holder and not exists(select 1 from private.access_transfer_operations transfer
     where transfer.right_id=stored.right_id and transfer.environment='sandbox' and transfer.source_holder=p_holder))
    or stored.provider_source<>'revenuecat' or stored.provider_product is distinct from item->>'product' then
    raise exception 'unknown QA negative transaction' using errcode='42501';
   end if;
   insert into private.qa_sandbox_negative_rights(right_id) values(stored.right_id) on conflict do nothing;
  else
   if not admitted then raise exception 'QA membership disabled' using errcode='42501'; end if;
   if stored.right_id is not null and stored.holder=p_holder and exists(select 1 from private.qa_sandbox_negative_rights where right_id=stored.right_id) then
    -- A delayed verified-active listing cannot resurrect a canonical QA refund.
    item:=item||'{"state":"revoked"}'::jsonb;
   end if;
  end if;
  filtered:=filtered||jsonb_build_array(item);
 end loop;
 result:=private.commit_access_observation_core(p_holder,'sandbox',p_token,filtered);
 if not admitted and result->>'status'<>'stale' then
  result:=result||'{"rights":[],"observed_rights":[]}'::jsonb;
 end if;
 return result;
end;
$$;

create function public.qa_sandbox_confirm_access_observation(p_holder uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if not private.qa_sandbox_subject(p_holder,false) then return false; end if;
 return private.confirm_access_observation_core(p_holder,'sandbox',p_token);
end;
$$;
create function public.qa_sandbox_read_access_removals(p_holder uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform private.qa_sandbox_subject(p_holder,false);
 return private.read_access_removals_core(p_holder,'sandbox',p_token,false);
end;
$$;
create function public.qa_sandbox_transfer_access_right(p_operation uuid,p_right uuid,p_from uuid,p_to uuid,p_revision bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare subject uuid;
begin
 perform private.qa_sandbox_session();
 if p_from is null or p_to is null or p_from=p_to then raise exception 'invalid transfer scope'; end if;
 for subject in select holder from unnest(array[p_from,p_to]) holder order by holder loop
  perform private.qa_sandbox_subject(subject,true);
 end loop;
 if exists(select 1 from private.qa_sandbox_negative_rights where right_id=p_right) then return '{"status":"unavailable"}'; end if;
 return private.transfer_access_right_core(p_operation,p_right,'sandbox',p_from,p_to,p_revision);
end;
$$;

-- Anonymous native verification has no account/link/operation argument and cannot reassociate.
create function public.qa_sandbox_begin_apple_access_observation(p_key text,p_bundle text,p_product text,p_original text) returns uuid
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform private.qa_sandbox_session();
 return private.begin_apple_access_observation_core(p_key,'sandbox',p_bundle,p_product,p_original);
end;
$$;
create function public.qa_sandbox_commit_apple_local(p_key text,p_token uuid,p_active boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform private.qa_sandbox_session();
 return private.commit_apple_access_observation_core(p_key,'sandbox',p_token,p_active,null,null,null,null);
end;
$$;
create function public.qa_sandbox_commit_apple_link(p_key text,p_token uuid,p_active boolean,p_target uuid,p_operation uuid,p_revision bigint,p_source uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare subject uuid;
begin
 perform private.qa_sandbox_session();
 if p_active is false then
  -- Negative canonical Apple evidence is transaction-bound and ignores rejected link authority.
  return private.commit_apple_access_observation_core(p_key,'sandbox',p_token,false,null,null,null,null);
 end if;
 if p_active is null or p_target is null then raise exception 'invalid Apple link scope'; end if;
 for subject in select distinct holder from unnest(array[p_target,p_source]) holder where holder is not null order by holder loop
  perform private.qa_sandbox_subject(subject,true);
 end loop;
 return private.commit_apple_access_observation_core(p_key,'sandbox',p_token,p_active,p_target,p_operation,p_revision,p_source);
end;
$$;
create function public.qa_sandbox_confirm_apple_local(p_key text,p_token uuid,p_right uuid,p_revision bigint,p_verified bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform private.qa_sandbox_session();
 return private.confirm_apple_access_observation_core(p_key,'sandbox',p_token,p_right,p_right,p_revision,p_verified);
end;
$$;
create function public.qa_sandbox_confirm_apple_account(p_key text,p_token uuid,p_right uuid,p_holder uuid,p_revision bigint,p_verified bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if not private.qa_sandbox_subject(p_holder,false) then return false; end if;
 return private.confirm_apple_access_observation_core(p_key,'sandbox',p_token,p_right,p_holder,p_revision,p_verified);
end;
$$;
create function public.qa_sandbox_read_linked_apple_transactions(p_holder uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform private.qa_sandbox_subject(p_holder,false);
 return private.read_linked_apple_transactions_core(p_holder,'sandbox');
end;
$$;

create function public.qa_sandbox_prepare_checkout_operation(p_operation uuid,p_holder uuid,p_configuration_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare stored private.qa_sandbox_purchase_operations%rowtype;
begin
 perform private.qa_sandbox_subject(p_holder,true);
 if p_operation is null or p_configuration_hash is null or p_configuration_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid QA checkout scope'; end if;
 select * into stored from private.qa_sandbox_purchase_operations where operation_id=p_operation for update;
 if found then
  if stored.holder is distinct from p_holder or stored.configuration_hash is distinct from p_configuration_hash then raise exception 'checkout retry changed'; end if;
  return to_jsonb(stored);
 end if;
 select * into stored from private.qa_sandbox_purchase_operations where holder=p_holder and status not in ('refunded','closed_unpaid') for update;
 if found then
  if stored.configuration_hash is distinct from p_configuration_hash then raise exception 'unresolved checkout configuration changed'; end if;
  return to_jsonb(stored); -- Lost acknowledgement recovers the same immutable attempt.
 end if;
 insert into private.qa_sandbox_purchase_operations(operation_id,holder,configuration_hash)
  values(p_operation,p_holder,p_configuration_hash) returning * into stored;
 return to_jsonb(stored);
end;
$$;
create function public.qa_sandbox_claim_checkout_creation(p_operation uuid,p_holder uuid,p_configuration_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare stored private.qa_sandbox_purchase_operations%rowtype; claimed boolean:=false;
begin
 perform private.qa_sandbox_subject(p_holder,true);
 select * into stored from private.qa_sandbox_purchase_operations where operation_id=p_operation and holder=p_holder for update;
 if not found or stored.configuration_hash is distinct from p_configuration_hash then raise exception 'unknown QA checkout configuration'; end if;
 if stored.creation_started_at is null and stored.stripe_session_id is null and stored.status='prepared' then
  update private.qa_sandbox_purchase_operations set creation_started_at=clock_timestamp(),updated_at=clock_timestamp()
   where operation_id=p_operation returning * into stored;
  claimed:=true;
 end if;
 -- A claimed/ambiguous request is never automatically released, including after provider
 -- idempotency expiry. Recovery is a read/bind of this exact attempt, never another create.
 return jsonb_build_object('operation',to_jsonb(stored),'claimed',claimed);
end;
$$;
create function public.qa_sandbox_bind_checkout_session(p_operation uuid,p_holder uuid,p_session text,p_configuration_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare stored private.qa_sandbox_purchase_operations%rowtype;
begin
 -- An already-created Session may be recovered/bound after disablement; this issues no grant.
 perform private.qa_sandbox_subject(p_holder,false);
 if p_session is null or p_session !~ '^cs_test_[A-Za-z0-9_]{1,240}$' then raise exception 'invalid QA checkout Session'; end if;
 select * into stored from private.qa_sandbox_purchase_operations where operation_id=p_operation and holder=p_holder for update;
 if not found or stored.configuration_hash is distinct from p_configuration_hash or stored.creation_started_at is null then raise exception 'unknown QA checkout configuration'; end if;
 if stored.stripe_session_id is not null and stored.stripe_session_id<>p_session then raise exception 'checkout Session changed'; end if;
 if stored.status in ('refunded','closed_unpaid') and stored.stripe_session_id is null then raise exception 'closed QA checkout operation'; end if;
 update private.qa_sandbox_purchase_operations set stripe_session_id=p_session,
  status=case when status='prepared' then 'session_bound' else status end,updated_at=clock_timestamp() where operation_id=p_operation returning * into stored;
 return to_jsonb(stored);
end;
$$;
create function public.qa_sandbox_read_checkout_operation(p_operation uuid,p_holder uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform private.qa_sandbox_subject(p_holder,false);
 return (select to_jsonb(o) from private.qa_sandbox_purchase_operations o where operation_id=p_operation and holder=p_holder);
end;
$$;
create function public.qa_sandbox_record_checkout_status(p_operation uuid,p_session text,p_status text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare stored private.qa_sandbox_purchase_operations%rowtype;
begin
 perform private.qa_sandbox_session();
 select * into stored from private.qa_sandbox_purchase_operations where operation_id=p_operation and stripe_session_id is not distinct from p_session for update;
 if not found then raise exception 'unknown QA checkout Session'; end if;
 if p_session is null and (p_status<>'recovery_required' or stored.creation_started_at is null) then raise exception 'unbound QA checkout Session'; end if;
 if stored.status=p_status then return to_jsonb(stored); end if;
 if stored.status in ('refunded','closed_unpaid') then raise exception 'terminal QA checkout operation'; end if;
 if p_status='refunded' then null; -- Exact known Session canonical negative; disabled membership allowed.
 elsif p_status='closed_unpaid' and stored.status in ('session_bound','recovery_required') and stored.paid_at is null then
  -- The caller must independently verify this Session is expired/cancelled and unpaid.
  null;
 elsif p_status='recovery_required' then null; -- Retains the same operation and Session.
 elsif (stored.status,p_status) in (('session_bound','paid_verified'),('recovery_required','paid_verified'),
  ('paid_verified','import_pending'),('recovery_required','import_pending'),('import_pending','imported'),
  ('recovery_required','imported'),('imported','access_observed')) then null;
 else raise exception 'invalid QA checkout transition'; end if;
 update private.qa_sandbox_purchase_operations set status=p_status,
  paid_at=case when p_status in ('paid_verified','import_pending','imported','access_observed','refunded') then coalesce(paid_at,clock_timestamp()) else paid_at end,
  updated_at=clock_timestamp() where operation_id=p_operation returning * into stored;
 return to_jsonb(stored);
end;
$$;

-- Separate short-lived QA limiter. Raw IP/subject bucket strings never enter a table.
create function public.qa_sandbox_consume_rate_limit(p_bucket_key text,p_max_requests integer,p_window_seconds integer) returns integer
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare parts text[]; allowed integer; moment timestamptz; v_window_start timestamptz;
 window_secret bytea; derived text; requests integer; subject uuid;
begin
 perform private.qa_sandbox_session();
 if p_bucket_key is null or length(p_bucket_key)>1024 or p_window_seconds is distinct from 60 then raise exception 'invalid QA rate policy'; end if;
 parts:=regexp_match(p_bucket_key,'^(qa-sandbox-(?:apple-access|checkout|reconcile)):(user|ip):(.+)$');
 if parts is null then raise exception 'invalid QA rate bucket'; end if;
 allowed:=case parts[1] when 'qa-sandbox-apple-access' then case parts[2] when 'user' then 10 else 30 end
  when 'qa-sandbox-checkout' then case parts[2] when 'user' then 5 else 20 end
  when 'qa-sandbox-reconcile' then case parts[2] when 'user' then 10 else 60 end end;
 if p_max_requests is distinct from allowed then raise exception 'invalid QA rate quota'; end if;
 if parts[2]='user' then
  subject:=parts[3]::uuid;
  perform private.qa_sandbox_subject(subject,false);
 end if;
 moment:=clock_timestamp(); v_window_start:=to_timestamp(floor(extract(epoch from moment)/60)*60);
 delete from private.qa_sandbox_rate_windows where expires_at<=moment;
 insert into private.qa_sandbox_rate_windows values(v_window_start,extensions.gen_random_bytes(32),v_window_start+interval '60 seconds') on conflict do nothing;
 select secret into strict window_secret from private.qa_sandbox_rate_windows w where w.window_start=v_window_start for key share;
 derived:=parts[1]||':'||parts[2]||':'||encode(extensions.hmac(p_bucket_key::bytea,window_secret,'sha256'),'hex');
 insert into private.qa_sandbox_rate_counters(bucket_key,window_start,count) values(derived,v_window_start,1)
  on conflict(bucket_key,window_start) do update set count=least(private.qa_sandbox_rate_counters.count+1,allowed+1) returning count into requests;
 if requests<=allowed then return 0; end if;
 return greatest(1,ceil(extract(epoch from v_window_start+interval '60 seconds'-moment))::integer);
end;
$$;

-- Owner changes require temporary operator membership on non-superuser hosted postgres.
-- Neither production writer nor QA writer inherits the wrapper owner.
grant still_qa_sandbox_owner to postgres;
grant create on schema public to still_qa_sandbox_owner;
alter function public.qa_sandbox_account_enabled(uuid) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_account_enabled(uuid) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_account_enabled(uuid) to still_qa_sandbox_writer;
alter function public.qa_sandbox_begin_access_observation(uuid) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_begin_access_observation(uuid) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_begin_access_observation(uuid) to still_qa_sandbox_writer;
alter function public.qa_sandbox_commit_access_observation(uuid,uuid,jsonb) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_commit_access_observation(uuid,uuid,jsonb) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_commit_access_observation(uuid,uuid,jsonb) to still_qa_sandbox_writer;
alter function public.qa_sandbox_confirm_access_observation(uuid,uuid) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_confirm_access_observation(uuid,uuid) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_confirm_access_observation(uuid,uuid) to still_qa_sandbox_writer;
alter function public.qa_sandbox_read_access_removals(uuid,uuid) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_read_access_removals(uuid,uuid) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_read_access_removals(uuid,uuid) to still_qa_sandbox_writer;
alter function public.qa_sandbox_transfer_access_right(uuid,uuid,uuid,uuid,bigint) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_transfer_access_right(uuid,uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_transfer_access_right(uuid,uuid,uuid,uuid,bigint) to still_qa_sandbox_writer;
alter function public.qa_sandbox_begin_apple_access_observation(text,text,text,text) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_begin_apple_access_observation(text,text,text,text) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_begin_apple_access_observation(text,text,text,text) to still_qa_sandbox_writer;
alter function public.qa_sandbox_commit_apple_local(text,uuid,boolean) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_commit_apple_local(text,uuid,boolean) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_commit_apple_local(text,uuid,boolean) to still_qa_sandbox_writer;
alter function public.qa_sandbox_commit_apple_link(text,uuid,boolean,uuid,uuid,bigint,uuid) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_commit_apple_link(text,uuid,boolean,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_commit_apple_link(text,uuid,boolean,uuid,uuid,bigint,uuid) to still_qa_sandbox_writer;
alter function public.qa_sandbox_confirm_apple_local(text,uuid,uuid,bigint,bigint) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_confirm_apple_local(text,uuid,uuid,bigint,bigint) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_confirm_apple_local(text,uuid,uuid,bigint,bigint) to still_qa_sandbox_writer;
alter function public.qa_sandbox_confirm_apple_account(text,uuid,uuid,uuid,bigint,bigint) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_confirm_apple_account(text,uuid,uuid,uuid,bigint,bigint) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_confirm_apple_account(text,uuid,uuid,uuid,bigint,bigint) to still_qa_sandbox_writer;
alter function public.qa_sandbox_read_linked_apple_transactions(uuid) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_read_linked_apple_transactions(uuid) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_read_linked_apple_transactions(uuid) to still_qa_sandbox_writer;
alter function public.qa_sandbox_prepare_checkout_operation(uuid,uuid,text) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_prepare_checkout_operation(uuid,uuid,text) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_prepare_checkout_operation(uuid,uuid,text) to still_qa_sandbox_writer;
alter function public.qa_sandbox_claim_checkout_creation(uuid,uuid,text) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_claim_checkout_creation(uuid,uuid,text) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_claim_checkout_creation(uuid,uuid,text) to still_qa_sandbox_writer;
alter function public.qa_sandbox_bind_checkout_session(uuid,uuid,text,text) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_bind_checkout_session(uuid,uuid,text,text) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_bind_checkout_session(uuid,uuid,text,text) to still_qa_sandbox_writer;
alter function public.qa_sandbox_read_checkout_operation(uuid,uuid) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_read_checkout_operation(uuid,uuid) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_read_checkout_operation(uuid,uuid) to still_qa_sandbox_writer;
alter function public.qa_sandbox_record_checkout_status(uuid,text,text) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_record_checkout_status(uuid,text,text) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_record_checkout_status(uuid,text,text) to still_qa_sandbox_writer;
alter function public.qa_sandbox_consume_rate_limit(text,integer,integer) owner to still_qa_sandbox_owner;
revoke all on function public.qa_sandbox_consume_rate_limit(text,integer,integer) from public,anon,authenticated,service_role,still_entitlement_writer;
grant execute on function public.qa_sandbox_consume_rate_limit(text,integer,integer) to still_qa_sandbox_writer;
revoke create on schema public from still_qa_sandbox_owner;
revoke still_qa_sandbox_owner from postgres;

-- Fail closed at apply if a QA credential can inherit privileged roles or reach live mutation.
do $$
declare role_name text; sig text; relation text; setting text;
begin
 if exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member
   where r.rolname in ('still_qa_sandbox_writer','still_qa_sandbox_owner'))
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid
   where r.rolname in ('still_qa_sandbox_writer','still_qa_sandbox_owner') and not (m.member=(select oid from pg_catalog.pg_roles where rolname='postgres')
    and m.admin_option and not m.inherit_option and not m.set_option
    and exists(select 1 from pg_catalog.pg_roles grantor where grantor.oid=m.grantor and grantor.rolsuper))) then raise exception 'unsafe QA role membership'; end if;
 foreach role_name in array array['still_qa_sandbox_writer','still_qa_sandbox_owner'] loop
  if not exists(select 1 from pg_catalog.pg_roles where rolname=role_name and not rolcanlogin and not rolinherit
   and not rolsuper and not rolcreaterole and not rolcreatedb and not rolreplication and not rolbypassrls) then raise exception 'unsafe QA role'; end if;
 end loop;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid='private.read_access_removals_core(uuid,text,uuid,boolean)'::regprocedure
  and p.pronargdefaults=1 and pg_catalog.pg_get_expr(p.proargdefaults,0)='true') then raise exception 'unsafe production removal default'; end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid='private.qa_sandbox_confirmed_account(uuid,boolean,boolean)'::regprocedure
  and p.pronargdefaults=2 and pg_catalog.pg_get_expr(p.proargdefaults,0)='false, true') then raise exception 'unsafe QA account defaults'; end if;
 foreach setting in array array['lock_timeout=1s','statement_timeout=2s','idle_in_transaction_session_timeout=5s','log_parameter_max_length=0','log_parameter_max_length_on_error=0'] loop
  if not exists(select 1 from pg_catalog.pg_db_role_setting where setrole=(select oid from pg_catalog.pg_roles where rolname='still_qa_sandbox_writer')
   and setdatabase=0 and setting=any(setconfig)) then raise exception 'unsafe QA role settings'; end if;
 end loop;
 foreach relation in array array['access_observations','access_rights','access_revocations','access_transfer_operations','apple_access_observations','apple_access_link_operations'] loop
  if not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=relation and c.relrowsecurity and not c.relforcerowsecurity) then raise exception 'unsafe shared QA RLS'; end if;
  if (select count(*) from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=relation)<>1
   or not exists(select 1 from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relname=relation and p.polname='qa_sandbox_owner' and p.polcmd='*' and p.polpermissive
     and p.polroles=array[(select oid from pg_catalog.pg_roles where rolname='still_qa_sandbox_owner')]
     and pg_catalog.pg_get_expr(p.polqual,p.polrelid)='(environment = ''sandbox''::text)' and pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)='(environment = ''sandbox''::text)') then raise exception 'unsafe shared QA policy'; end if;
  if exists(select 1 from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=relation and not t.tgisinternal) then raise exception 'unsafe shared QA trigger'; end if;
 end loop;
 foreach sig in array array[
  'public.begin_access_observation(uuid,text)','public.commit_access_observation(uuid,text,uuid,jsonb)',
  'public.confirm_access_observation(uuid,text,uuid)','public.transfer_access_right(uuid,uuid,text,uuid,uuid,bigint)',
  'public.begin_apple_access_observation(text,text,text,text,text)','public.commit_apple_access_observation(text,text,uuid,boolean,uuid,uuid,bigint,uuid)',
  'public.confirm_apple_access_observation(text,text,uuid,uuid,uuid,bigint,bigint)',
  'public.read_linked_apple_transactions(uuid,text)','public.read_access_removals(uuid,text,uuid)',
  'public.consume_rate_limit(text,integer,integer)','public.set_entitlement(uuid,boolean,text,text)'
 ] loop
  if pg_catalog.has_function_privilege('still_qa_sandbox_writer',sig,'EXECUTE') then raise exception 'QA live RPC reachability'; end if;
 end loop;
 foreach relation in array array['private.qa_sandbox_subjects','private.qa_sandbox_purchase_operations',
  'private.qa_sandbox_negative_rights','private.access_rights','private.access_observations','private.access_revocations',
  'private.access_transfer_operations','private.apple_access_observations','private.apple_access_link_operations','public.entitlements'] loop
  if pg_catalog.has_table_privilege('still_qa_sandbox_writer',relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or pg_catalog.has_any_column_privilege('still_qa_sandbox_writer',relation,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'QA direct table reachability'; end if;
 end loop;
end;
$$;

do $$
declare item record;
begin
 for item in select p.oid,p.proowner,p.proacl,n.nspname,p.proname from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='public' and p.proname like 'qa_sandbox_%')
   or (n.nspname='private' and p.proname in ('begin_access_observation_core','commit_access_observation_core','confirm_access_observation_core','transfer_access_right_core','begin_apple_access_observation_core','commit_apple_access_observation_core','confirm_apple_access_observation_core','read_linked_apple_transactions_core','read_access_removals_core','qa_sandbox_session','qa_sandbox_confirmed_account','qa_sandbox_subject')) loop
  if exists(select 1 from pg_catalog.aclexplode(coalesce(item.proacl,pg_catalog.acldefault('f',item.proowner))) a
   where a.grantee<>item.proowner and (a.grantee is distinct from (select oid from pg_catalog.pg_roles where rolname=case when item.nspname='public' then 'still_qa_sandbox_writer' else 'still_qa_sandbox_owner' end) or a.is_grantable)) then
   raise exception 'unexpected QA routine ACL';
  end if;
 end loop;
end;
$$;
commit;
