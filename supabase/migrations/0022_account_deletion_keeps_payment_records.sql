-- Forward-only. Deploy ALONE through the protected migration operation after 0021 is verified,
-- then check scripts/backend/deploy/verify/0022_account_deletion_keeps_payment_records.sql.
-- No routine created by 0014-0021 is replaced, granted or revoked here.
--
-- Owner decision (2026-10-10): deleting a Still account deletes the person's data but KEEPS the
-- payment records needed for refunds, tax and disputes, and DEACTIVATES the account's Pro rights.
--
-- 1. QA checkout operations survive account deletion. Their account id is cleared (ON DELETE SET
--    NULL instead of CASCADE). The Stripe Checkout Session id and operation id stay as the
--    non-personal keys that match a later refund or dispute; nothing else in the row names a person.
-- 2. A BEFORE DELETE trigger on auth.users deactivates every active RevenueCat-sourced right the
--    account holds, inside GoTrue's own deletion transaction. It must run BEFORE the delete: the
--    existing access_rights ON DELETE SET NULL action fires after it and clears the holder. The
--    right row, its hashed provider key and its revision history are kept, detached from the person.
--    Apple-sourced rights are deliberately not deactivated: since 0020 they are accountless, their
--    `active` flag is Apple's refund verdict for local access on the purchaser's own Apple ID, and
--    a false value is treated as a permanent refund. Deletion already detaches them from the account
--    (holder set null) and 0020 refuses to re-link a detached right to any account.
-- 3. One-time repair: RevenueCat-sourced rights already orphaned by an earlier deletion (holder
--    null and still active) are deactivated the same way. A RevenueCat-sourced right is only ever
--    written with a holder, so holder null means its account was deleted.
-- Live accounts' rows are untouched.
begin;
do $$
begin
 if current_user<>'postgres' or session_user<>'postgres' or current_setting('server_version_num')::integer<170000
  or not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and not rolsuper and rolcreaterole) then
  raise exception 'ordinary PostgreSQL17 postgres operator required';
 end if;
end;
$$;
-- Every step is small. Never queue behind a long sign-in or reconcile transaction on auth.users.
set local lock_timeout = '5s';

-- (1) Keep QA checkout operations when their account is deleted.
alter table private.qa_sandbox_purchase_operations alter column holder drop not null;
alter table private.qa_sandbox_purchase_operations drop constraint qa_sandbox_purchase_operations_holder_fkey;
alter table private.qa_sandbox_purchase_operations add constraint qa_sandbox_purchase_operations_holder_fkey
 foreign key (holder) references auth.users(id) on delete set null;

-- (2) Deactivate the deleted account's RevenueCat-sourced rights in the deletion transaction.
create function private.deactivate_deleted_account_rights() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  -- Observation rows before rights, the order commit/transfer use for this ledger. The QA wrappers
  -- lock the auth.users row first, so they queue behind this deletion. A production reconcile holds
  -- its observation row before its insert's key-share check on auth.users, so it can deadlock with
  -- a deletion of the same account, exactly as the existing cascade could before 0022: PostgreSQL
  -- aborts one transaction and the caller retries.
  perform 1 from private.access_observations where holder = old.id order by environment for update;
  -- The same state change as a canonical refund observation of an active right.
  update private.access_rights
    set active = false, ownership_revision = ownership_revision + 1, verified_at = v_now
    where holder = old.id and active and provider_source = 'revenuecat';
  return old;
end;
$$;
revoke all on function private.deactivate_deleted_account_rights()
 from public, anon, authenticated, service_role, still_entitlement_writer, still_qa_sandbox_writer, still_qa_sandbox_owner;
create trigger access_rights_account_deleted before delete on auth.users
 for each row execute function private.deactivate_deleted_account_rights();

-- (3) Repair rights orphaned by deletions before this migration.
update private.access_rights
 set active = false, ownership_revision = ownership_revision + 1,
  verified_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint
 where holder is null and active and provider_source = 'revenuecat';

-- Self-check inside the transaction: any drift aborts the whole migration.
do $$
begin
 if (select count(*) from pg_catalog.pg_constraint c where c.conrelid='private.qa_sandbox_purchase_operations'::regclass
     and c.contype='f' and c.confrelid='auth.users'::regclass) <> 1
  or not exists(select 1 from pg_catalog.pg_constraint c where c.conrelid='private.qa_sandbox_purchase_operations'::regclass
     and c.conname='qa_sandbox_purchase_operations_holder_fkey' and c.contype='f' and c.confrelid='auth.users'::regclass
     and c.confdeltype='n' and c.confupdtype='a' and c.convalidated
     and c.conkey=array[(select attnum from pg_catalog.pg_attribute where attrelid='private.qa_sandbox_purchase_operations'::regclass and attname='holder')]::int2[])
  or exists(select 1 from pg_catalog.pg_attribute where attrelid='private.qa_sandbox_purchase_operations'::regclass and attname='holder' and attnotnull) then
  raise exception 'unexpected QA checkout operation account reference';
 end if;
 if (select count(*) from pg_catalog.pg_trigger t where t.tgrelid='auth.users'::regclass and t.tgname='access_rights_account_deleted'
     and not t.tgisinternal and t.tgtype=11 and t.tgenabled='O' and t.tgqual is null and t.tgnargs=0
     and t.tgfoid='private.deactivate_deleted_account_rights()'::regprocedure) <> 1 then
  raise exception 'unexpected account deletion rights trigger';
 end if;
 if exists(select 1 from pg_catalog.aclexplode(coalesce((select proacl from pg_catalog.pg_proc where oid='private.deactivate_deleted_account_rights()'::regprocedure),
     pg_catalog.acldefault('f',(select oid from pg_catalog.pg_roles where rolname='postgres')))) a
   where a.grantee<>(select oid from pg_catalog.pg_roles where rolname='postgres')) then
  raise exception 'account deletion rights routine reachable';
 end if;
 if exists(select 1 from private.access_rights where holder is null and active and provider_source='revenuecat') then
  raise exception 'orphaned active account right remains';
 end if;
end;
$$;
commit;
