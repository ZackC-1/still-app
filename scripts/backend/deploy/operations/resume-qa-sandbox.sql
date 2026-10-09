-- Owner-approved operation resume-qa-sandbox (undoes pause-qa-sandbox).
--
-- still_qa_sandbox_writer may sign in again with its existing password: NOLOGIN and LOGIN never
-- touch the password, so no secret changes and nothing is redeployed. No data, grant or other role
-- changes. Safe to repeat.
alter role still_qa_sandbox_writer login;
