-- Additive QA-only delivery hints. Canonical settings and existing writer RPCs are unchanged.
-- Private Broadcast is advisory: no settings, receipts, email or entitlement data enters a message.
begin;
set local lock_timeout = '5s';
do $$ begin
 if current_user <> 'postgres' or session_user <> 'postgres'
  or not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and not rolsuper)
  or pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null
  or not (select relrowsecurity from pg_catalog.pg_class where oid='realtime.messages'::regclass)
  or exists(select 1 from pg_catalog.pg_policy where polrelid='realtime.messages'::regclass) then
  raise exception 'QA notification prerequisites differ';
 end if;
end $$;

-- No caller-selected subject: disclose only whether this authenticated account is admitted.
create function public.qa_settings_notifications_enabled() returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
 select exists(select 1 from private.qa_sandbox_subjects where holder=(select auth.uid()) and enabled);
$$;
revoke all on function public.qa_settings_notifications_enabled() from public, anon, authenticated, service_role;
grant execute on function public.qa_settings_notifications_enabled() to authenticated;

create policy qa_settings_notifications_receive on realtime.messages for select to authenticated
 using (extension='broadcast'
  and (select realtime.topic())='qa-settings-v1:' || (select auth.uid())::text
  and (select public.qa_settings_notifications_enabled()));
-- No INSERT policy: clients cannot publish a hint, even to their own channel.

create function private.notify_qa_settings_changed() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
 if tg_op='UPDATE' and new.settings_version is not distinct from old.settings_version then return new; end if;
 if exists(select 1 from private.qa_sandbox_subjects where holder=new.id and enabled) then
  -- realtime.send inserts transactionally, so rollback cannot announce an uncommitted change.
  perform realtime.send('{"schema":1}'::jsonb, 'settings-changed', 'qa-settings-v1:' || new.id::text, true);
 end if;
 return new;
exception when others then
 -- Notifications must not turn an otherwise valid settings write into an outage.
 -- Fixed text only: SQL errors can contain private row values.
 raise warning 'QA settings notification unavailable';
 return new;
end;
$$;
revoke all on function private.notify_qa_settings_changed() from public, anon, authenticated, service_role,
 still_settings_writer, still_entitlement_writer, still_qa_sandbox_writer, still_qa_sandbox_owner;
create trigger qa_settings_changed after insert or update of settings_version on public.profiles
 for each row execute function private.notify_qa_settings_changed();
commit;
