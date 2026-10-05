-- Product policy: the server store behind remote sales and rating switches (U6).
--
-- What this adds. Four owner-only tables in the `private` schema and two narrow login roles that
-- reach them only through SECURITY DEFINER functions:
--   * private.product_policy_owners     the server-side owner allowlist (created EMPTY; the owner
--                                        adds their own account later as a separate approved
--                                        operation, never in Git and never by an agent);
--   * private.product_policy_operations the operation ledger: one row per owner preview with its
--                                        exact body, preview hash, expected revision, five-minute
--                                        validity and final status. No customer data;
--   * private.product_policy_revisions  the published history. Append-only: a trigger refuses any
--                                        update, delete or truncate, so a revision never changes
--                                        and never decreases. The newest row per namespace and
--                                        environment is the current policy;
--   * private.paid_cutoff                the paid cutoff. At most one row per environment, written
--                                        only inside the first sales activation, and write-once:
--                                        triggers refuse update, delete and truncate.
--
-- Roles. `still_policy_reader` may only read the current published body (the public endpoint);
-- `still_policy_admin` may only preview, apply and read back as an allowlisted owner (the owner
-- endpoint). Neither holds any table privilege. No client role, and not service_role, reaches any
-- of it.
--
-- Wire format. A stored body is exactly what clients parse with the shared grammar in
-- packages/shared-types/src/product-policy.ts (#280): restricted ASCII JSON in one canonical key
-- order, no whitespace, at most 8192 bytes. private.product_policy_body_valid re-checks that grammar
-- here and requires the body to equal its own canonical rendering, so a duplicate key, escape,
-- unknown key, free string, URL or reordered body is refused by the database itself.
--
-- Off by default. No policy, ledger, owner or cutoff row is written here. A missing row means sales
-- and rating are Off: the public read returns nothing and clients treat that as Off. The server
-- never claims that paid is on: a sales body is only the second key, which packaged builds AND with
-- their compiled switch (PAID_TIER_ENABLED, false in every build today).
--
-- Owner operation. preview (verified owner, exact draft, actual expected revision) -> apply (same
-- owner, exact preview id, hash, body and expected revision; compare-and-set on the revision;
-- idempotent per operation id, so a retry after a lost reply returns the committed result) ->
-- authoritative readback. Rollback republishes the body of an earlier revision at a NEW revision.
-- A first sales activation (salesEnabled with an enabled channel for an allowlisted build) must
-- carry the frozen cutoff snapshot; without it the apply is refused and nothing is written. The
-- owner endpoint passes no snapshot today, so no paid activation is possible from this change.
--
-- Deploy order. 0015 must be deployed and verified on its own before 0016. 0015's post-apply check
-- enumerates the private schema exactly, so a run listing both would fail 0015's check after
-- applying. Section 5 revokes on every function in schema private; the deploy planner reads that
-- as changing every private routine, which 0015's check pins, so its `verification-overlap` rule
-- refuses any plan listing 0015 and 0016 together. Re-running 0015's check after 0016 reports the
-- new private objects; that is expected and not a regression.
--
-- Authority and idempotence. Applied by the hosted migration role `postgres` (non-superuser) and
-- nothing else. Every statement is guarded or replace-in-place, so applying the file twice leaves the
-- catalog as it was. No existing row is read, rewritten or deleted.
--
-- Not done here, on purpose: the two roles' LOGIN and passwords, the owner allowlist row, the two
-- function deployments, any policy revision and any signing key (owner question 4: no signing yet;
-- a separate configuration-signing purpose can be added later without changing this storage).

-- ── 0. Preconditions: fail before any DDL ─────────────────────────────────────────────────────
do $$
begin
  if current_user <> 'postgres'
     or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'product policy migration role precondition' using errcode = '42501';
  end if;
  if pg_catalog.current_setting('server_version_num')::int < 160000 then
    raise exception 'product policy server version precondition' using errcode = '0A000';
  end if;
  -- 0015 created the private schema (owned by postgres) and its settings helpers.
  if pg_catalog.to_regnamespace('private') is null
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'private')
        <> (select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres')
     or pg_catalog.to_regprocedure('private.lock_settings(uuid,uuid,text)') is null then
    raise exception 'product policy requires 0015' using errcode = '55000';
  end if;
end
$$;

-- ── 1. The two narrow roles ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'still_policy_reader') then
    create role still_policy_reader nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'still_policy_admin') then
    create role still_policy_admin nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;
alter role still_policy_reader set lock_timeout = '1s';
alter role still_policy_reader set statement_timeout = '2s';
alter role still_policy_reader set idle_in_transaction_session_timeout = '5s';
alter role still_policy_admin set lock_timeout = '1s';
alter role still_policy_admin set statement_timeout = '2s';
alter role still_policy_admin set idle_in_transaction_session_timeout = '5s';

revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to still_policy_reader, still_policy_admin;

