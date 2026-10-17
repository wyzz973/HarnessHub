-- Returns a management database from schema v5 (ADR-044, official installs) to v4, so a build that only knows uninstall
-- jobs can open it again. v5 added official install jobs and the install each one froze; a v4 reader rejects both. This
-- deletes every official install job with its logs and its frozen request, then the requests table, and keeps every
-- other row. What is lost: the record of each official install (source, SHA-256, what it changed). The programs it
-- installed stay installed. Run it with no Gateway owning the data directory:
-- sqlite3 <data>/management/management.sqlite < this file. Continue with management-v4-to-v3.sql to go further back.
BEGIN IMMEDIATE;
DELETE FROM management_logs WHERE job_id IN (SELECT id FROM management_jobs WHERE json_type(view_json, '$.native.official') = 'object');
DELETE FROM management_commands WHERE job_id IN (SELECT id FROM management_jobs WHERE json_type(view_json, '$.native.official') = 'object');
DELETE FROM management_install_requests;
DELETE FROM management_jobs WHERE json_type(view_json, '$.native.official') = 'object';
DROP TABLE management_install_requests;
PRAGMA user_version = 4;
COMMIT;
