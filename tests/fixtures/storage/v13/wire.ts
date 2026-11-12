import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { application } from "../../../../src/cli/session-application.js";
import { sessionId } from "../../../../src/contracts/session.js";
import { prepareConfiguration } from "../../../../src/infrastructure/session/binding-factory.js";
import { MemoryTableGrants } from "../../../../src/infrastructure/session/table-grants.js";
import { startWebServer } from "../../../../src/web/server.js";
import { loadV13Fixture, writeV13Root, type V13FixtureName } from "./database.js";

/*
 * What the whole application says over HTTP of the conversations of a frozen v13 fixture, as digests: the list, the readiness, and for each conversation its view, its
 * export (Markdown and JSON), its event log, its handoff view and the text of each handoff packet, and the context table's directory, Turns and search.
 *
 * It is written to run against two builds with the same text. `wire-golden.json` holds what the build BEFORE the cut (the store of snapshots, `SqliteSessionStore`)
 * said of every fixture, made by running this file there (generate-wire.mjs); `tests/integration/cut-wire.test.ts` runs it on the current build and holds the digests
 * to those. So it uses only what both builds have: `application`, `startWebServer`, `MemoryTableGrants`, `prepareConfiguration`, and the fixtures' own reader.
 *
 * Two things the build before the cut said are no longer said by this build, because their shapes were replaced (ADR-057 3.4): the list of conversations (`GET /sessions`, a bare array;
 * now a page, `{ sessions, next }`, whose `sessions` are what `state.sessions` holds) and the conversation's view (`GET /sessions/:id`, whole; now its head and its newest Turns). They stay in
 * `wire-golden.json` as the build before the cut gave them and are not read here; `readsOfFixture` reads the new shapes whole, and `cut-wire.test.ts` holds them to what the golden's
 * export says of the same conversation (the export is the old view's facts, pinned by the golden).
 *
 * What is not compared, because it is not the same by design: the conversation's `version` (the tables' conversion is a commit the old store never made), the time the
 * application started at (the recovery of the two fixtures an owner left unfinished writes it, and the export says when it was made), and the ORDER of the conversations in
 * the list (the old store listed them by creation, the tables list the one updated last first: ADR-057's list index; a list is compared as the set it holds, by identity).
 * Every number and every ISO date within a minute of the run is written `<now>`; every JSON is written with its keys in order (the order an object is built in is no part of
 * what it says).
 */

export interface WireDigest { readonly sha256: string; readonly bytes: number }
export type Wire = Readonly<Record<string, WireDigest>>;
export type WireGolden = Readonly<Record<string, Wire>>;

/** The fixtures that are run: all but the one that records a kept process, which this application would try to end by its recorded group on its start. */
export const WIRE_FIXTURES: readonly V13FixtureName[] = [
  "switches", "relay-states", "commands", "branch", "branch-pending", "import", "tools", "text-extremes", "at-the-old-limits", "unknown-recovered", "unknown-acknowledged",
  "running-crash", "recovered-after-crash", "waiting-crash", "recovered-after-waiting-crash", "trial-2026-11-11",
  "from-v12-d1", "from-v12-dispatch-failed", "from-v12-insert-rejected", "from-v12-import", "from-v12-branch", "from-v12-clear", "from-v12-reset-d1",
];

const WINDOW_MS = 60_000;
function digestOf(text: string): WireDigest { return { sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) }; }
/** WIRE_DUMP=<directory> keeps the text each digest is of, one file a key, for whoever reads a difference (diff the two builds' directories). */
async function keep(fixture: string, key: string, text: string): Promise<void> {
  const where = process.env.WIRE_DUMP;
  if (where === undefined || where === "") return;
  const directory = join(where, fixture); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, key.replace(/[^A-Za-z0-9._-]+/gu, "_") + ".txt"), text);
}

/** Keys in order, and the application's start written `<now>`. */
function settled(value: unknown, window: { readonly from: number; readonly to: number }): unknown {
  if (typeof value === "number") return value >= window.from && value <= window.to ? "<now>" : value;
  if (typeof value === "string") { const time = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(value) ? Date.parse(value) : NaN; return time >= window.from && time <= window.to ? "<now>" : value; }
  if (Array.isArray(value)) return value.map(entry => settled(entry, window));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, entry]) => [name, settled(entry, window)]));
  }
  return value;
}

type Application = ReturnType<typeof application>;
/**
 * What a run of this file may be told, for a build whose readers have moved (tests/integration/cut-wire-rows.test.ts): where the context table is read from instead of the web server
 * (a mount of the table over the application's store, which reads rows), and what is edited of a table answer before it is digested. The build before the cut is run without any.
 */