-- ── 2. Tables: owner-only ─────────────────────────────────────────────────────────────────────
-- Owner question 3: the allowlist is a server-only table. It starts empty and cascades away with
-- the owner's account.
create table if not exists private.product_policy_owners (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists private.product_policy_operations (
  operation_id uuid primary key,
  kind text not null check (kind in ('apply', 'rollback')),
  namespace text not null check (namespace in ('sales', 'rating')),
  environment text not null check (environment in ('sandbox', 'production')),
  owner_subject uuid not null,
  expected_revision bigint not null check (expected_revision >= 0 and expected_revision < 9007199254740991),
  body text not null check (pg_catalog.octet_length(body) <= 8192),
  preview_hash text not null check (preview_hash ~ '^[0-9a-f]{64}$'),
  rollback_of bigint check (rollback_of >= 1),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null check (status in ('previewed', 'applied', 'stale', 'expired')),
  applied_revision bigint,
  applied_at timestamptz,
  check ((status = 'applied') = (applied_revision is not null and applied_at is not null)),
  check (applied_revision is null or applied_revision = expected_revision + 1),
  check ((kind = 'rollback') = (rollback_of is not null))
);
create index if not exists product_policy_operations_open
  on private.product_policy_operations(namespace, environment) where status = 'previewed';

create table if not exists private.product_policy_revisions (
  namespace text not null check (namespace in ('sales', 'rating')),
  environment text not null check (environment in ('sandbox', 'production')),
  revision bigint not null check (revision >= 1 and revision <= 9007199254740991),
  body text not null check (pg_catalog.octet_length(body) <= 8192),
  operation_id uuid not null unique references private.product_policy_operations(operation_id),
  published_at timestamptz not null,
  primary key (namespace, environment, revision)
);

-- Owner question 6 is open: the content stays minimal (the protected product id and the sorted
-- feature ids frozen as released free), bound to the sales revision and operation that created it.
create table if not exists private.paid_cutoff (
  environment text primary key check (environment in ('sandbox', 'production')),
  product text not null check (product ~ '^[a-z0-9][a-z0-9._-]{0,95}$' and product <> 'still-pro-v3'),
  benefits text[] not null check (pg_catalog.cardinality(benefits) between 1 and 32
    and pg_catalog.array_position(benefits, null) is null),
  sales_revision bigint not null check (sales_revision >= 1),
  operation_id uuid not null unique references private.product_policy_operations(operation_id),
  activated_at timestamptz not null
);

alter table private.product_policy_owners enable row level security;
alter table private.product_policy_operations enable row level security;
alter table private.product_policy_revisions enable row level security;
alter table private.paid_cutoff enable row level security;
revoke all on table private.product_policy_owners, private.product_policy_operations,
  private.product_policy_revisions, private.paid_cutoff
  from public, anon, authenticated, service_role, still_settings_writer,
       still_policy_reader, still_policy_admin;

-- ── 3. Write-once enforcement ─────────────────────────────────────────────────────────────────
-- Published revisions and the paid cutoff can be inserted, never changed. Only an owner-level
-- `alter table ... disable trigger` could bypass this; the post-apply check proves the triggers are
-- present and enabled.
create or replace function private.product_policy_refuse_change() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'product policy history is write-once' using errcode = '55000';
end $$;
create or replace trigger product_policy_revisions_write_once
  before update or delete on private.product_policy_revisions
  for each row execute function private.product_policy_refuse_change();
create or replace trigger product_policy_revisions_no_truncate
  before truncate on private.product_policy_revisions
  for each statement execute function private.product_policy_refuse_change();
create or replace trigger paid_cutoff_write_once
  before update or delete on private.paid_cutoff
  for each row execute function private.product_policy_refuse_change();
create or replace trigger paid_cutoff_no_truncate
  before truncate on private.paid_cutoff
  for each statement execute function private.product_policy_refuse_change();

-- ── 4. Grammar helpers (owner-only, not SECURITY DEFINER) ─────────────────────────────────────
-- The one canonical rendering. Key order: schema, environment, revision, the namespace's fields,
-- builds; channels in SALES_CHANNELS order; surfaces in PRODUCT_POLICY_SURFACES order; builds in
-- the order given. The owner endpoint renders the same bytes (product-policy/policy-wire.ts).
create or replace function private.product_policy_render(p_namespace text, v jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '{"schema":1,"environment":"' || (v->>'environment') || '","revision":' || (v->>'revision') || ','
    || case p_namespace
      when 'sales' then '"salesEnabled":' || (v->>'salesEnabled') || ',"channels":{'
        || (select pg_catalog.string_agg('"' || c.name || '":{"enabled":' || (v->'channels'->c.name->>'enabled')
              || ',"offer":"' || (v->'channels'->c.name->>'offer') || '"}', ',' order by c.ord)
            from pg_catalog.unnest(array['apple', 'web']) with ordinality c(name, ord)) || '}'
      when 'rating' then '"master":' || (v->>'master') || ',"surfaces":{'
        || (select pg_catalog.string_agg('"' || s.name || '":' || (v->'surfaces'->>s.name), ',' order by s.ord)
            from pg_catalog.unnest(array['chrome_desktop', 'edge_desktop', 'firefox_desktop', 'firefox_android',
              'apple_mobile_host', 'apple_macos_host']) with ordinality s(name, ord)) || '}'
    end
    || ',"builds":[' || coalesce((select pg_catalog.string_agg('{"surface":"' || (b.value->>'surface')
         || '","build":"' || (b.value->>'build') || '"}', ',' order by b.ord)
       from pg_catalog.jsonb_array_elements(v->'builds') with ordinality b(value, ord)), '') || ']}';
$$;

-- True only for a complete, canonical body of the closed grammar for this namespace, environment
-- and revision. Any error is a refusal.
create or replace function private.product_policy_body_valid(
  p_namespace text, p_environment text, p_revision bigint, p_body text
) returns boolean
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v jsonb;
  item jsonb;
  name text;
  seen text[] := '{}';
  surfaces constant text[] := array['chrome_desktop', 'edge_desktop', 'firefox_desktop',
    'firefox_android', 'apple_mobile_host', 'apple_macos_host'];
begin
  if p_namespace is null or p_namespace not in ('sales', 'rating')
     or p_environment is null or p_environment not in ('sandbox', 'production')
     or p_revision is null or p_revision < 1 or p_revision > 9007199254740991
     or p_body is null or pg_catalog.octet_length(p_body) > 8192 or p_body !~ '^[!-~]+$' then
    return false;
  end if;
  v := p_body::jsonb;
  if pg_catalog.jsonb_typeof(v) <> 'object' then return false; end if;
  if (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(v) k)
     is distinct from (case p_namespace
       when 'sales' then array['builds', 'channels', 'environment', 'revision', 'salesEnabled', 'schema']
       else array['builds', 'environment', 'master', 'revision', 'schema', 'surfaces'] end) then
    return false;
  end if;
  if v->'schema' is distinct from '1'::jsonb
     or v->'environment' is distinct from pg_catalog.to_jsonb(p_environment)
     or (v->>'revision') is distinct from p_revision::text then
    return false;
  end if;
  if pg_catalog.jsonb_typeof(v->'builds') <> 'array' or pg_catalog.jsonb_array_length(v->'builds') > 32 then
    return false;
  end if;
  for item in select e from pg_catalog.jsonb_array_elements(v->'builds') e loop
    if pg_catalog.jsonb_typeof(item) <> 'object' then return false; end if;
    if (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(item) k)
       is distinct from array['build', 'surface'] then return false; end if;
    if pg_catalog.jsonb_typeof(item->'surface') <> 'string' or pg_catalog.jsonb_typeof(item->'build') <> 'string'
       or not ((item->>'surface') = any (surfaces))
       or (item->>'build') !~ '^[a-z0-9][a-z0-9._-]{0,95}$' then return false; end if;
    name := (item->>'surface') || ' ' || (item->>'build');
    if name = any (seen) then return false; end if;
    seen := seen || name;
  end loop;
  if p_namespace = 'sales' then
    if pg_catalog.jsonb_typeof(v->'salesEnabled') <> 'boolean' or pg_catalog.jsonb_typeof(v->'channels') <> 'object' then
      return false;
    end if;
    if (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(v->'channels') k)
       is distinct from array['apple', 'web'] then return false; end if;
    foreach name in array array['apple', 'web'] loop
      item := v->'channels'->name;
      if pg_catalog.jsonb_typeof(item) <> 'object' then return false; end if;
      if (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(item) k)
         is distinct from array['enabled', 'offer'] then return false; end if;
      if pg_catalog.jsonb_typeof(item->'enabled') <> 'boolean'
         or item->'offer' is distinct from '"still-pro-v3"'::jsonb then return false; end if;
    end loop;
  else
    if pg_catalog.jsonb_typeof(v->'master') <> 'boolean' or pg_catalog.jsonb_typeof(v->'surfaces') <> 'object' then
      return false;
    end if;
    if (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(v->'surfaces') k)
       is distinct from (select pg_catalog.array_agg(s order by s collate "C") from pg_catalog.unnest(surfaces) s) then
      return false;
    end if;
    foreach name in array surfaces loop
      if pg_catalog.jsonb_typeof(v->'surfaces'->name) <> 'boolean' then return false; end if;
    end loop;
  end if;
  return private.product_policy_render(p_namespace, v) = p_body;
exception when others then
  return false;
end $$;

-- A sales body that would let at least one supported, allowlisted build start a purchase if its
-- compiled switch were on: the first such apply is the paid activation that freezes the cutoff.
-- edge_desktop maps to no channel (deferred), exactly as SALES_CHANNEL_BY_SURFACE.
create or replace function private.product_policy_sales_activates(p_body text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce((x.v->>'salesEnabled')::boolean, false) and exists (
    select 1 from pg_catalog.jsonb_array_elements(x.v->'builds') b
    where ((b->>'surface') in ('chrome_desktop', 'firefox_desktop', 'firefox_android')
           and coalesce((x.v->'channels'->'web'->>'enabled')::boolean, false))
       or ((b->>'surface') in ('apple_mobile_host', 'apple_macos_host')
           and coalesce((x.v->'channels'->'apple'->>'enabled')::boolean, false)))
  from (select p_body::jsonb as v) x;
$$;

-- ── 5. The server-only routes ─────────────────────────────────────────────────────────────────
-- Public read: the current body for one namespace and environment, or null (Off). Nothing else:
-- no revision metadata, operation, owner or cutoff.
create or replace function private.read_product_policy(p_namespace text, p_environment text)
returns text language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_namespace is null or p_namespace not in ('sales', 'rating')
     or p_environment is null or p_environment not in ('sandbox', 'production') then
    raise exception 'product policy request shape' using errcode = '22023';
  end if;
  return (select r.body from private.product_policy_revisions r
          where r.namespace = p_namespace and r.environment = p_environment
          order by r.revision desc limit 1);
end $$;

-- Owner readback: the authoritative current revision, body and operation, and whether a cutoff
-- exists for the environment.
create or replace function private.read_product_policy_state(p_owner uuid, p_namespace text, p_environment text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare head record;
begin
  if p_owner is null or not exists (select 1 from private.product_policy_owners o where o.user_id = p_owner) then
    raise exception 'product policy owner required' using errcode = '28000';
  end if;
  if p_namespace is null or p_namespace not in ('sales', 'rating')
     or p_environment is null or p_environment not in ('sandbox', 'production') then
    raise exception 'product policy request shape' using errcode = '22023';
  end if;
  select r.revision, r.body, r.operation_id into head from private.product_policy_revisions r
    where r.namespace = p_namespace and r.environment = p_environment
    order by r.revision desc limit 1;
  return pg_catalog.jsonb_build_object(
    'revision', coalesce(head.revision, 0), 'body', head.body, 'operationId', head.operation_id,
    'cutoff', exists (select 1 from private.paid_cutoff c where c.environment = p_environment));
end $$;

-- Preview: stage the exact body (or, with p_rollback_of, the body of that earlier revision at the
-- next revision) against the actual current revision. Returns the operation id, the preview hash
-- over every bound field and the five-minute expiry; a stale expected revision stages nothing.
create or replace function private.preview_product_policy(
  p_owner uuid, p_namespace text, p_environment text, p_expected bigint, p_body text, p_rollback_of bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  current_revision bigint;
  current_body text;
  source text;
  v_body text;
  v_kind text;
  v_id uuid := pg_catalog.gen_random_uuid();
  v_created timestamptz := pg_catalog.clock_timestamp();
  v_expires timestamptz := v_created + interval '5 minutes';
  v_hash text;
begin
  if p_owner is null or not exists (select 1 from private.product_policy_owners o where o.user_id = p_owner) then
    raise exception 'product policy owner required' using errcode = '28000';
  end if;
  if p_namespace is null or p_namespace not in ('sales', 'rating')
     or p_environment is null or p_environment not in ('sandbox', 'production')
     or p_expected is null or p_expected < 0 or p_expected >= 9007199254740991
     or (p_rollback_of is null) = (p_body is null) then
    raise exception 'product policy request shape' using errcode = '22023';
  end if;
  select r.revision, r.body into current_revision, current_body from private.product_policy_revisions r
    where r.namespace = p_namespace and r.environment = p_environment
    order by r.revision desc limit 1;
  current_revision := coalesce(current_revision, 0);
  if current_revision <> p_expected then
    return pg_catalog.jsonb_build_object('status', 'stale', 'currentRevision', current_revision);
  end if;
  if p_rollback_of is null then
    v_kind := 'apply';
    v_body := p_body;
  else
    select r.body into source from private.product_policy_revisions r
      where r.namespace = p_namespace and r.environment = p_environment and r.revision = p_rollback_of;
    if source is null or p_rollback_of >= current_revision then
      raise exception 'product policy request shape' using errcode = '22023';
    end if;
    v_kind := 'rollback';
    v_body := private.product_policy_render(p_namespace,
      pg_catalog.jsonb_set(source::jsonb, '{revision}', pg_catalog.to_jsonb(p_expected + 1)));
  end if;
  if not private.product_policy_body_valid(p_namespace, p_environment, p_expected + 1, v_body) then
    raise exception 'product policy body invalid' using errcode = '22023';
  end if;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(E'\n',
    'still-product-policy-preview-1', v_id::text, v_kind, p_namespace, p_environment, p_owner::text,
    p_expected::text, coalesce(p_rollback_of::text, '-'),
    pg_catalog.floor(extract(epoch from v_expires) * 1000)::bigint::text, v_body), 'UTF8')), 'hex');
  insert into private.product_policy_operations (operation_id, kind, namespace, environment,
    owner_subject, expected_revision, body, preview_hash, rollback_of, created_at, expires_at, status)
  values (v_id, v_kind, p_namespace, p_environment, p_owner, p_expected, v_body, v_hash, p_rollback_of,
    v_created, v_expires, 'previewed');
  return pg_catalog.jsonb_build_object('status', 'previewed', 'operationId', v_id, 'previewHash', v_hash,
    'kind', v_kind, 'rollbackOf', p_rollback_of, 'expectedRevision', p_expected,
    'revision', p_expected + 1, 'body', v_body, 'currentBody', current_body,
    'expiresAt', pg_catalog.floor(extract(epoch from v_expires) * 1000)::bigint);
end $$;

-- Apply: the same owner submits the exact preview. Compare-and-set on the expected revision under a
-- per-namespace/environment transaction lock, so of two parallel applies one commits and the other
-- answers "stale" (an open preview is never silently rebased); idempotent per operation id (a
-- committed operation answers every later identical retry with its committed result, even after
-- expiry); a changed body or hash never reuses it. The first sales activation must carry the cutoff
-- snapshot.
create or replace function private.apply_product_policy(
  p_owner uuid, p_operation uuid, p_hash text, p_namespace text, p_environment text,
  p_expected bigint, p_body text, p_cutoff_product text, p_cutoff_benefits text[]
) returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  op private.product_policy_operations%rowtype;
  current_revision bigint;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_owner is null or not exists (select 1 from private.product_policy_owners o where o.user_id = p_owner) then
    raise exception 'product policy owner required' using errcode = '28000';
  end if;
  if p_operation is null or p_hash is null or p_body is null
     or p_namespace is null or p_namespace not in ('sales', 'rating')
     or p_environment is null or p_environment not in ('sandbox', 'production')
     or p_expected is null or p_expected < 0 or p_expected >= 9007199254740991
     or (p_cutoff_product is null) <> (p_cutoff_benefits is null) then
    raise exception 'product policy request shape' using errcode = '22023';
  end if;
  -- One apply per namespace and environment at a time, taken before the operation's row lock. Every
  -- other open preview for the same namespace and environment then fails the compare-and-set.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('still-product-policy:' || p_namespace || ':' || p_environment, 0));
  select * into op from private.product_policy_operations o where o.operation_id = p_operation for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'unknown_preview');
  end if;
  if op.owner_subject <> p_owner then
    return pg_catalog.jsonb_build_object('status', 'wrong_owner');
  end if;
  if op.namespace <> p_namespace or op.environment <> p_environment or op.expected_revision <> p_expected then
    return pg_catalog.jsonb_build_object('status', 'preview_mismatch');
  end if;
  if op.preview_hash <> p_hash then
    return pg_catalog.jsonb_build_object('status', 'hash_mismatch');
  end if;
  if op.body <> p_body then
    return pg_catalog.jsonb_build_object('status', 'body_mismatch');
  end if;
  if op.status = 'applied' then
    return pg_catalog.jsonb_build_object('status', 'applied', 'replay', true, 'operationId', op.operation_id,
      'revision', op.applied_revision, 'body', op.body);
  end if;
  if op.status <> 'previewed' then
    return pg_catalog.jsonb_build_object('status', op.status);
  end if;
  if v_now >= op.expires_at or v_now < op.created_at then
    update private.product_policy_operations set status = 'expired' where operation_id = p_operation;
    return pg_catalog.jsonb_build_object('status', 'expired');
  end if;
  -- Compare-and-set on the actual revision below.
  select coalesce(max(r.revision), 0) into current_revision from private.product_policy_revisions r
    where r.namespace = p_namespace and r.environment = p_environment;
  if current_revision <> op.expected_revision then
    update private.product_policy_operations set status = 'stale' where operation_id = p_operation;
    return pg_catalog.jsonb_build_object('status', 'stale', 'currentRevision', current_revision);
  end if;
  if not private.product_policy_body_valid(p_namespace, p_environment, op.expected_revision + 1, op.body) then
    raise exception 'product policy body invalid' using errcode = '22023';
  end if;
  if p_namespace = 'sales' and private.product_policy_sales_activates(op.body)
     and not exists (select 1 from private.paid_cutoff c where c.environment = p_environment) then
    if p_cutoff_product is null then
      return pg_catalog.jsonb_build_object('status', 'cutoff_required');
    end if;
    if p_cutoff_product !~ '^[a-z0-9][a-z0-9._-]{0,95}$' or p_cutoff_product = 'still-pro-v3'
       or pg_catalog.cardinality(p_cutoff_benefits) not between 1 and 32
       or exists (select 1 from pg_catalog.unnest(p_cutoff_benefits) b
                  where b is null or b !~ '^[a-z0-9][a-z0-9._-]{0,95}$')
       or p_cutoff_benefits is distinct from (select pg_catalog.array_agg(d.b order by d.b collate "C")
                                             from (select distinct u.b from pg_catalog.unnest(p_cutoff_benefits) u(b)) d) then
      raise exception 'product policy cutoff shape' using errcode = '22023';
    end if;
    insert into private.paid_cutoff (environment, product, benefits, sales_revision, operation_id, activated_at)
    values (p_environment, p_cutoff_product, p_cutoff_benefits, op.expected_revision + 1, op.operation_id, v_now);
  end if;
  insert into private.product_policy_revisions (namespace, environment, revision, body, operation_id, published_at)
  values (p_namespace, p_environment, op.expected_revision + 1, op.body, op.operation_id, v_now);
  update private.product_policy_operations
    set status = 'applied', applied_revision = op.expected_revision + 1, applied_at = v_now
    where operation_id = p_operation;
  return pg_catalog.jsonb_build_object('status', 'applied', 'replay', false, 'operationId', op.operation_id,
    'revision', op.expected_revision + 1, 'body', op.body);
