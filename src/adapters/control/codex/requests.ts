import { basename } from "node:path";
import { changeLines, line, record, type Row } from "./mapping.js";

/**
 * What Codex asks the client (app-server 0.169.0 server requests) as the Hub's prompts: the title and the choices the user sees, what the Hub's
 * policy tells the request by (`toolKind`), and the answer Codex gets for each choice. Pure: the driver asks, these say what to ask and answer.
 */
export interface Choice { readonly id: string; readonly name: string }
export interface Prompt {
  readonly title: string;
  readonly detail?: string;
  readonly choices: readonly Choice[];
  readonly toolKind?: string;
  readonly forCall?: string;
  /** Codex's answer for one of the choices. */
  answer(choice: string): unknown;
  /** The answer when nobody decides (no one is asked on this connection, or the Turn ended): a refusal that lets the turn go on. */
  readonly refusal: unknown;
  /** The answer while the Turn is being stopped. */
  readonly cancel: unknown;
}
const child = (owned: boolean) => owned ? "" : "子 Agent · ";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];

// ---- permissions a command or a request asks for -------------------------------------------------------------------------

/** The paths a permission profile reads and writes (`read`/`write`, and the newer `entries` with their access), and whether it asks for the network. */
function profile(value: unknown): { readonly network: boolean; readonly read: string[]; readonly write: string[]; readonly fileSystem: boolean } {
  const permissions = record(value), fs = record(permissions?.fileSystem), read = strings(fs?.read), write = strings(fs?.write);
  for (const entry of Array.isArray(fs?.entries) ? fs.entries : []) {
    const row = record(entry), path = record(row?.path), where = typeof path?.path === "string" ? path.path : typeof path?.pattern === "string" ? path.pattern : typeof path?.value === "string" ? path.value : record(path?.value) ? JSON.stringify(path!.value) : undefined;
    if (where === undefined) continue;
    if (row?.access === "write") write.push(where); else if (row?.access === "read") read.push(where);
  }
  return { network: record(permissions?.network)?.enabled === true, read, write, fileSystem: fs !== null };
}
function profileLines(asked: ReturnType<typeof profile>): string[] {
  return [...(asked.network ? ["联网"] : []), ...(asked.write.length ? ["写入 " + asked.write.join("、")] : []), ...(asked.read.length ? ["读取 " + asked.read.join("、")] : [])];
}

// ---- commands ------------------------------------------------------------------------------------------------------------

/** A command decision (CommandExecutionApprovalDecision) as a choice, with the Hub's words for it; null for a shape this driver does not know. */
function commandChoice(decision: unknown, index: number, host: string | undefined): (Choice & { readonly value: unknown; readonly order: number }) | null {
  if (decision === "accept") return { id: "accept", name: "允许一次", value: decision, order: 0 };
  if (decision === "acceptForSession") return { id: "acceptForSession", name: host ? "本次会话都允许访问 " + host : "本次会话允许", value: decision, order: 1 };
  if (decision === "decline") return { id: "decline", name: "拒绝", value: decision, order: 3 };
  if (decision === "cancel") return { id: "cancel", name: "取消并停止这一轮", value: decision, order: 4 };
  const row = record(decision);
  const exec = record(row?.acceptWithExecpolicyAmendment), prefix = strings(exec?.execpolicy_amendment);
  if (exec !== null && prefix.length) return { id: "acceptWithExecpolicyAmendment", name: "以后都允许以“" + line(prefix.join(" "), 200) + "”开头的命令", value: decision, order: 2 };
  const network = record(record(row?.applyNetworkPolicyAmendment)?.network_policy_amendment);
  if (network !== null && typeof network.host === "string" && (network.action === "allow" || network.action === "deny"))
    // A remembered refusal goes after the plain refusal, so that a refusal the Hub gives itself is never a lasting rule.
    return { id: "applyNetworkPolicyAmendment:" + index, name: (network.action === "allow" ? "以后都允许访问 " : "以后都拒绝访问 ") + line(network.host, 256), value: decision, order: network.action === "allow" ? 2 : 5 };
  return null;
}
/**
 * `item/commandExecution/requestApproval`: every decision shape Codex offers (`availableDecisions`, in its order within each group: allowing,
 * remembering, refusing), the network host it is about, the permissions it adds and the rules it proposes in the detail.
 */
