// Invalid sample for B11 and B12: who may read a whole conversation in the old shape. The format is described in README.md. This file is never compiled, and the repository check does not scan tools/.

// @@ file: src/web/export-leak.ts
import { snapshotFromRows } from "../infrastructure/session/snapshot-adapter.js"; // expect: B11
import type { SessionSnapshot } from "../contracts/session.js";
import { ConversationTables } from "../infrastructure/session/read.js";

export const leak = (store: { snapshot(id: string): SessionSnapshot }, tables: ConversationTables, db: never, id: string) => [store.snapshot(id), snapshotFromRows, tables]; // expect: B12

// @@ file: src/cli/leak.ts
export function leak(app: { store: { snapshot(id: string): unknown } }, id: string): unknown {
  return app.store.snapshot(id); // expect: B12
}
export function leakAgain(store: { snapshot(id: string): unknown }, id: string): unknown {
  const read = store["snapshot"](id); // expect: B12
  return (store as { snapshot(id: string): unknown }).snapshot(id) ?? read; // expect: B12
}

// @@ file: src/web/session-stream.ts
// A `snapshot` that is not the store's (a stream hub's, a source's) is no old-shape read.
export class Hub {
  constructor(private readonly source: { snapshot(id: string): unknown }, private readonly hub: { snapshot(id: string): unknown }) {}
  snapshot(id: string): unknown { return this.source.snapshot(id) ?? this.hub.snapshot(id) ?? this.snapshot(id); }
}

// @@ file: tests/integration/reads-the-old-shape.test.ts
import { snapshotFromRows } from "../../src/infrastructure/session/snapshot-adapter.js";

export const fine = (store: { snapshot(id: string): unknown }, id: string) => [store.snapshot(id), snapshotFromRows];
