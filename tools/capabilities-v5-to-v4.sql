-- Returns a capability database from schema v5 (ADR-045 step 5: HarnessHub's subagent list, and the kind of each
-- installed skill's source) to v4, so a build that knows the instructions but not subagents can open it again. v5 added
-- the subagents table and the skill_sources.kind column; a v4 reader rejects both, its page rejects the history entries of
-- subagent changes, and its drift check cannot read the ledger entries of subagent files or of the directories HarnessHub
-- created. This deletes all of them, and the records of skills HarnessHub wrote from the user's text (their folders stay
-- in ~/.agents/skills, then as the user's). Every other row is kept. The Harnesses' files stay as they are. Run it with
-- no Gateway owning the data directory: sqlite3 <data>/capabilities/capabilities.sqlite < this file. Continue with
-- capabilities-v4-to-v3.sql.
BEGIN IMMEDIATE;
DELETE FROM capability_changes WHERE json_extract(view_json, '$.kind') IN ('subagent-sync', 'subagent-remove', 'subagent-claim', 'skill-create');
DELETE FROM capability_ledger WHERE key LIKE 'subagent/%' OR key = 'dir/created';
DELETE FROM skill_sources WHERE kind = 'local';
ALTER TABLE skill_sources DROP COLUMN kind;
DROP TABLE subagents;
PRAGMA user_version = 4;
COMMIT;