export function commandApproval(params: Row, owned: boolean): Prompt {
  const kind = typeof params.kind === "string" ? params.kind : "command", command = typeof params.command === "string" ? params.command : "";
  const network = record(params.networkApprovalContext), host = typeof network?.host === "string" ? network.host : undefined;
  const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : kind === "humanCommand" ? ["accept", "decline", "cancel"]
    : ["accept", "acceptForSession", ...(strings(params.proposedExecpolicyAmendment).length ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: strings(params.proposedExecpolicyAmendment) } }] : []),
      ...(Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments.map(amendment => ({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } })) : []), "decline", "cancel"];
  let choices = offered.slice(0, 32).map((value, index) => commandChoice(value, index, host)).filter((choice): choice is NonNullable<typeof choice> => choice !== null);
  // A plain refusal is always there (0.169.0 offers accept, a rule and cancel for a command, and cancel stops the whole turn): the Hub's own refusal lets the turn go on.
  if (!choices.some(choice => choice.id === "decline")) choices.push({ id: "decline", name: "拒绝", value: "decline", order: 3 });
  choices = choices.filter((choice, index) => choices.findIndex(other => other.id === choice.id) === index).sort((left, right) => left.order - right.order);
  const title = child(owned) + (kind === "humanCommand" ? "需要你亲自确认：" + (line(command) || "一项操作") : kind === "writeStdin" ? "Codex 请求向运行中的命令输入" + (command ? "：" + line(command, 512) : "")
    : host ? "Codex 请求联网：" + line(host, 256) : line(command) || "Codex 请求执行命令");
  const added = profile(params.additionalPermissions), amendment = strings(params.proposedExecpolicyAmendment);
  const rules = (Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments : []).flatMap(value => { const row = record(value); return typeof row?.host === "string" ? [(row.action === "deny" ? "拒绝 " : "允许 ") + row.host] : []; });
  const detail = [typeof params.reason === "string" ? line(params.reason) : "", host && command ? "命令：" + command : "", typeof params.cwd === "string" ? "目录：" + params.cwd : "",
    host && typeof network?.protocol === "string" ? "访问 " + network.protocol + "://" + host : "", params.additionalPermissions ? profileLines(added).map(text => "另外需要：" + text).join("\n") : "",
    amendment.length ? "可以记住的命令前缀：" + amendment.join(" ") : "", rules.length ? "可以记住的网络规则：" + rules.join("，") : ""].filter(Boolean).join("\n");
  const byId = new Map(choices.map(choice => [choice.id, choice.value]));
  return { title, ...(detail ? { detail } : {}), choices: choices.map(({ id, name }) => ({ id, name })), toolKind: host ? "fetch" : "execute",
    ...(typeof params.itemId === "string" ? { forCall: params.itemId } : {}),
    answer: choice => ({ decision: byId.get(choice) ?? "decline" }), refusal: { decision: "decline" }, cancel: { decision: byId.has("cancel") ? "cancel" : "decline" } };
}
/** `item/fileChange/requestApproval`: the files and what happens to each (from the item's own changes), the root it asks to write under, the diff. */
export function fileChangeApproval(params: Row, owned: boolean, changes: readonly unknown[], diff: string | undefined): Prompt {
  const files = changes.flatMap(value => { const row = record(value); return typeof row?.path === "string" ? [basename(row.path)] : []; }).slice(0, 3).join(", ");
  const detail = [typeof params.reason === "string" ? line(params.reason) : "", typeof params.grantRoot === "string" && params.grantRoot ? "请求本次会话可写：" + params.grantRoot : "", ...changeLines(changes), diff ?? ""].filter(Boolean).join("\n");
  return { title: child(owned) + "Codex 请求修改文件" + (files ? "：" + files : ""), ...(detail ? { detail } : {}),
    choices: [{ id: "accept", name: "允许一次" }, { id: "acceptForSession", name: "本次会话允许" }, { id: "decline", name: "拒绝" }, { id: "cancel", name: "取消并停止这一轮" }], toolKind: "edit",
    ...(typeof params.itemId === "string" ? { forCall: params.itemId } : {}),
    answer: choice => ({ decision: ["accept", "acceptForSession", "decline", "cancel"].includes(choice) ? choice : "decline" }), refusal: { decision: "decline" }, cancel: { decision: "cancel" } };
}
/**
 * `item/permissions/requestApproval` (a sandbox escalation: the network, more paths): granted for this turn or the whole session, or only part of it
 * when it asks for both the network and files; a refusal grants nothing. What it is about tells the Hub's policy: the network, a write, a read, or,
 * for both at once, neither alone.
 */
