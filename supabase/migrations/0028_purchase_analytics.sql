-- Optional production web-purchase attribution. No usage events or provider requests are queued.
-- Every dispatch requires a fresh originating-device request; payment processing never waits for it.
begin;
set local lock_timeout='5s';
do $$ begin
 if current_user<>'postgres' or session_user<>'postgres'
  or exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper)
  or to_regclass('private.production_purchase_operations') is null
  or to_regclass('private.analytics_subjects') is null then
  raise exception 'ordinary production migration operator and payment/analytics foundations required';
 end if;
end $$;

create table private.purchase_analytics_attribution (
 operation_id uuid primary key references private.production_purchase_operations(operation_id) on delete cascade,
 subject_id uuid not null references private.analytics_subjects(subject_id) on delete cascade,
 surface text not null check(surface in ('chrome','firefox')),
 app_version text not null check(app_version ~ '^[0-9]+(\.[0-9]+){1,3}$'),
 sale_id uuid not null default gen_random_uuid(),
 refund_id uuid not null default gen_random_uuid(),
 refunded_at timestamptz,
 sale_reported_at timestamptz,
 refund_reported_at timestamptz,
 claim_event text check(claim_event in ('purchase_recorded','purchase_refunded')),
 claim_token uuid,
 claim_until timestamptz,
 check((claim_event is null)=(claim_token is null) and (claim_token is null)=(claim_until is null)),
 check(refund_reported_at is null or sale_reported_at is not null)
);
create index purchase_analytics_subject on private.purchase_analytics_attribution(subject_id,operation_id);
alter table private.purchase_analytics_attribution enable row level security;
revoke all on private.purchase_analytics_attribution from public,anon,authenticated,service_role,
 still_entitlement_writer,still_settings_writer,still_policy_reader,still_policy_admin,
 still_analytics_eraser,still_qa_sandbox_writer,still_qa_sandbox_owner;

