-- Optional Apple attribution. No anonymous PostHog ID, private erasure key or event outbox is stored.
begin;
set local lock_timeout='5s';
do $$ begin
 if current_user<>'postgres' or session_user<>'postgres'
  or exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper)
  or to_regclass('private.analytics_subjects') is null then
  raise exception 'ordinary migration operator and analytics foundations required';
 end if;
end $$;
create table private.apple_purchase_analytics (
 capability_hash text primary key check(capability_hash ~ '^[0-9a-f]{64}$'),
 origin_key bytea not null check(octet_length(origin_key)=32),
 subject_id uuid references private.analytics_subjects(subject_id) on delete cascade,
 anon_index integer check(anon_index between 0 and 255),
 project_hash text not null check(project_hash ~ '^[0-9a-f]{64}$'),
 surface text not null check(surface in ('app-ios','app-macos')),
 app_version text not null check(app_version ~ '^[0-9]+(\.[0-9]+){1,3}$'),
 prepared_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '10 minutes',
 transaction_key text unique,
 transaction jsonb,
 purchased_at bigint,
 refunded_at bigint,
 sale_id uuid not null default gen_random_uuid(),
 refund_id uuid not null default gen_random_uuid(),
 retired boolean not null default false,
 check((subject_id is null)<>(anon_index is null)),
 check((transaction_key is null)=(transaction is null) and (transaction is null)=(purchased_at is null)),
 check(transaction_key is null or transaction_key ~ '^[0-9a-f]{64}$'),
 check(purchased_at is null or purchased_at>=0),
 check(refunded_at is null or refunded_at>=purchased_at)
);
create index apple_purchase_analytics_origin on private.apple_purchase_analytics(origin_key);
create index apple_purchase_analytics_expiry on private.apple_purchase_analytics(expires_at) where transaction_key is null;
alter table private.apple_purchase_analytics enable row level security;
revoke all on private.apple_purchase_analytics from public,anon,authenticated,service_role,
 still_entitlement_writer,still_settings_writer,still_policy_reader,still_policy_admin,
 still_analytics_eraser,still_qa_sandbox_writer,still_qa_sandbox_owner;

create function private.apple_analytics_session() returns void
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$ begin
 if session_user<>'still_analytics_eraser' and not pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'analytics server role required' using errcode='42501';
 end if;
end $$;

-- All attribution paths take the erasure origin lock BEFORE touching an attribution row.
create function private.apple_analytics_scope(p_origin text,p_holder uuid,p_index integer) returns uuid
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare k bytea; subject uuid;
begin
 perform private.apple_analytics_session();
 if p_origin is null or p_origin !~ '^[0-9a-f]{64}$' then raise exception 'invalid scope'; end if;
 k:=private.analytics_origin_key(decode(p_origin,'hex'));
 perform pg_advisory_xact_lock(hashtextextended(encode(k,'hex'),170017));
 if exists(select 1 from private.analytics_erasure_jobs where scope='device' and scope_key=k) then
  raise exception 'retired scope';
 end if;
 if p_holder is null then
  if p_index is null or p_index not between 0 and 255 then raise exception 'invalid scope'; end if;
  return null;
 end if;
 if p_index is not null then raise exception 'invalid scope'; end if;
 perform 1 from auth.users where id=p_holder and deleted_at is null and email_confirmed_at is not null
  and (banned_until is null or banned_until<=clock_timestamp()) for share;
 if not found then raise exception 'unavailable scope'; end if;
 select subject_id into subject from private.analytics_subjects where user_id=p_holder
  and origin_key=k and epoch=0 and retired_at is null for share;
 if subject is null then raise exception 'unavailable scope'; end if;
 return subject;
end $$;

-- Called by the existing authenticated erasure worker and opportunistically by preparation.
-- No financial rows are touched. Limit fixed by SQL, not caller supplied.
create function private.apple_analytics_cleanup() returns integer
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare removed integer;
begin
 perform private.apple_analytics_session();
 delete from private.apple_purchase_analytics where capability_hash in
  (select capability_hash from private.apple_purchase_analytics
   where (transaction_key is null and expires_at<=clock_timestamp())
    or (purchased_at is not null and purchased_at<extract(epoch from clock_timestamp()-interval '90 days')*1000)
    or retired order by prepared_at limit 256 for update skip locked);
 get diagnostics removed=row_count;
 return removed;
end $$;

create function private.apple_analytics_prepare(p_hash text,p_origin text,p_holder uuid,p_index integer,
 p_project text,p_surface text,p_version text) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare subject uuid; k bytea;
begin
 perform private.apple_analytics_session();
 -- Global lock bounds anonymous allocation even across different IPs/origins. Maintenance is
 -- performed on every preparation, including requests refused by the global allocation ceiling.
 perform pg_advisory_xact_lock(170029,1);
 -- Acquire this origin before cleanup can take attribution row locks. A concurrent erasure
 -- already owns that origin before retiring rows; reversing this order would deadlock.
 subject:=private.apple_analytics_scope(p_origin,p_holder,p_index);
 perform private.apple_analytics_cleanup();
 if (select count(*) from private.apple_purchase_analytics where transaction_key is null)>=2048 then return false; end if;
 k:=private.analytics_origin_key(decode(p_origin,'hex'));
 if (select count(*) from private.apple_purchase_analytics where origin_key=k and transaction_key is null)>=2 then return false; end if;
 insert into private.apple_purchase_analytics(capability_hash,origin_key,subject_id,anon_index,project_hash,surface,app_version)
  values(p_hash,k,subject,p_index,p_project,p_surface,p_version);
 return true;
