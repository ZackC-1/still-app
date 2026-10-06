-- Read-only. REHEARSAL ONLY: never run against production (it reads every row of the listed
-- schemas). One row, one column: a sorted JSON array with one line per table in schemas public,
-- private and supabase_migrations: its row count and an MD5 of all its rows in a stable order.
--
-- The owner-approved operations rehearsal runs it on the runner's throwaway database before and
-- after the operation and requires the two lists to be identical: the operation touched no data.
select coalesce(pg_catalog.json_agg(x.line order by x.line collate "C"), '[]'::json)::text
from (
  select n.nspname || '.' || c.relname || ' | ' ||
         (pg_catalog.xpath(
            '/row/f/text()',
            pg_catalog.query_to_xml(
              pg_catalog.format(
                'select pg_catalog.count(*)::text || %L || pg_catalog.md5(coalesce(pg_catalog.string_agg(t::text, %L order by t::text collate "C"), %L)) as f from %I.%I t',
                ' rows, md5 ', E'\n', '', n.nspname, c.relname),
              false, true, '')))[1]::text as line
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public', 'private', 'supabase_migrations')
) x;
