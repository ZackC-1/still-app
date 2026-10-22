-- Protected production sales off: fixed environment and exact build admission.
-- Compare-and-set and all writes occur in one transaction. Off preserves every existing right.
\getenv still_operation_expected_revision STILL_OPERATION_EXPECTED_REVISION
\getenv still_operation_policy_body STILL_OPERATION_POLICY_BODY
begin;
select pg_catalog.set_config('still_operation.expected_revision', :'still_operation_expected_revision', true) is not null and pg_catalog.set_config('still_operation.policy_body', :'still_operation_policy_body', true) is not null as configured;
do $$
declare
  v_template constant jsonb := '{"schema":1,"environment":"production","salesEnabled":false,"channels":{"apple":{"enabled":false,"offer":"still-pro-v3"},"web":{"enabled":false,"offer":"still-pro-v3"}},"builds":[{"surface":"chrome_desktop","build":"3.0.0"},{"surface":"firefox_desktop","build":"3.0.0"},{"surface":"apple_mobile_host","build":"3.0"},{"surface":"apple_macos_host","build":"3.0"}]}';
  v_operator constant uuid := '00000000-0000-0000-0000-000000000000';
  v_expected bigint;
  v_current bigint;
  v_body text;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if current_user <> 'postgres' then
    raise exception 'QP000 operator role required' using errcode = 'QP000';
  end if;
  if pg_catalog.current_setting('still_operation.expected_revision') !~ '^(0|[1-9][0-9]{0,15})$' then
    raise exception 'QP005 expected revision input invalid' using errcode = 'QP005';
  end if;
  v_expected := pg_catalog.current_setting('still_operation.expected_revision')::bigint;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('still-product-policy:sales:production', 0));
  select coalesce(max(r.revision), 0) into v_current from private.product_policy_revisions r
    where r.namespace = 'sales' and r.environment = 'production';
  if v_current <> v_expected then
    raise exception 'QP001 production sales revision is not the approved expected revision' using errcode = 'QP001';
  end if;
  v_body := private.product_policy_render('sales',
    v_template || pg_catalog.jsonb_build_object('revision', v_expected + 1));
  if not private.product_policy_body_valid('sales', 'production', v_expected + 1, v_body) then
    raise exception 'QP002 rendered body is not a valid production sales body' using errcode = 'QP002';
  end if;
  if v_body <> pg_catalog.current_setting('still_operation.policy_body') then
    raise exception 'QP003 rendered body differs from the approved plan' using errcode = 'QP003';
  end if;
  if private.product_policy_sales_activates(v_body) or (v_body::jsonb ->> 'salesEnabled')::boolean then
    raise exception 'QP004 an off body must not enable sales' using errcode = 'QP004';
  end if;
  insert into private.product_policy_operations (operation_id, kind, namespace, environment,
    owner_subject, expected_revision, body, preview_hash, rollback_of, created_at, expires_at,
    status, applied_revision, applied_at)
  values (v_operation, 'apply', 'sales', 'production', v_operator, v_expected, v_body,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(E'\n',
      'still-protected-operation-1', v_operation::text, 'sales', 'production', v_expected::text, v_body),
      'UTF8')), 'hex'),
    null, v_now, v_now, 'applied', v_expected + 1, v_now);
  insert into private.product_policy_revisions (namespace, environment, revision, body, operation_id, published_at)
  values ('sales', 'production', v_expected + 1, v_body, v_operation, v_now);
  perform pg_catalog.set_config('still_operation.outcome',
    pg_catalog.json_build_object('revision', v_expected + 1, 'cutoff', 'unchanged')::text, true);
end
$$;
select pg_catalog.current_setting('still_operation.outcome');
commit;
