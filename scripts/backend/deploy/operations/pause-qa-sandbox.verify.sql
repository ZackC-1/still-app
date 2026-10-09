-- Read-only check for pause-qa-sandbox. Run before the operation (to detect "already paused")
-- and twice after it (immediately, then after a settle wait). One row, one column: a JSON array of
-- issue codes ordered with collate "C". An empty array means the paid QA lane is paused: the QA
-- writer role exists, cannot sign in, and holds no connection. Catalog and activity counts only;
-- never a table row.
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
  select 'writer_can_login'
  from writer w
  where w.rolcanlogin
  union all
  select 'writer_connections_open'
  from writer w
  where exists (
    select 1 from pg_catalog.pg_stat_activity a
    where a.usesysid = w.oid and a.pid <> pg_catalog.pg_backend_pid()
  )
)
select coalesce(pg_catalog.json_agg(i.code order by i.code collate "C"), '[]'::json)::text
from issues i;
