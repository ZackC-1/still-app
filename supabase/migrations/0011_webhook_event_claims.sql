-- Webhook idempotency: claim BEFORE side effects. Previously the event row was recorded only
-- AFTER a successful reconcile, so a replayed valid webhook re-ran the RevenueCat lookup and
-- entitlement write before noticing the duplicate. That could never mint entitlement (canonical
-- subscriber state wins) but defeated workload idempotency. The claim/complete/release protocol
-- below makes the duplicate check atomic and up-front while KEEPING failed events retriable —
-- a failed reconcile releases its claim, which is the property the old record-after ordering
-- existed to protect.

alter table public.revenuecat_events
  add column status     text        not null default 'completed',
  add column claimed_at timestamptz not null default now();

alter table public.revenuecat_events
  add constraint revenuecat_events_status_check check (status in ('processing', 'completed'));

-- Atomically claim an event for processing. Returns:
--   'claimed'   → the caller owns the event: reconcile, then complete (or release on failure)
--   'duplicate' → already fully processed: skip all side effects
--   'in_flight' → another worker holds a live claim: answer 5xx so the sender retries later
-- A 'processing' claim older than 5 minutes is treated as a crashed worker and taken over, so a
-- die-mid-reconcile isolate cannot wedge an event forever.
create or replace function public.claim_revenuecat_event(
  p_event_id text,
  p_app_user_id text,
  p_payload jsonb
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
  existing_status text;
begin
  insert into public.revenuecat_events (event_id, app_user_id, payload, status, claimed_at)
  values (p_event_id, p_app_user_id, p_payload, 'processing', now())
  on conflict (event_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    return 'claimed';
  end if;

  update public.revenuecat_events
     set claimed_at = now()
   where event_id = p_event_id
     and status = 'processing'
     and claimed_at < now() - interval '5 minutes';
  if found then
    return 'claimed';
  end if;

  select status into existing_status
    from public.revenuecat_events
   where event_id = p_event_id;
  if existing_status = 'completed' then
    return 'duplicate';
  end if;
  return 'in_flight';
end;
$$;

-- Commit a claimed event after successful reconciliation; it is the duplicate guard from then on.
create or replace function public.complete_revenuecat_event(p_event_id text) returns void
language sql
security definer
set search_path = public
as $$
  update public.revenuecat_events
     set status = 'completed', processed_at = now()
   where event_id = p_event_id and status = 'processing';
$$;

-- Release a failed claim so the sender's retry can re-claim it. Deleting (rather than flagging)
-- keeps the audit table to events that actually reconciled.
create or replace function public.release_revenuecat_event(p_event_id text) returns void
language sql
security definer
set search_path = public
as $$
  delete from public.revenuecat_events
   where event_id = p_event_id and status = 'processing';
$$;

revoke execute on function public.claim_revenuecat_event(text, text, jsonb) from public;
revoke execute on function public.complete_revenuecat_event(text) from public;
revoke execute on function public.release_revenuecat_event(text) from public;
grant execute on function public.claim_revenuecat_event(text, text, jsonb) to still_entitlement_writer;
grant execute on function public.complete_revenuecat_event(text) to still_entitlement_writer;
grant execute on function public.release_revenuecat_event(text) to still_entitlement_writer;

-- record_revenuecat_event (0001) stays granted through the deploy window — already-running
-- function code may still call it while migrations land; its rows insert with the 'completed'
-- default, matching its record-after-reconcile semantics.
