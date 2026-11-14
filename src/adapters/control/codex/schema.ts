import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlLaunch } from "../../../contracts/control.js";

/**
 * Version drift (research of 2026-11-14 §7): the methods and fields this driver relies on, checked against the installed Codex's own schema
 * (`codex app-server generate-json-schema --experimental`, about 80 ms) once per version in this Gateway process. A feature whose method or
 * field is missing is turned off with one diagnostic line; nothing is asked of the user. `core` is what nothing works without: it is reported,
 * never turned off.
 */
export type CodexFeature = "core" | "steer" | "collaborationMode" | "summary" | "serviceTierForTurn" | "approvalsReviewer" | "autoReview" | "sessionStartSource"
  | "unsubscribe" | "unarchive" | "turnsList";
interface Relied { readonly requests?: readonly string[]; readonly notifications?: readonly string[]; readonly fields?: readonly string[]; readonly values?: readonly string[] }
/** `fields` are `<Type>.<field>` of the v2 schema's definitions; `values` are `<Type>:<value>`, a value one of the type's enums lists. */
const RELIED: Readonly<Record<CodexFeature, Relied>> = {
  core: { requests: ["initialize", "thread/start", "thread/resume", "turn/start", "turn/interrupt", "config/read", "model/list"],
    notifications: ["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "thread/tokenUsage/updated", "serverRequest/resolved"],
    fields: ["TurnStartParams.clientUserMessageId", "TurnStartParams.effort", "TurnStartParams.model", "TurnStartParams.approvalPolicy", "ThreadStartParams.sandbox", "ThreadStartParams.config",
      "ThreadStartParams.developerInstructions", "InitializeCapabilities.optOutNotificationMethods"], values: ["AskForApproval:untrusted", "AskForApproval:on-request", "AskForApproval:never"] },
  steer: { requests: ["turn/steer"] },
  collaborationMode: { requests: ["collaborationMode/list"], fields: ["TurnStartParams.collaborationMode"] },
  summary: { fields: ["TurnStartParams.summary"] },
  serviceTierForTurn: { fields: ["TurnStartParams.serviceTierForTurn"] },
  approvalsReviewer: { fields: ["TurnStartParams.approvalsReviewer", "ThreadStartParams.approvalsReviewer", "ThreadResumeParams.approvalsReviewer"] },
  autoReview: { values: ["ApprovalsReviewer:auto_review"] },
  sessionStartSource: { fields: ["ThreadStartParams.sessionStartSource"] },
  unsubscribe: { requests: ["thread/unsubscribe"] },
  unarchive: { requests: ["thread/unarchive"] },
  turnsList: { requests: ["thread/turns/list"] },
};
export interface CodexSchemaCheck {
  /** Features whose methods or fields this Codex lacks. */
  readonly off: ReadonlySet<CodexFeature>;
  /** The one line said about it, when something is missing or the schema could not be read; null otherwise. */
  readonly diagnostic: string | null;
}
const ALL_ON: CodexSchemaCheck = { off: new Set(), diagnostic: null };
const checked = new Map<string, Promise<CodexSchemaCheck>>();
const SCHEMA_TIMEOUT_MS = 15_000;

/** The arguments that start this launch's app-server, up to and without `app-server` (a wrapper's own, or none); null when it does not start one. */
function prefix(launch: ControlLaunch): readonly string[] | null {
  const at = launch.args.indexOf("app-server");
  return at < 0 ? null : launch.args.slice(0, at);
}
/**
 * What this Codex lacks of what the driver relies on, read once per executable and version in this process. A launch that is not an app-server
 * command (a test peer) or a version not stated is not checked; neither is a schema that cannot be generated, which keeps every feature on and says so.
 */
export function checkSchema(launch: ControlLaunch, env: Readonly<Record<string, string>>, version: string | null): Promise<CodexSchemaCheck> {
  const head = prefix(launch);
  if (head === null || version === null) return Promise.resolve(ALL_ON);
  const key = JSON.stringify([launch.executable, head, version]);
  let check = checked.get(key);
  if (check === undefined) { check = generate(launch, head, env).then(dir => compare(dir), () => ({ off: new Set<CodexFeature>(), diagnostic: "没能读到 Codex " + version + " 的协议说明，按已知能力运行。" })); checked.set(key, check); }
  return check;
}
async function generate(launch: ControlLaunch, head: readonly string[], env: Readonly<Record<string, string>>): Promise<Schema> {
  const dir = await mkdtemp(join(tmpdir(), "harnesshub-codex-schema-"));
  try {
    await new Promise<void>((resolve, reject) => execFile(launch.executable, [...head, "app-server", "generate-json-schema", "--experimental", "--out", dir],
      { env: { ...env, ...launch.env }, timeout: SCHEMA_TIMEOUT_MS, maxBuffer: 1 << 20 }, error => error ? reject(error) : resolve()));
    const read = async (name: string) => JSON.parse(await readFile(join(dir, name), "utf8")) as unknown;
    return { client: methods(await read("ClientRequest.json")), server: methods(await read("ServerRequest.json")), notifications: methods(await read("ServerNotification.json")),
      definitions: definitions(await read("codex_app_server_protocol.v2.schemas.json")) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
interface Schema { readonly client: ReadonlySet<string>; readonly server: ReadonlySet<string>; readonly notifications: ReadonlySet<string>; readonly definitions: Readonly<Record<string, unknown>> }
const row = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** The method names of a request or notification union (`oneOf[].properties.method.enum[0]`). */
function methods(value: unknown): ReadonlySet<string> {
  const variants = Array.isArray(row(value)?.oneOf) ? row(value)!.oneOf as unknown[] : [];
  return new Set(variants.flatMap(variant => { const names = row(row(row(variant)?.properties)?.method)?.enum; return Array.isArray(names) && typeof names[0] === "string" ? [names[0]] : []; }));
}
function definitions(value: unknown): Readonly<Record<string, unknown>> { return row(row(value)?.definitions) ?? {}; }
/** Whether a schema node (its variants included) lists `value` in an enum. */
function lists(node: unknown, value: string, depth = 0): boolean {
  const here = row(node);
  if (here === null || depth > 8) return false;
  if (Array.isArray(here.enum) && here.enum.includes(value)) return true;
  return ["oneOf", "anyOf", "allOf"].some(key => Array.isArray(here[key]) && (here[key] as unknown[]).some(part => lists(part, value, depth + 1)));
}
function compare(schema: Schema): CodexSchemaCheck {
  const missing = (relied: Relied): string[] => [
    ...(relied.requests ?? []).filter(name => !schema.client.has(name)),
    ...(relied.notifications ?? []).filter(name => !schema.notifications.has(name)),
    ...(relied.fields ?? []).filter(field => { const [type, name] = field.split("."); return !Object.hasOwn(row(row(schema.definitions[type!])?.properties) ?? {}, name!); }),
    ...(relied.values ?? []).filter(entry => { const [type, value] = entry.split(":"); return !lists(schema.definitions[type!], value!); }),
  ];
  const off = new Set<CodexFeature>(), said: string[] = [];
  for (const [feature, relied] of Object.entries(RELIED) as [CodexFeature, Relied][]) {
    const gone = missing(relied);
    if (gone.length === 0) continue;
    if (feature !== "core") off.add(feature);
    said.push(feature + "（缺 " + gone.join("、") + "）");
  }
  return { off, diagnostic: said.length ? "这个版本的 Codex 少了 HarnessHub 用到的协议内容，相关功能已关闭：" + said.join("；") : null };
}