export interface WireOptions {
  readonly table?: (app: Application, grants: MemoryTableGrants) => Promise<{ readonly origin: string; close(): Promise<void> }>;
  readonly editTable?: (kind: "turns" | "turn" | "search", value: Record<string, unknown>) => void;
  /** The `limit` a context-table search is asked with; 10 when absent. */
  readonly searchLimit?: number;
  /** The conversation's export as Markdown, written by a reader of rows instead of asked of the web server. */
  readonly markdown?: (app: Application, root: string, id: string, exportedAt: Date) => Promise<string>;
  /** What is edited of the Markdown export, however it was made, before it is digested. */
  readonly editMarkdown?: (text: string) => string;
}
/** What a body gets of the application started on a fixture: how to read it as a page, and as a Harness's tool process would; the application itself and its data root. */
export interface Running {
  readonly fixture: ReturnType<typeof loadV13Fixture>;
  readonly origin: string;
  readonly window: { readonly from: number; readonly to: number };
  readonly grants: MemoryTableGrants;
  readonly read: (path: string) => Promise<Reply>;
  readonly table: (path: string, bearer: string) => Promise<Reply>;
  readonly app: Application;
  readonly data: string;
}
export interface Reply { readonly status: number; readonly text: string }

/** Runs the application on the fixture's data root and gives `body` what it needs to read it. Nothing outside a temporary directory is touched. */
export async function withApplication<T>(name: V13FixtureName, body: (running: Running) => Promise<T>, options: Pick<WireOptions, "table"> = {}): Promise<T> {
  const fixture = loadV13Fixture(name), scratch = await mkdtemp(join(tmpdir(), "wire-v13-"));
  const workspace = join(scratch, "workspace"), assets = join(scratch, "assets"), manifest = join(scratch, "catalog.json"), home = join(scratch, "home"), locks = join(scratch, "locks"), data = join(scratch, "data");
  const started = Date.now(), window = { from: started - WINDOW_MS, to: started + 10 * WINDOW_MS };
  let gateway: Awaited<ReturnType<typeof startWebServer>> | undefined, running: Application | undefined, mount: { close(): Promise<void> } | undefined;
  try {
    for (const directory of [workspace, assets, home]) await mkdir(directory);
    await writeFile(join(assets, "index.html"), "<!doctype html><title>wire fixture</title>");
    const source = { repository: "fixture", revision: "wire", upstreamId: "peer", url: "https://example.invalid/wire-peer" };
    const definitions = [{ id: "wire-a", name: "Wire fixture", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "wire-a-control", protocol: "codex-app-server", executableNames: ["fixture-peer"], args: [], env: {}, requiredExecutables: [], package: null, distribution: null, source }] }];
    await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: { "wire-a-control": { executable: process.execPath } } }));
    writeV13Root(data, [fixture]);
    const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
    // A private home and system root, so that nothing of the machine's own Harness configuration is read.
    const nativeEnvironment = { home, values: { HOME: home, PATH: dirname(process.execPath) + ":/usr/bin:/bin" }, system: join(scratch, "system") };
    const grants = new MemoryTableGrants();
    gateway = await startWebServer({ installations: "any", root: data, configuration, port: 0, assetsDirectory: assets, workspaceLockRoot: locks,
      application: (root, publish) => { running = application(root, publish, { workspaceLockRoot: locks, installations: "any", nativeEnvironment, tableGrants: grants }); return running; } });
    const parsed = new URL(gateway.url), origin = parsed.origin, token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
    const login = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (login.status !== 200) throw new Error("the login of the fixture's application failed: " + login.status);
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    // WIRE_TRACE=1 says on stderr what each request got (its status and the start of the answer), for whoever reads a difference.
    const trace = (path: string, reply: Reply): Reply => { if (process.env.WIRE_TRACE) process.stderr.write(reply.status + " " + path.slice(0, 90).padEnd(90) + " " + reply.text.slice(0, 70).replace(/\s+/gu, " ") + "\n"); return reply; };
    const read = async (path: string): Promise<Reply> => { const response = await fetch(origin + path, { headers: { Cookie: cookie, Origin: origin } }); return trace(path, { status: response.status, text: await response.text() }); };
    const mounted = options.table === undefined ? undefined : await options.table(running!, grants);
    mount = mounted;
    const table = async (path: string, bearer: string): Promise<Reply> => { const response = await fetch((mounted?.origin ?? origin) + path, { headers: { Authorization: "Bearer " + bearer } }); return trace(path, { status: response.status, text: await response.text() }); };
    return await body({ fixture, origin, window, grants, read, table, app: running!, data });
  } finally {
    try { await mount?.close(); } finally { try { await gateway?.close(); } finally { await rm(scratch, { recursive: true, force: true }); } }
  }
}

