-- Isolated device-only review access. Never writes the live/QA rights or payment ledgers.
-- No holder, auth-user reference, link operation or account-reconciliation entry point exists.
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
create table private.apple_sandbox_review_access (
 provider_key text primary key check(provider_key ~ '^[0-9a-f]{64}$'),
 right_id uuid not null unique default gen_random_uuid(),
 bundle_id text not null,
 product_id text not null check(product_id='still_pro_v3'),
 original_transaction_id text not null check(original_transaction_id ~ '^[1-9][0-9]{0,39}$'),
 active boolean not null default false,
 revoked boolean not null default false,
 revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 verified_at bigint not null default 0 check(verified_at between 0 and 9007199254740991),
 token uuid not null,
 deadline timestamptz not null,
 check(not revoked or not active)
);
alter table private.apple_sandbox_review_access enable row level security;
revoke all on private.apple_sandbox_review_access
 from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer,still_qa_sandbox_owner;

create function public.begin_apple_sandbox_review_observation(p_key text,p_bundle text,p_product text,p_original text)
returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_token uuid:=gen_random_uuid(); stored private.apple_sandbox_review_access%rowtype;
begin
 if session_user<>'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'production server role required' using errcode='42501';
 end if;
 if p_key is null or p_key !~ '^[0-9a-f]{64}$'
  or p_bundle is null or length(p_bundle)>160 or p_bundle !~ '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$'
  or p_product is distinct from 'still_pro_v3' or p_original is null or p_original !~ '^[1-9][0-9]{0,39}$' then
  raise exception 'invalid Apple review identity';
 end if;
 insert into private.apple_sandbox_review_access(provider_key,bundle_id,product_id,original_transaction_id,token,deadline)
  values(p_key,p_bundle,p_product,p_original,v_token,clock_timestamp()+interval '90 seconds')
  on conflict(provider_key) do nothing;
 select * into stored from private.apple_sandbox_review_access where provider_key=p_key for update;
 if stored.bundle_id<>p_bundle or stored.product_id<>p_product or stored.original_transaction_id<>p_original then
  raise exception 'Apple review identity changed';
 end if;
 update private.apple_sandbox_review_access set token=v_token,deadline=clock_timestamp()+interval '90 seconds'
  where provider_key=p_key;
 return v_token;
end;
$$;

create function public.commit_apple_sandbox_review_observation(p_key text,p_token uuid,p_active boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare stored private.apple_sandbox_review_access%rowtype;
 v_now bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if session_user<>'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'production server role required' using errcode='42501';
 end if;
 select * into stored from private.apple_sandbox_review_access where provider_key=p_key for update;
 if not found or p_token is null or stored.token<>p_token or stored.deadline<=clock_timestamp() then
  return '{"status":"stale"}';
 end if;
 if p_active is null then raise exception 'invalid Apple review observation'; end if;
 -- A canonical refund is terminal even when it was the first observation.
 if not p_active or stored.revoked then
  update private.apple_sandbox_review_access set active=false,revoked=true,
   revision=revision+case when revoked then 0 else 1 end,verified_at=greatest(verified_at,v_now)
   where provider_key=p_key;
  return '{"status":"revoked"}';
 end if;
 update private.apple_sandbox_review_access set active=true,verified_at=greatest(verified_at,v_now)
  where provider_key=p_key returning * into stored;
 return jsonb_build_object('status','verified','issuer_time',stored.verified_at,'right',jsonb_build_object(
  'right',stored.right_id,'holder',stored.right_id,'revision',stored.revision,'verified_at',stored.verified_at));
end;
$$;

create function public.confirm_apple_sandbox_review_observation(p_key text,p_token uuid,p_right uuid,p_revision bigint,p_verified bigint)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if session_user<>'still_entitlement_writer' and not pg_catalog.pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'production server role required' using errcode='42501';
 end if;
 return exists(select 1 from private.apple_sandbox_review_access
  where provider_key=p_key and token=p_token and deadline>clock_timestamp() and active and not revoked
   and right_id=p_right and revision=p_revision and verified_at=p_verified);
end;
$$;
revoke all on function public.begin_apple_sandbox_review_observation(text,text,text,text),
 public.commit_apple_sandbox_review_observation(text,uuid,boolean),
 public.confirm_apple_sandbox_review_observation(text,uuid,uuid,bigint,bigint)
 from public,anon,authenticated,service_role,still_qa_sandbox_writer,still_qa_sandbox_owner;
grant execute on function public.begin_apple_sandbox_review_observation(text,text,text,text),
 public.commit_apple_sandbox_review_observation(text,uuid,boolean),
 public.confirm_apple_sandbox_review_observation(text,uuid,uuid,bigint,bigint) to still_entitlement_writer;
commit;