export function permissionsApproval(params: Row, owned: boolean): Prompt {
  const asked = record(params.permissions) ?? {}, parts = profile(asked), both = parts.network && parts.fileSystem;
  const choices: Choice[] = [{ id: "accept", name: "允许（这一轮）" }, { id: "acceptForSession", name: "本次会话都允许" },
    ...(both ? [{ id: "network", name: "只允许联网（这一轮）" }, { id: "fileSystem", name: "只允许文件访问（这一轮）" }] : []), { id: "decline", name: "拒绝" }];
  const none = { permissions: {}, scope: "turn" };
  const detail = [typeof params.reason === "string" ? line(params.reason) : "", typeof params.cwd === "string" ? "目录：" + params.cwd : ""].filter(Boolean).join("\n");
  return { title: child(owned) + "Codex 请求更多权限：" + (profileLines(parts).join("；") || "沙箱之外"), ...(detail ? { detail } : {}), choices,
    toolKind: both ? "other" : parts.network ? "fetch" : parts.write.length ? "edit" : parts.read.length ? "read" : "other", ...(typeof params.itemId === "string" ? { forCall: params.itemId } : {}),
    answer: choice => choice === "accept" ? { permissions: asked, scope: "turn" } : choice === "acceptForSession" ? { permissions: asked, scope: "session" }
      : choice === "network" ? { permissions: { network: asked.network }, scope: "turn" } : choice === "fileSystem" ? { permissions: { fileSystem: asked.fileSystem }, scope: "turn" } : none,
    refusal: none, cancel: none };
}
/** The v1 `execCommandApproval` and `applyPatchApproval`, answered with a ReviewDecision. */
export function legacyApproval(method: string, params: Row, owned: boolean): Prompt {
  const patch = method === "applyPatchApproval", changes = record(params.fileChanges) ?? {}, files = Object.keys(changes);
  const command = Array.isArray(params.command) ? strings(params.command).join(" ") : "";
  const decisions: Readonly<Record<string, string>> = { accept: "approved", acceptForSession: "approved_for_session", decline: "denied", cancel: "abort" };
  const detail = [typeof params.reason === "string" ? line(params.reason) : "", typeof params.cwd === "string" ? "目录：" + params.cwd : "", ...files.map(path => "修改 " + path)].filter(Boolean).join("\n");
  return { title: child(owned) + (patch ? "Codex 请求修改文件" + (files.length ? "：" + files.slice(0, 3).map(path => basename(path)).join(", ") : "") : line(command) || "Codex 请求执行命令"), ...(detail ? { detail } : {}),
    choices: [{ id: "accept", name: "允许一次" }, { id: "acceptForSession", name: "本次会话允许" }, { id: "decline", name: "拒绝" }, { id: "cancel", name: "取消并停止这一轮" }], toolKind: patch ? "edit" : "execute",
    ...(typeof params.callId === "string" ? { forCall: params.callId } : {}),
    answer: choice => ({ decision: decisions[choice] ?? "denied" }), refusal: { decision: "denied" }, cancel: { decision: "abort" } };
}

// ---- questions -----------------------------------------------------------------------------------------------------------

