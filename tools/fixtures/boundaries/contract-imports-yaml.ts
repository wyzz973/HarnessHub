// Invalid sample for B3 and B10: the published contracts and where third-party packages may appear. The format is described in
// README.md. This file is never compiled, and the repository check does not scan tools/.

// @@ file: src/contracts/leak.ts
import YAML from "yaml"; // expect: B3, B10
import { readFileSync } from "node:fs"; // expect: B3
import type { Readable } from "node:stream"; // expect: B3
import type { SqliteSessionStore } from "../infrastructure/session/sqlite-store.js"; // expect: B3
import type { SessionState } from "../contexts/session/domain/state.js"; // expect: B3
import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js"; // expect: B3
import { sessionId } from "./session.js";
import type { ProviderId } from "./provider.js";
export { readFileSync as read } from "node:fs"; // expect: B3
export type { Readable as Stream } from "node:stream"; // expect: B3
export * from "yaml"; // expect: B3, B10
export type Hidden = import("../infrastructure/session/sqlite-store.js").SqliteSessionStore; // expect: B3
export type Visible = import("./session.js").SessionId;

export const leak = { YAML, readFileSync, sessionId };
export type Leak = [Readable, SqliteSessionStore, SessionState, ResolvedCommand, ProviderId];

// @@ file: src/cli/leak.ts
import YAML from "yaml"; // expect: B10
import { parse } from "jsonc-parser"; // expect: B10
import { readFileSync } from "node:fs";
import { application } from "./session-application.js";

export const leak = { YAML, parse, readFileSync, application };

// @@ file: src/web/leak.ts
import { gunzipSync } from "node:zlib";
import semver from "semver"; // expect: B10
import { startWebServer } from "./server.js";

export const leak = { gunzipSync, semver, startWebServer };

// @@ file: src/infrastructure/leak.ts
import leftPad from "left-pad"; // expect: B10
import { DatabaseSync } from "node:sqlite";
import semver from "semver";
import { parse } from "yaml";
import { extract } from "tar";

export const leak = { leftPad, DatabaseSync, semver, parse, extract };

// @@ file: src/adapters/leak.ts
import JSON5 from "json5";
import { Octokit } from "@octokit/rest"; // expect: B10
import { open } from "../infrastructure/session/sqlite-store.js";

export const leak = { JSON5, Octokit, open };
