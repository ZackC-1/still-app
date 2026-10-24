-- Recent production purchase operations by live Checkout Session: one read-only view for PROD-02.
--
-- Why. During launch the operator compares each paid live Stripe Checkout Session with Still's own
-- record of it: did the operation reach imported / access_observed (or refunded), or is it stuck?
-- The read-only QA check route could only see production as a keyed digest (DB-01/DB-31/DB-35) and
-- the public sales facts (PROD-01), so that comparison needed the SQL editor.
--
-- What it adds. Exactly one view, still_qa_checks.production_purchase_operations_recent: for each
-- production operation created in the last 30 days that is bound to a live Checkout Session, the
-- session id (cs_live_...), the operation state and its paid / created / updated times. It reads
-- only private.production_purchase_operations (migration 0026). No account id, holder, operation
-- id, configuration hash, email or anything else keyed to a person is exposed; the Stripe session
-- id is the provider's own object id, which the operator already sees in the Stripe dashboard. The
-- check prints it only inside the age-encrypted report, never in the public log or summary.
-- The view is owned by postgres and runs with its owner's privileges (as every still_qa_checks view
-- does), so no base-table grant is needed or made.
--
-- Who can read it. Only still_qa_readonly_checker, and only SELECT, exactly as 0025: the role and
-- schema come from the reviewed unnumbered candidate (scripts/backend/sql/qa-readonly-checks-candidate.sql),
-- which hosted production already holds; with no role (a disposable or fresh database) the view is
-- created with no grant and installing the candidate later grants it. PUBLIC, anon, authenticated
-- and service_role are revoked explicitly and never granted.
--
-- Authority and idempotence. Applied by the hosted migration role `postgres` (non-superuser) through
-- the protected migration operation (supabase-production-deploy.yml), never the SQL editor.
-- `create or replace view` and the guarded grant make a second apply a no-op. Forward-only: no
-- existing row, role, policy, function or grant is changed; nothing is written.
--
-- Deploy order. A numbered migration on main that hosted history lacks makes the purchase function
-- operations refuse ("no pending migration"). Apply this migration before the next purchase
-- function deploy, or merge it only after any urgent purchase function deploy has shipped.
--
-- Post-apply check: scripts/backend/deploy/verify/0030_production_purchase_operations_view.sql.
begin;
set local lock_timeout = '5s';

-- ── 0. Preconditions: fail before any DDL ─────────────────────────────────────────────────────
do $$
begin
  if current_user <> 'postgres' or session_user <> 'postgres'
     or not exists (select 1 from pg_catalog.pg_roles where rolname = current_user and not rolsuper) then
    raise exception 'production purchase operations view migration role precondition' using errcode = '42501';
  end if;
  if pg_catalog.to_regclass('private.production_purchase_operations') is null then
    raise exception 'production purchase operations view requires 0026' using errcode = '55000';
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

-- ── 2. The view: live session id, state and times only, last 30 days ───────────────────────────
create or replace view still_qa_checks.production_purchase_operations_recent with (security_barrier = true) as
select
  o.stripe_session_id as stripe_session_id,
  o.status as status,
  o.paid_at as paid_at,
  o.created_at as created_at,
  o.updated_at as updated_at
from private.production_purchase_operations o
where o.stripe_session_id is not null and o.created_at > pg_catalog.now() - interval '30 days';

revoke all on still_qa_checks.production_purchase_operations_recent from public, anon, authenticated, service_role;

-- ── 3. SELECT for the narrow checker only, when it exists ───────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'still_qa_readonly_checker') then
    execute 'grant select on still_qa_checks.production_purchase_operations_recent to still_qa_readonly_checker';
  end if;
end
$$;

-- ── 4. Self-check: fail the migration rather than leave a wider view ────────────────────────────
do $$
declare
  view_oid oid := pg_catalog.to_regclass('still_qa_checks.production_purchase_operations_recent');
  owner_oid oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres');
  checker oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = 'still_qa_readonly_checker');
begin
  if view_oid is null
     or (select c.relkind from pg_catalog.pg_class c where c.oid = view_oid) <> 'v'
     or (select c.relowner from pg_catalog.pg_class c where c.oid = view_oid) <> owner_oid
     or (select c.reloptions from pg_catalog.pg_class c where c.oid = view_oid)
          is distinct from array['security_barrier=true'] then
    raise exception 'production purchase operations view shape' using errcode = '55000';
  end if;
  -- The view reads exactly the production operation ledger and nothing else.
  if (select pg_catalog.array_agg(distinct d.refobjid::pg_catalog.regclass::text order by d.refobjid::pg_catalog.regclass::text)
      from pg_catalog.pg_depend d join pg_catalog.pg_rewrite w on w.oid = d.objid
      where d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass and w.ev_class = view_oid
        and d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass and d.refobjid <> view_oid)
     is distinct from array['private.production_purchase_operations'] then
    raise exception 'production purchase operations view reads an unexpected relation' using errcode = '55000';
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
    raise exception 'production purchase operations view grants' using errcode = '42501';
  end if;
end
$$;
commit;