end $$;

-- Execution: nothing in private for PUBLIC, the client roles or service_role (this schema-wide
-- statement is also what makes the deploy planner refuse listing 0015 and 0016 together), then
-- exactly one narrow grantee per route. Helpers and the trigger function stay owner-only.
revoke all on all functions in schema private from public, anon, authenticated, service_role;
revoke all on function private.product_policy_refuse_change(), private.product_policy_render(text, jsonb),
  private.product_policy_body_valid(text, text, bigint, text), private.product_policy_sales_activates(text),
  private.read_product_policy(text, text), private.read_product_policy_state(uuid, text, text),
  private.preview_product_policy(uuid, text, text, bigint, text, bigint),
  private.apply_product_policy(uuid, uuid, text, text, text, bigint, text, text, text[])
  from public, anon, authenticated, service_role, still_settings_writer, still_policy_reader, still_policy_admin;
grant execute on function private.read_product_policy(text, text) to still_policy_reader;
grant execute on function private.read_product_policy_state(uuid, text, text),
  private.preview_product_policy(uuid, text, text, bigint, text, bigint),
  private.apply_product_policy(uuid, uuid, text, text, text, bigint, text, text, text[])
  to still_policy_admin;

-- ── 6. Self-check: abort the whole migration unless the final state is the intended one ───────
-- Client reach is the closure of anon and authenticated over every membership edge, as in 0014
-- and 0015. "Restricted" means PUBLIC, that closure and service_role.
do $$
declare
  issues text[] := '{}';
  owner_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'postgres');
  reader_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_policy_reader');
  admin_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_policy_admin');
  settings_writer_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'still_settings_writer');
  service_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'service_role');
  private_oid oid := (select oid from pg_catalog.pg_namespace where nspname = 'private');
  clients oid[];
  restricted oid[];
  policy_roles oid[];
  role_settings text[] := array['lock_timeout=1s', 'statement_timeout=2s', 'idle_in_transaction_session_timeout=5s'];
  policy_tables text[] := array['product_policy_owners', 'product_policy_operations',
    'product_policy_revisions', 'paid_cutoff'];
  setting text;
  item record;
  routine record;
