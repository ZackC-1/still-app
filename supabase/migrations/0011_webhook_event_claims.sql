-- Webhook idempotency: claim BEFORE side effects. Previously the event row was recorded only
-- AFTER a successful reconcile, so a replayed valid webhook re-ran the RevenueCat lookup and
-- entitlement write before noticing the duplicate. That could never mint entitlement (canonical
-- subscriber state wins) but defeated workload idempotency. The claim/complete/release protocol
-- below makes the duplicate check atomic and up-front while KEEPING failed events retriable —
-- a failed reconcile releases its claim, which is the property the old record-after ordering
-- existed to protect.
--
-- claim() hands back a per-claim ownership token; complete()/release() only act on a row whose
-- token still matches. That makes the stale-claim takeover safe: if a slow-but-alive worker is
-- taken over, its later release carries the OLD token and matches nothing, so it cannot clobber
-- the takeover worker's live claim. The takeover threshold (15 min) sits above the Edge Function
-- wall-clock cap (400s), so a claim old enough to take over provably belongs to a dead worker.

alter table public.revenuecat_events
  add column status     text        not null default 'completed',
  add column claim_token uuid,
  add column claimed_at timestamptz not null default now();

alter table public.revenuecat_events
  add constraint revenuecat_events_status_check check (status in ('processing', 'completed'));

-- Atomically claim an event for processing. Returns (claim_status, claim_token):
--   ('claimed', <token>) → the caller owns the event: reconcile, then complete (or release) with
--                          the token
--   ('duplicate', null)  → already fully processed: skip all side effects
--   ('in_flight', null)  → another worker holds a live claim: answer 5xx so the sender retries
-- A 'processing' claim older than 15 minutes is treated as a crashed worker and taken over with a
-- FRESH token, so a die-mid-reconcile isolate cannot wedge an event forever and the dead worker's
-- token is invalidated.
create or replace function public.claim_revenuecat_event(
  p_event_id text,
  p_app_user_id text,
  p_payload jsonb
) returns table (claim_status text, claim_token uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
  v_token uuid := gen_random_uuid();
  existing_status text;
begin
  insert into public.revenuecat_events (event_id, app_user_id, payload, status, claim_token, claimed_at)
  values (p_event_id, p_app_user_id, p_payload, 'processing', v_token, now())
  on conflict (event_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    return query select 'claimed'::text, v_token;
    return;
  end if;

  update public.revenuecat_events
     set claim_token = v_token, claimed_at = now()
   where event_id = p_event_id
     and status = 'processing'
     and claimed_at < now() - interval '15 minutes';
  if found then
    return query select 'claimed'::text, v_token;
    return;
  end if;

  select status into existing_status
    from public.revenuecat_events
   where event_id = p_event_id;
  if existing_status = 'completed' then
    return query select 'duplicate'::text, null::uuid;
    return;
  end if;
  return query select 'in_flight'::text, null::uuid;
end;
$$;

-- Commit a claimed event after successful reconciliation; it is the duplicate guard from then on.
-- The token match ensures only the current claim owner can complete it.
create or replace function public.complete_revenuecat_event(
  p_event_id text,
  p_claim_token uuid
) returns void
language sql
security definer
set search_path = public
as $$
  update public.revenuecat_events
     set status = 'completed', processed_at = now()
   where event_id = p_event_id and status = 'processing' and claim_token = p_claim_token;
$$;

-- Release a failed claim so the sender's retry can re-claim it. Token-scoped: a stale worker's
-- release cannot delete a takeover worker's live claim. Deleting (rather than flagging) keeps the
-- audit table to events that actually reconciled.
create or replace function public.release_revenuecat_event(
  p_event_id text,
  p_claim_token uuid
) returns void
language sql
security definer
set search_path = public
as $$
  delete from public.revenuecat_events
   where event_id = p_event_id and status = 'processing' and claim_token = p_claim_token;
$$;

revoke execute on function public.claim_revenuecat_event(text, text, jsonb) from public;
revoke execute on function public.complete_revenuecat_event(text, uuid) from public;
revoke execute on function public.release_revenuecat_event(text, uuid) from public;
grant execute on function public.claim_revenuecat_event(text, text, jsonb) to still_entitlement_writer;
grant execute on function public.complete_revenuecat_event(text, uuid) to still_entitlement_writer;
grant execute on function public.release_revenuecat_event(text, uuid) to still_entitlement_writer;

-- record_revenuecat_event (0001) stays granted through the deploy window — already-running
-- function code may still call it while migrations land; its rows insert with the 'completed'
-- status default and a null claim_token, matching its record-after-reconcile semantics.
