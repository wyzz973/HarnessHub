// Invalid sample for B1, B2 and B4: the layers inside the bounded contexts. The format is described in README.md. This file is
// never compiled, and the repository check does not scan tools/.

// @@ file: src/contexts/session/domain/leak.ts
import { spawn } from "node:child_process"; // expect: B1
import { readFileSync } from "node:fs"; // expect: B1
import { writeFileSync } from "fs"; // expect: B1
import { readFile } from "fs/promises"; // expect: B1
import { posix } from "path/posix";
import { DatabaseSync } from "node:sqlite"; // expect: B1
import YAML from "yaml"; // expect: B1, B10
import { Runtime } from "../application/runtime.js"; // expect: B1
import type { SqliteSessionStore } from "../../../infrastructure/session/sqlite-store.js"; // expect: B1
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SessionId } from "../../../contracts/session.js";
import { reduce } from "./state.js";

export const leak = { spawn, readFileSync, writeFileSync, readFile, posix, DatabaseSync, YAML, Runtime, createHash, join, reduce };
export type Leak = [SqliteSessionStore, SessionId];

// @@ file: src/contexts/session/application/leak.ts
import { spawn } from "node:child_process"; // expect: B2
import { createServer } from "node:http"; // expect: B2
import { open } from "../../../infrastructure/session/sqlite-store.js"; // expect: B2
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { SessionId } from "../../../contracts/session.js";
import { reduce } from "../domain/state.js";

export const leak = { spawn, createServer, open, EventEmitter, performance, reduce };
export type Leak = SessionId;

// @@ file: src/contexts/catalog/domain/leak.ts
import type { SessionState } from "../../session/domain/state.js"; // expect: B4
import type { Provider } from "../../provider/domain/provider.js"; // expect: B4
import { parse } from "./catalog-parser.js";

export type Leak = [SessionState, Provider, typeof parse];

// @@ file: src/contexts/catalog/application/leak.ts
import { reduce } from "../../session/domain/state.js"; // expect: B4
import { parse } from "../domain/catalog-parser.js";

export const leak = [reduce, parse];
