-- TEST ONLY. Synthetic, disposable data for analytics_erasure_migration_test.ts. Run as the ordinary
-- `postgres` login against a throwaway local or CI database, never a hosted project.
--
-- Upgrade path: apply after the database is at 0016 and before 0017, so the test can prove 0017
-- leaves every existing row unchanged. Clean path: the test runs it itself after all migrations.
begin;

insert into auth.users (id, email) values
  ('b5b5b5b5-0000-4000-8000-000000000051', 'u5w2-settings@example.invalid'),
  ('b5b5b5b5-0000-4000-8000-000000000052', 'u5w2-paid@example.invalid');

insert into public.entitlements (user_id, still_sync, source, revenuecat_subscriber_id, updated_at)
values ('b5b5b5b5-0000-4000-8000-000000000052', true, 'webhook', 'synthetic-sub-u5w2', '2026-09-10 09:00:00+00');

insert into public.profiles
  (id, settings, updated_at, settings_version, settings_server_updated_at, settings_last_write_id) values
  ('b5b5b5b5-0000-4000-8000-000000000051',
   '{"globalOn":true,"services":{"youtube":true,"instagram":false,"tiktok":true,"facebook":true},"pauses":[],"updatedAt":1790000000000}',
   '2026-09-21 12:00:00.123+00', 3, '2026-09-21 12:00:00.123+00', 'eeeeeeee-0000-4000-8000-000000000051');

insert into private.settings_anchors (user_id, lineage, secret, modern_used)
values ('b5b5b5b5-0000-4000-8000-000000000051', 'f1f1f1f1-0000-4000-8000-000000000051',
        pg_catalog.decode(pg_catalog.repeat('b5', 32), 'hex'), true);

commit;
