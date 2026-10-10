-- UNNUMBERED candidate: the read-only QA check role, its QA account registry and QA-scoped views.
-- Owner review and an explicit install decision are required (docs/release/qa-readonly-database-checks.md).
-- It is deliberately not in supabase/migrations: a numbered file on main that hosted history lacks
-- would block the fixed qa-sandbox-functions operation, and it would move the QA baseline (DB-01).
--
-- What it creates (nothing else changes; no existing row, role, grant or policy is altered):
--   role   still_qa_readonly_checker  NOLOGIN until the owner sets a password; no membership,
--                                     read-only transactions by default, 15 s statement timeout
--   schema still_qa_checks            owned by postgres; the role may only USE it
--   table  still_qa_checks.qa_alias_owner  one row: SHA-256 of the owner's base mailbox; only its
--                                     "+stillqa-<name>" aliases can ever be registered or seen
--   table  still_qa_checks.qa_accounts  label -> account id for the nine designated QA accounts;
--                                     filled by the owner, never readable by the role directly
--   views  still_qa_checks.*          the ONLY relations the role can read: QA accounts' rows,
--                                     sandbox rights and whole-database counts. No email, token,
--                                     provider key, transaction id, Stripe session id or secret.
-- Views run with their owner's (postgres) privileges, so the role never needs a grant on a base
-- table. The holder column of qa_accounts is not a foreign key on purpose: it survives account
-- deletion so the deletion checks (DB-29, DB-30) can prove that nothing is left for that account.
begin;
do $$
begin
  if current_user <> 'postgres' or session_user <> 'postgres'
     or current_setting('server_version_num')::integer < 170000
     or not exists (select 1 from pg_catalog.pg_roles where rolname = current_user and not rolsuper and rolcreaterole) then
    raise exception 'ordinary PostgreSQL 17 postgres operator required';
  end if;
  if pg_catalog.to_regclass('private.qa_sandbox_subjects') is null
     or pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'migration 0021 and the migration history table are required first';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'still_qa_readonly_checker') then
    create role still_qa_readonly_checker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'still_qa_readonly_checker'
               and (rolsuper or rolinherit or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
     or exists (select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.member
                where r.rolname = 'still_qa_readonly_checker') then
    raise exception 'still_qa_readonly_checker exists but is not narrow; inspect it privately';
  end if;
end;
$$;
alter role still_qa_readonly_checker connection limit 2;
alter role still_qa_readonly_checker set default_transaction_read_only = on;
alter role still_qa_readonly_checker set statement_timeout = '15s';
alter role still_qa_readonly_checker set lock_timeout = '1s';
alter role still_qa_readonly_checker set idle_in_transaction_session_timeout = '30s';
alter role still_qa_readonly_checker set log_parameter_max_length = 0;
alter role still_qa_readonly_checker set log_parameter_max_length_on_error = 0;

create schema if not exists still_qa_checks authorization postgres;
revoke all on schema still_qa_checks from public, anon, authenticated, service_role;
grant usage on schema still_qa_checks to still_qa_readonly_checker;

-- The owner's base mailbox (the address without its "+stillqa-<name>" tag), as a SHA-256 digest.
-- A QA alias is a confirmed Auth email of the form <base local part>+stillqa-<name>@<base domain>
-- whose tag-free form hashes to this digest. Mail to such an alias reaches only the owner, so no
-- customer can hold one; a typo or a customer's address can never be registered or become visible.
create table if not exists still_qa_checks.qa_alias_owner (
  singleton boolean primary key default true check (singleton),
  base_sha256 text not null check (base_sha256 ~ '^[0-9a-f]{64}$')
);
alter table still_qa_checks.qa_alias_owner enable row level security;

create table if not exists still_qa_checks.qa_accounts (
  label text primary key check (label in ('preserved', 'web-chrome', 'web-firefox', 'web-android',
    'fresh', 'refund-web', 'qa-a', 'qa-b', 'delete')),
  holder uuid not null unique,
  registered_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table still_qa_checks.qa_accounts enable row level security;

-- Registration accepts only a confirmed, live owner QA alias (same rule as qa_scope below).
create or replace function still_qa_checks.qa_accounts_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if not exists (
    select 1 from auth.users u
    where u.id = new.holder and u.email_confirmed_at is not null and u.deleted_at is null
      and pg_catalog.lower(u.email) ~ '^[^+@]+\+stillqa-[a-z0-9-]+@[^@]+$'
      and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.regexp_replace(pg_catalog.lower(u.email), '\+stillqa-[a-z0-9-]+@', '@'), 'UTF8')), 'hex')
        = (select o.base_sha256 from still_qa_checks.qa_alias_owner o)) then
    raise exception 'only a confirmed owner QA alias can be registered';
  end if;
  return new;
