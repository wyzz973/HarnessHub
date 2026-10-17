-- Returns a management database from schema v6 (ADR-044, upgrades of one installation) to v5, so a build that only knows
-- official installs can open it again. v6 added upgrade jobs of one installation through its channel and the upgrade each
-- one froze; a v5 reader rejects both. This deletes every such job with its logs and frozen request, then the table, and
-- keeps every other row. What is lost: the record of those upgrades (which installation, the versions before and after,
-- what they changed). The programs stay as they were upgraded. Run it with no Gateway owning the data directory:
-- sqlite3 <data>/management/management.sqlite < this file. Continue with management-v5-to-v4.sql to go further back.
BEGIN IMMEDIATE;
DELETE FROM management_logs WHERE job_id IN (SELECT id FROM management_jobs WHERE json_type(view_json, '$.native.installation') = 'object');
DELETE FROM management_commands WHERE job_id IN (SELECT id FROM management_jobs WHERE json_type(view_json, '$.native.installation') = 'object');
DELETE FROM management_installation_upgrades;
DELETE FROM management_jobs WHERE json_type(view_json, '$.native.installation') = 'object';
DROP TABLE management_installation_upgrades;
PRAGMA user_version = 5;
COMMIT;
