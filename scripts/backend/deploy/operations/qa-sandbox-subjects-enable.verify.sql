-- Read-only check for qa-sandbox-subjects (policy_mode enable). Run before the operation (to detect
-- "already enabled" and to refuse an unusable list before any write) and after it. The runner
-- supplies the approved per-email SHA-256 values as the psql variable
-- still_operation_subject_hashes (a JSON array). One row, one column: a JSON array of issue codes
-- ordered with collate "C". An empty array means every approved entry matches exactly one confirmed,
-- active Auth account whose QA membership is enabled, and no other membership is enabled (the
-- enabled set is exactly the approved list). Prints codes only, never an email, hash or id.
with
approved as (
  select h.hash
  from pg_catalog.jsonb_array_elements_text((:'still_operation_subject_hashes')::jsonb) h(hash)
),
matched as (
  select a.hash, u.id,
         u.email_confirmed_at is not null and u.deleted_at is null
           and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp()) as active
  from approved a
  left join auth.users u
    on pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8')), 'hex') = a.hash
),
issues(code) as (
  select 'subject_unresolved'
  where exists (select 1 from matched m where m.id is null)
  union all
  select 'subject_ambiguous'
  where exists (select 1 from matched m where m.id is not null group by m.hash having pg_catalog.count(*) > 1)
  union all
  select 'subject_unconfirmed'
  where exists (select 1 from matched m where m.id is not null and not m.active)
  union all
  select 'subject_not_enabled'
  where exists (
    select 1 from matched m
    left join private.qa_sandbox_subjects s on s.holder = m.id
    where m.id is not null and s.enabled is not true
  )
  union all
  select 'subjects_unlisted_enabled'
  where exists (
    select 1 from private.qa_sandbox_subjects s
    where s.enabled and not exists (select 1 from matched m where m.id = s.holder)
  )
)
select coalesce(pg_catalog.json_agg(i.code order by i.code collate "C"), '[]'::json)::text
from issues i;