end;
$$;
revoke all on function still_qa_checks.qa_accounts_guard() from public, anon, authenticated, service_role;
drop trigger if exists qa_accounts_guard on still_qa_checks.qa_accounts;
create trigger qa_accounts_guard before insert or update on still_qa_checks.qa_accounts
  for each row execute function still_qa_checks.qa_accounts_guard();

-- QA scope (not granted): registered labels whose account is still a confirmed owner QA alias
-- and, for the seven paid-lane labels, a fixed sandbox member. A registered account whose Auth row
-- is gone (deleted after its validated registration) stays in scope so the deletion checks can
-- prove nothing is left; it can never match a new account.
create or replace view still_qa_checks.qa_scope with (security_barrier = true) as
select a.label, a.holder
from still_qa_checks.qa_accounts a
left join auth.users u on u.id = a.holder
where u.id is null
   or (u.email_confirmed_at is not null
       and pg_catalog.lower(u.email) ~ '^[^+@]+\+stillqa-[a-z0-9-]+@[^@]+$'
       and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.regexp_replace(pg_catalog.lower(u.email), '\+stillqa-[a-z0-9-]+@', '@'), 'UTF8')), 'hex')
         = (select o.base_sha256 from still_qa_checks.qa_alias_owner o)
       and (a.label in ('preserved', 'delete')
            or exists (select 1 from private.qa_sandbox_subjects s where s.holder = a.holder)));

-- Rights in scope (not granted): held by a QA account, or holder-less sandbox rights that a QA
-- account linked, or that were verified after the QA registry was filled (the QA run's start).
create or replace view still_qa_checks.qa_rights_scope with (security_barrier = true) as
select r.right_id
from private.access_rights r
where r.holder in (select q.holder from still_qa_checks.qa_scope q)
   or (r.holder is null and r.environment = 'sandbox' and (
        exists (select 1 from private.apple_access_link_operations l
                where l.environment = r.environment and l.provider_key = r.provider_key
                  and (l.target_holder in (select q.holder from still_qa_checks.qa_scope q)
                    or l.source_holder in (select q.holder from still_qa_checks.qa_scope q)))
        or pg_catalog.to_timestamp(r.verified_at / 1000.0) >= (select pg_catalog.min(a.registered_at) from still_qa_checks.qa_accounts a)));

create or replace view still_qa_checks.account_status with (security_barrier = true) as
select a.label, a.holder, u.id is not null as auth_present,
  u.email_confirmed_at is not null as confirmed, u.deleted_at is not null as deleted,
  (u.banned_until is not null and u.banned_until > pg_catalog.now()) as banned, u.created_at,
  a.label not in ('preserved', 'delete') as subject_expected,
  s.enabled as subject_enabled, s.revision as subject_revision,
  a.holder in (select q.holder from still_qa_checks.qa_scope q) as in_scope
from still_qa_checks.qa_accounts a
left join auth.users u on u.id = a.holder
left join private.qa_sandbox_subjects s on s.holder = a.holder;

create or replace view still_qa_checks.qa_subjects with (security_barrier = true) as
select s.holder, s.enabled, s.revision, a.label,
  coalesce(u.email_confirmed_at is not null
    and pg_catalog.lower(u.email) ~ '^[^+@]+\+stillqa-[a-z0-9-]+@[^@]+$'
    and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.regexp_replace(pg_catalog.lower(u.email), '\+stillqa-[a-z0-9-]+@', '@'), 'UTF8')), 'hex')
      = (select o.base_sha256 from still_qa_checks.qa_alias_owner o), false) as qa_alias
