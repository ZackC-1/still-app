-- Read-only production state check. Sandbox preservation is proved by the operation rehearsal.
with
target as (
  select (:'still_operation_policy_body')::jsonb - 'revision' as body
),
head as (
  select r.body
  from private.product_policy_revisions r
  where r.namespace = 'sales' and r.environment = 'production'
  order by r.revision desc
  limit 1
),
cutoff as (
  select c.product, c.benefits
  from private.paid_cutoff c
  where c.environment = 'production'
),
issues(code) as (
  select 'production_sales_policy_missing'
  where not exists (select 1 from head)
  union all
  select 'production_sales_policy_differs'
  from head h cross join target t
  where (h.body::jsonb - 'revision') is distinct from t.body
  union all
  select 'production_cutoff_missing'
  where not exists (select 1 from cutoff)
  union all
  select 'production_cutoff_differs'
  from cutoff c
  where c.product <> 'still-free-v2'
     or c.benefits is distinct from array['facebook.reels', 'instagram.reels', 'tiktok.all', 'youtube.shorts']::text[]
)
select coalesce(pg_catalog.json_agg(i.code order by i.code collate "C"), '[]'::json)::text
from issues i;
