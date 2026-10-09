-- Owner-approved operation qa-sandbox-subjects (policy_mode enable): admit the approved test
-- accounts to the QA sandbox lane (private.qa_sandbox_subjects enabled = true). Nothing else
-- changes; no account, right or other table is written.
--
-- Input: the runner hashes each approved, lower-cased email with SHA-256 and passes only the sorted
-- JSON array of those hashes through its environment (never the command line). No email reaches
-- the database, a log or a receipt.
--
-- What runs, in one transaction (a refusal anywhere writes nothing):
--   1. every hash must match exactly one Auth account (lower-cased email): an unknown or ambiguous
--      entry refuses, so the admitted count always equals the approved count;
--   2. per account in UUID order, the same lock order as the QA wrappers: its Auth row FOR SHARE
--      (it must be confirmed, not deleted and not banned, or the whole run refuses), then its
--      membership row FOR UPDATE;
--   3. a missing membership row is inserted enabled (revision 1); a disabled one is enabled with
--      revision + 1; an enabled one is left exactly as it is.
-- Refusals use fixed SQLSTATEs (QS001-QS004, see operations.mjs) and print no data. Counts only.
\getenv still_operation_subject_hashes STILL_OPERATION_SUBJECT_HASHES
begin;
select pg_catalog.set_config('still_operation.subject_hashes', :'still_operation_subject_hashes', true) is not null as configured;
do $$
declare
  v_input jsonb;
  v_hashes text[];
  v_holders uuid[];
  v_holder uuid;
  v_confirmed boolean;
  v_changed integer := 0;
  v_rows integer;
begin
  if current_user <> 'postgres' then
    raise exception 'QS000 operator role required' using errcode = 'QS000';
  end if;
  begin
    v_input := pg_catalog.current_setting('still_operation.subject_hashes')::jsonb;
  exception when others then
    raise exception 'QS001 subject input invalid' using errcode = 'QS001';
  end;
  if pg_catalog.jsonb_typeof(v_input) <> 'array'
     or pg_catalog.jsonb_array_length(v_input) not between 1 and 50
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_input) e
                where pg_catalog.jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[0-9a-f]{64}$') then
    raise exception 'QS001 subject input invalid' using errcode = 'QS001';
  end if;
  select pg_catalog.array_agg(distinct e order by e) into v_hashes
    from pg_catalog.jsonb_array_elements_text(v_input) e;
  if pg_catalog.cardinality(v_hashes) <> pg_catalog.jsonb_array_length(v_input) then
    raise exception 'QS001 subject input invalid' using errcode = 'QS001';
  end if;
  -- Resolve: each approved hash to exactly one Auth account.
  if exists (
    select 1 from pg_catalog.unnest(v_hashes) h(hash)
    where not exists (select 1 from auth.users u
      where pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8')), 'hex') = h.hash)
  ) then
    raise exception 'QS002 an approved account does not exist' using errcode = 'QS002';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(v_hashes) h(hash)
    where (select pg_catalog.count(*) from auth.users u
      where pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8')), 'hex') = h.hash) > 1
  ) then
    raise exception 'QS003 an approved entry matches more than one account' using errcode = 'QS003';
  end if;
  select pg_catalog.array_agg(u.id order by u.id) into v_holders
    from auth.users u
    where pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8')), 'hex') = any (v_hashes);
  -- Lock and admit in UUID order: Auth row first, then the membership row (the wrappers' order).
  foreach v_holder in array v_holders loop
    select u.email_confirmed_at is not null and u.deleted_at is null
           and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
      into v_confirmed
      from auth.users u where u.id = v_holder for share;
    if not coalesce(v_confirmed, false) then
      raise exception 'QS004 an approved account is not confirmed and active' using errcode = 'QS004';
    end if;
    perform 1 from private.qa_sandbox_subjects s where s.holder = v_holder for update;
    insert into private.qa_sandbox_subjects as s (holder, enabled, revision)
    values (v_holder, true, 1)
    on conflict (holder) do update set enabled = true, revision = s.revision + 1
      where not s.enabled;
    get diagnostics v_rows = row_count;
    v_changed := v_changed + v_rows;
  end loop;
  perform pg_catalog.set_config('still_operation.outcome', pg_catalog.json_build_object(
    'listed', pg_catalog.cardinality(v_hashes), 'admitted', pg_catalog.cardinality(v_holders),
    'changed', v_changed)::text, true);
end
$$;
select pg_catalog.current_setting('still_operation.outcome');
commit;
