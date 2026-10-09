-- Owner-approved operation qa-sandbox-secrets, modes apply and rotate: sign-in for the three
-- function roles the sandbox QA functions use (scripts/backend/deploy/qa-secrets.mjs).
--
-- Each value is a SCRAM-SHA-256 verifier ("SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>")
-- computed on the runner from a password that exists only in runner memory. PostgreSQL stores a
-- pre-hashed verifier as given, so no plaintext password ever reaches the server or its logs.
--
-- The runner passes a verifier only through the psql process environment (never argv) and only
-- for the roles this run changes. \getenv leaves a variable unset when its environment variable
-- is absent, so \if skips that role. The runner wraps the file in one transaction
-- (--single-transaction) and never echoes statements (-q, no -a/-e). Requires psql 15 or newer.
--
-- Only LOGIN and the password change. No grant, membership, per-role setting or other role
-- changes; the runner compares every role's facts before and after.
\getenv qa_policy_reader_verifier STILL_QA_POLICY_READER_VERIFIER
\getenv qa_settings_writer_verifier STILL_QA_SETTINGS_WRITER_VERIFIER
\getenv qa_writer_verifier STILL_QA_WRITER_VERIFIER
\if :{?qa_policy_reader_verifier}
alter role still_policy_reader with login password :'qa_policy_reader_verifier';
\endif
\if :{?qa_settings_writer_verifier}
alter role still_settings_writer with login password :'qa_settings_writer_verifier';
\endif
\if :{?qa_writer_verifier}
alter role still_qa_sandbox_writer with login password :'qa_writer_verifier';
\endif
