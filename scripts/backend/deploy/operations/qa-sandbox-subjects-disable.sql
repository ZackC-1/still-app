-- Owner-approved operation qa-sandbox-subjects (policy_mode disable): switch every enabled QA
-- sandbox membership off (enabled = false, revision + 1). It needs no account list, so it works even
-- after the list secret is deleted. It NEVER deletes a membership row: a disabled account keeps its
-- refund and removal recovery reachable (0021). Nothing else changes.
--
-- What runs, in one transaction: the enabled membership rows are locked FOR UPDATE in UUID order
-- (the wrappers' order; an in-flight QA call finishes first, and every later positive call sees the
-- account disabled), then switched off. Counts only.
begin;
do $$
declare
  v_changed integer;
begin
  if current_user <> 'postgres' then
    raise exception 'QS000 operator role required' using errcode = 'QS000';
  end if;
  perform 1 from private.qa_sandbox_subjects s where s.enabled order by s.holder for update;
  update private.qa_sandbox_subjects s set enabled = false, revision = s.revision + 1
    where s.enabled;
  get diagnostics v_changed = row_count;
  perform pg_catalog.set_config('still_operation.outcome', pg_catalog.json_build_object(
    'disabled', v_changed, 'members', (select pg_catalog.count(*) from private.qa_sandbox_subjects))::text, true);
end
$$;
select pg_catalog.current_setting('still_operation.outcome');
commit;