/** One question of a sequence the user answers one by one: its choices, or a field to type in. `value` turns the answer into what Codex is given. */
export interface Question {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly choices: readonly Choice[];
  readonly input?: { readonly kind: "text" | "secret"; readonly value: string };
  /** The answer for a choice (and the typed text for `submit`): a value, a refusal (`decline`) or a stop (`cancel`). Throws on a typed text it cannot take. */
  value(choice: string, input?: string): { readonly value: unknown } | "decline" | "cancel";
}
const CANCEL: Choice = { id: "cancel", name: "取消" };
/** `item/tool/requestUserInput` (blocking or not): each question with its options, a free answer when it allows one, secret when it says so. */
export function userInputQuestions(params: Row): Question[] | null {
  if (!Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > 64) return null;
  const questions = params.questions.map(value => {
    const row = record(value);
    if (row === null || typeof row.id !== "string" || !row.id || typeof row.question !== "string") return null;
    const options = (Array.isArray(row.options) ? row.options : []).map(option => record(option)).filter((option): option is Row => typeof option?.label === "string");
    const freeform = row.isOther === true || options.length === 0, header = typeof row.header === "string" && row.header.trim() && row.header.trim() !== row.question.trim() ? row.header.trim() : undefined;
    const question: Question = { id: row.id, title: row.question.slice(0, 4096), ...(header ? { detail: header } : {}),
      choices: [...options.map((option, index) => ({ id: "answer-" + index, name: String(option.label) })), ...(freeform ? [{ id: "submit", name: "提交回答" }] : []), CANCEL],
      ...(freeform ? { input: { kind: row.isSecret === true ? "secret" as const : "text" as const, value: "" } } : {}),
      value: (choice, input) => {
        if (choice === "cancel") return "cancel";
        if (choice === "submit") { if (typeof input !== "string" || input.includes("\0")) throw new Error("invalid native input answer"); return { value: input }; }
        const option = options[Number(choice.slice(7))];
        if (!choice.startsWith("answer-") || option === undefined) throw new Error("invalid native answer choice");
        return { value: String(option.label) };
      } };
    return question;
  });
  if (questions.some(question => question === null) || new Set(questions.map(question => question!.id)).size !== questions.length) return null;
  return questions as Question[];
}

// ---- MCP elicitations ----------------------------------------------------------------------------------------------------

/**
 * 移植自 T3 Code（MIT, © 2026 T3 Tools Inc.）：apps/server/src/provider/CodexMcpElicitation.ts。
 * Whether a choice or a field asks to remember an approval for the session or for good, by its words.
 */
function persistence(value: string): "acceptForSession" | "acceptAlways" | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("session")) return "acceptForSession";
  if (["always", "permanent", "forever", "persistent"].some(word => normalized.includes(word))) return "acceptAlways";
  return null;
}
interface Field { readonly type?: unknown; readonly title?: unknown; readonly description?: unknown; readonly default?: unknown; readonly enum?: unknown; readonly enumNames?: unknown; readonly oneOf?: unknown; readonly items?: unknown; readonly minimum?: unknown; readonly maximum?: unknown }
function fieldOptions(field: Field): { readonly value: string; readonly label?: string }[] {
  if (Array.isArray(field.oneOf)) return field.oneOf.flatMap(option => { const row = record(option); return typeof row?.const === "string" ? [{ value: row.const, ...(typeof row.title === "string" ? { label: row.title } : {}) }] : []; });
  const names = Array.isArray(field.enumNames) ? field.enumNames : [];
  return strings(field.enum).map((value, index) => ({ value, ...(typeof names[index] === "string" ? { label: names[index] as string } : {}) }));
}
function persistenceField(key: string, field: Field): boolean {
  return persistence(key) !== null || key.toLowerCase() === "persist" || persistence(typeof field.title === "string" ? field.title : "") !== null || persistence(typeof field.description === "string" ? field.description : "") !== null;
}
const ONCE = /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/iu;
/** The form of a form-mode elicitation (`requestedSchema.properties`), or null when it has none. */
function formOf(params: Row): { readonly properties: Readonly<Record<string, Field>>; readonly required: readonly string[] } | null {
  if (params.mode === "url") return null;
  const schema = record(params.requestedSchema);
  if (schema === null) return null;
  const properties = record(schema.properties) ?? {};
  return { properties: Object.fromEntries(Object.entries(properties).flatMap(([key, value]) => record(value) ? [[key, value as Field]] : [])), required: strings(schema.required) };
}
/** T3 Code's toMcpElicitationResponse: the answer to an approval-like elicitation for a decision, every field filled from it (a choice that names it, a remembered-approval switch, a default). */
function approvalResponse(params: Row, decision: string): Row {
  if (decision === "decline" || decision === "cancel") return { action: decision };
  if (params.mode === "url") return { action: "decline" };
  const persist = decision === "acceptForSession" ? "session" : decision === "acceptAlways" ? "always" : undefined, form = formOf(params), content: Row = {};
  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    const chosen = fieldOptions(field).find(option => persist ? persistence(option.value) === decision : ONCE.test(option.value.trim()) && persistence(option.value) === null);
    if (chosen) content[key] = chosen.value;
    else if (field.type === "boolean" && persistenceField(key, field)) content[key] = decision === "acceptAlways";
    else if (field.default !== undefined && field.default !== null) content[key] = field.default;
  }
  if (form?.required.some(key => !Object.hasOwn(content, key))) return { action: "decline" };
  return { action: "accept", ...(persist ? { _meta: { persist } } : {}), ...(form ? { content } : {}) };
}
/** The app an elicitation is for, as T3 Code finds it in its metadata or message; else the MCP server. */
function appName(params: Row): string {
  const meta = record(params._meta), target = record(meta?.target), tool = record(meta?.tool_params), message = typeof params.message === "string" ? params.message : "";
  const named = [meta?.app_name, meta?.appName, meta?.app, target?.app, target?.name, tool?.app_name, tool?.app, /^Allow ChatGPT to use (.+?)\?$/iu.exec(message)?.[1], meta?.connector_name, meta?.connectorName, params.serverName]
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  return named ?? "MCP";
}
export type Elicitation =
  | { readonly kind: "approval"; readonly prompt: Prompt }
  | { readonly kind: "form"; readonly questions: readonly Question[]; readonly answer: (values: Readonly<Record<string, unknown>>) => Row }
  | { readonly kind: "decline"; readonly notice: string };
