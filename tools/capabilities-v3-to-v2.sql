-- Returns a capability database from schema v3 (ADR-045 step 3: HarnessHub's MCP list) to v2, so a build that only knows
-- skills can open it again. v3 added the MCP list; a v2 reader rejects the table, its page rejects the history entries of
-- MCP changes, and its drift check cannot read the ledger entries of MCP servers. This deletes all three and keeps every
-- other row. What is lost: the MCP list, the history of writing its servers into Harnesses, and the record of which of
-- those entries HarnessHub wrote. The Harnesses' files stay as they are. Run it with no Gateway owning the data
-- directory: sqlite3 <data>/capabilities/capabilities.sqlite < this file. Continue with capabilities-v2-to-v1.sql.
BEGIN IMMEDIATE;
DELETE FROM capability_changes WHERE json_extract(view_json, '$.kind') IN ('mcp-sync', 'mcp-remove', 'mcp-claim');
DELETE FROM capability_ledger WHERE key LIKE 'mcp/%';
DROP TABLE mcp_servers;
PRAGMA user_version = 2;
COMMIT;
