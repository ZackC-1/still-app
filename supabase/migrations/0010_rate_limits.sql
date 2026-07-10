-- Fixed-window rate limiting for the authenticated billing/reconcile functions. Every accepted
-- create-web-checkout / reconcile-entitlement request triggers RevenueCat-backed work, so counters
-- gate them per user and per IP. The ONLY access path is the SECURITY DEFINER RPC below, granted —
-- like the entitlement write RPCs (KTD5) — solely to the narrow still_entitlement_writer role;
-- clients can neither read nor tamper with counters.

create table public.rate_limit_counters (
  bucket_key   text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (bucket_key, window_start)
);

alter table public.rate_limit_counters enable row level security;

create policy "rate_limit_counters: deny all"
  on public.rate_limit_counters for all
  to anon, authenticated
  using (false)
  with check (false);

-- Atomically consume one request from the caller's current fixed window. Returns 0 when the
-- request is allowed, else the number of seconds until the window resets (the 429 Retry-After
-- value). Stale windows of the same bucket are deleted on the way in, so the table holds at most
-- one live row per active bucket.
create or replace function public.consume_rate_limit(
  p_bucket_key text,
  p_max_requests integer,
  p_window_seconds integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  w_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  new_count integer;
begin
  delete from public.rate_limit_counters
   where bucket_key = p_bucket_key and window_start < w_start;

  insert into public.rate_limit_counters (bucket_key, window_start, count)
  values (p_bucket_key, w_start, 1)
  on conflict (bucket_key, window_start) do update
    set count = rate_limit_counters.count + 1
  returning count into new_count;

  if new_count <= p_max_requests then
    return 0;
  end if;
  return greatest(1, ceil(extract(epoch from (w_start + make_interval(secs => p_window_seconds) - now())))::integer);
end;
$$;

revoke execute on function public.consume_rate_limit(text, integer, integer) from public;
grant execute on function public.consume_rate_limit(text, integer, integer) to still_entitlement_writer;
