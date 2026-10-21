-- Production sales and cutoff summary: one read-only view for the PROD-01 check.
--
-- Why. Before production sales are switched on (and after), the operator needs to read the
-- production sales policy and the paid cutoff without the SQL editor and without any account data:
-- the newest production sales revision (and so the expected revision a later production sales
-- operation must name), salesEnabled, both channel offers, the approved build list, and whether the
-- write-once production cutoff exists with its product id and benefit list. The read-only QA check
-- route (docs/release/qa-readonly-database-checks.md) could only see production as a keyed digest.
--
-- What it adds. Exactly one view, still_qa_checks.production_sales_summary, that always returns one
-- row. It reads only private.product_policy_revisions (the newest production sales row) and
-- private.paid_cutoff (the production row). Everything in the sales columns is already public
-- through the product-policy route; the cutoff columns are product configuration. No account id,
-- owner, operation id, preview hash, email, count of people or anything keyed to a person is
-- exposed. The view is owned by postgres and runs with its owner's privileges (as every
-- still_qa_checks view does), so no base-table grant is needed or made.
--
-- Who can read it. Only still_qa_readonly_checker, and only SELECT. That narrow role and the
-- still_qa_checks schema come from the reviewed, unnumbered candidate
-- scripts/backend/sql/qa-readonly-checks-candidate.sql, which hosted production already holds. This
-- migration therefore works in both orders:
--   * the role exists (hosted production): the view is created and SELECT is granted to it;
--   * the role does not exist (a disposable rehearsal or a fresh database): the schema is created
--     owned by postgres if missing, the view is created with no grant, and installing the candidate
--     later grants it (the candidate grants this view whenever it exists).
-- PUBLIC, anon, authenticated and service_role are revoked explicitly and never granted.
--
-- Authority and idempotence. Applied by the hosted migration role `postgres` (non-superuser) and
-- nothing else, through the protected migration operation (supabase-production-deploy.yml), never
-- the dashboard SQL editor. `create or replace view` and the guarded grant make a second apply a
-- no-op. Forward-only: no existing row, role, policy, function or grant is changed; nothing is
-- written. To remove it, a later reviewed migration drops the view.
--
-- Post-apply check: scripts/backend/deploy/verify/0025_production_sales_summary_view.sql.
begin;
set local lock_timeout = '5s';

-- ── 0. Preconditions: fail before any DDL ─────────────────────────────────────────────────────
do $$
begin
  if current_user <> 'postgres' or session_user <> 'postgres'
     or not exists (select 1 from pg_catalog.pg_roles where rolname = current_user and not rolsuper) then
    raise exception 'production sales summary migration role precondition' using errcode = '42501';
  end if;
  if pg_catalog.to_regclass('private.product_policy_revisions') is null
     or pg_catalog.to_regclass('private.paid_cutoff') is null then
    raise exception 'production sales summary requires 0016' using errcode = '55000';
  end if;
  if pg_catalog.to_regnamespace('still_qa_checks') is not null
     and (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'still_qa_checks')
       <> (select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres') then
    raise exception 'still_qa_checks exists but is not owned by postgres' using errcode = '42501';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'still_qa_readonly_checker'
               and (rolsuper or rolinherit or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    raise exception 'still_qa_readonly_checker exists but is not narrow' using errcode = '42501';
  end if;
end
$$;

-- ── 1. The schema (normally already present from the candidate) ─────────────────────────────────
create schema if not exists still_qa_checks authorization postgres;
revoke all on schema still_qa_checks from public, anon, authenticated, service_role;

-- ── 2. The view: exactly one row, public policy facts and the cutoff configuration only ─────────
-- A missing sales revision means production sales are Off; then sales_revision is null and
-- expected_revision is 0 (the expected revision of the first production sales operation).
create or replace view still_qa_checks.production_sales_summary with (security_barrier = true) as
select
  h.revision as sales_revision,
  coalesce(h.revision, 0::bigint) as expected_revision,
  h.published_at as sales_published_at,
  (h.v ->> 'salesEnabled')::boolean as sales_enabled,
  (h.v -> 'channels' -> 'apple' ->> 'enabled')::boolean as apple_enabled,
  h.v -> 'channels' -> 'apple' ->> 'offer' as apple_offer,
  (h.v -> 'channels' -> 'web' ->> 'enabled')::boolean as web_enabled,
  h.v -> 'channels' -> 'web' ->> 'offer' as web_offer,
  coalesce(h.v -> 'builds', '[]'::jsonb) as builds,
  c.environment is not null as cutoff_present,
  c.product as cutoff_product,
  c.benefits as cutoff_benefits,
  c.sales_revision as cutoff_sales_revision,
  c.activated_at as cutoff_activated_at
from (select 1 as one) as base
left join lateral (
  select r.revision, r.published_at, r.body::jsonb as v
  from private.product_policy_revisions r
  where r.namespace = 'sales' and r.environment = 'production'
  order by r.revision desc
  limit 1
) as h on true
left join private.paid_cutoff c on c.environment = 'production';

revoke all on still_qa_checks.production_sales_summary from public, anon, authenticated, service_role;

-- ── 3. SELECT for the narrow checker only, when it exists ───────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'still_qa_readonly_checker') then
    execute 'grant select on still_qa_checks.production_sales_summary to still_qa_readonly_checker';
  end if;
end
$$;

-- ── 4. Self-check: fail the migration rather than leave a wider view ────────────────────────────
do $$
declare
  view_oid oid := pg_catalog.to_regclass('still_qa_checks.production_sales_summary');
  owner_oid oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres');
  checker oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = 'still_qa_readonly_checker');
begin
  if view_oid is null
     or (select c.relkind from pg_catalog.pg_class c where c.oid = view_oid) <> 'v'
     or (select c.relowner from pg_catalog.pg_class c where c.oid = view_oid) <> owner_oid
     or (select c.reloptions from pg_catalog.pg_class c where c.oid = view_oid)
          is distinct from array['security_barrier=true'] then
    raise exception 'production sales summary view shape' using errcode = '55000';
  end if;
  -- The view reads exactly the two policy tables and nothing else.
  if (select pg_catalog.array_agg(distinct d.refobjid::pg_catalog.regclass::text order by d.refobjid::pg_catalog.regclass::text)
      from pg_catalog.pg_depend d join pg_catalog.pg_rewrite w on w.oid = d.objid
      where d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass and w.ev_class = view_oid
        and d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass and d.refobjid <> view_oid)
     is distinct from array['private.paid_cutoff', 'private.product_policy_revisions'] then
    raise exception 'production sales summary reads an unexpected relation' using errcode = '55000';
  end if;
  -- Only the owner and (when it exists) the checker's plain SELECT; no column grant.
  if exists (
       select 1 from pg_catalog.pg_class c,
         lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
       where c.oid = view_oid and a.grantee <> c.relowner
         -- coalesce: with no checker role, every non-owner entry (any role) is a wider grant.
         and not coalesce(a.grantee = checker and a.privilege_type = 'SELECT' and not a.is_grantable, false))
     or exists (select 1 from pg_catalog.pg_attribute t where t.attrelid = view_oid and t.attacl is not null)
     or (checker is not null and not pg_catalog.has_table_privilege(checker, view_oid, 'SELECT')) then
    raise exception 'production sales summary grants' using errcode = '42501';
  end if;
end
$$;
commit;