/** What the application says over HTTP of a fixture's conversations, as digests (the stable keys; see above). */
export async function wireOfFixture(name: V13FixtureName, options: WireOptions = {}): Promise<Wire> {
  return withApplication(name, async ({ fixture, window, read, table, grants, app, data }) => {
    const wire: Record<string, WireDigest> = {};
    const note = (key: string, text: string): void => { wire[key] = digestOf(text); pending.push(keep(name, key, text)); };
    const pending: Promise<void>[] = [];
    /** A JSON answer, settled; `edit` leaves out what is not the same by design. */
    const json = (key: string, reply: Reply, edit: (value: Record<string, unknown>) => void = () => {}): void => {
      let value: unknown; try { value = JSON.parse(reply.text); } catch { value = reply.text; }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) edit(value as Record<string, unknown>);
      note(key, reply.status + " " + JSON.stringify(settled(value, window)));
    };
    // The lists, by identity (see above).
    const byIdentity = (key: (entry: Record<string, unknown>) => string) => (list: unknown): unknown => Array.isArray(list) ? [...list].sort((left, right) => { const a = key(left as Record<string, unknown>), b = key(right as Record<string, unknown>); return a < b ? -1 : a > b ? 1 : 0; }) : list;
    const byId = byIdentity(entry => String(entry.id)), byControl = byIdentity(entry => String(entry.harnessId) + "/" + String(entry.controlId));
    const state = JSON.parse((await read("/api/v1/state")).text) as { readonly sessions: unknown; readonly readiness: unknown };
    note("state.sessions", JSON.stringify(settled(byId(state.sessions), window)));
    note("state.readiness", JSON.stringify(settled(byControl(state.readiness), window)));
    const readiness = await read("/api/v1/harnesses/readiness");
    note("readiness", readiness.status + " " + JSON.stringify(settled(byControl((JSON.parse(readiness.text) as { readonly readiness: unknown }).readiness), window)));

    for (const row of fixture.sessions) {
      const id = row.id, base = "/api/v1/sessions/" + id;
      const markdown = options.markdown === undefined ? await read(base + "/export?format=markdown") : { status: 200, text: await options.markdown(app, data, id, new Date()) };
      note(id + " export.md", markdown.status + " " + (options.editMarkdown?.(markdown.text) ?? markdown.text).split("\n").filter(line => !line.startsWith("- 导出时间：")).join("\n"));
      json(id + " export.json", await read(base + "/export?format=json"), value => { delete value.exportedAt; const exported = value.session; if (exported !== null && typeof exported === "object") delete (exported as Record<string, unknown>).version; });
      // The event log, a page at a time.
      const events: unknown[] = [];
      for (let after = 0; ;) {
        const page = JSON.parse((await read(base + "/events?afterSeq=" + after + "&limit=100")).text) as { readonly events: readonly unknown[]; readonly nextSeq: number; readonly hasMore: boolean };
        events.push(...page.events);
        if (!page.hasMore || page.events.length === 0) break;
        after = page.nextSeq;
      }
      note(id + " events", JSON.stringify(settled(events, window)));
      // The handoff: the relay view of the conversation and the text of each packet it shows.
      const relay = await read(base + "/relay");
      json(id + " relay", relay);
      const packets = (JSON.parse(relay.text) as { readonly packets?: readonly { readonly packetId: string }[] }).packets ?? [];
      for (const packet of packets) json(id + " relay " + packet.packetId, await read(base + "/relay/" + packet.packetId));
      // The context table, as the tool process of a Harness running a Turn of this conversation reads it.
      const grant = grants.mint({ sessionId: sessionId(id), harnessId: "wire-a", controlId: "wire-a-control" });
      const directory = await table("/api/table/turns?limit=100", grant);
      json(id + " table turns", directory, value => options.editTable?.("turns", value));
      const total = (JSON.parse(directory.text) as { readonly total?: number }).total ?? 0;
      const numbers = [...new Set([...Array.from({ length: Math.min(total, 6) }, (_, index) => index + 1), ...(total > 6 ? [total] : [])])];
      for (const n of numbers) for (const part of ["overview", "user", "reply", "tools", "files", "plan"]) json(id + " table turn " + n + " " + part, await table("/api/table/turns/" + n + "?part=" + part, grant), value => options.editTable?.("turn", value));
      for (const words of ["run", "的"]) json(id + " table search " + words, await table("/api/table/search?limit=" + (options.searchLimit ?? 10) + "&q=" + encodeURIComponent(words), grant), value => options.editTable?.("search", value));
    }
    await Promise.all(pending);
    return wire;
  }, options);
}

/** Every fixture that is run, or the ones named. */
export async function wireOfAll(names: readonly V13FixtureName[] = WIRE_FIXTURES): Promise<WireGolden> {
  const result: Record<string, Wire> = {};
  for (const name of names) result[name] = await wireOfFixture(name);
  return result;
}