begin
  with recursive reach(oid) as (
    select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
    union
    select m.roleid from pg_catalog.pg_auth_members m join reach c on m.member = c.oid
  ) select pg_catalog.array_agg(oid) into clients from reach;
  restricted := clients || service_oid || 0::oid;
  policy_roles := array[reader_oid, admin_oid];

  -- Roles: narrow attributes, the three session limits, member of nothing, and the only membership
  -- in them is postgres's automatic non-inheriting, non-SET admin grant.
  for item in select x.name, x.oid from (values ('still_policy_reader', reader_oid),
                                                ('still_policy_admin', admin_oid)) x(name, oid) loop
    if item.oid is null then
      issues := issues || ('role_missing:' || item.name);
      continue;
    end if;
    if exists (select 1 from pg_catalog.pg_roles r where r.oid = item.oid
               and (r.rolsuper or r.rolinherit or r.rolcreaterole or r.rolcreatedb
                    or r.rolreplication or r.rolbypassrls)) then
      issues := issues || ('role_attributes:' || item.name);
    end if;
    foreach setting in array role_settings loop
      if not exists (select 1 from pg_catalog.pg_db_role_setting s
                     where s.setrole = item.oid and s.setdatabase = 0 and setting = any (s.setconfig)) then
        issues := issues || ('role_setting_missing:' || item.name || ':' || setting);
      end if;
    end loop;
    if exists (select 1 from pg_catalog.pg_auth_members m where m.member = item.oid) then
      issues := issues || ('role_member_of_role:' || item.name);
    end if;
    if exists (select 1 from pg_catalog.pg_auth_members m where m.roleid = item.oid
               and not (m.member = owner_oid and not m.inherit_option and not m.set_option)) then
      issues := issues || ('role_granted_to_other:' || item.name);
    end if;
    if item.oid = any (clients) then
      issues := issues || ('role_client_reachable:' || item.name);
    end if;
  end loop;

  -- Schema private: owned by postgres; only the three narrow roles may look up names in it.
  if private_oid is null or (select n.nspowner from pg_catalog.pg_namespace n where n.oid = private_oid) <> owner_oid then
    issues := issues || 'private_schema_owner'::text;
  else
    for item in
      select a.grantee, a.privilege_type from pg_catalog.pg_namespace n
      cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      where n.oid = private_oid and a.grantee <> owner_oid
        and not (a.grantee = any (array[settings_writer_oid, reader_oid, admin_oid]) and a.privilege_type = 'USAGE')
    loop
      issues := issues || ('private_schema_grant:' || case when item.grantee = 0 then 'PUBLIC'
        else item.grantee::regrole::text end || ':' || item.privilege_type);
    end loop;
    foreach setting in array array['still_policy_reader', 'still_policy_admin'] loop
      if not pg_catalog.has_schema_privilege(setting, 'private', 'USAGE') then
        issues := issues || ('private_usage_missing:' || setting);
      end if;
    end loop;
  end if;

  -- The four tables: present, owned by postgres, RLS on, no table or column grant to anyone.
  foreach setting in array policy_tables loop
    select c.oid, c.relkind, c.relowner, c.relrowsecurity, c.relacl into item
      from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('private.' || setting);
    if item.oid is null or item.relkind <> 'r' then
      issues := issues || ('policy_relation_missing:' || setting);
      continue;
    end if;
    if item.relowner <> owner_oid then
      issues := issues || ('policy_relation_owner:' || setting);
    end if;
    if not item.relrowsecurity then
      issues := issues || ('policy_rls_disabled:' || setting);
    end if;
    if exists (select 1 from pg_catalog.aclexplode(coalesce(item.relacl, pg_catalog.acldefault('r', item.relowner))) a
               where a.grantee <> owner_oid)
       or exists (select 1 from pg_catalog.pg_attribute att
                  where att.attrelid = item.oid and att.attnum > 0 and not att.attisdropped
                    and att.attacl is not null) then
      issues := issues || ('policy_relation_grant:' || setting);
    end if;
  end loop;
  -- `create table if not exists` keeps a pre-existing table: prove the columns the routes use.
  for item in
    select x.relname, x.attname from (values
      ('product_policy_owners', 'user_id', 'pg_catalog.uuid'::pg_catalog.regtype),
      ('product_policy_operations', 'operation_id', 'pg_catalog.uuid'::pg_catalog.regtype),
      ('product_policy_operations', 'kind', 'pg_catalog.text'::pg_catalog.regtype),
      ('product_policy_operations', 'namespace', 'pg_catalog.text'::pg_catalog.regtype),
      ('product_policy_operations', 'environment', 'pg_catalog.text'::pg_catalog.regtype),
      ('product_policy_operations', 'owner_subject', 'pg_catalog.uuid'::pg_catalog.regtype),
      ('product_policy_operations', 'expected_revision', 'pg_catalog.int8'::pg_catalog.regtype),
      ('product_policy_operations', 'body', 'pg_catalog.text'::pg_catalog.regtype),
      ('product_policy_operations', 'preview_hash', 'pg_catalog.text'::pg_catalog.regtype),
      ('product_policy_operations', 'created_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
      ('product_policy_operations', 'expires_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
      ('product_policy_operations', 'status', 'pg_catalog.text'::pg_catalog.regtype),
      ('product_policy_revisions', 'namespace', 'pg_catalog.text'::pg_catalog.regtype),
      ('product_policy_revisions', 'environment', 'pg_catalog.text'::pg_catalog.regtype),
      ('product_policy_revisions', 'revision', 'pg_catalog.int8'::pg_catalog.regtype),
      ('product_policy_revisions', 'body', 'pg_catalog.text'::pg_catalog.regtype),
      ('product_policy_revisions', 'operation_id', 'pg_catalog.uuid'::pg_catalog.regtype),
      ('product_policy_revisions', 'published_at', 'pg_catalog.timestamptz'::pg_catalog.regtype),
      ('paid_cutoff', 'environment', 'pg_catalog.text'::pg_catalog.regtype),
      ('paid_cutoff', 'product', 'pg_catalog.text'::pg_catalog.regtype),
      ('paid_cutoff', 'benefits', 'pg_catalog._text'::pg_catalog.regtype),
      ('paid_cutoff', 'sales_revision', 'pg_catalog.int8'::pg_catalog.regtype),
      ('paid_cutoff', 'operation_id', 'pg_catalog.uuid'::pg_catalog.regtype),
      ('paid_cutoff', 'activated_at', 'pg_catalog.timestamptz'::pg_catalog.regtype)
    ) x(relname, attname, typ)
    where pg_catalog.to_regclass('private.' || x.relname) is not null
      and not exists (select 1 from pg_catalog.pg_attribute a
                      where a.attrelid = pg_catalog.to_regclass('private.' || x.relname)
                        and a.attname = x.attname and not a.attisdropped and a.attnotnull
                        and a.atttypid = x.typ::pg_catalog.oid)
  loop
    issues := issues || ('policy_column:' || item.relname || '.' || item.attname);
  end loop;
  for item in
    select x.relname, x.cols from (values
      ('product_policy_owners', array['user_id']),
      ('product_policy_operations', array['operation_id']),
      ('product_policy_revisions', array['namespace', 'environment', 'revision']),
      ('paid_cutoff', array['environment'])
    ) x(relname, cols)
    where pg_catalog.to_regclass('private.' || x.relname) is not null
      and not exists (
        select 1 from pg_catalog.pg_index i
        where i.indrelid = pg_catalog.to_regclass('private.' || x.relname) and i.indisprimary
          and i.indpred is null and i.indexprs is null
          and (select pg_catalog.array_agg(a.attname::text order by k.ord)
               from pg_catalog.unnest(i.indkey) with ordinality k(attnum, ord)
               join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = x.cols)
  loop
    issues := issues || ('policy_key:' || item.relname);
  end loop;
  if pg_catalog.to_regclass('private.product_policy_owners') is not null and not exists (
       select 1 from pg_catalog.pg_constraint k
       where k.conrelid = 'private.product_policy_owners'::pg_catalog.regclass and k.contype = 'f'
         and k.confrelid = 'auth.users'::pg_catalog.regclass and k.confdeltype = 'c') then
    issues := issues || 'policy_owner_no_account_cascade'::text;
  end if;

  -- Write-once triggers: present, enabled, calling the refusal function. tgtype 27 = row, before,
  -- update or delete; 34 = statement, before, truncate.
  for item in
    select x.relname, x.tgname, x.tgtype from (values
      ('product_policy_revisions', 'product_policy_revisions_write_once', 27),
      ('product_policy_revisions', 'product_policy_revisions_no_truncate', 34),
      ('paid_cutoff', 'paid_cutoff_write_once', 27),
      ('paid_cutoff', 'paid_cutoff_no_truncate', 34)
    ) x(relname, tgname, tgtype)
    where not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = pg_catalog.to_regclass('private.' || x.relname) and t.tgname = x.tgname
        and t.tgtype = x.tgtype and t.tgenabled = 'O' and not t.tgisinternal
        and t.tgfoid = pg_catalog.to_regprocedure('private.product_policy_refuse_change()'))
  loop
    issues := issues || ('write_once_trigger:' || item.tgname);
  end loop;

  -- The 0016 routines: present, owned by postgres, pg_temp-last, SECURITY DEFINER exactly for the
  -- four routes, EXECUTE for the owner plus exactly the one narrow grantee of each route.
  for routine in
    select x.sig, x.definer, x.grantee, pg_catalog.to_regprocedure(x.sig) as oid from (values
      ('private.product_policy_refuse_change()', false, null::oid),
      ('private.product_policy_render(text,jsonb)', false, null::oid),
      ('private.product_policy_body_valid(text,text,bigint,text)', false, null::oid),
      ('private.product_policy_sales_activates(text)', false, null::oid),
      ('private.read_product_policy(text,text)', true, reader_oid),
      ('private.read_product_policy_state(uuid,text,text)', true, admin_oid),
      ('private.preview_product_policy(uuid,text,text,bigint,text,bigint)', true, admin_oid),
      ('private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])', true, admin_oid)
    ) x(sig, definer, grantee)
  loop
    if routine.oid is null then
      issues := issues || ('policy_function_missing:' || routine.sig);
      continue;
    end if;
    select p.proowner, p.prosecdef, p.proconfig, p.proacl into item from pg_catalog.pg_proc p where p.oid = routine.oid;
    if item.proowner <> owner_oid then
      issues := issues || ('policy_function_owner:' || routine.sig);
    end if;
    if item.prosecdef is distinct from routine.definer then
      issues := issues || ('policy_function_definer:' || routine.sig);
    end if;
    if not coalesce(item.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false) then
      issues := issues || ('unsafe_search_path:' || routine.sig);
    end if;
    if (select pg_catalog.array_agg(a.grantee order by a.grantee)
        from pg_catalog.aclexplode(coalesce(item.proacl, pg_catalog.acldefault('f', item.proowner))) a
        where a.grantee <> owner_oid) is distinct from
       (case when routine.grantee is null then null else array[routine.grantee] end) then
      issues := issues || ('policy_function_grant:' || routine.sig);
    end if;
  end loop;

  -- The two policy roles reach no other SECURITY DEFINER routine and no table in public or private.
  for item in
    select distinct r.rolname::text as rolname, p.oid::regprocedure::text as routine
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join pg_catalog.unnest(policy_roles) x(oid)
    join pg_catalog.pg_roles r on r.oid = x.oid
    where n.nspname in ('public', 'private') and p.prosecdef
      and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                               'pg_catalog.event_trigger'::pg_catalog.regtype)
      and not (x.oid = reader_oid and p.oid = 'private.read_product_policy(text,text)'::regprocedure)
      and not (x.oid = admin_oid and p.oid in (
        'private.read_product_policy_state(uuid,text,text)'::regprocedure,
        'private.preview_product_policy(uuid,text,text,bigint,text,bigint)'::regprocedure,
        'private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])'::regprocedure))
      and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE')
  loop
    issues := issues || ('policy_role_execute:' || item.rolname || ':' || item.routine);
  end loop;
  for item in
    select distinct r.rolname::text as rolname, n.nspname || '.' || c.relname as relation
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join pg_catalog.unnest(policy_roles) x(oid)
    join pg_catalog.pg_roles r on r.oid = x.oid
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (pg_catalog.has_table_privilege(x.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or pg_catalog.has_any_column_privilege(x.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
  loop
    issues := issues || ('policy_role_table:' || item.rolname || ':' || item.relation);
  end loop;

  -- 0014/0015's client boundary still holds: no client-reachable SECURITY DEFINER except the two
  -- client RPCs, and service_role reaches nothing in private.
  for item in
    select distinct c.oid::regrole::text as rolname, p.oid::regprocedure::text as routine
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join pg_catalog.unnest(clients || service_oid) c(oid)
    where n.nspname in ('public', 'private') and p.prosecdef
      and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                               'pg_catalog.event_trigger'::pg_catalog.regtype)
      and p.oid not in ('public.write_profile_settings(jsonb,uuid)'::regprocedure,
                        'public.get_current_rule_set()'::regprocedure)
      and (n.nspname = 'private' or c.oid <> service_oid)
      and pg_catalog.has_function_privilege(c.oid, p.oid, 'EXECUTE')
  loop
    issues := issues || ('client_execute:' || item.rolname || ':' || item.routine);
  end loop;

  -- Every SECURITY DEFINER in public and private searches pg_temp last.
  for item in
    select p.oid::regprocedure::text as routine
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
      and not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)
  loop
    issues := issues || ('unsafe_search_path:' || item.routine);
  end loop;

  -- No default privilege, from any creator, hands future objects in private to anyone restricted or
  -- to a narrow role.
  for item in
    select d.defaclrole::regrole::text as creator, d.defaclobjtype::text as objtype
    from pg_catalog.pg_default_acl d
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where d.defaclnamespace = private_oid
      and (a.grantee = any (restricted) or a.grantee = any (array[settings_writer_oid, reader_oid, admin_oid]))
  loop
    issues := issues || ('private_default:' || item.creator || ':' || item.objtype);
  end loop;

  if pg_catalog.cardinality(issues) > 0 then
    raise exception 'product policy self-check failed: %',
      pg_catalog.array_to_string(issues, ', ') using errcode = '42501';
  end if;
end
$$;

-- ── FIX-FORWARD (manual, never a re-grant) ─────────────────────────────────────────────────────
-- Do not grant any private table, helper or route to a client role or to service_role to make a
-- failure go away. If either endpoint misbehaves, stop deploying that function: a missing policy
-- is Off on every client. Ship a NEW forward migration for any correction. Never delete a published
-- revision or the paid cutoff, never disable their triggers, and never lower a revision: rollback
-- is a new revision carrying earlier values. The owner allowlist is changed only by a separately
-- approved owner operation that inserts or deletes exactly one row.
--
-- ── RULES FOR LATER MIGRATIONS ─────────────────────────────────────────────────────────────────
-- 0014's and 0015's rules still apply (explicit grants, revokes from public, anon, authenticated and
-- service_role, `set search_path = pg_catalog, pg_temp` on every SECURITY DEFINER, schema-qualified
-- bodies). In addition: a migration that changes the policy grammar changes
-- private.product_policy_body_valid and private.product_policy_render together with the shared
-- grammar and its vectors, and a stored body that the new grammar refuses is never rewritten; it is
-- superseded by a new revision.
