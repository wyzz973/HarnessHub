-- Returns a capability database from schema v2 (ADR-045 step 2: adding, updating and deleting skills) to v1, so a build
-- that only knows skill switches, placement and link cleanup can open it again. v2 added the record of the skills
-- HarnessHub installed from a repository; a v1 reader rejects the table, and its page rejects the history entries of
-- those changes. This deletes both and keeps every other row. What is lost: where those skills came from and the
-- history of adding, updating and deleting them (and with it their undo). The skill folders, links and lock entries stay
-- as they are; the snapshots under capabilities/skills/ are no longer used and can be removed by hand. Run it with no
-- Gateway owning the data directory: sqlite3 <data>/capabilities/capabilities.sqlite < this file.
BEGIN IMMEDIATE;
DELETE FROM capability_changes WHERE json_extract(view_json, '$.kind') IN ('skill-add', 'skill-update', 'skill-delete', 'skill-undo');
DROP TABLE skill_sources;
DROP TABLE skill_undo;
PRAGMA user_version = 1;
COMMIT;
