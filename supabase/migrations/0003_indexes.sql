-- Indexes (KTD8). The user_id / id / event_id columns are primary keys (already indexed); these are
-- the additional lookup + integrity indexes the access patterns need.

-- Reconcile looks up events by app_user_id (e.g. TRANSFER touches two ids).
create index if not exists revenuecat_events_app_user_id_idx
  on public.revenuecat_events (app_user_id);

-- get_current_rule_set() filters on is_current; also enforce that AT MOST ONE row is current so
-- "the current set" is unambiguous (a publish flips the old one off in the same transaction).
create unique index if not exists rule_sets_single_current_idx
  on public.rule_sets (is_current)
  where is_current = true;
