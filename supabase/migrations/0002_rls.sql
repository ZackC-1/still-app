-- Row-level security (KTD8). RLS is enabled on every table. auth.uid() is wrapped in a scalar
-- subselect `(select auth.uid())` so the planner evaluates it once per query (Supabase RLS perf
-- guidance, CVE-2025-48757). Writes to entitlements / revenuecat_events go ONLY through the
-- SECURITY DEFINER RPCs in 0001 — there are deliberately no write policies here.

-- ── profiles: a user reads and writes only their own row ─────────────────────────
alter table public.profiles enable row level security;

create policy "profiles: read own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "profiles: insert own"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

create policy "profiles: update own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ── entitlements: a user reads only their own row; nobody writes via RLS ──────────
alter table public.entitlements enable row level security;

create policy "entitlements: read own"
  on public.entitlements for select
  to authenticated
  using ((select auth.uid()) = user_id);
-- No insert/update/delete policy: the only write path is set_entitlement() (narrow writer role).

-- ── revenuecat_events: denied to everyone via RLS (writer role uses SECURITY DEFINER RPC) ─
alter table public.revenuecat_events enable row level security;

create policy "revenuecat_events: deny all"
  on public.revenuecat_events for all
  to anon, authenticated
  using (false)
  with check (false);

-- ── rule_sets: no direct access; the current set is read via get_current_rule_set() ──
alter table public.rule_sets enable row level security;

create policy "rule_sets: deny direct read"
  on public.rule_sets for all
  to anon, authenticated
  using (false)
  with check (false);

-- ── table-level grants ───────────────────────────────────────────────────────────
-- This project keeps the Data API roles un-auto-exposed (config.toml), so grants are explicit and
-- RLS gates the rows. A user touches its own profile + reads its own entitlement; everything else
-- (events, raw rule_sets, entitlement writes) is reachable only through SECURITY DEFINER RPCs.
grant select, insert, update on public.profiles to authenticated;
grant select on public.entitlements to authenticated;
-- events + raw rule_sets carry SELECT grants but a `using(false)` policy, so a direct SELECT
-- returns ZERO rows (never an error that leaks shape); the real data flows through the RPCs only.
-- No insert/update/delete grants → write attempts are denied outright.
grant select on public.revenuecat_events to anon, authenticated;
grant select on public.rule_sets to anon, authenticated;
