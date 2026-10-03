-- Execute AFTER all changes. Injection tests must change final state, then run this assertion.
do $$ declare failures text; begin
  select string_agg(issue, ', ' order by issue) into failures from still_security.audit();
  if failures is not null then
    raise exception 'Still security assertions failed: %', failures using errcode = '42501';
  end if;
end $$;
