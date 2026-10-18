import { isDeepStrictEqual } from "node:util";
import { looksSecret, maskSecrets } from "./masking.js";
import { record } from "./formats.js";

/**
 * MCP servers in one neutral form (ADR-045 §5 and the approval of step 3): what HarnessHub's list keeps, read from each
 * Harness's own way of writing a server and written back the same way. A value that looks like a credential is never
 * kept: it is only ever a reference to one of the user's environment variables. Plain settings may be literal.
 */

/** An environment variable the server sees (`key`): the value of the user's variable `variable`, or a plain literal `value`. */
export type McpEnv = { readonly key: string; readonly variable: string } | { readonly key: string; readonly value: string };
/** A request header: `prefix` (such as `Bearer `) followed by the user's variable `variable`, or a plain literal `value`. */
export type McpHeader = { readonly name: string; readonly variable: string; readonly prefix: string } | { readonly name: string; readonly value: string };
export interface McpDefinition {
  readonly transport: "stdio" | "http" | "sse";
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly url: string | null;
  readonly env: readonly McpEnv[];
  readonly headers: readonly McpHeader[];
}
/** The Harnesses whose MCP configuration HarnessHub reads into the list, by their file's style. */
export type McpStyle = "claude" | "codex" | "cursor" | "opencode" | "gemini" | "hermes" | "dsh";
/**
 * A JavaScript expression in DeepSeek Harness's YAML (`!!js …`), as the reader returns it; never evaluated. HarnessHub
 * writes only `process.env.NAME` and `'<prefix>' + process.env.NAME` with a checked name and prefix.
 */