-- The ordinary payment claim and optional attribution are one transaction. Only the request
-- that wins creation can name its originating subject. Analytics failure never undoes the claim.
create function public.production_claim_checkout_with_analytics(p_operation uuid,p_holder uuid,p_configuration_hash text,p_surface text,p_build text,p_origin text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare claimed jsonb; subject uuid;
begin
 claimed:=public.production_claim_checkout_creation(p_operation,p_holder,p_configuration_hash,p_surface,p_build);
 if claimed->>'claimed'='true' then
  begin
   if p_origin ~ '^[0-9a-f]{64}$' and p_build ~ '^[0-9]+(\.[0-9]+){1,3}$' then
    select subject_id into subject from private.analytics_subjects
     where user_id=p_holder and origin_key=private.analytics_origin_key(decode(p_origin,'hex'))
      and epoch=0 and retired_at is null for share skip locked;
    if subject is not null then
     insert into private.purchase_analytics_attribution(operation_id,subject_id,surface,app_version)
      values(p_operation,subject,case p_surface when 'chrome_desktop' then 'chrome' else 'firefox' end,p_build)
      on conflict(operation_id) do nothing;
    end if;
   end if;
  exception when query_canceled then null;
   when others then
   -- Optional collection is dropped; do not expose driver parameters or fail the purchase.
   null;
  end;
 end if;
 return claimed;
end $$;

-- A later checkout bind may touch operation.updated_at. Freeze the first canonical full-refund
-- observation in the optional attribution instead. This never creates an attribution or grants access.
create function private.purchase_analytics_refund_time() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$ begin
 begin
  perform 1 from private.purchase_analytics_attribution
   where operation_id=new.operation_id and refunded_at is null for update skip locked;
  if found then
   update private.purchase_analytics_attribution set refunded_at=new.updated_at
    where operation_id=new.operation_id;
  end if;
 exception when query_canceled then null; when others then null;
 end;
 return null;
end $$;
create trigger purchase_analytics_refund_time after update of status on private.production_purchase_operations
 for each row when (new.status='refunded' and old.status is distinct from 'refunded')
 execute function private.purchase_analytics_refund_time();

create function private.purchase_analytics_session() returns void
language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$ begin
 if session_user<>'still_analytics_eraser' and not pg_has_role(session_user,current_user,'USAGE') then
  raise exception 'analytics server role required' using errcode='42501';
 end if;
end $$;

-- One event per claim; callers use at most two claims per fresh device request. The paid timestamp
-- and terminal refund updated_at are canonical ledger observation times, not client/report times.
create function private.analytics_claim_purchase(p_holder uuid,p_origin text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare subject uuid; candidate record; kind text; token uuid:=gen_random_uuid();
begin
 perform private.purchase_analytics_session();
 if p_origin is null or p_origin !~ '^[0-9a-f]{64}$' then return null; end if;
 perform 1 from auth.users where id=p_holder and deleted_at is null and email_confirmed_at is not null
  and (banned_until is null or banned_until<=clock_timestamp()) for share;
 if not found then return null; end if;
 select subject_id into subject from private.analytics_subjects
  where user_id=p_holder and origin_key=private.analytics_origin_key(decode(p_origin,'hex'))
   and epoch=0 and retired_at is null for share;
 if subject is null then return null; end if;
 select a.*,o.paid_at,o.updated_at,o.status into candidate
  from private.purchase_analytics_attribution a join private.production_purchase_operations o using(operation_id)
  where a.subject_id=subject and o.holder=p_holder and o.environment='production'
   and o.stripe_session_id ~ '^cs_live_[A-Za-z0-9_]{1,240}$' and o.paid_at is not null
   and (a.claim_until is null or a.claim_until<=clock_timestamp())
   and (a.sale_reported_at is null or (o.status='refunded' and a.refunded_at is not null and a.refund_reported_at is null))
  order by o.paid_at,a.operation_id limit 1 for update of a skip locked;
 if not found then return null; end if;
 kind:=case when candidate.sale_reported_at is null then 'purchase_recorded' else 'purchase_refunded' end;
 update private.purchase_analytics_attribution set claim_event=kind,claim_token=token,
  claim_until=clock_timestamp()+interval '10 seconds' where operation_id=candidate.operation_id;
 return jsonb_build_object('operation',candidate.operation_id,'token',token,'subject',subject,'event',kind,
  'id',case kind when 'purchase_recorded' then candidate.sale_id else candidate.refund_id end,
  'at',case kind when 'purchase_recorded' then candidate.paid_at else candidate.refunded_at end,
  'surface',candidate.surface,'appVersion',candidate.app_version);
end $$;

-- A final retirement/ownership/lease check immediately before a bounded provider request.
-- Never trusts a payload retained from a claim that has since been erased or superseded.
create function private.analytics_purchase_current(p_holder uuid,p_origin text,p_operation uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$ begin
 perform private.purchase_analytics_session();
 if p_origin is null or p_origin !~ '^[0-9a-f]{64}$' then return false; end if;
 return exists(select 1 from private.purchase_analytics_attribution a
  join private.analytics_subjects s using(subject_id)
  join private.production_purchase_operations o using(operation_id)
  join auth.users u on u.id=s.user_id
  where a.operation_id=p_operation and a.claim_token=p_token and a.claim_until>clock_timestamp()
   and s.user_id=p_holder and s.retired_at is null and s.origin_key=private.analytics_origin_key(decode(p_origin,'hex'))
   and o.holder=p_holder and o.environment='production' and u.deleted_at is null
   and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<=clock_timestamp()));
end $$;

-- Expired workers cannot clear or complete a successor's claim. A provider failure releases the
-- claim; a later fresh-consent request retries the identical event tuple. No worker runs on a timer.
create function private.analytics_finish_purchase(p_operation uuid,p_token uuid,p_delivered boolean) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare changed integer;
begin
 perform private.purchase_analytics_session();
 if p_delivered is null then return false; end if;
 update private.purchase_analytics_attribution set
  sale_reported_at=case when p_delivered and claim_event='purchase_recorded' then clock_timestamp() else sale_reported_at end,
  refund_reported_at=case when p_delivered and claim_event='purchase_refunded' then clock_timestamp() else refund_reported_at end,
  claim_event=null,claim_token=null,claim_until=null
  where operation_id=p_operation and claim_token=p_token and claim_until>clock_timestamp();
 get diagnostics changed=row_count;
 return changed=1;
end $$;

revoke all on function public.production_claim_checkout_with_analytics(uuid,uuid,text,text,text,text) from public,anon,authenticated,service_role,still_analytics_eraser,still_qa_sandbox_writer,still_qa_sandbox_owner;
grant execute on function public.production_claim_checkout_with_analytics(uuid,uuid,text,text,text,text) to still_entitlement_writer;
revoke all on function private.purchase_analytics_refund_time() from public,anon,authenticated,service_role,still_entitlement_writer,still_analytics_eraser,still_qa_sandbox_writer,still_qa_sandbox_owner;
revoke all on function private.purchase_analytics_session() from public,anon,authenticated,service_role,still_entitlement_writer,still_analytics_eraser,still_qa_sandbox_writer,still_qa_sandbox_owner;
revoke all on function private.analytics_claim_purchase(uuid,text),private.analytics_purchase_current(uuid,text,uuid,uuid),private.analytics_finish_purchase(uuid,uuid,boolean)
 from public,anon,authenticated,service_role,still_entitlement_writer,still_qa_sandbox_writer,still_qa_sandbox_owner;
grant execute on function private.analytics_claim_purchase(uuid,text),private.analytics_purchase_current(uuid,text,uuid,uuid),private.analytics_finish_purchase(uuid,uuid,boolean) to still_analytics_eraser;
commit;