/**
 * `mcpServer/elicitation/request`. An approval-like form (nothing in it the user must type: no fields, switches that remember the approval, choices
 * that name it, defaults) is an approval with T3 Code's choices: allow, for this session, always (when the form can say so), refuse, cancel. A simple
 * form (text, numbers, a yes or no, one choice of a list) is asked as questions, one field at a time. A link to open (`url`), a device verification
 * and a form the Hub cannot show (several choices at once, nested values) are declined, and the notice says so.
 */
export function elicitation(params: Row, owned: boolean): Elicitation {
  const server = typeof params.serverName === "string" && params.serverName ? params.serverName : "MCP", app = appName(params);
  const message = typeof params.message === "string" ? params.message : typeof params.title === "string" ? params.title : "";
  if (params.mode === "url") return { kind: "decline", notice: "Codex 的 MCP 服务 " + server + " 要你打开一个网页完成这一步，HarnessHub 还不能代为打开，已拒绝。" };
  if (params.mode !== "form" && params.mode !== "openai/form" && params.mode !== "openaiForm") return { kind: "decline", notice: "Codex 的 MCP 服务 " + server + " 发来的请求（" + String(params.mode ?? "未知方式") + "）HarnessHub 还不能显示，已拒绝。" };
  const form = formOf(params);
  const fillable = (key: string, field: Field) => persistenceField(key, field) && field.type === "boolean" || fieldOptions(field).some(option => ONCE.test(option.value.trim()) || persistence(option.value) !== null) || field.default !== undefined && field.default !== null;
  const typed = Object.entries(form?.properties ?? {}).filter(([key, field]) => !fillable(key, field));
  if (typed.length === 0) {
    if (approvalResponse(params, "accept").action !== "accept") return { kind: "decline", notice: "Codex 的 MCP 服务 " + server + " 发来的表单缺少能自动填写的内容，已拒绝。" };
    const remembered = new Map<string, string>();
    const meta = record(params._meta), persist = meta?.persist;
    for (const value of typeof persist === "string" ? [persist] : strings(persist)) { const decision = persistence(value); if (decision) remembered.set(decision, ""); }
    if (meta?.allowPersistentApproval === true) remembered.set("acceptAlways", "");
    for (const [key, field] of Object.entries(form?.properties ?? {})) {
      for (const option of fieldOptions(field)) { const decision = persistence(option.value); if (decision) remembered.set(decision, option.label ?? ""); }
      if (field.type === "boolean" && persistenceField(key, field)) remembered.set("acceptAlways", typeof field.title === "string" ? field.title : "");
    }
    const choices: Choice[] = [{ id: "accept", name: "允许" },
      ...(remembered.has("acceptForSession") && approvalResponse(params, "acceptForSession").action === "accept" ? [{ id: "acceptForSession", name: "本次会话允许" }] : []),
      ...(remembered.has("acceptAlways") && approvalResponse(params, "acceptAlways").action === "accept" ? [{ id: "acceptAlways", name: "始终允许" }] : []),
      { id: "decline", name: "拒绝" }, { id: "cancel", name: "取消" }];
    const said = line(message, 1024);
    return { kind: "approval", prompt: { title: child(owned) + (said ? (said.includes(app) ? said : app + "：" + said) : app + " 请求使用工具"), choices, toolKind: "mcp",
      answer: choice => approvalResponse(params, choice), refusal: { action: "decline" }, cancel: { action: "cancel" } } };
  }
  const questions: Question[] = [];
  for (const [index, [key, field]] of typed.entries()) {
    const options = fieldOptions(field), required = form!.required.includes(key);
    const name = (typeof field.title === "string" && field.title.trim() ? field.title.trim() : key) + (required ? "" : "（可不填）");
    const title = index === 0 && message ? line(message, 1024) + "\n" + name : name, detail = typeof field.description === "string" && field.description.trim() ? field.description.trim() : undefined;
    const end: Choice[] = [...(required ? [] : [{ id: "skip", name: "跳过" }]), { id: "decline", name: "拒绝" }, CANCEL];
    const settle = (choice: string) => choice === "cancel" ? "cancel" as const : choice === "decline" ? "decline" as const : choice === "skip" && !required ? { value: undefined } : null;
    if (options.length && field.type !== "array") {
      questions.push({ id: key, title, ...(detail ? { detail } : {}), choices: [...options.map((option, at) => ({ id: "answer-" + at, name: option.label ?? option.value })), ...end],
        value: choice => settle(choice) ?? (() => { const option = options[Number(choice.slice(7))]; if (!choice.startsWith("answer-") || option === undefined) throw new Error("invalid answer choice"); return { value: option.value }; })() });
      continue;
    }
    if (field.type === "boolean") {
      questions.push({ id: key, title, ...(detail ? { detail } : {}), choices: [{ id: "answer-yes", name: "是" }, { id: "answer-no", name: "否" }, ...end], value: choice => settle(choice) ?? { value: choice === "answer-yes" } });
      continue;
    }
    if (field.type === "string" || field.type === "number" || field.type === "integer") {
      const number = field.type !== "string";
      questions.push({ id: key, title, ...(detail ? { detail } : {}), choices: [{ id: "submit", name: "提交" }, ...end], input: { kind: "text", value: field.default == null ? "" : String(field.default) },
        value: (choice, input) => {
          const settled = settle(choice);
          if (settled !== null) return settled;
          if (choice !== "submit" || typeof input !== "string" || input.includes("\0")) throw new Error("invalid answer");
          if (!number) return { value: input };
          const value = Number(input.trim());
          if (input.trim() === "" || !Number.isFinite(value) || field.type === "integer" && !Number.isSafeInteger(value)) throw new Error("not a number");
          return { value };
        } });
      continue;
    }
    return { kind: "decline", notice: "Codex 的 MCP 服务 " + server + " 发来的表单（" + name + "）HarnessHub 还显示不了，已拒绝。" };
  }
  return { kind: "form", questions, answer: values => {
    const filled = approvalResponse(params, "accept"), content = { ...(record(filled.content) ?? {}) };
    for (const [key, value] of Object.entries(values)) if (value !== undefined) content[key] = value;
    return { action: "accept", content };
  } };
}
/** The default answer to a server request nobody on this connection is asked about (another client's thread, a thread given up, no Turn running). */
export function refusalOf(method: string): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval": case "item/fileChange/requestApproval": return { decision: "decline" };
    case "item/permissions/requestApproval": return { permissions: {}, scope: "turn" };
    case "mcpServer/elicitation/request": return { action: "decline" };
    case "item/tool/requestUserInput": return { answers: {} };
    case "item/tool/call": return { contentItems: [{ type: "inputText", text: "HarnessHub 没有给这个会话注册动态工具。" }], success: false };
    case "applyPatchApproval": case "execCommandApproval": return { decision: "denied" };
    default: return undefined;
  }
}
