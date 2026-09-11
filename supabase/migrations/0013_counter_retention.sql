-- Approval-gated forward migration: purges all legacy identifier-bearing counters once.
-- Existing RPC callers and throttle windows stay compatible; do not restore old counter backups.
create extension if not exists pgcrypto with schema extensions;

-- A fresh random key per fixed window prevents a persistent connection identifier. Keys and
-- derived counters have the same expiry; no IP-to-account association is recorded.
create table public.rate_limit_window_keys (
  window_start timestamptz not null,
  window_seconds integer not null check (window_seconds in (60, 600)),
  secret bytea not null,
  expires_at timestamptz not null,
  primary key (window_start, window_seconds),
  check (isfinite(window_start) and isfinite(expires_at)),
  check (expires_at = window_start + window_seconds * interval '1 second')
);
alter table public.rate_limit_window_keys enable row level security;
revoke all on public.rate_limit_window_keys from public, anon, authenticated, service_role, still_entitlement_writer;

-- The legacy schema did not record each bucket's duration. Purge rather than invent an expiry or
-- carry raw IP/email keys into the new schema. This resets only transient abuse counters once.
delete from public.rate_limit_counters;
alter table public.rate_limit_counters
  add column window_seconds integer not null check (window_seconds in (60, 600)),
  add column expires_at timestamptz not null,
  add column account_id uuid references auth.users(id) on delete cascade,
  add constraint rate_limit_expiry check (expires_at = window_start + window_seconds * interval '1 second'),
  add constraint rate_limit_window_key foreign key (window_start, window_seconds)
    references public.rate_limit_window_keys(window_start, window_seconds) on delete cascade;
create index rate_limit_expiry_idx on public.rate_limit_counters(expires_at);
create index rate_limit_account_idx on public.rate_limit_counters(account_id) where account_id is not null;
create index rate_limit_key_expiry_idx on public.rate_limit_window_keys(expires_at);
revoke all on public.rate_limit_counters from public, anon, authenticated, service_role, still_entitlement_writer;

create or replace function public.consume_rate_limit(
  p_bucket_key text, p_max_requests integer, p_window_seconds integer
) returns integer
language plpgsql security definer set search_path = ''
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
  if parts is null or parts[1] not in ('checkout', 'reconcile', 'review-signin:request', 'review-signin:verify') then
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
revoke execute on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.consume_rate_limit(text, integer, integer) to still_entitlement_writer;

-- Pre-account review-email buckets may exist before auth.users does. Attach them when an account
-- appears; also erase any still-unattached current-email buckets as part of auth deletion. The
-- advisory lock serializes email lookup/creation with these transitions without storing history.
create function public.sync_rate_limit_account() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  email_value text;
begin
  email_value := lower(case when TG_OP = 'DELETE' then OLD.email else NEW.email end);
  if email_value is not null then
    perform pg_advisory_xact_lock(hashtextextended(email_value, 152));
    if TG_OP = 'DELETE' then
      delete from public.rate_limit_counters c using public.rate_limit_window_keys k
        where c.window_start = k.window_start and c.window_seconds = k.window_seconds
        and c.bucket_key in (
          'review-signin:request:user:' || encode(extensions.hmac(
            ('review-signin:request:user:' || email_value)::bytea, k.secret, 'sha256'), 'hex'),
          'review-signin:verify:user:' || encode(extensions.hmac(
            ('review-signin:verify:user:' || email_value)::bytea, k.secret, 'sha256'), 'hex'));
    else
      update public.rate_limit_counters c set account_id = NEW.id
        from public.rate_limit_window_keys k
        where c.account_id is null and c.window_start = k.window_start and c.window_seconds = k.window_seconds
        and c.bucket_key in (
          'review-signin:request:user:' || encode(extensions.hmac(
            ('review-signin:request:user:' || email_value)::bytea, k.secret, 'sha256'), 'hex'),
          'review-signin:verify:user:' || encode(extensions.hmac(
            ('review-signin:verify:user:' || email_value)::bytea, k.secret, 'sha256'), 'hex'));
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.sync_rate_limit_account() from public, anon, authenticated, service_role, still_entitlement_writer;
create trigger rate_limit_account_created after insert or update of email on auth.users
  for each row execute function public.sync_rate_limit_account();
create trigger rate_limit_account_deleted after delete on auth.users
  for each row execute function public.sync_rate_limit_account();

-- Deleting a window key cascades to its counters. This is a SQL DELETE of expired records, not
-- merely ignoring them; WAL/backups/provider logs remain a separate operational retention scope.
create function public.cleanup_rate_limit_counters() returns void
language sql security definer set search_path = ''
as $$
  delete from public.rate_limit_window_keys where expires_at <= clock_timestamp();
$$;
revoke all on function public.cleanup_rate_limit_counters() from public, anon, authenticated, service_role, still_entitlement_writer;

create extension if not exists pg_cron;
select cron.schedule('still-rate-limit-retention', '* * * * *',
  $$set statement_timeout = '5s'; select public.cleanup_rate_limit_counters();$$);