from private.qa_sandbox_subjects s
left join still_qa_checks.qa_accounts a on a.holder = s.holder
left join auth.users u on u.id = s.holder;

create or replace view still_qa_checks.profiles with (security_barrier = true) as
select p.id, p.settings, p.settings_version, p.settings_server_updated_at,
  exists (select 1 from private.settings_writes w where w.user_id = p.id and w.write_id = p.settings_last_write_id) as last_write_logged
from public.profiles p
where p.id in (select q.holder from still_qa_checks.qa_scope q);

create or replace view still_qa_checks.settings_writes_summary with (security_barrier = true) as
select w.user_id, pg_catalog.count(*) as writes, pg_catalog.max(w.created_at) as newest
from private.settings_writes w
where w.user_id in (select q.holder from still_qa_checks.qa_scope q)
group by w.user_id;

create or replace view still_qa_checks.settings_anchors with (security_barrier = true) as
select a.user_id, a.modern_used
from private.settings_anchors a
where a.user_id in (select q.holder from still_qa_checks.qa_scope q);

create or replace view still_qa_checks.entitlements_summary with (security_barrier = true) as
select e.user_id, pg_catalog.count(*) as legacy_rows
from public.entitlements e
where e.user_id in (select q.holder from still_qa_checks.qa_scope q)
group by e.user_id;

create or replace view still_qa_checks.access_rights with (security_barrier = true) as
select r.right_id, r.holder, r.environment, r.provider_source, r.provider_product,
  r.ownership_revision, r.active, r.verified_at
from private.access_rights r
where r.right_id in (select x.right_id from still_qa_checks.qa_rights_scope x);

create or replace view still_qa_checks.apple_observations with (security_barrier = true) as
select o.right_id, o.environment, o.product_id, o.deadline
from private.apple_access_observations o
where o.right_id in (select x.right_id from still_qa_checks.qa_rights_scope x);

create or replace view still_qa_checks.access_observations with (security_barrier = true) as
select o.holder, o.environment, o.deadline, o.result ->> 'status' as status
from private.access_observations o
where o.holder in (select q.holder from still_qa_checks.qa_scope q);

create or replace view still_qa_checks.access_revocations with (security_barrier = true) as
select v.holder, v.environment, v.right_id, v.revision
from private.access_revocations v
where v.holder in (select q.holder from still_qa_checks.qa_scope q);

create or replace view still_qa_checks.apple_link_operations with (security_barrier = true) as
select l.environment, l.target_holder, l.source_holder, l.expected_revision, l.resulting_revision, l.status
from private.apple_access_link_operations l
where l.target_holder in (select q.holder from still_qa_checks.qa_scope q)
   or l.source_holder in (select q.holder from still_qa_checks.qa_scope q);

create or replace view still_qa_checks.purchase_operations with (security_barrier = true) as
select o.operation_id, o.holder, o.status, o.environment,
  o.stripe_session_id like 'cs\_test\_%' as test_session,
  o.creation_started_at, o.paid_at, o.created_at, o.updated_at
from private.qa_sandbox_purchase_operations o
where o.holder in (select q.holder from still_qa_checks.qa_scope q);

create or replace view still_qa_checks.negative_rights with (security_barrier = true) as
select n.right_id, n.environment, n.revoked_at
from private.qa_sandbox_negative_rights n
where n.right_id in (select x.right_id from still_qa_checks.qa_rights_scope x);

create or replace view still_qa_checks.sessions_summary with (security_barrier = true) as
select s.user_id, pg_catalog.count(*) as sessions
from auth.sessions s
where s.user_id in (select q.holder from still_qa_checks.qa_scope q)
group by s.user_id;

