import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";

/**
 * The Gateway methods this driver may call, and nothing else (2026-11-15). The same Gateway serves the user's Feishu and Weixin, so no method
 * that sends anywhere is here, and every write names one of the Hub's own session keys. A call outside the list throws before anything is sent.
 */
export const ALLOWED_METHODS = [
  "agents.list", "models.list", "commands.list", "skills.status", "tools.catalog",
  "chat.history", "sessions.describe", "sessions.messages.subscribe", "sessions.messages.unsubscribe",
  "sessions.create", "sessions.patch", "chat.send", "chat.abort", "sessions.compact", "sessions.rewind",
  "exec.approval.resolve", "plugin.approval.resolve", "question.resolve", "question.list",
] as const;
export type GatewayMethod = (typeof ALLOWED_METHODS)[number];
const ALLOWED: ReadonlySet<string> = new Set(ALLOWED_METHODS);

/** Methods and families that send outside the session or change the Gateway itself; none may ever be called (the test holds the list against them). */
export const FORBIDDEN_METHODS: readonly string[] = ["send", "poll", "wake", "message.action", "conversations.send", "conversations.turn", "sessions.send", "sessions.steer", "agent",
  "push.*", "cron.*", "talk.*", "tts.*", "channels.*", "config.*", "web.login.*", "node.invoke", "openclaw.chat", "board.*", "taskSuggestions.*"];

/** The Hub's own Gateway session keys; no other key is created, written, read or continued. */
export const HUB_KEY = /^agent:[a-z0-9][a-z0-9_-]{0,63}:harnesshub:[a-f0-9][a-f0-9-]{7,63}$/u;
/** What chat.send must never carry: a delivery to a channel or a reply route (without them the route is the session's own, internal). */
const CHAT_DELIVERY = ["deliver", "originatingChannel", "originatingTo", "originatingAccountId", "originatingThreadId", "replyToId"];
/** The only session settings the driver writes. */
const PATCHED = new Set(["key", "agentId", "label", "model", "thinkingLevel", "permissionMode", "fastMode", "category", "communication", "expectedPermissionMode"]);
/** Where each method names its session, when it names one. */
const SESSION_FIELD: Readonly<Partial<Record<GatewayMethod, string>>> = { "chat.history": "sessionKey", "sessions.describe": "key", "sessions.messages.subscribe": "key", "sessions.messages.unsubscribe": "key",
  "sessions.create": "key", "sessions.patch": "key", "chat.send": "sessionKey", "chat.abort": "sessionKey", "sessions.compact": "key", "sessions.rewind": "sessionKey" };

/** Throws, before anything is sent, for a method outside ALLOWED_METHODS or a request that could reach anything but a Hub session. */
export function guard(method: string, params: Readonly<Record<string, unknown>>): asserts method is GatewayMethod {
  if (!ALLOWED.has(method)) throw new ControlError("METHOD_NOT_ALLOWED", "HarnessHub does not call the OpenClaw Gateway method " + method.slice(0, 64));
  const field = SESSION_FIELD[method as GatewayMethod];
  if (field !== undefined && (typeof params[field] !== "string" || !HUB_KEY.test(params[field] as string))) throw new ControlError("METHOD_NOT_ALLOWED", method + " is only called on the Hub's own sessions");
  if (method === "sessions.create" && params.parentSessionKey !== undefined && (typeof params.parentSessionKey !== "string" || !HUB_KEY.test(params.parentSessionKey))) throw new ControlError("METHOD_NOT_ALLOWED", "a fork is only made of the Hub's own sessions");
  if (method === "chat.send" && CHAT_DELIVERY.some(name => params[name] !== undefined)) throw new ControlError("METHOD_NOT_ALLOWED", "chat.send never carries a delivery");
  if (method === "sessions.patch" && Object.keys(params).some(name => !PATCHED.has(name))) throw new ControlError("METHOD_NOT_ALLOWED", "sessions.patch only writes the session's model, thinking, permission mode, category and title");
}
