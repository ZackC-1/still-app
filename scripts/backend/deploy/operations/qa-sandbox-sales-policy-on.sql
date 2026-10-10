-- Owner-approved operation qa-sandbox-sales-policy (policy_mode on): publish the pinned "sales on"
-- body as the next SANDBOX sales revision, so the listed QA builds may offer a sandbox purchase.
-- The production environment is never named here, so it cannot be touched.
--
-- What runs, in one transaction (a refusal anywhere writes nothing):
--   1. the same advisory lock private.apply_product_policy takes for sales/sandbox;
--   2. compare-and-set: the current sandbox sales revision must equal the approved expected one;
--   3. the body is rendered from the pinned template below at the next revision with
--      private.product_policy_render, must equal the body shown in the approved plan, must be
--      valid for private.product_policy_body_valid and must activate sales for a listed build;
--   4. one ledger row (kind apply, status applied, owner subject = the fixed all-zero "protected
--      workflow operator" id, so no owner identity is stored) and the new revision are inserted;
--   5. only if the sandbox has no paid cutoff yet: the pinned sandbox cutoff below (write-once by
--      0016's triggers; it can never be changed or removed, and it never applies to production).
-- Revisions are append-only; "undo" is publishing the off body as another revision.
--
-- Inputs come from the runner's environment through psql, never from the command line: the
-- expected revision and the body the plan showed for approval. Refusals use fixed SQLSTATEs
-- (QP000-QP005, see operations.mjs) and print no data.
\getenv still_operation_expected_revision STILL_OPERATION_EXPECTED_REVISION
\getenv still_operation_policy_body STILL_OPERATION_POLICY_BODY
begin;
select pg_catalog.set_config('still_operation.expected_revision', :'still_operation_expected_revision', true) is not null and pg_catalog.set_config('still_operation.policy_body', :'still_operation_policy_body', true) is not null as configured;
do $$
declare
  v_template constant jsonb := '{"schema":1,"environment":"sandbox","salesEnabled":true,"channels":{"apple":{"enabled":true,"offer":"still-pro-v3"},"web":{"enabled":true,"offer":"still-pro-v3"}},"builds":[{"surface":"chrome_desktop","build":"2.1.1.321"},{"surface":"firefox_desktop","build":"2.1.1.321"},{"surface":"firefox_android","build":"2.1.1.321"},{"surface":"apple_mobile_host","build":"2.1.0"},{"surface":"apple_macos_host","build":"2.1.0"}]}';
  -- Decision D2 (accepted for the sandbox): the protected product id and the sorted free-tier ids.
  v_cutoff_product constant text := 'still-free-v2';
  v_cutoff_benefits constant text[] := array['facebook.reels', 'instagram.reels', 'tiktok.all', 'youtube.shorts'];
  v_operator constant uuid := '00000000-0000-0000-0000-000000000000';
  v_expected bigint;
  v_current bigint;
  v_body text;
  v_cutoff text := 'present';
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
    pg_catalog.hashtextextended('still-product-policy:sales:sandbox', 0));
  select coalesce(max(r.revision), 0) into v_current from private.product_policy_revisions r
    where r.namespace = 'sales' and r.environment = 'sandbox';
  if v_current <> v_expected then
    raise exception 'QP001 sandbox sales revision is not the approved expected revision' using errcode = 'QP001';
  end if;
  v_body := private.product_policy_render('sales',
    v_template || pg_catalog.jsonb_build_object('revision', v_expected + 1));
  if not private.product_policy_body_valid('sales', 'sandbox', v_expected + 1, v_body) then
    raise exception 'QP002 rendered body is not a valid sandbox sales body' using errcode = 'QP002';
  end if;
  if v_body <> pg_catalog.current_setting('still_operation.policy_body') then
    raise exception 'QP003 rendered body differs from the approved plan' using errcode = 'QP003';
  end if;
  if not private.product_policy_sales_activates(v_body) then
    raise exception 'QP004 an on body must enable sales for a listed build' using errcode = 'QP004';
  end if;
  insert into private.product_policy_operations (operation_id, kind, namespace, environment,
    owner_subject, expected_revision, body, preview_hash, rollback_of, created_at, expires_at,
    status, applied_revision, applied_at)
  values (v_operation, 'apply', 'sales', 'sandbox', v_operator, v_expected, v_body,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(E'\n',
      'still-protected-operation-1', v_operation::text, 'sales', 'sandbox', v_expected::text, v_body),
      'UTF8')), 'hex'),
    null, v_now, v_now, 'applied', v_expected + 1, v_now);
  insert into private.product_policy_revisions (namespace, environment, revision, body, operation_id, published_at)
  values ('sales', 'sandbox', v_expected + 1, v_body, v_operation, v_now);
  if not exists (select 1 from private.paid_cutoff c where c.environment = 'sandbox') then
    insert into private.paid_cutoff (environment, product, benefits, sales_revision, operation_id, activated_at)
    values ('sandbox', v_cutoff_product, v_cutoff_benefits, v_expected + 1, v_operation, v_now);
    v_cutoff := 'inserted';
  end if;
  perform pg_catalog.set_config('still_operation.outcome',
    pg_catalog.json_build_object('revision', v_expected + 1, 'cutoff', v_cutoff)::text, true);
end
$$;
select pg_catalog.current_setting('still_operation.outcome');
commit;
