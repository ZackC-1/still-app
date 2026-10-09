-- Read-only check for resume-qa-sandbox. Run before the operation (to detect "already resumed")
-- and after it. One row, one column: a JSON array of issue codes ordered with collate "C". An empty
-- array means the paid QA lane may resume: the QA writer role exists and can sign in. Catalog only;
-- never a row.
with
writer as (
  select r.oid, r.rolcanlogin
  from pg_catalog.pg_roles r
  where r.rolname = 'still_qa_sandbox_writer'
),
issues(code) as (
  select 'writer_role_missing'
  where not exists (select 1 from writer)
  union all
  select 'writer_cannot_login'
  from writer w
  where not w.rolcanlogin
)
select coalesce(pg_catalog.json_agg(i.code order by i.code collate "C"), '[]'::json)::text
from issues i;
