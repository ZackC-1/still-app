-- Owner-approved operation pause-settings-sync (the emergency stop for new settings sync).
--
-- The sync-settings function reaches the database only as still_settings_writer. After this runs,
-- that role cannot sign in, so every new-sync request fails and the apps keep each setting on the
-- device ("saved on this device") and retry. Blocking is unaffected. No data, grant, password or
-- other role changes. Resume with resume-settings-sync. Safe to repeat.
--
-- The runner executes the two statements in order, each committed on its own (no surrounding
-- transaction): the login is switched off first, so nothing can reconnect after step 2.
alter role still_settings_writer nologin;
-- Step 2: close the role's connections that are already open (a connection pooler keeps them
-- across NOLOGIN). Waits up to 5 seconds for each one to end. Prints counts only.
select pg_catalog.json_build_object('closed', pg_catalog.count(*) filter (where t.closed), 'remaining', pg_catalog.count(*) filter (where not t.closed))::text from (select pg_catalog.pg_terminate_backend(a.pid, 5000) as closed from pg_catalog.pg_stat_activity a where a.usename = 'still_settings_writer' and a.pid <> pg_catalog.pg_backend_pid()) t;
