-- Returns a capability database from schema v4 (ADR-045 step 4: HarnessHub's instructions) to v3, so a build that only
-- knows skills and the MCP list can open it again. v4 added the instruction texts; a v3 reader rejects the table, its page
-- rejects the history entries of instruction changes, and its drift check cannot read the ledger entries of instruction
-- blocks or of the files HarnessHub created (`file/created`, DeepSeek Harness's patch file). This deletes all of them and
-- keeps every other row. What is lost: the shared text and each Harness's addition, the history of writing them into
-- Harnesses, the record of which blocks HarnessHub wrote, and that it created the patch file (a v3 build leaves `[]` in it
-- when its last server goes). The Harnesses' files stay as they are, blocks included. Run it with no Gateway owning the
-- data directory:
-- sqlite3 <data>/capabilities/capabilities.sqlite < this file. Continue with capabilities-v3-to-v2.sql.
BEGIN IMMEDIATE;
DELETE FROM capability_changes WHERE json_extract(view_json, '$.kind') IN ('instructions-sync', 'instructions-remove', 'instructions-claim');
DELETE FROM capability_ledger WHERE key LIKE 'instructions/%' OR key LIKE 'file/%';
DROP TABLE instruction_texts;
PRAGMA user_version = 3;
COMMIT;
