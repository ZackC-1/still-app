-- Owner-approved operation pause-qa-sandbox (the emergency stop for the paid QA sandbox lane).
--
-- Every paid qa-sandbox-* function reaches the database only as still_qa_sandbox_writer. After this
-- runs, that role cannot sign in, so every paid QA request answers "unavailable" at once. Free
-- settings sync, the live functions and real customers are unaffected (other roles). No data,
-- grant, password or other role changes. Resume with resume-qa-sandbox. Safe to repeat.
--
-- The runner executes the two statements in order, each committed on its own (no surrounding
-- transaction): the login is switched off first, so nothing can reconnect after step 2.
alter role still_qa_sandbox_writer nologin;
-- Step 2: close the role's connections that are already open (a connection pooler keeps them
-- across NOLOGIN). Waits up to 5 seconds for each one to end. Prints counts only.
select pg_catalog.json_build_object('closed', pg_catalog.count(*) filter (where t.closed), 'remaining', pg_catalog.count(*) filter (where not t.closed))::text from (select pg_catalog.pg_terminate_backend(a.pid, 5000) as closed from pg_catalog.pg_stat_activity a where a.usename = 'still_qa_sandbox_writer' and a.pid <> pg_catalog.pg_backend_pid()) t;