end $$;

create function private.apple_analytics_read(p_hash text,p_origin text,p_holder uuid,p_index integer,p_project text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare subject uuid; a private.apple_purchase_analytics%rowtype;
begin
 perform private.apple_analytics_session();
 subject:=private.apple_analytics_scope(p_origin,p_holder,p_index);
 select * into a from private.apple_purchase_analytics where capability_hash=p_hash
  and origin_key=private.analytics_origin_key(decode(p_origin,'hex')) and project_hash=p_project
  and subject_id is not distinct from subject and anon_index is not distinct from p_index
  and not retired and (transaction_key is not null or expires_at>clock_timestamp())
  and (purchased_at is null or purchased_at>=extract(epoch from clock_timestamp()-interval '90 days')*1000) for update;
 if not found then return null; end if;
 return jsonb_build_object('transaction',a.transaction,'saleId',a.sale_id,'refundId',a.refund_id,
  'purchasedAt',a.purchased_at,'refundedAt',a.refunded_at,'surface',a.surface,'appVersion',a.app_version);
end $$;

create function private.apple_analytics_commit(p_hash text,p_origin text,p_holder uuid,p_index integer,p_project text,p_tx jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a private.apple_purchase_analytics%rowtype; state jsonb; paid bigint; refund bigint;
begin
 state:=private.apple_analytics_read(p_hash,p_origin,p_holder,p_index,p_project);
 if state is null then return null; end if;
 select * into a from private.apple_purchase_analytics where capability_hash=p_hash;
 if jsonb_typeof(p_tx) is distinct from 'object' or not(p_tx ?& array['key','environment','bundleId','productId','originalTransactionId','transactionId','active','purchasedAt'])
  or p_tx->>'environment' is distinct from 'production' or p_tx->>'productId' is distinct from 'still_pro_v3'
  or jsonb_typeof(p_tx->'active') is distinct from 'boolean'
  or p_tx->>'bundleId' is null or p_tx->>'key' is null or p_tx->>'transactionId' is null
  or p_tx->>'originalTransactionId' is null or p_tx->>'purchasedAt' is null
  or p_tx ? 'localOnly' or p_tx->>'key' !~ '^[0-9a-f]{64}$'
  or p_tx->>'transactionId' !~ '^[1-9][0-9]{0,39}$'
  or p_tx->>'originalTransactionId' !~ '^[1-9][0-9]{0,39}$'
  or p_tx->>'purchasedAt' !~ '^[0-9]{1,16}$' then return null; end if;
 paid:=(p_tx->>'purchasedAt')::bigint;
 if a.transaction_key is null then
  if p_tx->>'active' is distinct from 'true' or paid<extract(epoch from a.prepared_at)*1000
   or paid>extract(epoch from a.expires_at)*1000 or paid>extract(epoch from clock_timestamp())*1000 then return null; end if;
  begin
   update private.apple_purchase_analytics set transaction_key=p_tx->>'key',transaction=p_tx,purchased_at=paid
    where capability_hash=p_hash;
  exception when unique_violation then return null; end;
 elsif a.transaction_key<>p_tx->>'key' or a.transaction->>'transactionId'<>p_tx->>'transactionId'
  or a.transaction->>'bundleId'<>p_tx->>'bundleId' or a.purchased_at<>paid then return null;
 end if;
 if p_tx->>'fullRefundAt' ~ '^[0-9]{1,16}$' then
  refund:=(p_tx->>'fullRefundAt')::bigint;
  if refund>=paid and refund<=extract(epoch from clock_timestamp())*1000 then
   update private.apple_purchase_analytics set refunded_at=coalesce(refunded_at,refund) where capability_hash=p_hash;
  end if;
 end if;
 return private.apple_analytics_read(p_hash,p_origin,p_holder,p_index,p_project);
end $$;

create function private.apple_analytics_retire_device() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$ begin
 if new.scope='device' then
  perform pg_advisory_xact_lock(hashtextextended(encode(new.scope_key,'hex'),170017));
  update private.apple_purchase_analytics set retired=true where origin_key=new.scope_key and not retired;
 end if;
 return null;
end $$;
create trigger apple_analytics_retire_device after insert or update on private.analytics_erasure_jobs
 for each row execute function private.apple_analytics_retire_device();

revoke all on function private.apple_analytics_session(),private.apple_analytics_scope(text,uuid,integer),
 private.apple_analytics_prepare(text,text,uuid,integer,text,text,text),
 private.apple_analytics_read(text,text,uuid,integer,text),
 private.apple_analytics_commit(text,text,uuid,integer,text,jsonb),private.apple_analytics_retire_device(),private.apple_analytics_cleanup()
 from public,anon,authenticated,service_role,still_entitlement_writer,still_settings_writer,
 still_policy_reader,still_policy_admin,still_analytics_eraser,still_qa_sandbox_writer,still_qa_sandbox_owner;
grant execute on function private.apple_analytics_prepare(text,text,uuid,integer,text,text,text),
 private.apple_analytics_read(text,text,uuid,integer,text),
 private.apple_analytics_commit(text,text,uuid,integer,text,jsonb),private.apple_analytics_cleanup() to still_analytics_eraser;
commit;
