// Invalid sample for B5, B6 and B7: who may import the web client, the entry points and the tests. The format is described in
// README.md. This file is never compiled, and the repository check does not scan tools/.

// @@ file: web/src/components/Leak.tsx
import { SqliteSessionStore } from "../../../src/infrastructure/session/sqlite-store.js"; // expect: B6
import { startWebServer } from "../../../src/web/server.js"; // expect: B6
import { readFileSync } from "node:fs"; // expect: B6
import { createRequire } from "node:module"; // expect: B6
import type { SessionSnapshot } from "../../../src/contracts/session.js";
import { Check } from "lucide-react";
import { cn } from "../lib/cn.js";

export const Leak = () => <Check className={cn("a")} data-store={SqliteSessionStore} data-server={startWebServer} data-read={readFileSync} data-require={createRequire} data-snapshot={undefined as SessionSnapshot | undefined} />;

// @@ file: web/src/api.ts
import type { SessionSnapshot } from "../../src/contracts/session.js";
import { goes } from "../../tests/fixtures/capability-home.js"; // expect: B6
import data from "../../package.json"; // expect: B6

export const leak = [goes, data] as [unknown, unknown, SessionSnapshot?];

// @@ file: src/adapters/control/leak.ts
import { startWebServer } from "../../web/server.js"; // expect: B5
import { main } from "../../cli/chat.js"; // expect: B5
import type { WebServer } from "../../web/server.js"; // expect: B5
import { LocalExecutableLocator } from "../../infrastructure/discovery/local.js";
import type { ControlSession } from "../../contracts/control.js";

export const leak = { startWebServer, main, LocalExecutableLocator };
export type Leak = [WebServer, ControlSession];

// @@ file: src/cli/leak.ts
import { fixture } from "../../tests/fixtures/capability-home.js"; // expect: B7
import { App } from "../../web/src/App.js"; // expect: B7
import "../../web/src/styles.css"; // expect: B7
import { startWebServer } from "../web/server.js";
import { application } from "./session-application.js";

export const leak = { fixture, App, startWebServer, application };
