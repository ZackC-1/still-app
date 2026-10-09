-- Owner-approved operation qa-sandbox-secrets, mode disable: the sandbox QA writer stops signing in.
--
-- still_qa_sandbox_writer is the only role the paid QA functions write through. After this runs it
-- cannot sign in, so every paid QA function answers "unavailable". The shared still_policy_reader
-- and still_settings_writer logins (used by live functions too) are not touched. No data, grant,
-- password or other role changes. Safe to repeat.
--
-- The runner executes the two statements in order, each committed on its own (no surrounding
-- transaction): the login is switched off first, so nothing can reconnect after step 2.
alter role still_qa_sandbox_writer nologin;
-- Step 2: close the role's connections that are already open (a connection pooler keeps them
-- across NOLOGIN). Waits up to 5 seconds for each one to end. Prints counts only.
select pg_catalog.json_build_object('closed', pg_catalog.count(*) filter (where t.closed), 'remaining', pg_catalog.count(*) filter (where not t.closed))::text from (select pg_catalog.pg_terminate_backend(a.pid, 5000) as closed from pg_catalog.pg_stat_activity a where a.usename = 'still_qa_sandbox_writer' and a.pid <> pg_catalog.pg_backend_pid()) t;
