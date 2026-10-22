-- Additive production checkout ledger. Does not activate sales, change a cutoff, or touch QA rows.
-- The production writer calls fixed RPCs; clients and QA credentials cannot read or mutate it.
-- Provider references survive account deletion for reconciliation/refunds; the account is detached.
-- Deploy through the reviewed protected migration operation only. 0025 belongs to PROD-01.
begin;
do $$
begin
 if current_user<>'postgres' or session_user<>'postgres' or current_setting('server_version_num')::integer<170000
  or not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and not rolsuper and rolcreaterole) then
  raise exception 'ordinary PostgreSQL17 postgres operator required';
 end if;
end;
$$;
set local lock_timeout='5s';
create table private.production_purchase_operations (
 operation_id uuid primary key,
 holder uuid references auth.users(id) on delete set null,
 environment text not null default 'production' check(environment='production'),
 configuration_hash text not null check(configuration_hash ~ '^[0-9a-f]{64}$'),
 stripe_session_id text unique check(stripe_session_id ~ '^cs_live_[A-Za-z0-9_]{1,240}$'),
 status text not null default 'prepared' check(status in ('prepared','session_bound','paid_verified','import_pending','imported','access_observed','recovery_required','refunded','closed_unpaid')),
 creation_started_at timestamptz,
 paid_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create unique index production_one_open_checkout on private.production_purchase_operations(holder)
 where status not in ('refunded','closed_unpaid');
alter table private.production_purchase_operations enable row level security;
revoke all on private.production_purchase_operations from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer,still_qa_sandbox_owner;

create function private.production_checkout_session() returns void
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
begin
 if session_user<>'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'production server role required' using errcode='42501';
 end if;
end;
$$;

-- This serializes two new operations for one holder, and follows account deletion's lock order.
-- Already-created payments remain recoverable after a ban; only admission requires confirmation.
create function private.production_checkout_account(p_holder uuid,p_positive boolean) returns void
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare confirmed boolean;
begin
 select email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=clock_timestamp())
  into confirmed from auth.users where id=p_holder for update;
 if not found or p_positive is null or (p_positive and not confirmed) then
  raise exception 'checkout account unavailable' using errcode='42501';
 end if;
end;
$$;

-- Same namespace lock as policy publication. A new checkout is admitted only by the current
-- production web sales policy, a reviewed release build, and the immutable free-feature cutoff.
-- Client build metadata selects an allowed release; it is not an identity/authorization claim.
create function private.production_checkout_admission(p_surface text,p_build text) returns void
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare body text; revision bigint; policy jsonb;
begin
 if p_surface is null or p_surface not in ('chrome_desktop','firefox_desktop') or p_build is null
  or p_build !~ '^[a-z0-9][a-z0-9._-]{0,95}$' then raise exception 'invalid checkout release'; end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('still-product-policy:sales:production',0));
 select r.body,r.revision into body,revision from private.product_policy_revisions r
  where r.namespace='sales' and r.environment='production' order by r.revision desc limit 1;
 if body is null or not private.product_policy_body_valid('sales','production',revision,body) then
  raise exception 'production sales unavailable';
 end if;
 policy:=body::jsonb;
 if policy->'salesEnabled' is distinct from 'true'::jsonb or policy->'channels'->'web'->'enabled' is distinct from 'true'::jsonb
  or policy->'channels'->'web'->>'offer' is distinct from 'still-pro-v3'
  or not exists(select 1 from jsonb_array_elements(policy->'builds') b where b->>'surface'=p_surface and b->>'build'=p_build)
  or not exists(select 1 from private.paid_cutoff where environment='production' and product='still-free-v2'
    and benefits=array['facebook.reels','instagram.reels','tiktok.all','youtube.shorts']) then
  raise exception 'production sales unavailable';
 end if;
end;
$$;

