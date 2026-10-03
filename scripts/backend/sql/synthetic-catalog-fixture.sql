-- TEST ONLY. Generic reviewed fixtures, never a snapshot of a provider/customer catalog.
-- Execute with the disposable CI fixture login. This file is bound to the synthetic source plan.
begin;
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'u1_provider_owner') then
    create role u1_provider_owner nologin superuser;
    create role u1_event_owner nologin superuser;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'u1_empty_creator') then
    create role u1_empty_creator nologin;
    create role u1_default_creator nologin;
    create role u1_discovered_creator nologin;
  end if;
end $$;
grant u1_provider_owner to postgres;
grant usage, create on schema public to u1_provider_owner;
grant u1_empty_creator, u1_default_creator, u1_discovered_creator to postgres;
grant usage, create on schema public to u1_empty_creator, u1_default_creator, u1_discovered_creator;
alter default privileges for role u1_default_creator grant select on tables to authenticated;
alter default privileges for role u1_default_creator in schema public grant execute on functions to anon;
alter default privileges for role u1_default_creator in schema public grant select on sequences to authenticated;
alter default privileges for role u1_discovered_creator in schema public grant update on tables to authenticated;
create schema if not exists u1_provider_schema authorization u1_default_creator;
alter default privileges for role u1_default_creator in schema u1_provider_schema grant update on tables to anon;
insert into still_security.reconciled_creators(role_name) values ('u1_empty_creator'), ('u1_default_creator')
  on conflict do nothing;
-- The third creator deliberately has public defaults but no selected objects or explicit entry.
set local role u1_provider_owner;
create or replace function public.u1_provider_guard() returns event_trigger
language plpgsql security definer set search_path = pg_catalog as 'BEGIN RETURN; END;';
reset role;
set local role u1_event_owner;
drop event trigger if exists u1_provider_binding;
create event trigger u1_provider_binding on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.u1_provider_guard();
reset role;
-- Literal approved descriptor, never an INSERT/SELECT accepting the current catalog as trusted.
insert into still_security.approved_provider_routines(routine, descriptor) values (
  'public.u1_provider_guard()',
  '{"schema":"public","routine":"u1_provider_guard()","owner":"u1_provider_owner","return_type":"event_trigger","language":"plpgsql","configuration":["search_path=pg_catalog"],"security_definer":true,"body":"BEGIN RETURN; END;","bindings":[{"name":"u1_provider_binding","owner":"u1_event_owner","event":"ddl_command_end","enabled":"O","tags":["CREATE TABLE","CREATE TABLE AS","SELECT INTO"]}]}'::jsonb
) on conflict (routine) do update set descriptor = excluded.descriptor;
commit;
