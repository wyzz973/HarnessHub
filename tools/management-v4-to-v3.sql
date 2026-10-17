-- Returns a management database from schema v4 (ADR-044) to v3, so a build from before ADR-044 can open it again.
-- v4 added uninstall jobs and the frozen installation each one removed; a v3 reader rejects both. This deletes every
-- uninstall job with its logs and its frozen target, then the targets table, and keeps every other row as it is.
-- What is lost: the record of every uninstall (which installation, which services were stopped, whether removal was
-- verified, and its logs). The programs it removed stay removed; nothing on disk changes.
-- Run it with no Gateway owning the data directory: sqlite3 <data>/management/management.sqlite < this file.
BEGIN IMMEDIATE;
DELETE FROM management_logs WHERE job_id IN (SELECT id FROM management_jobs WHERE json_extract(view_json, '$.action') = 'uninstall');
DELETE FROM management_commands WHERE job_id IN (SELECT id FROM management_jobs WHERE json_extract(view_json, '$.action') = 'uninstall');
DELETE FROM management_installation_targets;
DELETE FROM management_jobs WHERE json_extract(view_json, '$.action') = 'uninstall';
DROP TABLE management_installation_targets;
PRAGMA user_version = 3;
COMMIT;