create function public.production_prepare_checkout_operation(p_operation uuid,p_holder uuid,p_configuration_hash text,p_surface text,p_build text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare stored private.production_purchase_operations%rowtype;
begin
 perform private.production_checkout_session();
 perform private.production_checkout_admission(p_surface,p_build);
 perform private.production_checkout_account(p_holder,true);
 if p_operation is null or p_configuration_hash is null or p_configuration_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid production checkout scope'; end if;
 select * into stored from private.production_purchase_operations where operation_id=p_operation for update;
 if found then
  if stored.holder is distinct from p_holder or stored.configuration_hash is distinct from p_configuration_hash then raise exception 'checkout retry changed'; end if;
  return to_jsonb(stored);
 end if;
 select * into stored from private.production_purchase_operations where holder=p_holder and status not in ('refunded','closed_unpaid') for update;
 if found then
  if stored.configuration_hash is distinct from p_configuration_hash then raise exception 'unresolved checkout configuration changed'; end if;
  return to_jsonb(stored); -- Lost acknowledgement recovers the same immutable attempt.
 end if;
 insert into private.production_purchase_operations(operation_id,holder,configuration_hash)
  values(p_operation,p_holder,p_configuration_hash) returning * into stored;
 return to_jsonb(stored);
end;
$$;
create function public.production_claim_checkout_creation(p_operation uuid,p_holder uuid,p_configuration_hash text,p_surface text,p_build text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare stored private.production_purchase_operations%rowtype; claimed boolean:=false;
begin
 perform private.production_checkout_session();
 perform private.production_checkout_admission(p_surface,p_build);
 perform private.production_checkout_account(p_holder,true);
 select * into stored from private.production_purchase_operations where operation_id=p_operation and holder=p_holder for update;
 if not found or stored.configuration_hash is distinct from p_configuration_hash then raise exception 'unknown production checkout configuration'; end if;
 if stored.creation_started_at is null and stored.stripe_session_id is null and stored.status='prepared' then
  update private.production_purchase_operations set creation_started_at=clock_timestamp(),updated_at=clock_timestamp()
   where operation_id=p_operation returning * into stored;
  claimed:=true;
 end if;
 -- A claimed/ambiguous request is never automatically released, including after provider
 -- idempotency expiry. Recovery is a read/bind of this exact attempt, never another create.
 return jsonb_build_object('operation',to_jsonb(stored),'claimed',claimed);
end;
$$;
create function public.production_bind_checkout_session(p_operation uuid,p_holder uuid,p_session text,p_configuration_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare stored private.production_purchase_operations%rowtype;
begin
 -- An already-created Session may be recovered/bound after disablement; this issues no grant.
 perform private.production_checkout_session();
 perform private.production_checkout_account(p_holder,false);
 if p_session is null or p_session !~ '^cs_live_[A-Za-z0-9_]{1,240}$' then raise exception 'invalid production checkout Session'; end if;
 select * into stored from private.production_purchase_operations where operation_id=p_operation and holder=p_holder for update;
 if not found or stored.configuration_hash is distinct from p_configuration_hash or stored.creation_started_at is null then raise exception 'unknown production checkout configuration'; end if;
 if stored.stripe_session_id is not null and stored.stripe_session_id<>p_session then raise exception 'checkout Session changed'; end if;
 if stored.status in ('refunded','closed_unpaid') and stored.stripe_session_id is null then raise exception 'closed production checkout operation'; end if;
 update private.production_purchase_operations set stripe_session_id=p_session,
  status=case when status='prepared' then 'session_bound' else status end,updated_at=clock_timestamp() where operation_id=p_operation returning * into stored;
 return to_jsonb(stored);
end;
$$;
create function public.production_read_checkout_operation(p_operation uuid,p_holder uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform private.production_checkout_session();
 perform private.production_checkout_account(p_holder,false);
 return (select to_jsonb(o) from private.production_purchase_operations o where operation_id=p_operation and holder=p_holder);
end;
$$;
create function public.production_record_checkout_status(p_operation uuid,p_session text,p_status text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare stored private.production_purchase_operations%rowtype;
begin
 perform private.production_checkout_session();
 select * into stored from private.production_purchase_operations where operation_id=p_operation and stripe_session_id is not distinct from p_session for update;
 if not found then raise exception 'unknown production checkout Session'; end if;
 if p_session is null and (p_status<>'recovery_required' or stored.creation_started_at is null) then raise exception 'unbound production checkout Session'; end if;
 if stored.status=p_status then return to_jsonb(stored); end if;
 if stored.status in ('refunded','closed_unpaid') then raise exception 'terminal production checkout operation'; end if;
 if p_status='refunded' then null; -- Exact known Session canonical negative; stopped sales and deleted accounts allowed.
 elsif p_status='closed_unpaid' and stored.status in ('session_bound','recovery_required') and stored.paid_at is null then
  -- The caller must independently verify this Session is expired/cancelled and unpaid.
  null;
 elsif p_status='recovery_required' then null; -- Retains the same operation and Session.
 elsif (stored.status,p_status) in (('session_bound','paid_verified'),('recovery_required','paid_verified'),
  ('paid_verified','import_pending'),('recovery_required','import_pending'),('import_pending','imported'),
  ('recovery_required','imported'),('imported','access_observed')) then null;
 else raise exception 'invalid production checkout transition'; end if;
 update private.production_purchase_operations set status=p_status,
  paid_at=case when p_status in ('paid_verified','import_pending','imported','access_observed','refunded') then coalesce(paid_at,clock_timestamp()) else paid_at end,
  updated_at=clock_timestamp() where operation_id=p_operation returning * into stored;
 return to_jsonb(stored);
end;
$$;


revoke all on function public.production_prepare_checkout_operation(uuid,uuid,text,text,text) from public,anon,authenticated,service_role,still_qa_sandbox_writer,still_qa_sandbox_owner;
grant execute on function public.production_prepare_checkout_operation(uuid,uuid,text,text,text) to still_entitlement_writer;
revoke all on function public.production_claim_checkout_creation(uuid,uuid,text,text,text) from public,anon,authenticated,service_role,still_qa_sandbox_writer,still_qa_sandbox_owner;
grant execute on function public.production_claim_checkout_creation(uuid,uuid,text,text,text) to still_entitlement_writer;
revoke all on function public.production_bind_checkout_session(uuid,uuid,text,text) from public,anon,authenticated,service_role,still_qa_sandbox_writer,still_qa_sandbox_owner;
grant execute on function public.production_bind_checkout_session(uuid,uuid,text,text) to still_entitlement_writer;
revoke all on function public.production_read_checkout_operation(uuid,uuid) from public,anon,authenticated,service_role,still_qa_sandbox_writer,still_qa_sandbox_owner;
grant execute on function public.production_read_checkout_operation(uuid,uuid) to still_entitlement_writer;
revoke all on function public.production_record_checkout_status(uuid,text,text) from public,anon,authenticated,service_role,still_qa_sandbox_writer,still_qa_sandbox_owner;
grant execute on function public.production_record_checkout_status(uuid,text,text) to still_entitlement_writer;
revoke all on function private.production_checkout_session() from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer,still_qa_sandbox_owner;
revoke all on function private.production_checkout_account(uuid,boolean) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer,still_qa_sandbox_owner;
revoke all on function private.production_checkout_admission(text,text) from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer,still_qa_sandbox_owner;
commit;
