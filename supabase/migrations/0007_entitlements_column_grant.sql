-- Tighten the entitlements read grant to only the column the client needs (P2 least-privilege).
-- Before: `grant select on public.entitlements to authenticated` exposed every column of a user's OWN
-- row to a `select *` — including the internal `revenuecat_subscriber_id` and `source`. RLS (0002)
-- already limits a user to their own row; this also limits WHICH columns that row exposes.
--
-- The web client reads only `still_sync` (sync/profile.ts). A column-level grant denies selecting
-- revenuecat_subscriber_id / source / updated_at while leaving the existing still_sync read working.
revoke select on public.entitlements from authenticated;
grant select (user_id, still_sync) on public.entitlements to authenticated;
