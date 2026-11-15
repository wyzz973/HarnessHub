import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";

/**
 * Every hermes-gateway-v1 method this driver may send, and nothing else (2026-11-15). The same gateway runs the user's messaging bots
 * (QQ and others): no method that sends, delivers, forwards or schedules is here (`bot_relay.*`, `a2a.forward`, `groups.*`, `cron.*`,
 * `kanban.run`, `shell.exec`, `message.react`, `prompt.background`, `prompt.btw`, `connectors.*`, `cli.exec`, `command.dispatch`), and a
 * method outside this list is refused before it is written. A few verbs are allowed only with some of their parameters:
 * `config.set` only for the session's own reasoning display, `session.mutate` only for the operations below (never `delete`, `reset`,
 * `import`, `archive`, `sidebar`), `session.create` only as a local editor session (`source: "acp"`) with no messaging delivery.
 */
type Guard = (params: Readonly<Record<string, unknown>>) => boolean;
const any: Guard = () => true;
/** The `session.mutate` operations the driver runs. */
export const MUTATIONS = ["rename", "model", "reasoning", "compress", "branch", "rewind", "edit_policy", "editor_mcp", "workspace"] as const;
export type Mutation = typeof MUTATIONS[number];
/**
 * The owner's read commands the driver runs as typed (gateway/session_commands.py `_READ_COMMANDS`, reviewed reads only): `slash.exec` runs
 * nothing else, so no command that writes config.yaml, schedules or delivers (`/cron`, `/kanban`, `/personality`, `/yolo`, `/skills approve`, …).
 */
export const READ_COMMANDS: ReadonlySet<string> = new Set(["help", "commands", "status", "context", "version", "whoami", "usage", "insights", "diff", "toolsets", "platforms"]);
function readCommand(params: Readonly<Record<string, unknown>>): boolean {
  if (typeof params.command !== "string" || typeof params.session_id !== "string") return false;
  const [word = "", ...rest] = params.command.replace(/^\s*\//u, "").trim().split(/\s+/u);
  return READ_COMMANDS.has(word.toLowerCase()) && (word.toLowerCase() !== "usage" || rest.length === 0);
}
/** `session.create` parameters the driver sets; anything else (`api_key`, `base_url`, `client_env`, `accept_hooks`, …) is refused. */
const CREATE_PARAMS = new Set(["request_id", "source", "cwd", "model", "provider", "reasoning", "yolo", "checkpoints", "editor", "title", "client"]);
export const ALLOWED_METHODS: Readonly<Record<string, Guard>> = {
  "runtime.describe": any,
  "model.options": any,
  "commands.catalog": any,
  "session.create": params => params.source === "acp" && Object.keys(params).every(key => CREATE_PARAMS.has(key)),
  "session.resume": any,
  "session.info": any,
  "session.list": any,
  "session.detach": any,
  "session.events.since": any,
  "session.stats": any,
  "session.export": any,
  "session.transcript": any,
  "session.mutate": params => (MUTATIONS as readonly string[]).includes(String(params.operation)),
  "session.steer": any,
  "session.interrupt": any,
  "prompt.submit": params => !("surface" in params) && !("unattended" in params),
  "prompt.receipt": any,
  "prompt.cancel": any,
  "approval.respond": any,
  "clarify.respond": any,
  "image.attach_bytes": any,
  "config.set": params => params.key === "show_reasoning" && typeof params.session_id === "string" && params.session_id !== "",
  "slash.exec": readCommand,
  "rollback.list": any,
  "rollback.diff": any,
  "rollback.restore": any,
  "ping": any,
};
/** Throws before anything is written when `method` is not on the list, or its parameters are not the ones the list allows. */
export function assertAllowed(method: string, params: Readonly<Record<string, unknown>>): void {
  const guard = Object.hasOwn(ALLOWED_METHODS, method) ? ALLOWED_METHODS[method] : undefined;
  if (guard === undefined) throw new ControlError("METHOD_NOT_ALLOWED", "HarnessHub 不向 Hermes 网关发送这个方法：" + method.slice(0, 64));
  if (!guard(params)) throw new ControlError("METHOD_NOT_ALLOWED", "HarnessHub 不向 Hermes 网关发送这组参数：" + method.slice(0, 64));
}
