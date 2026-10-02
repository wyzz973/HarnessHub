import { DatabaseSync } from "node:sqlite";

/** Read only override identities for release/console conflict checks; never create or migrate a database. */
export function readReleaseOverrides(database: string): {
  engineIds: string[];
  hasDefault: boolean;
} {
  const connection = new DatabaseSync(database, { readOnly: true });
  try {
    const row = connection
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'engine_catalog'",
      )
      .get();
    if (!row) return { engineIds: [], hasDefault: false };
    if (typeof row.value !== "string")
      throw new Error("Invalid stored engine catalog");
    const value: unknown = JSON.parse(row.value);
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      (value.version !== 1 && value.version !== 2) ||
      !("overrides" in value) ||
      !Array.isArray(value.overrides) ||
      !("defaultOverride" in value) ||
      !(
        value.defaultOverride === null ||
        typeof value.defaultOverride === "string"
      )
    )
      throw new Error("Invalid stored engine catalog");
    const engineIds = value.overrides.map((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("id" in entry) ||
        typeof entry.id !== "string"
      )
        throw new Error("Invalid stored engine override");
      return entry.id;
    });
    return { engineIds, hasDefault: value.defaultOverride !== null };
  } finally {
    connection.close();
  }
}
