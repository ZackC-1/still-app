-- Owner-approved operation analytics-erasure-schedule, policy_mode disable
-- (scripts/backend/deploy/analytics-subjects.mjs): stop the scheduled analytics-erasure worker.
--
-- Removes only the pg_cron job still-analytics-erasure-worker. Queued deletions stay queued and are
-- worked when the schedule is enabled again; pg_net, the Vault token and every secret are kept.
-- Safe to repeat: with no such job this changes nothing.
select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'still-analytics-erasure-worker';