create or replace view still_qa_checks.rate_limit_summary with (security_barrier = true) as
select c.account_id, pg_catalog.count(*) as buckets
from public.rate_limit_counters c
where c.account_id in (select q.holder from still_qa_checks.qa_scope q)
group by c.account_id;

create or replace view still_qa_checks.analytics_subjects_summary with (security_barrier = true) as
select s.user_id, pg_catalog.count(*) as subjects
from private.analytics_subjects s
where s.user_id in (select q.holder from still_qa_checks.qa_scope q)
group by s.user_id;

-- Whole-database facts: counts, versions and fingerprints only, never a customer row. The runner
-- reads production_rights_fingerprint only to compare it, keyed, with the recorded baseline; it
-- never prints production counts or digests.
create or replace view still_qa_checks.migration_history with (security_barrier = true) as
select m.version from supabase_migrations.schema_migrations m;

create or replace view still_qa_checks.policy_heads with (security_barrier = true) as
select r.environment, r.namespace, pg_catalog.max(r.revision) as newest
from private.product_policy_revisions r group by r.environment, r.namespace;

create or replace view still_qa_checks.paid_cutoff_environments with (security_barrier = true) as
select c.environment from private.paid_cutoff c;

create or replace view still_qa_checks.production_rights_fingerprint with (security_barrier = true) as
select pg_catalog.count(*) as rights,
  pg_catalog.md5(coalesce(pg_catalog.string_agg(r.right_id::text || coalesce(r.holder::text, '-') || r.ownership_revision
    || r.active || r.verified_at, ',' order by r.right_id), '')) as fingerprint
from private.access_rights r where r.environment = 'production';

create or replace view still_qa_checks.rights_summary with (security_barrier = true) as
select r.environment, r.provider_source, r.provider_product, pg_catalog.count(*) as total,
  pg_catalog.count(*) filter (where r.active) as active
from private.access_rights r where r.environment = 'sandbox'
group by r.environment, r.provider_source, r.provider_product;

create or replace view still_qa_checks.isolation_summary with (security_barrier = true) as
with qa as (select q.holder from still_qa_checks.qa_scope q)
select
  (select pg_catalog.count(*) from private.access_rights r where r.holder in (select holder from qa) and r.environment <> 'sandbox') as qa_non_sandbox_rights,
  (select pg_catalog.count(*) from private.qa_sandbox_negative_rights n join private.access_rights r using (right_id) where r.environment <> 'sandbox') as cross_environment_negative_rights,
  (select pg_catalog.count(*) from public.entitlements e where e.user_id in (select holder from qa)) as qa_legacy_entitlements,
  (select pg_catalog.count(*) from private.access_transfer_operations t where t.environment = 'sandbox') as sandbox_transfer_operations,
  (select pg_catalog.count(*) from public.profiles p where p.id in (select holder from private.qa_sandbox_subjects)) as subject_profiles;

create or replace view still_qa_checks.retention_summary with (security_barrier = true) as
select
  (select pg_catalog.count(*) from private.settings_writes w where w.created_at < pg_catalog.now() - interval '30 days') as writes_older_than_30_days,
  (select pg_catalog.count(*) from public.rate_limit_counters c where c.expires_at < pg_catalog.now() - interval '1 day') as expired_rate_rows,
  (select pg_catalog.count(*) from private.qa_sandbox_rate_windows q where q.expires_at < pg_catalog.now() - interval '1 day') as expired_qa_rate_windows;

create or replace view still_qa_checks.privacy_summary with (security_barrier = true) as
select
  (select pg_catalog.count(*) from public.profiles p, pg_catalog.jsonb_object_keys(case when pg_catalog.jsonb_typeof(p.settings) = 'object' then p.settings else '{}'::jsonb end) k
     where k not in ('schemaVersion', 'globalOn', 'updatedAt', 'services', 'sites', 'clocks', 'pauses')) as unknown_settings_keys,
  (select pg_catalog.count(*) from public.rate_limit_counters c where c.bucket_key !~ '^[a-z:-]+:(user|ip):[0-9a-f]{64}$') as unhashed_rate_keys;

