-- Read-only check for qa-sandbox-sales-policy (policy_mode off). Run before the operation (to detect
-- "already off") and after it. The runner supplies the body the plan showed for approval as the psql
-- variable still_operation_policy_body. One row, one column: a JSON array of issue codes ordered
-- with collate "C". An empty array means the newest SANDBOX sales revision carries exactly the
-- pinned off body (ignoring its revision number) and production has no paid cutoff. Prints codes
-- only, never a body or row.
with
target as (
  select (:'still_operation_policy_body')::jsonb - 'revision' as body
),
head as (
  select r.body
  from private.product_policy_revisions r
  where r.namespace = 'sales' and r.environment = 'sandbox'
  order by r.revision desc
  limit 1
),
issues(code) as (
  select 'sandbox_sales_policy_missing'
  where not exists (select 1 from head)
  union all
  select 'sandbox_sales_policy_differs'
  from head h cross join target t
  where (h.body::jsonb - 'revision') is distinct from t.body
  union all
  select 'production_cutoff_present'
  where exists (select 1 from private.paid_cutoff c where c.environment = 'production')
)
select coalesce(pg_catalog.json_agg(i.code order by i.code collate "C"), '[]'::json)::text
from issues i;