export interface JsExpression { readonly jsExpression: string }
function jsReference(value: unknown): { readonly variable: string; readonly prefix: string } | "cwd" | null {
  if (value === null || typeof value !== "object" || typeof (value as JsExpression).jsExpression !== "string") return null;
  const expression = (value as JsExpression).jsExpression.trim();
  if (/^process\.cwd\(\)$/u.test(expression)) return "cwd";
  const match = /^(?:(['"])([A-Za-z0-9 _:-]{0,32})\1\s*\+\s*)?process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(expression);
  return match ? { variable: match[3]!, prefix: match[2] ?? "" } : null;
}
export const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u, VARIABLE = /^[A-Z_][A-Z0-9_]{0,127}$/u, ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const SHELL = /[;&|$<>`\\"'\n\r]/u;

/** A server read from a Harness: its neutral definition, or why it cannot be kept. */
export interface McpRead { readonly definition: McpDefinition | null; readonly problem: string | null }

/** The variable a whole value refers to in a style, with what comes before it (a header's `Bearer `); null for a literal. */
function reference(value: string, style: McpStyle): { readonly variable: string; readonly prefix: string } | null {
  const pattern = style === "cursor" ? /^(.*?)\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/su : style === "opencode" ? /^(.*?)\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/su
    : /^(.*?)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/su;
  const match = pattern.exec(value);
  if (!match) return null;
  const variable = match[2] ?? match[3]!, prefix = match[1]!;
  // Only a reference at the end of the value after a short prefix (`Bearer `) is carried; one inside a longer text is not.
  return /[{}$]/u.test(prefix) || prefix.length > 32 ? null : { variable, prefix };
}
function strings(value: unknown): string[] | null { return Array.isArray(value) && value.every(item => typeof item === "string") ? value as string[] : null; }
function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
/** Whether an argument list carries what looks like a credential (`--token x`, `sk-…`, a URL with an account). */
export function secretArguments(args: readonly string[]): boolean { return args.some(arg => maskSecrets(arg) !== arg) || maskSecrets(args.join(" ")) !== args.join(" "); }
/** Why a URL cannot be kept: anything but HTTPS (or HTTP to this machine), an account, a query or a fragment. Null when it can. */
export function urlProblem(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "地址无法解析"; }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "地址里带有账号、查询串或片段，可能含有密钥";
  if (parsed.protocol === "https:") return null;
  return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ? null : "地址必须是 HTTPS（本机地址可以用 HTTP）";
}
/**
 * Why a definition cannot be kept or written (the approval's rules), or null: the program without shell characters, an
 * argument list without credentials, an absolute working folder, a plain address, upper-case variable names, and no value
 * that looks like a credential written literally.
 */
export function definitionProblem(definition: McpDefinition): string | null {
  if (definition.transport === "stdio") {
    if (definition.command === null || !definition.command.trim()) return "没有写明要运行的程序";
    if (SHELL.test(definition.command)) return "程序里有 shell 字符；请只写程序本身，参数分开写";
    if (secretArguments(definition.args)) return "参数里像是写着密钥，请改用环境变量";
    if (definition.cwd !== null && !definition.cwd.startsWith("/")) return "工作目录必须是绝对路径";
    if (definition.url !== null) return "本地运行的服务器不写地址";
  } else {
    if (definition.url === null) return "没有写明地址";
    const problem = urlProblem(definition.url);
    if (problem !== null) return problem;
    if (definition.command !== null || definition.args.length) return "远程服务器不写程序";
  }
  for (const item of definition.env) {
    if (!ENV_KEY.test(item.key)) return "环境变量名 " + item.key + " 不合法";
    if ("variable" in item ? !VARIABLE.test(item.variable) : looksSecret(item.key, item.value)) return "variable" in item ? "变量名 " + item.variable + " 必须是大写字母、数字和下划线" : item.key + " 的值像是密钥，必须改成变量引用";
  }
  for (const item of definition.headers) {
    if (!HEADER.test(item.name)) return "请求头 " + item.name + " 不合法";
    if ("variable" in item ? !VARIABLE.test(item.variable) || item.prefix.length > 32 || /[\r\n]/u.test(item.prefix) : looksSecret(item.name, item.value) || /[\r\n]/u.test(item.value))
      return "variable" in item ? "请求头 " + item.name + " 的变量名必须是大写字母、数字和下划线" : "请求头 " + item.name + " 的值像是密钥，必须改成变量引用";
  }
  return null;
}

/** Reads one server as a Harness writes it; a value that looks like a credential refuses the server rather than being kept. */
export function readMcp(raw: unknown, style: McpStyle): McpRead {
  const value = record(raw), env: McpEnv[] = [], headers: McpHeader[] = [];
  let transport: McpDefinition["transport"], command: string | null = null, args: string[] | null = [], url: string | null = null;
  const envValues = (map: unknown) => { for (const [key, item] of Object.entries(record(map))) { if (typeof item !== "string") continue; const found = reference(item, style); env.push(found === null || found.prefix ? { key, value: item } : { key, variable: found.variable }); } };
  const headerValues = (map: unknown) => { for (const [name, item] of Object.entries(record(map))) { if (typeof item !== "string") continue; const found = reference(item, style); headers.push(found === null ? { name, value: item } : { name, variable: found.variable, prefix: found.prefix }); } };
  switch (style) {
    case "codex": {
      url = text(value.url); command = text(value.command); args = value.args === undefined ? [] : strings(value.args);
      transport = url !== null ? "http" : "stdio";
      for (const [key, item] of Object.entries(record(value.env))) if (typeof item === "string") env.push({ key, value: item });
      for (const name of strings(value.env_vars) ?? []) env.push({ key: name, variable: name });
      const bearer = text(value.bearer_token_env_var);
      if (bearer !== null) headers.push({ name: "Authorization", variable: bearer, prefix: "Bearer " });
      for (const [name, variable] of Object.entries(record(value.env_http_headers))) if (typeof variable === "string") headers.push({ name, variable, prefix: "" });
      for (const [name, item] of Object.entries(record(value.http_headers))) if (typeof item === "string") headers.push({ name, value: item });
      break;
    }
    case "dsh": {
      // The `config` of an insert row of `@deepseek-ai/dsh-mcp-client`: environment and headers may be `!!js` expressions.
      url = text(value.url); command = text(value.command); args = value.args === undefined ? [] : strings(value.args);
      transport = value.transport === "streamable-http" || (url !== null && value.transport === undefined) ? "http" : value.transport === "sse" ? "sse" : "stdio";
      for (const [key, item] of Object.entries(record(value.env))) {
        const found = jsReference(item);
        if (typeof item === "string") env.push({ key, value: item }); else if (found !== null && found !== "cwd" && !found.prefix) env.push({ key, variable: found.variable }); else return { definition: null, problem: "环境变量 " + key + " 是 HarnessHub 读不了的表达式" };
      }
      for (const [name, item] of Object.entries(record(value.headers))) {
        const found = jsReference(item);
        if (typeof item === "string") headers.push({ name, value: item }); else if (found !== null && found !== "cwd") headers.push({ name, variable: found.variable, prefix: found.prefix }); else return { definition: null, problem: "请求头 " + name + " 是 HarnessHub 读不了的表达式" };
      }
      // `!!js process.cwd()` is the folder DeepSeek Harness runs in: the same as giving none.
      if (value.cwd !== undefined && jsReference(value.cwd) !== "cwd" && typeof value.cwd !== "string") return { definition: null, problem: "工作目录是 HarnessHub 读不了的表达式" };
      break;
    }
    case "opencode": {
      const list = strings(value.command) ?? [];
      url = text(value.url); command = list[0] ?? null; args = list.slice(1);
      transport = value.type === "remote" || url !== null ? "http" : "stdio";
      envValues(value.environment); headerValues(value.headers);
      break;
    }
    default: {
      url = text(value.httpUrl) ?? text(value.url) ?? text(value.serverUrl); command = text(value.command); args = value.args === undefined ? [] : strings(value.args);
      const type = text(value.type) ?? text(value.transport);
      transport = type === "sse" || (style === "gemini" && value.httpUrl === undefined && url !== null && type === null) ? "sse" : url !== null ? "http" : "stdio";
      envValues(value.env); headerValues(value.headers);
    }
  }
  if (args === null) return { definition: null, problem: "参数不是字符串列表" };
  const definition: McpDefinition = { transport, command: transport === "stdio" ? command : null, args: transport === "stdio" ? args : [], cwd: typeof value.cwd === "string" ? text(value.cwd) : null, url: transport === "stdio" ? null : url,
    env: [...env].sort((left, right) => left.key.localeCompare(right.key)), headers: [...headers].sort((left, right) => left.name.localeCompare(right.name)) };
  const problem = definitionProblem(definition);
  return problem === null ? { definition, problem: null } : { definition: null, problem };
}

/** Two definitions mean the same server. */
export function sameMcp(left: McpDefinition, right: McpDefinition): boolean { return isDeepStrictEqual(canonical(left), canonical(right)); }
/** A value with its object keys sorted at every level, so its JSON does not depend on the order a Harness wrote them in. */
export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => canonical(item)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) as T;
  return value;
}

/**
 * The keys of a server entry that HarnessHub writes and owns, per Harness: everything else (timeouts, tool approvals,
 * `enabled`, `trust`) stays the user's and is never changed or counted.
 */
export const MCP_OWNED: Readonly<Record<McpStyle, readonly string[]>> = {
  claude: ["type", "command", "args", "env", "cwd", "url", "headers"],
  cursor: ["type", "command", "args", "env", "cwd", "url", "headers"],
  gemini: ["command", "args", "env", "cwd", "url", "httpUrl", "headers"],
  hermes: ["command", "args", "env", "cwd", "url", "headers"],
  opencode: ["type", "command", "environment", "url", "headers"],
  codex: ["command", "args", "env", "env_vars", "cwd", "url", "bearer_token_env_var", "env_http_headers", "http_headers"],
  dsh: ["serverName", "transport", "command", "args", "env", "cwd", "url", "headers"],
};
/** The owned part of a server entry as written in a file, canonical; undefined when there is no such entry. */
export function ownedOf(raw: unknown, style: McpStyle): unknown {
  if (raw === undefined) return undefined;
  const value = record(raw);
  return canonical(Object.fromEntries(MCP_OWNED[style].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
}

/** What a definition is written as in one Harness's file (its owned keys), or why that Harness cannot express it. */
export type McpRender = { readonly ok: true; readonly value: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly reason: string };
/**
 * A definition as one Harness writes it: its own variable reference syntax and transport names. What a Harness cannot
 * express (SSE, a renamed variable, a header prefix) is refused with the reason, never written another way.
 */
export function renderMcp(definition: McpDefinition, style: McpStyle): McpRender {
  const refuse = (reason: string): McpRender => ({ ok: false, reason });
  const ref = (variable: string, prefix = ""): string => prefix + (style === "cursor" ? "${env:" + variable + "}" : style === "opencode" ? "{env:" + variable + "}" : "${" + variable + "}");
  const env = Object.fromEntries(definition.env.map(item => [item.key, "variable" in item ? ref(item.variable) : item.value]));
  const headers = Object.fromEntries(definition.headers.map(item => [item.name, "variable" in item ? ref(item.variable, item.prefix) : item.value]));
  const optional = (key: string, value: unknown) => value === null || value === undefined || (Array.isArray(value) && !value.length) || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length) ? {} : { [key]: value };
  const done = (value: Record<string, unknown>): McpRender => ({ ok: true, value: canonical(value) });
  switch (style) {
    case "codex": {
      if (definition.transport === "sse") return refuse("Codex 不支持 SSE 传输");
      const references = definition.env.filter((item): item is { key: string; variable: string } => "variable" in item), literals = definition.env.filter((item): item is { key: string; value: string } => "value" in item);
      if (references.some(item => item.key !== item.variable)) return refuse("Codex 只能把同名的环境变量转给服务器（env_vars），变量名与键不同时无法表达");
      const bearer = definition.headers.find(item => "variable" in item && item.name.toLowerCase() === "authorization" && item.prefix === "Bearer ");
      if (definition.headers.some(item => item !== bearer && "variable" in item && item.prefix !== "")) return refuse("Codex 的请求头只能整段取自一个环境变量（或 Authorization: Bearer），不能带其他前缀");
      if (definition.transport === "stdio") return done({ command: definition.command, ...optional("args", definition.args), ...optional("env", Object.fromEntries(literals.map(item => [item.key, item.value]))),
        ...optional("env_vars", references.map(item => item.variable)), ...optional("cwd", definition.cwd) });
      return done({ url: definition.url, ...optional("bearer_token_env_var", bearer !== undefined && "variable" in bearer ? bearer.variable : null),
        ...optional("env_http_headers", Object.fromEntries(definition.headers.filter(item => item !== bearer && "variable" in item).map(item => [item.name, (item as { variable: string }).variable]))),
        ...optional("http_headers", Object.fromEntries(definition.headers.filter(item => "value" in item).map(item => [item.name, (item as { value: string }).value]))) });
    }
    case "opencode":
      return definition.transport === "stdio" ? done({ type: "local", command: [definition.command, ...definition.args], ...optional("environment", env) })
        : done({ type: "remote", url: definition.url, ...optional("headers", headers) });
    case "hermes":
      if (definition.transport === "sse") return refuse("这个版本的 Hermes 不支持 SSE 传输");
      return definition.transport === "stdio" ? done({ command: definition.command, ...optional("args", definition.args), ...optional("env", env), ...optional("cwd", definition.cwd) })
        : done({ url: definition.url, ...optional("headers", headers) });
    case "gemini":
      return definition.transport === "stdio" ? done({ command: definition.command, ...optional("args", definition.args), ...optional("env", env), ...optional("cwd", definition.cwd) })
        : done({ [definition.transport === "http" ? "httpUrl" : "url"]: definition.url, ...optional("headers", headers) });
    case "dsh": {
      if (definition.transport === "sse") return refuse("DeepSeek Harness 不支持 SSE 传输");
      const js = (variable: string, prefix = ""): JsExpression => ({ jsExpression: (prefix ? "'" + prefix + "' + " : "") + "process.env." + variable });
      if (definition.headers.some(item => "variable" in item && !/^[A-Za-z0-9 _:-]{0,32}$/u.test(item.prefix))) return refuse("请求头的前缀只能是字母、数字、空格和 _ : -");
      const dshEnv = Object.fromEntries(definition.env.map(item => [item.key, "variable" in item ? js(item.variable) : item.value]));
      const dshHeaders = Object.fromEntries(definition.headers.map(item => [item.name, "variable" in item ? js(item.variable, item.prefix) : item.value]));
      // Its stdio bridge drops ambient variables whose names look like credentials, so every variable is passed explicitly.
      return definition.transport === "stdio" ? done({ transport: "stdio", command: definition.command, args: [...definition.args], env: dshEnv, ...optional("cwd", definition.cwd) })
        : done({ transport: "streamable-http", url: definition.url, ...optional("headers", dshHeaders) });
    }
    case "claude": case "cursor":
      // Claude names the transport; Cursor's own entries carry none (it tells HTTP from SSE by itself).
      return definition.transport === "stdio" ? done({ ...(style === "claude" ? { type: "stdio" } : {}), command: definition.command, ...optional("args", definition.args), ...optional("env", env), ...optional("cwd", definition.cwd) })
        : done({ ...(style === "claude" ? { type: definition.transport } : {}), url: definition.url, ...optional("headers", headers) });
  }
}
/** The variables a definition needs from the user's environment. */
export function mcpVariables(definition: McpDefinition): readonly string[] {
  return [...new Set([...definition.env.flatMap(item => "variable" in item ? [item.variable] : []), ...definition.headers.flatMap(item => "variable" in item ? [item.variable] : [])])].sort();
}
/** The command line a definition runs, as shown in a confirmation (credentials masked). */
export function commandLine(definition: McpDefinition): string | null {
  return definition.command === null ? null : maskSecrets([definition.command, ...definition.args].map(part => /^[A-Za-z0-9@%+=:,./_-]+$/u.test(part) ? part : JSON.stringify(part)).join(" "));
}