create or replace view still_qa_checks.erasure_jobs_last_hour with (security_barrier = true) as
select j.scope, j.stage, pg_catalog.count(*) as jobs
from private.analytics_erasure_jobs j where j.created_at > pg_catalog.now() - interval '1 hour'
group by j.scope, j.stage;

-- Exactly SELECT on these views for the checker; nothing for anyone else.
revoke all on all tables in schema still_qa_checks from public, anon, authenticated, service_role, still_qa_readonly_checker;
grant select on still_qa_checks.account_status, still_qa_checks.qa_subjects, still_qa_checks.profiles,
  still_qa_checks.settings_writes_summary, still_qa_checks.settings_anchors, still_qa_checks.entitlements_summary,
  still_qa_checks.access_rights, still_qa_checks.apple_observations, still_qa_checks.access_observations,
  still_qa_checks.access_revocations, still_qa_checks.apple_link_operations, still_qa_checks.purchase_operations,
  still_qa_checks.negative_rights, still_qa_checks.sessions_summary, still_qa_checks.rate_limit_summary,
  still_qa_checks.analytics_subjects_summary, still_qa_checks.migration_history, still_qa_checks.policy_heads,
  still_qa_checks.paid_cutoff_environments, still_qa_checks.production_rights_fingerprint,
  still_qa_checks.rights_summary, still_qa_checks.isolation_summary, still_qa_checks.retention_summary,
  still_qa_checks.privacy_summary, still_qa_checks.erasure_jobs_last_hour
  to still_qa_readonly_checker;

-- End-state check: the role's own grants are exactly SELECT on these views, and it can neither
-- write nor directly read any Still, Auth, Storage or migration relation. (Platform grants to
-- PUBLIC, such as pg_cron's row-filtered job tables, apply to every role and are out of scope.)
do $$
declare
  checker oid := (select oid from pg_catalog.pg_roles where rolname = 'still_qa_readonly_checker');
begin
  if (select pg_catalog.count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
        lateral pg_catalog.aclexplode(c.relacl) a
      where a.grantee = checker) <> 25
     or exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
        lateral pg_catalog.aclexplode(c.relacl) a
      where a.grantee = checker and (n.nspname <> 'still_qa_checks' or c.relkind <> 'v'
        or a.privilege_type <> 'SELECT' or a.is_grantable))
     or exists (select 1 from pg_catalog.pg_attribute t, lateral pg_catalog.aclexplode(t.attacl) a where a.grantee = checker) then
    raise exception 'still_qa_readonly_checker grants are not exactly SELECT on the check views';
  end if;
  if exists (
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and n.nspname in ('auth', 'public', 'private', 'storage', 'supabase_migrations', 'still_qa_checks')
      and (pg_catalog.has_table_privilege(checker, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or pg_catalog.has_any_column_privilege(checker, c.oid, 'INSERT,UPDATE,REFERENCES'))) then
    raise exception 'still_qa_readonly_checker can write a relation';
  end if;
  if exists (
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname in ('auth', 'public', 'private', 'storage', 'supabase_migrations')
      and (pg_catalog.has_table_privilege(checker, c.oid, 'SELECT') or pg_catalog.has_any_column_privilege(checker, c.oid, 'SELECT'))) then
    raise exception 'still_qa_readonly_checker can read a base relation directly';
  end if;
  if pg_catalog.has_table_privilege(checker, 'still_qa_checks.qa_accounts', 'SELECT')
     or pg_catalog.has_table_privilege(checker, 'still_qa_checks.qa_alias_owner', 'SELECT')
     or pg_catalog.has_table_privilege(checker, 'still_qa_checks.qa_scope', 'SELECT')
     or pg_catalog.has_table_privilege(checker, 'still_qa_checks.qa_rights_scope', 'SELECT')
     or pg_catalog.has_function_privilege(checker, 'still_qa_checks.qa_accounts_guard()', 'EXECUTE') then
    raise exception 'still_qa_readonly_checker can read the registry or scope directly';
  end if;
end;
$$;
commit;
