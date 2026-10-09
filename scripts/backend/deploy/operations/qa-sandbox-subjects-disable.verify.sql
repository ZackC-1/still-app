-- Read-only check for qa-sandbox-subjects (policy_mode disable). Run before the operation (to detect
-- "already disabled") and after it. One row, one column: a JSON array of issue codes ordered with
-- collate "C". An empty array means no QA sandbox membership is enabled. Counts only; never a row.
with
issues(code) as (
  select 'subjects_enabled'
  where exists (select 1 from private.qa_sandbox_subjects s where s.enabled)
)
select coalesce(pg_catalog.json_agg(i.code order by i.code collate "C"), '[]'::json)::text
from issues i;
