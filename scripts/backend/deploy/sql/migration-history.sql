-- Read-only. One row, one column: the applied migration history as a JSON array of
-- {"version", "name"} objects ordered by version. Reads catalog bookkeeping only, never
-- customer rows. The deploy runner executes it inside a read-only session and never prints
-- the raw result; it compares it with the expected list and prints only a category and counts.
select coalesce(
  pg_catalog.json_agg(
    pg_catalog.json_build_object('version', m.version, 'name', coalesce(m.name, ''))
    order by m.version
  ),
  '[]'::json
)::text
from supabase_migrations.schema_migrations m;
