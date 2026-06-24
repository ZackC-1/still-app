-- Still v1 schema (KTD6/KTD8). One settings set per user, server-written entitlements, an
-- idempotent RevenueCat event log, and signed rule-set hosting exposed through a current-only RPC.
-- RLS policies live in 0002_rls.sql; indexes in 0003_indexes.sql.

-- ── profiles ────────────────────────────────────────────────────────────────────
-- One row per user (KTD6). `settings` is the single synced settings set (jsonb). No scope column.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  settings    jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ── entitlements ────────────────────────────────────────────────────────────────
-- The cross-device unlock. Written ONLY server-side (webhook/reconcile) via set_entitlement();
-- users may read their own row but never write it. `revenuecat_subscriber_id` is not exposed to
-- clients (see 0002 — only still_sync is user-readable through the select policy on the row).
create table public.entitlements (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  still_sync              boolean     not null default false,
  source                  text,
  revenuecat_subscriber_id text,
  updated_at              timestamptz not null default now()
);

-- ── revenuecat_events ───────────────────────────────────────────────────────────
-- Webhook idempotency + audit. event_id is the RevenueCat event id (idempotency key). NEVER
-- user-readable (resolved aliases live only here / in the payload, never in a user-facing column).
create table public.revenuecat_events (
  event_id      text primary key,
  app_user_id   text        not null,
  processed_at  timestamptz not null default now(),
  payload       jsonb       not null
);

-- ── rule_sets ───────────────────────────────────────────────────────────────────
-- Signed rule-set hosting. Raw history is NOT publicly enumerable; clients read the current set
-- only through get_current_rule_set() (KTD8). Exactly one row may be is_current (enforced in 0003).
create table public.rule_sets (
  version       text primary key,
  payload       jsonb       not null,
  signature     jsonb       not null,
  is_current    boolean     not null default false,
  published_at  timestamptz not null default now()
);

-- ── narrow entitlement-write role (KTD5) ────────────────────────────────────────
-- A login-less role that is the ONLY grantee of the write RPCs below — never the full service_role
-- key. The deploy step grants it LOGIN + a password (ENTITLEMENT_WRITE_RPC_SECRET) so the webhook /
-- reconcile functions connect as this role and can do nothing but execute these functions.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'still_entitlement_writer') then
    create role still_entitlement_writer nologin;
  end if;
end
$$;
grant usage on schema public to still_entitlement_writer;

-- ── write RPCs (SECURITY DEFINER) ───────────────────────────────────────────────
-- Run as the owner (postgres), so they bypass RLS to write the otherwise-unwritable tables. The
-- subject user_id is always passed in by the caller (the webhook resolves it from RevenueCat; the
-- reconcile function takes it ONLY from the verified JWT — never the request body).

create or replace function public.set_entitlement(
  p_user_id uuid,
  p_still_sync boolean,
  p_source text,
  p_revenuecat_subscriber_id text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.entitlements (user_id, still_sync, source, revenuecat_subscriber_id, updated_at)
  values (p_user_id, p_still_sync, p_source, p_revenuecat_subscriber_id, now())
  on conflict (user_id) do update
    set still_sync = excluded.still_sync,
        source = excluded.source,
        revenuecat_subscriber_id = excluded.revenuecat_subscriber_id,
        updated_at = now();
end;
$$;

-- Records an event idempotently. Returns true if newly inserted (process it), false if a duplicate.
create or replace function public.record_revenuecat_event(
  p_event_id text,
  p_app_user_id text,
  p_payload jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted boolean;
begin
  insert into public.revenuecat_events (event_id, app_user_id, payload)
  values (p_event_id, p_app_user_id, p_payload)
  on conflict (event_id) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- ── public current-rule-set RPC ─────────────────────────────────────────────────
-- The only public read path into rule_sets. Returns just the current published set; raw history
-- enumeration is blocked by RLS (0002).
create or replace function public.get_current_rule_set()
returns table (version text, payload jsonb, signature jsonb)
language sql
security definer
set search_path = public
stable
as $$
  select version, payload, signature
  from public.rule_sets
  where is_current = true
  limit 1;
$$;

-- Lock down execute grants: write RPCs only to the narrow writer role; current-set RPC to clients.
revoke execute on function public.set_entitlement(uuid, boolean, text, text) from public;
revoke execute on function public.record_revenuecat_event(text, text, jsonb) from public;
grant execute on function public.set_entitlement(uuid, boolean, text, text) to still_entitlement_writer;
grant execute on function public.record_revenuecat_event(text, text, jsonb) to still_entitlement_writer;

revoke execute on function public.get_current_rule_set() from public;
grant execute on function public.get_current_rule_set() to anon, authenticated;
