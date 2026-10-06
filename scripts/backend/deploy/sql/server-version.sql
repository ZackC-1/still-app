-- Read-only. One row, one column: the server's numeric version (e.g. 170006 for 17.6).
-- The owner-approved operations refuse before any write below 160000 (PostgreSQL 16).
select pg_catalog.current_setting('server_version_num');
