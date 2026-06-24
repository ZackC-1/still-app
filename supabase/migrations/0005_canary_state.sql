-- Selector-canary persisted state (U21/R12). One row per tracked key (svc:<id> consecutive-
-- indeterminate streak, surf:<id>:<surface> already-notified-broken flag) so the canary alerts on
-- transitions rather than every run. Written by the canary function (service role); opaque to users.
create table public.canary_state (
  key         text primary key,
  num         integer     not null default 0,
  flag        boolean     not null default false,
  updated_at  timestamptz not null default now()
);

alter table public.canary_state enable row level security;

create policy "canary_state: deny all"
  on public.canary_state for all
  to anon, authenticated
  using (false)
  with check (false);
-- No grants to anon/authenticated. The scheduled canary uses the service role (bypasses RLS).
