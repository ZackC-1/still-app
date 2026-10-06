-- Owner-approved operation resume-settings-sync (undoes pause-settings-sync).
--
-- still_settings_writer may sign in again with its existing password: NOLOGIN and LOGIN never touch
-- the password, so no secret changes and nothing is redeployed. No data, grant or other role
-- changes. Safe to repeat.
alter role still_settings_writer login;
