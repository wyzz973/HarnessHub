import type { Row } from "./http.js";

/**
 * Version drift (research of 2026-11-14 §7): the operations, request fields and event types this driver relies on, checked against the installed
 * server's own `/openapi.json` once per executable and version in this process (its `info.version` is "0.0.1" in every build, so the server's version
 * names it). A feature whose operation, field or event is missing is turned off with one diagnostic line; nothing is asked of the user, nothing is
 * refused. `core` is what nothing works without: it is reported, never turned off.
 */
export type OpenCodeFeature = "core" | "steer" | "inbox" | "rules" | "agent" | "model" | "title" | "instructions" | "mcp" | "compact" | "command" | "revert" | "fork" | "move"
  | "diff" | "forms" | "permissions" | "active" | "sessions";
interface Relied {
  /** Operation ids. */
  readonly operations?: readonly string[];
  /** `<operationId>.<field>` of a request body. */
  readonly fields?: readonly string[];
  /** `<operationId>.<field>:<value>`, a value the field's enum lists. */
  readonly values?: readonly string[];
  /** Event types `event.subscribe` lists. */
  readonly events?: readonly string[];
}
const RELIED: Readonly<Record<OpenCodeFeature, Relied>> = {
  core: { operations: ["server.info", "event.subscribe", "session.create", "session.get", "session.prompt", "session.interrupt", "session.message.list", "model.list", "session.permission.reply"],
    fields: ["session.create.location", "session.create.model", "session.prompt.id", "session.prompt.text", "session.prompt.files", "session.permission.reply.decision"],
    events: ["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.text.delta", "session.text.ended",
      "session.reasoning.delta", "session.tool.called", "session.tool.success", "session.tool.failed", "session.step.ended", "permission.asked", "permission.replied"] },
  steer: { fields: ["session.prompt.delivery"], values: ["session.prompt.delivery:steer"] },
  inbox: { operations: ["session.inbox.cancel", "session.inbox.list"], events: ["session.inbox.delivered", "session.inbox.cancelled"] },
  rules: { operations: ["session.update"], fields: ["session.create.permissions", "session.update.permissions"] },
  agent: { operations: ["session.switchAgent", "agent.list"], fields: ["session.create.agent"] },
  model: { operations: ["session.switchModel", "model.default"] },
  title: { operations: ["session.update"], fields: ["session.update.title"] },
  instructions: { operations: ["experimental.session.instructions.entry.put"] },
  mcp: { operations: ["experimental.mcp.add", "experimental.mcp.remove"] },
  compact: { operations: ["session.compact"], fields: ["session.compact.id"], events: ["session.compaction.started", "session.compaction.ended"] },
  command: { operations: ["session.command", "command.list"] },
  revert: { operations: ["session.revert.stage", "session.revert.commit", "session.revert.clear"], fields: ["session.revert.stage.messageID", "session.revert.stage.files"] },
  fork: { operations: ["session.fork"] },
  move: { operations: ["session.move"] },
  diff: { operations: ["session.diff"] },
  forms: { operations: ["session.form.reply", "session.form.cancel", "session.form.list"], events: ["form.created"] },
  permissions: { operations: ["session.permission.list"] },
  active: { operations: ["session.active"] },
  sessions: { operations: ["session.list", "session.remove"] },
};
export interface OpenCodeSchemaCheck {
  readonly off: ReadonlySet<OpenCodeFeature>;
  /** The one line said about it, when something is missing or the document could not be read; null otherwise. */
  readonly diagnostic: string | null;
}
const checked = new Map<string, OpenCodeSchemaCheck>();

/** What this server lacks of what the driver relies on, from its `/openapi.json` (`doc`; null when it could not be read), once per `key`. */
export function checkSchema(key: string, version: string, doc: unknown): OpenCodeSchemaCheck {
  const known = checked.get(key);
  if (known !== undefined) return known;
  const check = doc === null ? { off: new Set<OpenCodeFeature>(), diagnostic: "没能读到 OpenCode " + version + " 的接口说明，按已知能力运行。" } : compare(doc);
  checked.set(key, check);
  return check;
}
const row = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
interface Operation { readonly body: Row | null; readonly parameters: readonly Row[] }
function operations(doc: Row): Map<string, Operation> {
  const out = new Map<string, Operation>();
  for (const methods of Object.values(row(doc.paths) ?? {})) for (const value of Object.values(row(methods) ?? {})) {
    const op = row(value);
    if (op === null || typeof op.operationId !== "string") continue;
    const body = row(row(row(row(op.requestBody)?.content)?.["application/json"])?.schema);
    out.set(op.operationId, { body, parameters: Array.isArray(op.parameters) ? op.parameters.map(row).filter((item): item is Row => item !== null) : [] });
  }
  return out;
}
/** A schema with its `$ref`s and `anyOf`/`oneOf`/`allOf` branches followed, as the list of object shapes it can be. */
function shapes(doc: Row, node: unknown, depth = 0): Row[] {
  const here = row(node);
  if (here === null || depth > 8) return [];
  if (typeof here.$ref === "string") {
    const name = here.$ref.split("/").at(-1)!;
    return shapes(doc, row(row(doc.components)?.schemas)?.[name], depth + 1);
  }
  const branches = ["anyOf", "oneOf", "allOf"].flatMap(key => Array.isArray(here[key]) ? here[key] as unknown[] : []);
  return [...(row(here.properties) ? [here] : []), ...branches.flatMap(branch => shapes(doc, branch, depth + 1))];
}
function lists(doc: Row, node: unknown, value: string, depth = 0): boolean {
  const here = row(node);
  if (here === null || depth > 10) return false;
  if (typeof here.$ref === "string") return lists(doc, row(row(doc.components)?.schemas)?.[here.$ref.split("/").at(-1)!], value, depth + 1);
  if (Array.isArray(here.enum) && here.enum.includes(value)) return true;
  if (here.const === value) return true;
  return ["anyOf", "oneOf", "allOf"].some(key => Array.isArray(here[key]) && (here[key] as unknown[]).some(part => lists(doc, part, value, depth + 1))) || lists(doc, here.items, value, depth + 1);
}
function compare(raw: unknown): OpenCodeSchemaCheck {
  const doc = row(raw) ?? {}, ops = operations(doc);
  const field = (entry: string): Row | null => {
    const at = entry.lastIndexOf("."), op = ops.get(entry.slice(0, at)), name = entry.slice(at + 1);
    return op?.body ? shapes(doc, op.body).map(shape => row(row(shape.properties)?.[name])).find(found => found !== null) ?? null : null;
  };
  const types = ops.get("event.subscribe")?.parameters.find(parameter => parameter.name === "types")?.schema;
  const missing = (relied: Relied): string[] => [
    ...(relied.operations ?? []).filter(name => !ops.has(name)),
    ...(relied.fields ?? []).filter(entry => field(entry) === null),
    ...(relied.values ?? []).filter(entry => { const [where, value] = entry.split(":"); const node = field(where!); return node === null || !lists(doc, node, value!); }),
    ...(relied.events ?? []).filter(name => types !== undefined && !lists(doc, types, name)),
  ];
  const off = new Set<OpenCodeFeature>(), said: string[] = [];
  for (const [feature, relied] of Object.entries(RELIED) as [OpenCodeFeature, Relied][]) {
    const gone = missing(relied);
    if (gone.length === 0) continue;
    if (feature !== "core") off.add(feature);
    said.push(feature + "（缺 " + gone.join("、") + "）");
  }
  return { off, diagnostic: said.length ? "这个版本的 OpenCode 少了 HarnessHub 用到的接口，相关功能已关闭：" + said.join("；") : null };
}
