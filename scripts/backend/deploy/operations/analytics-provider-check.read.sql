-- Read-only answer to analytics-provider-check.sql (scripts/backend/deploy/analytics-subjects.mjs).
-- The runner passes the pg_net request id as STILL_OPERATION_REQUEST_ID. One row, one column, a
-- JSON object: whether pg_net has an answer yet, its HTTP status, and the body only when the status
-- is 200 (the function's fixed provider codes; the runner checks each against its fixed list).
select pg_catalog.json_build_object(
  'found', pg_catalog.count(*) > 0,
  'status', pg_catalog.max(r.status_code),
  'content', pg_catalog.max(case when r.status_code = 200 then r.content end)
)::text
from net._http_response r
where r.id = (:'still_operation_request_id')::bigint;
