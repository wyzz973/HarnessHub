-- Returns a management database from schema v3 (ADR-043) to v2, so a build from before ADR-043 can open it again.
-- v3 changed no table: only an upgrade job's facts may carry its restart consent and results, which a v2 reader rejects.
-- This strips those five fields from every job and keeps every row; nothing else is touched. What is lost: the services
-- the user agreed to restart, each restarted service's outcome, how many idle processes and left-over usage records the
-- upgrade handled, and whether a restarted service rewrote its configuration. Each job's logs still say all of it.
-- Run it with no Gateway owning the data directory: sqlite3 <data>/management/management.sqlite < this file.
BEGIN IMMEDIATE;
UPDATE management_jobs
  SET view_json = json_remove(view_json, '$.native.restartServices', '$.native.closedConversations', '$.native.clearedRecords', '$.native.services', '$.native.configurationChangedByService')
  WHERE json_type(view_json, '$.native') = 'object';
PRAGMA user_version = 2;
COMMIT;
