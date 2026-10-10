-- Read-only facts for the analytics-subjects operations (scripts/backend/deploy/analytics-subjects.mjs),
-- read before and after every change. One row, one column: a JSON object. Catalog facts, counts and
-- one SHA-256 digest only; no secret, id, email or row content leaves the database.
--
--   eraser            still_analytics_eraser: missing, login or nologin (pg_roles.rolcanlogin)
--   pgCron, pgNet     whether the extensions are installed
--   vaultTokens       how many Vault entries are named still_analytics_erasure_worker_token
--   vaultTokenSha256  SHA-256 (hex) of that entry's value when there is exactly one, else null; the
--                     runner compares it with the digest the Management API reports for the
--                     ANALYTICS_ERASURE_WORKER_TOKEN function secret (only digests are compared)
--   jobs              how many pg_cron jobs are named still-analytics-erasure-worker
--   job               that job's schedule, active flag, user and the SHA-256 of its command, or null
--   recentRuns        that job's runs that succeeded in the last 35 minutes (pg_cron ran the command)
--   recentWorkerOk    pg_net responses in the last 35 minutes with status 200 whose body is a worker
--                     report ({"claimed": ...}) that skipped nothing and has failed = 0 and lost = 0
--   recentWorkerSkipped  the same, but the report says the worker skipped (provider unconfigured)
--   recentWorkerFailing  a worker report that skipped nothing but has failed or lost jobs
--                     Both are 0 before pg_net is installed and null if this session may not read
--                     pg_net's response table (the switch then refuses: worker_evidence_unreadable).
--
-- pg_net's response table is read through query_to_xml so this query also parses before pg_net is
-- installed. A failed request (no status, an error message) never counts as a worker answer.
with
eraser as (
  select r.rolcanlogin from pg_catalog.pg_roles r where r.rolname = 'still_analytics_eraser'
),
tokens as (
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.decrypted_secret, 'UTF8')), 'hex') as digest
  from vault.decrypted_secrets s
  where s.name = 'still_analytics_erasure_worker_token'
),
jobs as (
  select j.jobid, j.schedule, j.active, j.username,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(j.command, 'UTF8')), 'hex') as command_sha256
  from cron.job j
  where j.jobname = 'still-analytics-erasure-worker'
),
runs as (
  select pg_catalog.count(*)::int as n
  from cron.job_run_details d
  join jobs j on j.jobid = d.jobid
  where d.status = 'succeeded' and d.end_time > pg_catalog.now() - interval '35 minutes'
),
net as (
  select pg_catalog.to_regclass('net._http_response') is not null as present
),
responses as (
  select
    case when n.present then case when pg_catalog.has_table_privilege('net._http_response', 'select') then
      (pg_catalog.xpath('/row/ok/text()', pg_catalog.query_to_xml($q$
      select pg_catalog.count(*) filter (where r.kind = 'ok') as ok
      from (
        select case
          when r.status_code is distinct from 200 or r.content is null
            or not pg_catalog.pg_input_is_valid(r.content, 'jsonb') then 'other'
          when pg_catalog.jsonb_typeof(r.content::jsonb) <> 'object' or not (r.content::jsonb ? 'claimed') then 'other'
          when r.content::jsonb ? 'skipped' then 'skipped'
          when coalesce(r.content::jsonb ->> 'failed', '') <> '0' or coalesce(r.content::jsonb ->> 'lost', '') <> '0' then 'failing'
          else 'ok' end as kind
        from net._http_response r
        where r.created > pg_catalog.now() - interval '35 minutes'
      ) r
    $q$, false, true, '')))[1]::text::int end end as ok,
    case when n.present then case when pg_catalog.has_table_privilege('net._http_response', 'select') then
      (pg_catalog.xpath('/row/skipped/text()', pg_catalog.query_to_xml($q$
      select pg_catalog.count(*) filter (where r.kind = 'skipped') as skipped
      from (
        select case
          when r.status_code is distinct from 200 or r.content is null
            or not pg_catalog.pg_input_is_valid(r.content, 'jsonb') then 'other'
          when pg_catalog.jsonb_typeof(r.content::jsonb) <> 'object' or not (r.content::jsonb ? 'claimed') then 'other'
          when r.content::jsonb ? 'skipped' then 'skipped'
          when coalesce(r.content::jsonb ->> 'failed', '') <> '0' or coalesce(r.content::jsonb ->> 'lost', '') <> '0' then 'failing'
          else 'ok' end as kind
        from net._http_response r
        where r.created > pg_catalog.now() - interval '35 minutes'
      ) r
    $q$, false, true, '')))[1]::text::int end end as skipped,
    case when n.present then case when pg_catalog.has_table_privilege('net._http_response', 'select') then
      (pg_catalog.xpath('/row/failing/text()', pg_catalog.query_to_xml($q$
      select pg_catalog.count(*) filter (where r.kind = 'failing') as failing
      from (
        select case
          when r.status_code is distinct from 200 or r.content is null
            or not pg_catalog.pg_input_is_valid(r.content, 'jsonb') then 'other'
          when pg_catalog.jsonb_typeof(r.content::jsonb) <> 'object' or not (r.content::jsonb ? 'claimed') then 'other'
          when r.content::jsonb ? 'skipped' then 'skipped'
          when coalesce(r.content::jsonb ->> 'failed', '') <> '0' or coalesce(r.content::jsonb ->> 'lost', '') <> '0' then 'failing'
          else 'ok' end as kind
        from net._http_response r
        where r.created > pg_catalog.now() - interval '35 minutes'
      ) r
    $q$, false, true, '')))[1]::text::int end end as failing
  from net n
)
select pg_catalog.json_build_object(
  'eraser', case when not exists (select 1 from eraser) then 'missing'
                 when (select e.rolcanlogin from eraser e) then 'login' else 'nologin' end,
  'pgCron', exists (select 1 from pg_catalog.pg_extension x where x.extname = 'pg_cron'),
  'pgNet', exists (select 1 from pg_catalog.pg_extension x where x.extname = 'pg_net'),
  'vaultTokens', (select pg_catalog.count(*)::int from tokens),
  'vaultTokenSha256', case when (select pg_catalog.count(*) from tokens) = 1 then (select t.digest from tokens t) end,
  'jobs', (select pg_catalog.count(*)::int from jobs),
  'job', case when (select pg_catalog.count(*) from jobs) = 1 then (
    select pg_catalog.json_build_object('schedule', j.schedule, 'active', j.active,
      'username', j.username::text, 'commandSha256', j.command_sha256) from jobs j) end,
  'recentRuns', (select r.n from runs r),
  'recentWorkerOk', case when (select n.present from net n) then (select r.ok from responses r) else 0 end,
  'recentWorkerSkipped', case when (select n.present from net n) then (select r.skipped from responses r) else 0 end,
  'recentWorkerFailing', case when (select n.present from net n) then (select r.failing from responses r) else 0 end
)::text;
