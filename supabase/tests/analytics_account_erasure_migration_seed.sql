-- TEST ONLY. Synthetic, disposable data for analytics_account_erasure_migration_test.ts. Run as the
-- ordinary `postgres` login against a throwaway local or CI database, never a hosted project.
--
-- Upgrade path: apply after the database is at 0017 and before 0018, so the test can prove 0018
-- leaves every existing row unchanged, erasure rows included: an active subject, a subject retired by
-- device erasure, and jobs at every stage. Clean path: the test runs it itself after all migrations.
begin;

insert into auth.users (id, email) values
  ('c7c7c7c7-0000-4000-8000-000000000071', 'u5w3-seed-one@example.invalid'),
  ('c7c7c7c7-0000-4000-8000-000000000072', 'u5w3-seed-two@example.invalid');

insert into public.profiles
  (id, settings, updated_at, settings_version, settings_server_updated_at, settings_last_write_id) values
  ('c7c7c7c7-0000-4000-8000-000000000071',
   '{"globalOn":true,"services":{"youtube":true,"instagram":true,"tiktok":false,"facebook":true},"pauses":[],"updatedAt":1790000000000}',
   '2026-10-01 12:00:00.123+00', 2, '2026-10-01 12:00:00.123+00', 'eeeeeeee-0000-4000-8000-000000000071');

insert into private.analytics_subjects
  (subject_id, user_id, origin_key, epoch, created_at, last_activity_month, retired_at, retired_reason) values
  ('d7d7d7d7-0000-4000-8000-000000000071', 'c7c7c7c7-0000-4000-8000-000000000071',
   pg_catalog.decode(pg_catalog.repeat('71', 32), 'hex'), 0, '2026-10-01 10:00:00+00', '2026-10-01', null, null),
  ('d7d7d7d7-0000-4000-8000-000000000072', 'c7c7c7c7-0000-4000-8000-000000000071',
   pg_catalog.decode(pg_catalog.repeat('72', 32), 'hex'), 0, '2026-10-01 10:05:00+00', '2026-10-01',
   '2026-10-02 09:00:00+00', 'device_erasure'),
  ('d7d7d7d7-0000-4000-8000-000000000073', 'c7c7c7c7-0000-4000-8000-000000000072',
   pg_catalog.decode(pg_catalog.repeat('73', 32), 'hex'), 0, '2026-10-01 11:00:00+00', '2026-10-01', null, null);

-- One job at each stage, and one account_deleted snapshot job.
insert into private.analytics_erasure_jobs
  (job_id, scope, scope_key, stage, sweeps, attempts, priority, next_attempt_at, lease_token, lease_until,
   last_error, created_at, accepted_at, last_queued_at, confirmed_at, completed_at, fence_until) values
  ('e7e7e7e7-0000-4000-8000-000000000071', 'device', pg_catalog.decode(pg_catalog.repeat('72', 32), 'hex'),
   'stop_recorded', 0, 2, 2, '2026-10-02 09:10:00+00', null, null, 'provider_unavailable',
   '2026-10-02 09:00:00+00', null, null, null, null, null),
  ('e7e7e7e7-0000-4000-8000-000000000072', 'device', pg_catalog.decode(pg_catalog.repeat('a2', 32), 'hex'),
   'provider_delete_accepted', 0, 0, 1, '2026-10-03 09:00:00+00', 'f7f7f7f7-0000-4000-8000-000000000072',
   '2026-10-02 09:05:00+00', null, '2026-10-01 09:00:00+00', '2026-10-02 09:00:00+00', '2026-10-02 09:00:00+00',
   null, null, null),
  ('e7e7e7e7-0000-4000-8000-000000000073', 'device', pg_catalog.decode(pg_catalog.repeat('a3', 32), 'hex'),
   'provider_delete_confirmed', 1, 0, 1, '2026-10-09 09:00:00+00', null, null, null,
   '2026-09-30 09:00:00+00', '2026-10-01 09:00:00+00', '2026-10-01 09:00:00+00', '2026-10-02 09:00:00+00', null, null),
  ('e7e7e7e7-0000-4000-8000-000000000074', 'device', pg_catalog.decode(pg_catalog.repeat('a4', 32), 'hex'),
   'complete', 3, 0, 0, null, null, null, null,
   '2026-08-01 09:00:00+00', '2026-08-01 09:00:00+00', '2026-08-01 09:00:00+00', '2026-08-02 09:00:00+00',
   '2026-08-10 09:00:00+00', '2027-09-10 09:00:00+00'),
  ('e7e7e7e7-0000-4000-8000-000000000075', 'account_deleted', pg_catalog.decode(pg_catalog.repeat('a5', 32), 'hex'),
   'stop_recorded', 0, 0, 2, '2026-10-02 10:00:00+00', null, null, null,
   '2026-10-02 10:00:00+00', null, null, null, null, null);

insert into private.analytics_erasure_targets (job_id, distinct_id, kind) values
  ('e7e7e7e7-0000-4000-8000-000000000071', 'd7d7d7d7-0000-4000-8000-000000000072', 'subject'),
  ('e7e7e7e7-0000-4000-8000-000000000071', '0dabc01d-ecd0-4609-ba4e-3e6042fc943d', 'anonymous'),
  ('e7e7e7e7-0000-4000-8000-000000000072', '4014f145-283a-46f9-a903-62884494004e', 'anonymous'),
  ('e7e7e7e7-0000-4000-8000-000000000073', 'b183e157-7bab-4097-ba43-d08a5a62d8bc', 'anonymous'),
  ('e7e7e7e7-0000-4000-8000-000000000074', 'd7d7d7d7-0000-4000-8000-0000000000a4', 'subject'),
  ('e7e7e7e7-0000-4000-8000-000000000075', 'd7d7d7d7-0000-4000-8000-0000000000a5', 'subject');

commit;
