// SPDX-License-Identifier: MIT
/**
 * The model-plane commands of `hh` (06-interfaces section 5): `provider`,
 * `credential`, `key`, `group`, `model`, `catalog`, `usage`, `status`,
 * `gateway share`, `import` and `subscription`. They talk to the
 * running daemon through `@harnesshub/sdk` with the admin token found in the
 * data directory, print a table (or `--json`, the API response), and exit
 * with the codes of 06 section 5. Secrets are read from a hidden prompt,
 * stdin, an environment variable or a file, never from the command line.
 */
import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  HarnessHubError,
  HarnessHubUnavailableError,
  type SubscriptionAccountView,
  type SubscriptionBackend,
  type SubscriptionNoticeView,
  type GatewayFeaturesView,
  type UsageAlertList,
  type GatewayShareStatus,
  type HarnessHubClient,
  type MetadataField,
  type ModelOverride,
  type OverrideValues,
  type RouteGroup,
  type RouteGroupPatch,
} from "@harnesshub/sdk/client";
import {
  AdminTokenUnavailableError,
  connectLocal,
  DEFAULT_DAEMON_URL,
} from "@harnesshub/sdk/local";
import {
  budgetPeriods,
  type BudgetPeriod,
  type GatewayKeyBudget,
  type GatewayKeyQuota,
  type UsageGroupBy,
  type WireProtocol,
} from "@harnesshub/core/model-plane";
import {
  choosePreset,
  type ProviderPreset,
} from "@harnesshub/core/provider-presets";
import {
  parseRule,
  RULE_KEYS,
  ruleConditions,
  ruleKey,
  ruleLine,
  ruleWords,
  RuleSyntaxError,
} from "@harnesshub/core/route-rules";
import {
  searchBackendKinds,
  type SearchBackendKind,
} from "@harnesshub/core/gateway-features";
import type { ImportPreview } from "@harnesshub/core/import-links";
import { drained } from "./pipes.js";

const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  unavailable: 3,
  confirm: 4,
  conflict: 5,
  auth: 6,
  limit: 7,
  interrupted: 130,
} as const;

/** One command's lines of a usage text: `group rule` for `hh group rule …`. */
interface CommandUsage {
  /** The command's words after `hh`. */
  command: string;
  text: string;
}

/** Whether `words` begin with every word of `prefix`. */
function begins(prefix: readonly string[], words: readonly string[]): boolean {
  return prefix.every((part, index) => words[index] === part);
}

/**
 * The usage for `words` (the command line's words before its first option):
 * the entry of the longest command they begin with, the entries of the
 * subcommands they name the whole of (`hh group` also shows `hh group
 * rule`), then `notes`. When they begin with no command, every entry under
 * `title`.
 */
function usageFor(
  title: string,
  entries: readonly CommandUsage[],
  notes: string,
  words: readonly string[],
): string {
  const commands = entries.map((entry) => entry.command.split(" "));
  const best = Math.max(
    0,
    ...commands
      .filter((command) => begins(command, words))
      .map((command) => command.length),
  );
  const shown = best
    ? entries.filter((_, index) => {
        const command = commands[index] ?? [];
        return begins(command, words)
          ? command.length === best
          : command.length > words.length && begins(words, command);
      })
    : entries;
  const header = best || !title ? "Usage:\n" : `Usage: ${title}\n\n`;
  return `${header}${shown.map((entry) => entry.text).join("\n")}\n\n${notes}`;
}

/** The words of a command line before its first option: what `--help` is about. */
function commandWords(argv: readonly string[]): string[] {
  const at = argv.findIndex((arg) => arg.startsWith("-"));
  return [...(at < 0 ? argv : argv.slice(0, at))];
}

/** The model-plane commands' usage, one entry per command, for `hh <command> --help`. */
const COMMAND_USAGE: readonly CommandUsage[] = [
  {
    command: "provider",
    text: `  hh provider list | show <id> | presets | models <id> [--refresh]
              | add <id> --chat URL [--responses URL] [--anthropic URL]
                [--gemini URL] [--image-endpoint URL] [--name N] [--kind K]
                [--api-key-header H] [--model ID]... [--proxy URL|direct]
                [--concurrency N] [--queue N]
              | add [<id>] --preset P [--region R] [--plan P] [--name N]
                [--base URL | --chat URL ...] [--proxy URL|direct]
                [--concurrency N] [--queue N]
                [--credential-from-stdin | --credential-from-env VAR
                 | --credential-from-file PATH]
              | proxy <id> [URL|direct|default]   its own proxy; default
                follows the daemon's (network.proxy)
              | limits <id> [--concurrency N] [--queue N] [--clear]
                requests out at once and waiting on each credential;
                unset follows the gateway's limits
              | disable <id> | enable <id>   a provider switched off serves
                no calls and offers no models; it keeps its configuration
              | remove <id>
              | test <id> [--model M]
              | doctor <id> [--model M] [--deep] [--slow-ms N] [--fix]`,
  },
  {
    command: "import",
    text: `  hh import <link> | - (link on stdin) | --from claude-code|codex [--only REF]...
              shows what would be added, then asks (--yes adds without asking)`,
  },
  {
    command: "credential",
    text: `  hh credential list <provider> | add <provider> [--name N] [--id ID]
              [--protocol P]... | rotate <provider> <credential>
              | disable <provider> <credential> | enable <provider> <credential>
              | remove <provider> <credential>
              secret from a hidden prompt, --from-stdin, --from-env VAR or --from-file PATH`,
  },
  {
    command: "key",
    text: `  hh key list | create --name N --allow REF... [--expires-at TIME | --no-expiry]
              [--lan] [--rpm N] [--budget PERIOD:tokens=N,cost=USD,cache-reads]...
              | quota <keyId> [--rpm N] [--budget ...]... | quota <keyId> --clear
              | limit <keyId> | rename <keyId> <name>
              | suspend <keyId> | resume <keyId> | revoke <keyId>
              a suspended key is refused until it is resumed; a revoked
              one for good
              budgets are per calendar day, week or month in the daemon's
              local time; tokens count input, output and cache writes (and
              cache reads with cache-reads), cost is the ledger's estimate`,
  },
  {
    command: "gateway",
    text: `  hh gateway features | redaction on|off | redaction rule add NAME PATTERN
              [--ignore-case] | redaction rule remove NAME | vision MODEL|off
              | search add tavily|brave|exa|firecrawl|searxng [--base-url URL]
              [--key | --key-from-stdin | --key-from-env VAR
              | --key-from-file PATH] | search remove ID
              | alert [PERCENT|off]`,
  },
  {
    command: "gateway share",
    text: `  hh gateway share status | off | on [--host IP] [--port N] [--name HOST]...
              [--public-base-url URL]`,
  },
  {
    command: "group",
    text: `  hh group list | add <id> --member REF... [--strategy S] [--stickiness S]
              | remove <id> | auto | hide <auto-id> | restore <auto-id>
              a member is provider/model, fixed at an effort with :none to
              :max (provider/model:high), sent fast with :fast last, or
              another group (group/<id>, at most 8 deep)`,
  },
  {
    command: "group rule",
    text: `  hh group rule list <id> | add <id> use=MEMBER [tokens=200k] [images]
              [effort[=on|low|medium|high|xhigh|max]] [agents=a,b]
              [intent="..."] [compact] [time=HH:MM-HH:MM] [days=mon-fri]
              [classifier=REF] [at=N] | remove <id> <n> | move <id> <n> <to>
              | classifier <id> REF|off | effort <id> auto|off
              the first rule a turn matches puts its member first for the
              turn; an intent is judged by the group's classifier`,
  },
  {
    command: "model",
    text: `  hh model show <provider/model | provider/*>
              | set <provider/model | provider/*> KEY=VALUE... | unset <ref>
              keys: context, output (tokens), reasoning, toolcall (yes|no),
              modalities (text,image,pdf,audio,video), price.input,
              price.output, price.cacheRead, price.cacheWrite (USD per
              million tokens); KEY= removes one key of the override`,
  },
  {
    command: "subscription",
    text: `  hh subscription notice | list | login chatgpt [--provider ID] [--account ID]
              [--accept-notice] | login copilot [--provider ID] [--account ID]
              [--token | --token-from-stdin | --token-from-env VAR
              | --token-from-file PATH] [--accept-notice]
              | setup copilot [--install]
              | logout <provider> <account>
              accounts are off until their risk notice is accepted, and serve
              agents on this computer only; Copilot uses the Copilot CLI's own
              login, or a fine-grained token with Copilot Requests`,
  },
  {
    command: "catalog",
    text: `  hh catalog status | refresh`,
  },
  {
    command: "usage",
    text: `  hh usage [--by model|provider|day|key|adapter|credential|conversation|call]
              [--since 7d] [--from TIME] [--to TIME] [--provider P]
              [--model REF] [--key KEY_ID] [--agent A] [--format text|json|csv]`,
  },
  {
    command: "status",
    text: `  hh status`,
  },
];

const USAGE_NOTES = `Common options: --url URL (default ${DEFAULT_DAEMON_URL}), --data-dir DIR
(the daemon's data directory holding admin.token, default ./data), --json,
--yes, --non-interactive.`;

/** The usage of the command `argv` names, or of every command when it names none. */
function commandUsage(argv: readonly string[]): string {
  return usageFor(
    "hh <command> [options]",
    COMMAND_USAGE,
    USAGE_NOTES,
    commandWords(argv),
  );
}

const USAGE = commandUsage([]);

class UsageError extends Error {}
/** Some items of an import failed; the others were added (exit code 5). */
class ImportFailed extends Error {}
class ConfirmationRequired extends Error {}
class Interrupted extends Error {}

const common = {
  url: { type: "string" },
  "data-dir": { type: "string" },
  json: { type: "boolean" },
  yes: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  help: { type: "boolean" },
} as const;

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(
  args: string[],
  options: T,
) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: { ...common, ...options },
    });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

interface Context {
  json: boolean;
  yes: boolean;
  interactive: boolean;
  client: () => Promise<HarnessHubClient>;
}

function context(values: Record<string, unknown>): Context {
  const url = typeof values.url === "string" ? values.url : DEFAULT_DAEMON_URL;
  const dataDir =
    typeof values["data-dir"] === "string" ? values["data-dir"] : "./data";
  return {
    json: values.json === true,
    yes: values.yes === true,
    interactive:
      process.stdin.isTTY === true &&
      !process.env.CI &&
      values["non-interactive"] !== true,
    client: () => connectLocal({ dataDir, url }),
  };
}

function positionals(list: string[], names: string[]): string[] {
  if (list.length !== names.length)
    throw new UsageError(
      `Expected ${names.map((name) => `<${name}>`).join(" ") || "no arguments"}`,
    );
  return list;
}

function write(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function output(ctx: Context, value: unknown, human: () => string): void {
  write(ctx.json ? JSON.stringify(value, null, 2) : human());
}

/** Columns padded to their widest cell; IDs are never shortened. */
function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return "(none)";
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

function localTime(value: string | undefined): string {
  return value === undefined ? "-" : new Date(value).toLocaleString();
}

/** Ask `[y/N]` on stderr unless `--yes`; refuse without a terminal. */
/**
 * What every command that asks before a change says when it cannot ask (no
 * terminal, `CI`, or `--non-interactive`) and `--yes` was not given; it
 * then exits 4 and changes nothing.
 */
const NO_TERMINAL = "No terminal to confirm; pass --yes.";

async function confirm(ctx: Context, question: string): Promise<void> {
  if (ctx.yes) return;
  if (!ctx.interactive)
    throw new ConfirmationRequired(`${question} ${NO_TERMINAL}`);
  process.stderr.write(`${question} [y/N] `);
  const answer = await readLine();
  if (!/^y(es)?$/i.test(answer.trim()))
    throw new ConfirmationRequired("Cancelled; nothing was changed.");
}

function readLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk: Buffer | string) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end >= 0) {
        cleanup();
        resolve(text.slice(0, end));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(text);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });
}

/** Read a secret without echo from the terminal (stderr carries the prompt). */
function hiddenPrompt(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    process.stderr.write(question);
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Interrupted());
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b")
          value = [...value].slice(0, -1).join("");
        else value += character;
      }
    };
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const secretSources = {
  "from-stdin": { type: "boolean" },
  "from-env": { type: "string" },
  "from-file": { type: "string" },
} as const;

/** The secret value from exactly one source; one trailing newline is dropped. */
async function readSecret(
  ctx: Context,
  values: Record<string, unknown>,
  prefix = "",
): Promise<string> {
  const [stdin, env, file] = ["from-stdin", "from-env", "from-file"].map(
    (name) => `${prefix}${name}`,
  ) as [string, string, string];
  const chosen = [stdin, env, file].filter(
    (name) => values[name] !== undefined && values[name] !== false,
  );
  if (chosen.length > 1)
    throw new UsageError(`Use only one of --${stdin}, --${env}, --${file}`);
  const trim = (text: string) => text.replace(/\r?\n$/, "");
  if (values[stdin] === true) return trim(await readStdin());
  const variable = values[env];
  if (typeof variable === "string") {
    const value = process.env[variable];
    if (value === undefined)
      throw new UsageError(`Environment variable ${variable} is not set`);
    return value;
  }
  const path = values[file];
  if (typeof path === "string") return trim(await readFile(path, "utf8"));
  if (!ctx.interactive)
    throw new UsageError(
      `No terminal for a hidden prompt: pass --${stdin}, --${env} VAR or --${file} PATH`,
    );
  return hiddenPrompt("Secret value (hidden): ");
}

/** Whether any `--credential-from-*` option was given. */
function credentialGiven(values: Record<string, unknown>): boolean {
  return [
    "credential-from-stdin",
    "credential-from-env",
    "credential-from-file",
  ].some((name) => values[name] !== undefined && values[name] !== false);
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** `--concurrency N` and `--queue N` as a provider's limits; undefined without either. */
function limitsOf(
  values: Record<string, unknown>,
):
  | { concurrentPerCredential?: number; queuePerCredential?: number }
  | undefined {
  const number = (name: string): number | undefined => {
    const text = values[name];
    if (typeof text !== "string") return undefined;
    if (!/^\d+$/.test(text))
      throw new UsageError(`--${name} takes a whole number, not ${text}`);
    return Number(text);
  };
  const concurrent = number("concurrency");
  const queue = number("queue");
  if (concurrent === undefined && queue === undefined) return undefined;
  return {
    ...(concurrent !== undefined
      ? { concurrentPerCredential: concurrent }
      : {}),
    ...(queue !== undefined ? { queuePerCredential: queue } : {}),
  };
}

function limitsText(limits: {
  concurrentPerCredential?: number;
  queuePerCredential?: number;
}): string {
  return [
    limits.concurrentPerCredential !== undefined
      ? `${limits.concurrentPerCredential} at once`
      : "the gateway's number at once",
    limits.queuePerCredential !== undefined
      ? `${limits.queuePerCredential} waiting`
      : "the gateway's queue",
  ].join(", ");
}

/**
 * A preset's endpoints moved onto `base` (`--base`): each endpoint's path is
 * appended to the base's path, so `http://10.0.0.2:3180` turns
 * `http://127.0.0.1:3180/v1` into `http://10.0.0.2:3180/v1`.
 */
function rebase(
  endpoints: Partial<Record<string, string>>,
  base: string,
): Record<string, string> {
  let root: URL;
  try {
    root = new URL(base);
  } catch {
    throw new UsageError("--base must be an http(s) URL");
  }
  if (
    !["http:", "https:"].includes(root.protocol) ||
    root.username ||
    root.password ||
    root.search ||
    root.hash
  )
    throw new UsageError(
      "--base must be an http(s) URL without credentials, query or fragment",
    );
  const prefix = root.pathname.replace(/\/+$/, "");
  return Object.fromEntries(
    Object.entries(endpoints).flatMap(([protocol, url]) => {
      if (url === undefined) return [];
      const path = new URL(url).pathname.replace(/\/+$/, "");
      return [[protocol, `${root.origin}${prefix}${path}`]];
    }),
  );
}

async function providerCommand(
  args: string[],
  options: AdminOptions,
): Promise<void> {
  const [action = "", ...rest] = args;
  // Loaded on use: doctor.ts uses this module's helpers.
  if (action === "test" || action === "doctor")
    return (await import("./doctor.js")).doctorCommand(action, rest);
  const { values, positionals: given } = parse(rest, {
    name: { type: "string" },
    kind: { type: "string" },
    chat: { type: "string" },
    responses: { type: "string" },
    anthropic: { type: "string" },
    gemini: { type: "string" },
    "image-endpoint": { type: "string" },
    proxy: { type: "string" },
    concurrency: { type: "string" },
    queue: { type: "string" },
    clear: { type: "boolean" },
    "api-key-header": { type: "string" },
    model: { type: "string", multiple: true },
    preset: { type: "string" },
    region: { type: "string" },
    plan: { type: "string" },
    base: { type: "string" },
    refresh: { type: "boolean" },
    "credential-from-stdin": { type: "boolean" },
    "credential-from-env": { type: "string" },
    "credential-from-file": { type: "string" },
  });
  const ctx = context(values);
  switch (action) {
    case "presets": {
      positionals(given, []);
      const page = await presetPage(ctx, options);
      // Grouped like `magpie presets`: vendors, relays, then local servers.
      const groups = [
        ["vendor", "Vendors"],
        ["relay", "Relays"],
        ["local", "Local"],
        ["custom", "Custom"],
      ] as const;
      return output(ctx, page, () =>
        groups
          .map(
            ([kind, title]) =>
              [title, page.items.filter((item) => item.kind === kind)] as const,
          )
          .filter(([, items]) => items.length)
          .map(([title, items]) =>
            [
              `${title} (${items.length})`,
              table(
                [
                  "PRESET",
                  "NAME",
                  "ENDPOINTS",
                  "REGIONS",
                  "PLANS",
                  "KEY",
                  "VERIFIED",
                ],
                items.map((item) => [
                  item.id,
                  item.name,
                  Object.keys(item.endpoints).join(","),
                  item.regions?.map((region) => region.id).join(",") ?? "-",
                  item.plans?.map((plan) => plan.id).join(",") ?? "-",
                  item.userEndpoint
                    ? "+base URL"
                    : item.auth.methods.includes("api-key")
                      ? item.auth.methods.includes("none")
                        ? "optional"
                        : "required"
                      : "none",
                  item.verified,
                ]),
              ),
            ].join("\n"),
          )
          .join("\n\n"),
      );
    }
    case "models": {
      const [id] = positionals(given, ["id"]);
      const client = await ctx.client();
      const item = values.refresh
        ? await client.providers.refreshModels(id!)
        : await client.providers.get(id!);
      const models = item.models;
      const exposed = (model: string) =>
        models.expose === "all" || models.expose.includes(model);
      return output(ctx, models, () =>
        [
          `Source: ${models.source}${models.refreshedAt ? `, refreshed ${localTime(models.refreshedAt)}` : ""}${models.stale ? " (stale: the last refresh failed)" : ""}`,
          "",
          table(
            ["MODEL", "CONTEXT", "EXPOSED"],
            models.list.map((model) => [
              `${item.id}/${model.id}`,
              model.contextWindow?.toString() ?? "-",
              exposed(model.id) ? "yes" : "no",
            ]),
          ),
        ].join("\n"),
      );
    }
    case "list": {
      positionals(given, []);
      const page = await (await ctx.client()).providers.list();
      return output(ctx, page, () =>
        table(
          ["ID", "NAME", "KIND", "ENDPOINTS", "CREDENTIALS", "MODELS", "ON"],
          page.items.map((item) => [
            item.id,
            item.name,
            item.kind,
            Object.keys(item.endpoints).join(","),
            String(item.credentials.length),
            String(item.models.list.length),
            item.enabled === false ? "no" : "yes",
          ]),
        ),
      );
    }
    case "show": {
      const [id] = positionals(given, ["id"]);
      const item = await (await ctx.client()).providers.get(id!);
      return output(ctx, item, () =>
        [
          `ID:       ${item.id}`,
          `Name:     ${item.name}`,
          `Kind:     ${item.kind}`,
          ...(item.enabled === false
            ? [`State:    switched off (hh provider enable ${item.id})`]
            : []),
          ...(item.preset !== undefined
            ? [
                `Preset:   ${item.preset}${item.region !== undefined ? `, region ${item.region}` : ""}${item.plan !== undefined ? `, plan ${item.plan}` : ""}`,
              ]
            : []),
          ...(item.catalog !== undefined ? [`Catalog:  ${item.catalog}`] : []),
          ...(item.proxy !== undefined ? [`Proxy:    ${item.proxy}`] : []),
          ...(item.limits ? [`Limits:   ${limitsText(item.limits)}`] : []),
          `Auth:     ${item.auth.apiKeyHeader}`,
          ...Object.entries(item.endpoints).map(
            ([protocol, url]) => `Endpoint: ${protocol} ${url}`,
          ),
          `Models:   ${item.models.list.map((model) => model.id).join(", ") || "-"}`,
          `Updated:  ${localTime(item.updatedAt)}`,
          "",
          table(
            ["CREDENTIAL", "NAME", "REFERENCE", "PROTOCOLS", "ENABLED"],
            item.credentials.map((credential) => [
              credential.id,
              credential.name,
              `${credential.ref.kind}:${credential.ref.value}`,
              credential.protocols?.join(",") ?? "all",
              credential.enabled ? "yes" : "no",
            ]),
          ),
        ].join("\n"),
      );
    }
    case "add": {
      const preset =
        typeof values.preset === "string" ? values.preset : undefined;
      if (given.length > 1 || (!preset && given.length !== 1))
        throw new UsageError(
          "provider add takes <id>, or --preset P with an optional <id>",
        );
      const id = given[0];
      const endpoints: Record<string, string> = Object.fromEntries(
        (["chat", "responses", "anthropic", "gemini"] as const)
          .filter((protocol) => typeof values[protocol] === "string")
          .map((protocol) => [protocol, values[protocol] as string]),
      );
      const region =
        typeof values.region === "string" ? values.region : undefined;
      const plan = typeof values.plan === "string" ? values.plan : undefined;
      if (typeof values.base === "string" && !preset)
        throw new UsageError("--base needs --preset");
      if ((region !== undefined || plan !== undefined) && !preset)
        throw new UsageError("--region and --plan need --preset");
      if (!preset && !Object.keys(endpoints).length)
        throw new UsageError(
          "Give at least one of --chat, --responses, --anthropic, --gemini",
        );
      const client = await ctx.client();
      if (typeof values.base === "string") {
        const found = (await client.presets.list()).items.find(
          (item) => item.id === preset,
        );
        if (!found) throw new UsageError(`There is no preset ${preset}`);
        let chosen: Partial<Record<string, string>>;
        try {
          chosen = choosePreset(found, { region, plan }).preset.endpoints;
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
        for (const [protocol, url] of Object.entries(
          rebase(chosen, values.base),
        ))
          endpoints[protocol] ??= url;
      }
      const credential = credentialGiven(values)
        ? { value: await readSecret(ctx, values, "credential-") }
        : undefined;
      const models = list(values.model);
      const created = await client.providers.create({
        ...(preset
          ? {
              preset,
              ...(id !== undefined ? { id } : {}),
              ...(region !== undefined ? { region } : {}),
              ...(plan !== undefined ? { plan } : {}),
              ...(Object.keys(endpoints).length ? { endpoints } : {}),
            }
          : { id: id!, endpoints }),
        ...(credential ? { credential } : {}),
        ...(typeof values.name === "string" ? { name: values.name } : {}),
        ...(typeof values["image-endpoint"] === "string"
          ? { imageEndpoint: values["image-endpoint"] }
          : {}),
        ...(typeof values.proxy === "string" ? { proxy: values.proxy } : {}),
        ...(limitsOf(values) ? { limits: limitsOf(values)! } : {}),
        ...(typeof values.kind === "string"
          ? { kind: values.kind as "vendor" | "relay" | "local" | "custom" }
          : {}),
        ...(typeof values["api-key-header"] === "string"
          ? {
              auth: {
                apiKeyHeader: values["api-key-header"] as "x-api-key",
              },
            }
          : {}),
        ...(models.length
          ? {
              models: {
                source: "manual",
                list: models.map((model) => ({ id: model })),
                expose: "all",
              },
            }
          : {}),
      });
      return output(
        ctx,
        created,
        () =>
          `Added provider ${created.id}${created.preset ? ` from preset ${created.preset}` : ""}${created.region ? `, region ${created.region}` : ""}${created.plan ? `, plan ${created.plan}` : ""}${created.credentials.length ? " with a stored credential" : ""}`,
      );
    }
    case "proxy": {
      if (given.length < 1 || given.length > 2)
        throw new UsageError(
          "Expected provider proxy <id> [URL|direct|default]",
        );
      const [id, choice] = given as [string, string | undefined];
      const client = await ctx.client();
      const item =
        choice === undefined
          ? await client.providers.get(id)
          : await client.providers.update(id, {
              proxy: choice === "default" ? null : choice,
            });
      return output(ctx, item, () =>
        item.proxy === undefined
          ? `${item.id} follows the daemon's proxy (network.proxy)`
          : `${item.id} uses ${item.proxy === "direct" ? "no proxy (direct)" : `the proxy ${item.proxy}`}`,
      );
    }
    case "limits": {
      const [id] = positionals(given, ["id"]);
      const limits = limitsOf(values);
      if (values.clear && limits)
        throw new UsageError("Give --clear or limits, not both");
      const client = await ctx.client();
      const item =
        values.clear || limits
          ? await client.providers.update(id!, {
              limits: values.clear ? null : limits!,
            })
          : await client.providers.get(id!);
      return output(ctx, item, () =>
        item.limits
          ? `${item.id}: ${limitsText(item.limits)} on each credential`
          : `${item.id} follows the gateway's limits (gateway.limits)`,
      );
    }
    case "disable":
    case "enable": {
      const [id] = positionals(given, ["id"]);
      const client = await ctx.client();
      const item = await client.providers.update(id!, {
        enabled: action === "enable",
      });
      // The daemon marks them as soon as the change is committed; one
      // started without a wiring home has no agents to mark.
      const marked = ctx.json ? undefined : await modelless(client);
      return output(ctx, item, () =>
        [
          item.enabled === false
            ? `Switched ${item.id} off: it serves no calls and offers no models`
            : `Switched ${item.id} on`,
          ...(marked === undefined
            ? []
            : [
                marked.length
                  ? `Marked for attention, a model they are wired to gone: ${marked.join(", ")} (hh agents)`
                  : "No wired agent is left without a model",
              ]),
        ].join("\n"),
      );
    }
    case "remove":
    case "rm": {
      const [id] = positionals(given, ["id"]);
      await confirm(ctx, `Remove provider ${id} and its stored credentials?`);
      await (await ctx.client()).providers.remove(id!);
      return output(ctx, { deleted: true, id }, () => `Removed provider ${id}`);
    }
    default:
      throw new UsageError(`Unknown provider command: ${action || "(none)"}`);
  }
}

/**
 * The wired agents a model they are wired to has left the gateway
 * (`AGENT_MODEL_UNAVAILABLE`); undefined when the daemon has no wiring home.
 */
async function modelless(
  client: HarnessHubClient,
): Promise<string[] | undefined> {
  try {
    return (await client.agents.list()).items
      .filter(
        (agent) => agent.wiring?.attention?.code === "AGENT_MODEL_UNAVAILABLE",
      )
      .map((agent) => agent.id);
  } catch (error) {
    if (
      error instanceof HarnessHubError &&
      error.code === "AGENT_WIRING_UNAVAILABLE"
    )
      return undefined;
    throw error;
  }
}

async function credentialCommand(args: string[]): Promise<void> {
  const [action = "", ...rest] = args;
  const { values, positionals: given } = parse(rest, {
    name: { type: "string" },
    id: { type: "string" },
    protocol: { type: "string", multiple: true },
    ...secretSources,
  });
  const ctx = context(values);
  switch (action) {
    case "list": {
      const [provider] = positionals(given, ["provider"]);
      const page = await (await ctx.client()).credentials.list(provider!);
      return output(ctx, page, () =>
        table(
          ["CREDENTIAL", "NAME", "REFERENCE", "PROTOCOLS", "ENABLED"],
          page.items.map((item) => [
            item.id,
            item.name,
            `${item.ref.kind}:${item.ref.value}`,
            item.protocols?.join(",") ?? "all",
            item.enabled ? "yes" : "no",
          ]),
        ),
      );
    }
    case "add": {
      const [provider] = positionals(given, ["provider"]);
      const client = await ctx.client();
      const value = await readSecret(ctx, values);
      const protocols = list(values.protocol) as WireProtocol[];
      const added = await client.credentials.add(provider!, {
        name: typeof values.name === "string" ? values.name : "default",
        value,
        ...(typeof values.id === "string" ? { id: values.id } : {}),
        ...(protocols.length ? { protocols } : {}),
      });
      return output(
        ctx,
        added,
        () =>
          `Added credential ${added.id} to ${provider} (${added.ref.kind}:${added.ref.value})`,
      );
    }
    case "rotate": {
      const [provider, credential] = positionals(given, [
        "provider",
        "credential",
      ]);
      const client = await ctx.client();
      const value = await readSecret(ctx, values);
      const rotated = await client.credentials.rotate(
        provider!,
        credential!,
        value,
      );
      return output(
        ctx,
        rotated,
        () => `Rotated credential ${rotated.id} of ${provider}`,
      );
    }
    case "disable":
    case "enable": {
      const [provider, credential] = positionals(given, [
        "provider",
        "credential",
      ]);
      const updated = await (
        await ctx.client()
      ).credentials.setEnabled(provider!, credential!, action === "enable");
      return output(
        ctx,
        updated,
        () =>
          `Credential ${updated.id} of ${provider} is ${updated.enabled ? "on" : "off"}`,
      );
    }
    case "remove":
    case "rm": {
      const [provider, credential] = positionals(given, [
        "provider",
        "credential",
      ]);
      await confirm(ctx, `Remove credential ${credential} of ${provider}?`);
      await (await ctx.client()).credentials.remove(provider!, credential!);
      return output(
        ctx,
        { deleted: true, provider, id: credential },
        () => `Removed credential ${credential} of ${provider}`,
      );
    }
    default:
      throw new UsageError(`Unknown credential command: ${action || "(none)"}`);
  }
}

/**
 * `--budget PERIOD:tokens=N,cost=USD,cache-reads`: a key budget for a
 * calendar day, week or month; at least one of tokens and cost.
 */
function budgetOption(text: string): GatewayKeyBudget {
  const [period = "", rest = ""] = text.split(/:(.*)/s);
  if (!(budgetPeriods as readonly string[]).includes(period))
    throw new UsageError(
      `--budget starts with day, week or month, not ${JSON.stringify(period)}`,
    );
  const budget: GatewayKeyBudget = { period: period as BudgetPeriod };
  for (const item of rest.split(",").map((part) => part.trim())) {
    if (!item) continue;
    const [name, value] = item.split("=", 2) as [string, string | undefined];
    const number =
      value !== undefined && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
        ? Number(value)
        : NaN;
    // A cap of 0 blocks the key for the window.
    if (name === "tokens" && Number.isSafeInteger(number) && number >= 0)
      budget.tokens = number;
    else if (name === "cost" && Number.isFinite(number) && number >= 0)
      budget.costUsd = number;
    else if (name === "cache-reads" && value === undefined)
      budget.cacheReads = true;
    else
      throw new UsageError(
        `--budget takes tokens=N, cost=USD and cache-reads, not ${JSON.stringify(item)}`,
      );
  }
  if (budget.tokens === undefined && budget.costUsd === undefined)
    throw new UsageError(`--budget ${text} needs tokens=N or cost=USD`);
  return budget;
}

/** A quota in words: `60 rpm; day 1000000 tokens; month $20`. */
function quotaText(quota: GatewayKeyQuota): string {
  return [
    ...(quota.requestsPerMinute !== undefined
      ? [`${quota.requestsPerMinute} rpm`]
      : []),
    ...(quota.budgets ?? []).map((budget) =>
      [
        budget.period,
        ...(budget.tokens !== undefined
          ? [
              `${budget.tokens} tokens${budget.cacheReads ? " (with cache reads)" : ""}`,
            ]
          : []),
        ...(budget.costUsd !== undefined ? [`$${budget.costUsd}`] : []),
      ].join(" "),
    ),
  ].join("; ");
}

/** A quota as the `hh key create` options that give it: `--rpm 60 --budget day:tokens=0,cache-reads`. */
export function quotaFlags(quota: GatewayKeyQuota): string {
  return [
    ...(quota.requestsPerMinute !== undefined
      ? [`--rpm ${quota.requestsPerMinute}`]
      : []),
    ...(quota.budgets ?? []).map(
      (budget) =>
        `--budget ${[
          budget.period,
          [
            ...(budget.tokens !== undefined ? [`tokens=${budget.tokens}`] : []),
            ...(budget.costUsd !== undefined ? [`cost=${budget.costUsd}`] : []),
            ...(budget.cacheReads ? ["cache-reads"] : []),
          ].join(","),
        ].join(":")}`,
    ),
  ].join(" ");
}

/** A quota from `--rpm` and `--budget`; undefined when neither was given. */
function quotaOptions(
  values: Record<string, unknown>,
): GatewayKeyQuota | undefined {
  const budgets = list(values.budget).map(budgetOption);
  const rpm = values.rpm;
  let requestsPerMinute: number | undefined;
  if (typeof rpm === "string") {
    requestsPerMinute = Number(rpm);
    if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1)
      throw new UsageError("--rpm takes a positive integer");
  }
  if (!budgets.length && requestsPerMinute === undefined) return undefined;
  return {
    ...(requestsPerMinute !== undefined ? { requestsPerMinute } : {}),
    ...(budgets.length ? { budgets } : {}),
  };
}

async function keyCommand(args: string[]): Promise<void> {
  const [action = "", ...rest] = args;
  const { values, positionals: given } = parse(rest, {
    name: { type: "string" },
    allow: { type: "string", multiple: true },
    "expires-at": { type: "string" },
    "no-expiry": { type: "boolean" },
    lan: { type: "boolean" },
    rpm: { type: "string" },
    budget: { type: "string", multiple: true },
    clear: { type: "boolean" },
  });
  const ctx = context(values);
  switch (action) {
    case "list": {
      positionals(given, []);
      const page = await (await ctx.client()).gatewayKeys.list();
      const now = Date.now();
      return output(ctx, page, () =>
        table(
          ["KEY ID", "NAME", "SCOPE", "ALLOW", "EXPIRES", "LAN", "STATUS"],
          page.items.map((item) => [
            item.keyId,
            item.name,
            item.scope.kind,
            item.modelAllow.join(","),
            localTime(item.expiresAt),
            item.allowLan ? "yes" : "-",
            item.revokedAt
              ? "revoked"
              : item.expiresAt && Date.parse(item.expiresAt) <= now
                ? "expired"
                : item.suspendedAt
                  ? "suspended"
                  : "active",
          ]),
        ),
      );
    }
    case "create": {
      positionals(given, []);
      const allow = list(values.allow);
      if (typeof values.name !== "string" || !allow.length)
        throw new UsageError(
          "key create needs --name and at least one --allow",
        );
      if (values["no-expiry"] && values["expires-at"] !== undefined)
        throw new UsageError("Use either --expires-at or --no-expiry");
      if (values["no-expiry"] && values.lan)
        throw new UsageError("A --lan key must expire; drop --no-expiry");
      const quota = quotaOptions(values);
      const created = await (
        await ctx.client()
      ).gatewayKeys.create({
        name: values.name,
        modelAllow: allow,
        ...(quota ? { quota } : {}),
        ...(values.lan ? { allowLan: true } : {}),
        ...(values["no-expiry"] ? { expiresAt: null } : {}),
        ...(typeof values["expires-at"] === "string"
          ? { expiresAt: values["expires-at"] }
          : {}),
      });
      process.stderr.write(
        `Created key ${created.gatewayKey.keyId}. Store it now: it is not shown again.\n`,
      );
      return output(ctx, created, () => created.key);
    }
    case "quota": {
      const [keyId] = positionals(given, ["keyId"]);
      const quota = quotaOptions(values);
      if (values.clear ? quota !== undefined : quota === undefined)
        throw new UsageError(
          "key quota takes --rpm N and --budget ..., or --clear alone",
        );
      const updated = await (
        await ctx.client()
      ).gatewayKeys.setQuota(keyId!, quota ?? {});
      return output(ctx, updated, () =>
        updated.quota
          ? `Key ${updated.keyId}: ${quotaText(updated.quota)}`
          : `Key ${updated.keyId} has no quota`,
      );
    }
    case "limit": {
      const [keyId] = positionals(given, ["keyId"]);
      const limit = await (await ctx.client()).gatewayKeys.limit(keyId!);
      return output(ctx, limit, () =>
        [
          `Key ${limit.keyId} (${limit.name})${limit.requestsPerMinute !== undefined ? `, ${limit.requestsPerMinute} requests per minute` : ""}; windows in ${limit.timeZone}`,
          table(
            [
              "PERIOD",
              "TOKENS",
              "COST USD",
              "CALLS",
              "IN FLIGHT",
              "RESETS",
              "STATUS",
            ],
            limit.budgets.map((item) => [
              item.period,
              item.tokenLimit !== undefined
                ? `${item.tokens}/${item.tokenLimit}${item.cacheReads ? " (with cache reads)" : ""}`
                : String(item.tokens),
              item.costLimitUsd !== undefined
                ? `${item.costUsd.toFixed(4)}/${item.costLimitUsd}`
                : item.costUsd.toFixed(4),
              String(item.calls),
              String(item.inFlight),
              localTime(item.resetsAt),
              item.spent ? "spent" : "ok",
            ]),
          ),
        ].join("\n"),
      );
    }
    case "rename": {
      const [keyId, name] = positionals(given, ["keyId", "name"]);
      const renamed = await (
        await ctx.client()
      ).gatewayKeys.rename(keyId!, name!);
      return output(
        ctx,
        renamed,
        () => `Key ${renamed.keyId} is named ${renamed.name}`,
      );
    }
    case "suspend":
    case "resume": {
      const [keyId] = positionals(given, ["keyId"]);
      const client = await ctx.client();
      const updated =
        action === "suspend"
          ? await client.gatewayKeys.suspend(keyId!)
          : await client.gatewayKeys.resume(keyId!);
      return output(ctx, updated, () =>
        updated.suspendedAt
          ? `Suspended key ${updated.keyId}: it is refused until hh key resume ${updated.keyId}`
          : `Resumed key ${updated.keyId}`,
      );
    }
    case "revoke": {
      const [keyId] = positionals(given, ["keyId"]);
      await confirm(ctx, `Revoke Gateway Key ${keyId}?`);
      const revoked = await (await ctx.client()).gatewayKeys.revoke(keyId!);
      return output(ctx, revoked, () => `Revoked key ${revoked.keyId}`);
    }
    default:
      throw new UsageError(`Unknown key command: ${action || "(none)"}`);
  }
}

async function groupCommand(args: string[]): Promise<void> {
  const [action = "", ...rest] = args;
  const { values, positionals: given } = parse(rest, {
    member: { type: "string", multiple: true },
    strategy: { type: "string" },
    stickiness: { type: "string" },
  });
  const ctx = context(values);
  switch (action) {
    case "list": {
      positionals(given, []);
      const page = await (await ctx.client()).routeGroups.list();
      return output(ctx, page, () =>
        table(
          ["GROUP", "STRATEGY", "STICKINESS", "MEMBERS"],
          page.items.map((item) => [
            `group/${item.id}`,
            item.strategy,
            item.stickiness,
            item.members.join(","),
          ]),
        ),
      );
    }
    case "add": {
      const [id] = positionals(given, ["id"]);
      const members = list(values.member);
      if (!members.length)
        throw new UsageError("group add needs at least one --member");
      const created = await (
        await ctx.client()
      ).routeGroups.create({
        id: id!,
        members,
        ...(typeof values.strategy === "string"
          ? { strategy: values.strategy as "order" }
          : {}),
        ...(typeof values.stickiness === "string"
          ? { stickiness: values.stickiness as "auto" }
          : {}),
      });
      return output(ctx, created, () => `Added group/${created.id}`);
    }
    case "remove":
    case "rm": {
      const [id] = positionals(given, ["id"]);
      await confirm(ctx, `Remove route group ${id}?`);
      await (await ctx.client()).routeGroups.remove(id!);
      return output(ctx, { deleted: true, id }, () => `Removed group/${id}`);
    }
    case "auto": {
      positionals(given, []);
      const page = await (await ctx.client()).autoGroups.list();
      return output(ctx, page, () =>
        table(
          ["GROUP", "MODEL", "MEMBERS", "HIDDEN"],
          page.items.map((item) => [
            `group/${item.id}`,
            item.model,
            item.members.join(","),
            item.hidden ? "yes" : "no",
          ]),
        ),
      );
    }
    case "hide": {
      const [id] = positionals(given, ["id"]);
      await (await ctx.client()).autoGroups.hide(id!);
      return output(
        ctx,
        { hidden: true, id },
        () => `Hid group/${id}; hh group restore ${id} shows it again`,
      );
    }
    case "restore": {
      const [id] = positionals(given, ["id"]);
      await (await ctx.client()).autoGroups.restore(id!);
      return output(ctx, { hidden: false, id }, () => `Restored group/${id}`);
    }
    case "rule":
      return groupRuleCommand(ctx, given);
    default:
      throw new UsageError(`Unknown group command: ${action || "(none)"}`);
  }
}

/** A group's rules as `hh group rule list` shows them. */
function rulesText(group: RouteGroup): string {
  const head = [
    `group/${group.id}`,
    ...(group.classifier ? [`classifier ${group.classifier}`] : []),
    ...(group.effort ? [`effort ${group.effort}`] : []),
  ].join(", ");
  return `${head}\n${table(
    ["N", "USE", "WHEN", "TYPED"],
    (group.rules ?? []).map((rule, index) => [
      String(index + 1),
      rule.use,
      ruleConditions(rule).join(", "),
      ruleLine(rule),
    ]),
  )}`;
}

/**
 * Typed rule words: each argument, or the words of one that holds a whole
 * rule (`'use=a/m tokens=200k'`); an argument whose value has spaces of
 * its own (`intent=a quick question`) stays one word.
 */
function typedWords(args: readonly string[]): string[] {
  return args.flatMap((arg) => {
    const words = ruleWords(arg);
    return words.length > 1 &&
      words.every((word) => RULE_KEYS.has(ruleKey(word)))
      ? words
      : [arg];
  });
}

/** A rule's place from 1, within `count` (`count + 1` for a place at the end). */
function rulePlace(text: string | undefined, count: number): number {
  const place = Number(text);
  if (!/^\d+$/.test(text ?? "") || place < 1 || place > count)
    throw new UsageError(
      `${text ?? "(none)"} is not a rule's place: 1 to ${count}`,
    );
  return place;
}

async function groupRuleCommand(ctx: Context, given: string[]): Promise<void> {
  const [verb = "", id, ...rest] = given;
  if (!id) throw new UsageError(`hh group rule ${verb || "list"} <id> …`);
  const client = await ctx.client();
  const group = await client.routeGroups.get(id);
  const rules = [...(group.rules ?? [])];
  const save = async (patch: RouteGroupPatch, said: string) => {
    const updated = await client.routeGroups.update(id, patch);
    return output(ctx, updated, () => `${said}\n${rulesText(updated)}`);
  };
  switch (verb) {
    case "list":
      positionals(rest, []);
      return output(ctx, group, () => rulesText(group));
    case "add": {
      let typed;
      try {
        typed = parseRule(group.members, id, typedWords(rest));
      } catch (error) {
        if (error instanceof RuleSyntaxError)
          throw new UsageError(error.message);
        throw error;
      }
      if (typed.rule.intent && !typed.classifier && !group.classifier)
        throw new UsageError(
          "a rule with an intent needs the group's classifier, the model that tells which intent a message is: add classifier=<provider/model>, best a small fast one",
        );
      const at =
        typed.at === undefined
          ? rules.length + 1
          : rulePlace(String(typed.at), rules.length + 1);
      rules.splice(at - 1, 0, typed.rule);
      return save(
        {
          rules,
          ...(typed.classifier ? { classifier: typed.classifier } : {}),
        },
        `Added rule ${at} to group/${id}`,
      );
    }
    case "remove":
    case "rm": {
      const [place] = positionals(rest, ["n"]);
      const n = rulePlace(place, rules.length);
      rules.splice(n - 1, 1);
      return save(
        { rules: rules.length ? rules : null },
        `Removed rule ${n} from group/${id}`,
      );
    }
    case "move":
    case "mv": {
      const [from, to] = positionals(rest, ["n", "to"]);
      const n = rulePlace(from, rules.length);
      const place = rulePlace(to, rules.length);
      const [moved] = rules.splice(n - 1, 1);
      rules.splice(place - 1, 0, moved!);
      return save({ rules }, `Moved rule ${n} of group/${id} to ${place}`);
    }
    case "classifier": {
      const [model] = positionals(rest, ["provider/model|off"]);
      return save(
        { classifier: model === "off" ? null : model! },
        model === "off"
          ? `group/${id} has no classifier`
          : `group/${id} asks ${model} which intent a message is`,
      );
    }
    case "effort": {
      const [effort] = positionals(rest, ["auto|off"]);
      if (effort !== "auto" && effort !== "off")
        throw new UsageError("hh group rule effort <id> auto|off");
      return save(
        { effort: effort === "off" ? null : "auto" },
        effort === "off"
          ? `group/${id}'s turns ask for the reasoning the agent asks for`
          : `group/${id}'s classifier picks each turn's reasoning`,
      );
    }
    default:
      throw new UsageError(`Unknown group rule command: ${verb || "(none)"}`);
  }
}

/** `7d`, `24h`, `30m` before now, as an RFC 3339 time. */
/** `hh model set` keys and the fields they override. */
const OVERRIDE_KEYS: Readonly<Record<string, MetadataField>> = {
  context: "contextWindow",
  output: "maxOutputTokens",
  reasoning: "reasoning",
  toolcall: "toolCall",
  modalities: "inputModalities",
  "price.input": "price.input",
  "price.output": "price.output",
  "price.cacheRead": "price.cacheRead",
  "price.cacheWrite": "price.cacheWrite",
};
function fieldValue(field: MetadataField, values: OverrideValues): unknown {
  if (field.startsWith("price."))
    return values.price?.[
      field.slice(6) as keyof NonNullable<OverrideValues["price"]>
    ];
  return values[field as Exclude<keyof OverrideValues, "price">];
}

/** Parse `KEY=VALUE` for `field`; an empty value removes the key. */
function overrideValue(key: string, field: MetadataField, text: string) {
  const fail = (expected: string): never => {
    throw new UsageError(`${key} must be ${expected}`);
  };
  if (text === "") return undefined;
  switch (field) {
    case "contextWindow":
    case "maxOutputTokens":
      return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text))
        ? Number(text)
        : fail("a positive whole number of tokens");
    case "reasoning":
    case "toolCall":
      return /^(yes|true)$/i.test(text)
        ? true
        : /^(no|false)$/i.test(text)
          ? false
          : fail("yes or no");
    case "inputModalities": {
      const items = text.split(",").map((item) => item.trim());
      return items.every((item) =>
        ["text", "image", "pdf", "audio", "video"].includes(item),
      ) && new Set(items).size === items.length
        ? items
        : fail("a comma-separated list of text, image, pdf, audio, video");
    }
    case "price.input":
    case "price.output":
    case "price.cacheRead":
    case "price.cacheWrite":
      return /^\d+(\.\d+)?$/.test(text)
        ? Number(text)
        : fail("a price in USD per million tokens, such as 0.27");
  }
}

/** `values` with `field` set (or removed when `value` is undefined). */
function withField(
  values: OverrideValues,
  field: MetadataField,
  value: unknown,
): OverrideValues {
  if (field.startsWith("price.")) {
    const price = { ...values.price, [field.slice(6)]: value };
    for (const [name, item] of Object.entries(price))
      if (item === undefined) delete price[name as keyof typeof price];
    const { price: _price, ...rest } = values;
    return Object.keys(price).length ? { ...rest, price } : rest;
  }
  const next: Record<string, unknown> = { ...values, [field]: value };
  if (value === undefined) delete next[field];
  return next as OverrideValues;
}

function display(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

/** A source time: ISO date-times in local time, a preset's verification date as it is. */
function when(at: string | undefined): string {
  return at === undefined ? "-" : at.includes("T") ? localTime(at) : at;
}

function describeOverride(item: ModelOverride): string {
  return (Object.keys(OVERRIDE_KEYS) as string[])
    .map((key) => [key, fieldValue(OVERRIDE_KEYS[key]!, item.values)] as const)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${display(value)}`)
    .join(" ");
}

async function modelCommand(args: string[]): Promise<void> {
  const [action = "", ...rest] = args;
  const { values, positionals: given } = parse(rest, {});
  const ctx = context(values);
  const wildcard = (ref: string) => ref.endsWith("/*");
  switch (action) {
    case "show": {
      const [ref] = positionals(given, ["ref"]);
      const client = await ctx.client();
      if (wildcard(ref!)) {
        const item = await client.models.getOverride(ref!);
        return output(ctx, item, () =>
          [
            `Override:  ${item.ref}`,
            `Values:    ${describeOverride(item)}`,
            `Updated:   ${localTime(item.updatedAt)}`,
          ].join("\n"),
        );
      }
      const item = await client.models.get(ref!);
      return output(ctx, item, () =>
        [
          `Model:     ${item.ref}${item.listed ? "" : " (not in the provider's model list)"}`,
          "",
          table(
            ["KEY", "VALUE", "SOURCE", "SINCE"],
            Object.entries(OVERRIDE_KEYS).map(([key, field]) => {
              const resolved = item.fields[field];
              return resolved
                ? [
                    key,
                    display(resolved.value),
                    resolved.source,
                    when(resolved.at),
                  ]
                : [key, "unknown", "-", "-"];
            }),
          ),
          ...(item.overrides.length ? [""] : []),
          ...item.overrides.map(
            (override) =>
              `Override ${override.ref}: ${describeOverride(override)}`,
          ),
        ].join("\n"),
      );
    }
    case "set": {
      const [ref, ...pairs] = given;
      if (ref === undefined || pairs.length === 0)
        throw new UsageError("Expected <ref> KEY=VALUE...");
      const client = await ctx.client();
      let current: OverrideValues = {};
      try {
        current = (await client.models.getOverride(ref)).values;
      } catch (error) {
        if (!(
          error instanceof HarnessHubError &&
          error.code === "MODEL_OVERRIDE_NOT_FOUND"
        ))
          throw error;
      }
      let next = current;
      for (const pair of pairs) {
        const equals = pair.indexOf("=");
        const key = equals > 0 ? pair.slice(0, equals) : pair;
        const field = Object.hasOwn(OVERRIDE_KEYS, key)
          ? OVERRIDE_KEYS[key]
          : undefined;
        if (equals <= 0 || field === undefined)
          throw new UsageError(
            `Expected KEY=VALUE with KEY one of ${Object.keys(OVERRIDE_KEYS).join(", ")}`,
          );
        next = withField(
          next,
          field,
          overrideValue(key, field, pair.slice(equals + 1)),
        );
      }
      if (Object.keys(next).length === 0) {
        if (Object.keys(current).length)
          await client.models.removeOverride(ref);
        return output(
          ctx,
          { ref, values: null },
          () => `Removed the override of ${ref}.`,
        );
      }
      const saved = await client.models.setOverride(ref, next);
      return output(
        ctx,
        saved,
        () => `Override ${saved.ref}: ${describeOverride(saved)}`,
      );
    }
    case "unset": {
      const [ref] = positionals(given, ["ref"]);
      await (await ctx.client()).models.removeOverride(ref!);
      return output(
        ctx,
        { ref, values: null },
        () => `Removed the override of ${ref}.`,
      );
    }
    default:
      throw new UsageError(`Unknown model action: ${action || "(none)"}`);
  }
}

async function catalogCommand(args: string[]): Promise<void> {
  const [action = "", ...rest] = args;
  const { values, positionals: given } = parse(rest, {});
  const ctx = context(values);
  if (action !== "status" && action !== "refresh")
    throw new UsageError(`Unknown catalog action: ${action || "(none)"}`);
  positionals(given, []);
  const client = await ctx.client();
  const status =
    action === "refresh"
      ? await client.catalog.refresh()
      : await client.catalog.status();
  const { snapshot, lastRefresh, autoRefresh } = status;
  output(ctx, status, () =>
    [
      `Catalog:   ${status.source === "refreshed" ? "refreshed copy" : "bundled snapshot"} of models.dev, ${snapshot.providers} providers, ${snapshot.models} models`,
      `Retrieved: ${localTime(snapshot.retrievedAt)} from ${snapshot.source}`,
      `Commit:    ${snapshot.commit ?? "unknown"}`,
      `SHA-256:   ${snapshot.sha256} (${snapshot.bytes} bytes upstream)`,
      `License:   ${snapshot.license}`,
      `Refresh:   ${
        autoRefresh.enabled
          ? `on, every 24 h from ${status.url}${status.nextRefreshAt ? `; next ${localTime(status.nextRefreshAt)}` : ""}`
          : `off (${autoRefresh.disabledBy === "offline" ? "HH_OFFLINE=1" : "catalog.autoRefresh: false"}); hh catalog refresh fetches ${status.url}`
      }`,
      `Last:      ${
        lastRefresh
          ? `${localTime(lastRefresh.at)}, ${lastRefresh.outcome}${lastRefresh.error ? `: ${lastRefresh.error}` : ""}`
          : "never"
      }`,
    ].join("\n"),
  );
}

function since(text: string): string {
  const match = /^(\d{1,5})([dhm])$/.exec(text);
  if (!match)
    throw new UsageError("--since takes a duration like 7d, 24h or 30m");
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2] as "d"];
  return new Date(Date.now() - Number(match[1]) * unit).toISOString();
}

/** Conversations shown by `hh usage --by conversation`; `--json` prints the API page. */
const CONVERSATION_ROWS = 200;
/** Calls shown by `hh usage --by call`; `--json` prints the API page, `--format csv` every call. */
const CALL_ROWS = 50;

/**
 * Copy a CSV export to standard output as it arrives; when the reader of
 * standard output goes away (`… | head`), the rest is not fetched.
 */
async function writeStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!process.stdout.write(value) && !(await drained(process.stdout))) {
        await reader.cancel();
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function usageCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {
    by: { type: "string" },
    since: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    key: { type: "string" },
    agent: { type: "string" },
    format: { type: "string" },
  });
  positionals(given, []);
  const format = values.format ?? (values.json ? "json" : "text");
  if (!["text", "json", "csv"].includes(format))
    throw new UsageError("--format is text, json or csv");
  if (values.json && format !== "json")
    throw new UsageError("Use either --json or --format");
  const ctx = context({ ...values, json: format === "json" });
  if (values.since !== undefined && values.from !== undefined)
    throw new UsageError("Use either --since or --from");
  const by = values.by ?? "model";
  const groups = ["model", "provider", "day", "key", "adapter", "credential"];
  if (by !== "conversation" && by !== "call" && !groups.includes(by))
    throw new UsageError(
      "--by is model, provider, day, key, adapter, credential, conversation or call",
    );
  if (format === "csv" && by === "conversation")
    throw new UsageError(
      "--format csv is for the calls (--by call) or their sums, not conversations",
    );
  const from = values.since !== undefined ? since(values.since) : values.from;
  const filter = {
    ...(from !== undefined ? { from } : {}),
    ...(values.to !== undefined ? { to: values.to } : {}),
    ...(values.provider !== undefined ? { provider: values.provider } : {}),
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(values.key !== undefined ? { keyId: values.key } : {}),
    ...(values.agent !== undefined ? { agent: values.agent } : {}),
  };
  const client = await ctx.client();
  if (by === "call") {
    if (format === "csv")
      return writeStream(await client.modelCalls.csv(filter));
    const page = await client.modelCalls.list({ ...filter, limit: CALL_ROWS });
    return output(ctx, page, () =>
      [
        table(
          [
            "TIME",
            "AGENT",
            "MODEL",
            "STATUS",
            "INPUT",
            "CACHE READ",
            "OUTPUT",
            "COST USD",
            "MS",
            "CALL",
          ],
          page.items.map((item) => [
            localTime(item.occurredAt),
            item.agent?.id ?? "-",
            item.modelRef ?? item.requestedModel ?? "-",
            String(item.status),
            String(item.usage?.input ?? 0),
            String(item.usage?.cacheRead ?? 0),
            String(item.usage?.output ?? 0),
            item.cost?.amount ?? "-",
            String(item.timing.durationMs),
            item.callId,
          ]),
        ),
        ...(page.nextCursor
          ? [
              `Showing the ${CALL_ROWS} latest calls; narrow with --since, --from or --to, or export them all with --format csv.`,
            ]
          : []),
      ].join("\n"),
    );
  }
  if (by === "conversation") {
    const page = await client.conversations.list({
      ...filter,
      limit: CONVERSATION_ROWS,
    });
    const total = (usage: (typeof page.items)[number]["usage"]) =>
      usage.input +
      usage.cacheRead +
      usage.cacheWrite +
      usage.output +
      usage.reasoning;
    return output(ctx, page, () =>
      [
        table(
          [
            "CONVERSATION",
            "CALLS",
            "FAILED",
            "TOKENS",
            "COST USD",
            "UNPRICED",
            "FIRST",
            "LAST",
            "MODELS",
            "AGENTS",
          ],
          page.items.map((item) => [
            item.key.slice(0, 12),
            String(item.calls),
            String(item.failedCalls),
            String(total(item.usage)),
            item.cost.amount,
            String(item.unpricedCalls),
            localTime(item.firstAt),
            localTime(item.lastAt),
            item.models.join(",") || "-",
            item.agents.join(",") || "-",
          ]),
        ),
        ...(page.nextCursor
          ? [
              `Showing the ${CONVERSATION_ROWS} conversations active last; narrow with --since, --from or --to, or use --json.`,
            ]
          : []),
      ].join("\n"),
    );
  }
  const groupBy = by as UsageGroupBy;
  if (format === "csv")
    return writeStream(await client.usage.csv({ groupBy, ...filter }));
  const report = await client.usage.aggregate({ groupBy, ...filter });
  // Keys by name too: an ID alone says little.
  const keyNames =
    groupBy === "key" && !ctx.json
      ? new Map(
          (await client.gatewayKeys.list()).items.map((key) => [
            key.keyId as string,
            key.name,
          ]),
        )
      : undefined;
  output(ctx, report, () =>
    table(
      [
        groupBy.toUpperCase(),
        ...(keyNames ? ["NAME"] : []),
        "CALLS",
        "FAILED",
        "INPUT",
        "CACHE READ",
        "CACHE WRITE",
        "OUTPUT",
        "REASONING",
        "COST USD",
        "UNPRICED",
      ],
      report.items.map((bucket) => [
        bucket.key || "(none)",
        ...(keyNames ? [keyNames.get(bucket.key) ?? "-"] : []),
        String(bucket.calls),
        String(bucket.failedCalls),
        String(bucket.usage.input),
        String(bucket.usage.cacheRead),
        String(bucket.usage.cacheWrite),
        String(bucket.usage.output),
        String(bucket.usage.reasoning),
        bucket.cost.amount,
        String(bucket.unpricedCalls),
      ]),
    ),
  );
}

async function statusCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {});
  const ctx = context(values);
  positionals(given, []);
  const client = await ctx.client();
  const [info, providers, groups, keys] = await Promise.all([
    client.system.info(),
    client.providers.list(),
    client.routeGroups.list(),
    client.gatewayKeys.list(),
  ]);
  const activeKeys = keys.items.filter(
    (key) => !key.revokedAt && !key.suspendedAt,
  ).length;
  const status = {
    daemon: info,
    providers: providers.items.length,
    routeGroups: groups.items.length,
    activeGatewayKeys: activeKeys,
  };
  output(ctx, status, () =>
    [
      `Daemon:        running, pid ${info.pid}, since ${localTime(info.startedAt)}`,
      `Version:       ${info.version} (${info.commit})`,
      `API:           ${info.apiVersion}`,
      `Data dir:      ${info.dataDir}`,
      `Secrets:       ${info.secretBackend}`,
      `Providers:     ${providers.items.length}`,
      `Route groups:  ${groups.items.length}`,
      `Gateway Keys:  ${activeKeys} active`,
      ...(info.gateway
        ? [
            `Model gateway: ${info.gateway.openaiBaseUrl}`,
            "",
            `Point your OpenAI client at ${info.gateway.openaiBaseUrl} (Anthropic: ${info.gateway.anthropicBaseUrl}) with a key from hh key create.`,
          ]
        : []),
    ].join("\n"),
  );
}

function shareText(status: GatewayShareStatus): string {
  const lan = status.lan;
  return [
    `LAN sharing:   ${lan.enabled ? "on" : "off"}${lan.enabled && !status.listening ? " (not listening)" : ""}`,
    `Address:       ${lan.host ?? "-"}${lan.port !== undefined ? ` port ${lan.port}` : " (daemon port)"}${status.boundPort !== undefined ? `, bound to port ${status.boundPort}` : ""}`,
    `Names:         ${lan.names.join(", ") || "-"}`,
    `Public URL:    ${status.publicBaseUrl ?? "-"}`,
    ...(status.error ? [`Error:         ${status.error}`] : []),
    ...(status.urls.length
      ? [
          "",
          `Peers use ${status.urls.join(" or ")} with a key from hh key create --lan`,
          "(another HarnessHub: hh provider add <id> --preset harnesshub-remote --base URL).",
          "LAN traffic is plain HTTP: share on trusted networks or behind a TLS proxy.",
        ]
      : []),
  ].join("\n");
}

/** The gateway features as lines. */
function featuresText(features: GatewayFeaturesView): string {
  const lines = [
    `Redaction: ${features.redaction.enabled ? "on" : "off"}${features.redaction.rules.length ? "" : " (known secrets only)"}`,
    ...features.redaction.rules.map(
      (rule) => `  rule ${rule.name}: /${rule.pattern}/${rule.flags ?? ""}`,
    ),
    `Vision fallback: ${features.vision ? features.vision.model : "off (images become a placeholder for models without image input)"}`,
    `Web search: ${features.search?.backends.length ? "" : "off"}`,
    ...(features.search?.backends ?? []).map(
      (backend) =>
        `  ${backend.id} ${backend.kind}${backend.baseUrl ? ` ${backend.baseUrl}` : ""}${backend.hasKey ? " (key stored)" : ""}`,
    ),
    `Usage alert: ${features.alerts ? `when an allowance window reaches ${features.alerts.usagePercent}% used, once each time it runs` : "off"}`,
  ];
  return lines.join("\n");
}

/** The usage alert and the alerts of the last 40 days. */
function alertsText(alerts: UsageAlertList): string {
  return [
    `Usage alert: ${alerts.usagePercent === null ? "off" : `at ${alerts.usagePercent}% of an allowance window`}`,
    alerts.items.length
      ? table(
          ["TIME", "PROVIDER", "CREDENTIAL", "WINDOW", "USED", "RESETS"],
          alerts.items.map((alert) => [
            localTime(alert.at),
            alert.provider,
            alert.credentialName ?? alert.credential,
            alert.window,
            `${Math.round(alert.usedPercent * 10) / 10}%`,
            localTime(alert.resetsAt),
          ]),
        )
      : "No alerts in the last 40 days.",
  ].join("\n");
}

/**
 * `hh gateway features | redaction on|off | redaction rule add <name>
 * <pattern> [--ignore-case] | redaction rule remove <name> | vision
 * <model>|off | search add <kind> [--base-url URL] [key source] | search
 * remove <id> | alert [<percent>|off]`: the gateway's optional
 * capabilities (Magpie parity §11).
 * A search key is read like a credential secret, never from the command
 * line itself and never from an environment variable that is not named.
 */
async function gatewayFeaturesCommand(
  group: string,
  args: string[],
): Promise<void> {
  const { values, positionals: given } = parse(args, {
    "ignore-case": { type: "boolean" },
    "base-url": { type: "string" },
    key: { type: "boolean" },
    "key-from-stdin": { type: "boolean" },
    "key-from-env": { type: "string" },
    "key-from-file": { type: "string" },
  });
  const ctx = context(values);
  const client = await ctx.client();
  const show = (features: GatewayFeaturesView) =>
    output(ctx, features, () => featuresText(features));
  if (group === "features") {
    positionals(given, []);
    return show(await client.gatewayFeatures.get());
  }
  if (group === "alert") {
    const [value] = given;
    if (given.length > 1)
      throw new UsageError("hh gateway alert [<percent>|off]");
    if (value === undefined) {
      const alerts = await client.usage.alerts();
      return output(ctx, alerts, () => alertsText(alerts));
    }
    if (value === "off")
      return show(await client.gatewayFeatures.clearAlerts());
    if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100)
      throw new UsageError(
        "A usage alert is at a whole percent from 1 to 100, or off",
      );
    return show(await client.gatewayFeatures.setAlerts(Number(value)));
  }
  if (group === "vision") {
    const [model] = positionals(given, ["model or off"]);
    return show(
      model === "off"
        ? await client.gatewayFeatures.clearVision()
        : await client.gatewayFeatures.setVision(model!),
    );
  }
  if (group === "redaction") {
    const [action = "", ...rest] = given;
    if (action === "on" || action === "off") {
      positionals(rest, []);
      return show(
        await client.gatewayFeatures.setRedaction({ enabled: action === "on" }),
      );
    }
    if (action !== "rule")
      throw new UsageError(
        "hh gateway redaction on | off | rule add | rule remove",
      );
    const [verb = "", name = "", pattern] = rest;
    const rules = (await client.gatewayFeatures.get()).redaction.rules;
    if (verb === "add") {
      positionals(rest.slice(1), ["name", "pattern"]);
      return show(
        await client.gatewayFeatures.setRedaction({
          rules: [
            ...rules.filter(
              (rule) => rule.name.toUpperCase() !== name.toUpperCase(),
            ),
            {
              name,
              pattern: pattern!,
              ...(values["ignore-case"] ? { flags: "i" } : {}),
            },
          ],
        }),
      );
    }
    if (verb === "remove") {
      positionals(rest.slice(1), ["name"]);
      if (!rules.some((rule) => rule.name === name))
        throw new UsageError(`No redaction rule ${name}`);
      return show(
        await client.gatewayFeatures.setRedaction({
          rules: rules.filter((rule) => rule.name !== name),
        }),
      );
    }
    throw new UsageError(
      "hh gateway redaction rule add <name> <pattern> | rule remove <name>",
    );
  }
  // search
  const [action = "", ...rest] = given;
  if (action === "remove") {
    const [id] = positionals(rest, ["id"]);
    return show(await client.gatewayFeatures.removeSearch(id!));
  }
  if (action !== "add")
    throw new UsageError("hh gateway search add <kind> | remove <id>");
  const [kind] = positionals(rest, ["kind"]);
  if (!searchBackendKinds.includes(kind as SearchBackendKind))
    throw new UsageError(
      `Unknown search backend ${kind}; known: ${searchBackendKinds.join(", ")}`,
    );
  const keyGiven = (
    ["key", "key-from-stdin", "key-from-env", "key-from-file"] as const
  ).some((name) => values[name] !== undefined && values[name] !== false);
  const key =
    keyGiven || kind !== "searxng"
      ? await readSecret(ctx, values, "key-")
      : undefined;
  return show(
    await client.gatewayFeatures.addSearch({
      kind: kind as SearchBackendKind,
      ...(key !== undefined ? { key } : {}),
      ...(typeof values["base-url"] === "string"
        ? { baseUrl: values["base-url"] }
        : {}),
    }),
  );
}

async function gatewayCommand(args: string[]): Promise<void> {
  const [group = "", action = "", ...rest] = args;
  if (["features", "redaction", "vision", "search", "alert"].includes(group))
    return gatewayFeaturesCommand(group, args.slice(1));
  if (group !== "share")
    throw new UsageError(`Unknown gateway command: ${group || "(none)"}`);
  const { values, positionals: given } = parse(rest, {
    host: { type: "string" },
    port: { type: "string" },
    name: { type: "string", multiple: true },
    "public-base-url": { type: "string" },
  });
  const ctx = context(values);
  positionals(given, []);
  const changes =
    values.host !== undefined ||
    values.port !== undefined ||
    values.name !== undefined ||
    values["public-base-url"] !== undefined;
  if (action !== "on" && changes)
    throw new UsageError(
      "--host, --port, --name and --public-base-url belong to gateway share on",
    );
  const client = await ctx.client();
  switch (action) {
    case "status": {
      const status = await client.gatewayShare.status();
      return output(ctx, status, () => shareText(status));
    }
    case "on":
    case "off": {
      const current = await client.gatewayShare.status();
      let port = current.lan.port;
      if (typeof values.port === "string") {
        port = Number(values.port);
        if (!/^\d{1,5}$/.test(values.port) || port > 65535)
          throw new UsageError("--port takes a port number from 0 to 65535");
      }
      const host =
        typeof values.host === "string" ? values.host : current.lan.host;
      if (action === "on" && host === undefined)
        throw new UsageError(
          "gateway share on needs --host: an IP address of this machine, or 0.0.0.0 for every address",
        );
      const names =
        values.name !== undefined ? list(values.name) : current.lan.names;
      const publicBaseUrl =
        typeof values["public-base-url"] === "string"
          ? values["public-base-url"]
          : current.publicBaseUrl;
      const status = await client.gatewayShare.update({
        lan: {
          enabled: action === "on",
          ...(host !== undefined ? { host } : {}),
          ...(port !== undefined ? { port } : {}),
          names,
        },
        ...(publicBaseUrl !== undefined ? { publicBaseUrl } : {}),
      });
      return output(ctx, status, () => shareText(status));
    }
    default:
      throw new UsageError(
        `Unknown gateway share command: ${action || "(none)"}`,
      );
  }
}

/** The preview as lines: each provider, where its key and prompts go, and warnings. */
function previewText(preview: ImportPreview): string {
  const lines: string[] = [];
  if (preview.file) lines.push(`Read ${preview.file}`);
  for (const item of preview.items) {
    const provider = item.provider;
    const label =
      item.status === "new"
        ? "Add"
        : item.status === "exists"
          ? "Exists"
          : "Skip";
    lines.push(
      `${label}: ${provider ? `${provider.id} (${provider.name})` : item.ref}${item.reason ? ` — ${item.reason}` : ""}`,
    );
    if (!provider || item.status === "skipped") continue;
    if (provider.preset !== undefined)
      lines.push(
        `  Preset:    ${provider.preset}${provider.region !== undefined ? `, region ${provider.region}` : ""}${provider.plan !== undefined ? `, plan ${provider.plan}` : ""}`,
      );
    for (const [protocol, url] of Object.entries(provider.endpoints))
      lines.push(`  Endpoint:  ${protocol} ${url}`);
    lines.push(`  Sends to:  ${item.hosts.join(", ")}`);
    lines.push(
      `  Key:       ${
        item.key.kind === "value"
          ? `from the ${preview.source === "link" ? "link" : "file"}${item.key.last4 ? ` (…${item.key.last4})` : ""}, stored in the secret store`
          : item.key.kind === "env"
            ? `read from the environment variable ${item.key.variable}`
            : "none (add one with hh credential add)"
      }`,
    );
    lines.push(
      `  Models:    ${provider.models.length ? provider.models.join(", ") : "listed when refreshed"}`,
    );
    if (provider.headers.length)
      lines.push(`  Headers:   ${provider.headers.join(", ")}`);
    if (item.keysUrl) lines.push(`  Keys page: ${item.keysUrl}`);
  }
  for (const warning of preview.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

async function importCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {
    from: { type: "string" },
    only: { type: "string", multiple: true },
  });
  const ctx = context(values);
  const from = typeof values.from === "string" ? values.from : undefined;
  if ((from === undefined) === (given.length !== 1) || given.length > 1)
    throw new UsageError(
      "import takes one link (or - to read it from stdin), or --from claude-code|codex",
    );
  if (from !== undefined && from !== "claude-code" && from !== "codex")
    throw new UsageError("--from takes claude-code or codex");
  let link = given[0];
  if (link === "-") link = (await readStdin()).trim();
  else if (link !== undefined && ctx.interactive && /[?#&]key=/.test(link))
    process.stderr.write(
      "Note: the key in this link is now in your shell history; hh import - reads a link from stdin.\n",
    );
  const client = await ctx.client();
  const preview = await client.imports.preview(
    link !== undefined ? { link } : { app: from as "claude-code" | "codex" },
  );
  const only = list(values.only);
  const unknown = only.filter(
    (ref) => !preview.items.some((item) => item.ref === ref),
  );
  if (unknown.length)
    throw new UsageError(`The import has no item ${unknown.join(", ")}`);
  const chosen = preview.items.filter(
    (item) =>
      item.status === "new" && (!only.length || only.includes(item.ref)),
  );
  if (!ctx.json) write(previewText(preview));
  if (!chosen.length) {
    if (ctx.json) write(JSON.stringify({ preview, result: null }, null, 2));
    else write("Nothing to add.");
    return;
  }
  await confirm(
    ctx,
    `Add ${chosen.length === 1 ? `provider ${chosen[0]!.provider!.id}` : `${chosen.length} providers`}?`,
  );
  const result = await client.imports.apply(
    preview.previewId,
    chosen.map((item) => item.ref),
  );
  const failed = result.items.filter((item) => item.status === "failed");
  output(ctx, { preview, result }, () =>
    result.items
      .map((item) =>
        item.status === "created"
          ? `Added provider ${item.provider!.id}${item.provider!.credentials.length ? " with a stored credential" : ""}`
          : `${item.status === "failed" ? "Failed" : "Skipped"} ${item.ref}: ${item.reason ?? ""}${item.code ? ` (${item.code})` : ""}`,
      )
      .join("\n"),
  );
  if (failed.length)
    throw new ImportFailed(
      `${failed.length} of ${result.items.length} providers could not be added`,
    );
}

/** Subscription backends by the name people use on the command line. */
const SUBSCRIPTION_NAMES: Readonly<Record<string, SubscriptionBackend>> = {
  chatgpt: "siwc",
  copilot: "copilot",
};

function accountStatus(account: SubscriptionAccountView): string {
  if (!account.signedIn) return "signed out";
  if (!account.noticeAccepted) return "notice not accepted";
  return account.enabled ? "usable" : "disabled";
}

/**
 * `hh subscription notice | list | login chatgpt | login copilot | setup
 * copilot | logout <provider> <account>` (ADR-P09). Login shows the risk
 * notice and asks before it starts; the account is used only after that
 * acceptance. ChatGPT continues in the browser with OpenAI's own sign-in;
 * Copilot uses the Copilot CLI's own login, or a fine-grained token read
 * like a credential secret (never from the command line itself).
 */
async function subscriptionCommand(args: string[]): Promise<void> {
  const [action = "", ...rest] = args;
  const { values, positionals: given } = parse(rest, {
    provider: { type: "string" },
    account: { type: "string" },
    "accept-notice": { type: "boolean" },
    token: { type: "boolean" },
    "token-from-stdin": { type: "boolean" },
    "token-from-env": { type: "string" },
    "token-from-file": { type: "string" },
    install: { type: "boolean" },
  });
  const ctx = context(values);
  const client = await ctx.client();
  switch (action) {
    case "notice": {
      positionals(given, []);
      const notices = await client.subscriptions.notices();
      return output(ctx, notices, () =>
        notices.items
          .map(
            (notice) =>
              `${notice.title} (${notice.backend}, notice ${notice.version})\n\n${notice.text}\n\nManage usage: ${notice.manageUsageUrl}`,
          )
          .join("\n\n"),
      );
    }
    case "list": {
      positionals(given, []);
      const accounts = await client.subscriptions.accounts();
      return output(ctx, accounts, () =>
        table(
          ["PROVIDER", "ACCOUNT", "NAME", "STATUS", "ACCEPTED"],
          accounts.items.map((account) => [
            account.provider,
            account.credential,
            account.email ??
              (account.login
                ? `${account.login} (${account.auth === "token" ? "token" : "Copilot CLI login"})`
                : "-"),
            accountStatus(account),
            localTime(account.acceptedAt),
          ]),
        ),
      );
    }
    case "login": {
      const [name] = positionals(given, ["subscription"]);
      const backend = SUBSCRIPTION_NAMES[name!];
      if (!backend)
        throw new UsageError(
          `Unknown subscription ${name}; known: ${Object.keys(SUBSCRIPTION_NAMES).join(", ")}`,
        );
      const notice = (await client.subscriptions.notices()).items.find(
        (item) => item.backend === backend,
      );
      if (!notice) throw new Error(`The daemon has no notice for ${name}`);
      if (backend === "copilot")
        return copilotLogin(ctx, client, notice, values);
      process.stderr.write(
        `Use your ChatGPT plan\nComplete eligible AI requests in HarnessHub with usage included in your ChatGPT plan or credits balance.\n\n${notice.title} (notice ${notice.version})\n${notice.text}\nManage usage: ${notice.manageUsageUrl}\n\n`,
      );
      if (!values["accept-notice"])
        await confirm(ctx, "Accept this notice and Continue with ChatGPT?");
      let view = await client.subscriptions.startSignIn({
        backend,
        acceptNotice: notice.version,
        ...(typeof values.provider === "string"
          ? { provider: values.provider }
          : {}),
        ...(typeof values.account === "string"
          ? { credential: values.account }
          : {}),
      });
      process.stderr.write(
        `Continue with ChatGPT in your browser:\n  ${view.authorizeUrl ?? ""}\nWaiting for the sign-in to finish (until ${localTime(view.expiresAt ?? "")})...\n`,
      );
      while (view.status === "pending") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        view = await client.subscriptions.signIn(view.id);
      }
      if (view.status === "cancelled")
        throw new Error("The sign-in was cancelled");
      if (view.status === "failed")
        throw new Error(`The sign-in failed: ${view.error ?? "unknown"}`);
      const models = await refreshSubscriptionModels(client, view.provider);
      return output(ctx, view, () =>
        [
          view.firstSignIn
            ? `You're using your ChatGPT plan. Eligible usage in HarnessHub uses your ChatGPT plan. Manage usage in your ChatGPT settings: ${notice.manageUsageUrl}`
            : `Signed in again${view.email ? ` as ${view.email}` : ""}.`,
          `Account ${view.credential ?? "-"} of provider ${view.provider}${view.email ? ` (${view.email})` : ""}; it serves agents on this computer only.`,
          models,
        ].join("\n"),
      );
    }
    case "setup": {
      const [name] = positionals(given, ["subscription"]);
      if (name !== "copilot")
        throw new UsageError(
          "Only copilot needs a setup: hh subscription setup copilot",
        );
      let setup = await client.subscriptions.copilotSetup();
      if (values.install && setup.sdkVersion !== setup.supportedSdkVersion) {
        await confirm(
          ctx,
          `Install @github/copilot-sdk@${setup.supportedSdkVersion} with npm into ${setup.sdkDirectory}?`,
        );
        process.stderr.write("Installing the Copilot SDK with npm...\n");
        setup = await client.subscriptions.installCopilot();
      }
      return output(ctx, setup, () =>
        [
          setup.sdkVersion
            ? `Copilot SDK ${setup.sdkVersion} is installed in ${setup.sdkDirectory}${setup.sdkVersion === setup.supportedSdkVersion ? "." : ` (HarnessHub was written for ${setup.supportedSdkVersion}; hh subscription setup copilot --install installs it).`}`
            : `The Copilot SDK is not installed. It is an optional add-on: hh subscription setup copilot --install installs it with npm, which runs\n  ${setup.installCommand}`,
          setup.cliPath
            ? `Copilot CLI: ${setup.cliPath}`
            : "The Copilot CLI was not found on PATH; install GitHub Copilot CLI, then sign in to it or create a fine-grained token with Copilot Requests.",
          ...(setup.sdkVersion && setup.cliPath
            ? ["Next: hh subscription login copilot"]
            : []),
        ].join("\n"),
      );
    }
    case "logout": {
      const [provider, account] = positionals(given, ["provider", "account"]);
      const found = (await client.subscriptions.accounts()).items.find(
        (item) => item.provider === provider && item.credential === account,
      );
      await confirm(
        ctx,
        `Sign account ${account} of ${provider} out and clear its tokens?`,
      );
      const result = await client.subscriptions.signOut(provider!, account!);
      return output(ctx, result, () =>
        found?.backend === "copilot"
          ? found.auth === "token"
            ? `Signed out; HarnessHub no longer holds the token. It stays valid at GitHub until you revoke it there. Sign in again with hh subscription login copilot --provider ${provider} --account ${account} --token.`
            : `Signed out; the Copilot CLI's own sign-in is unchanged. Sign in again with hh subscription login copilot --provider ${provider} --account ${account}.`
          : result.revoked
            ? `Signed out; OpenAI ended the session. Sign in again with hh subscription login chatgpt --provider ${provider} --account ${account}.`
            : `Signed out locally, but OpenAI did not confirm ending the session; you can disconnect HarnessHub in ChatGPT settings.`,
      );
    }
    default:
      throw new UsageError(
        `Unknown subscription command: ${action || "(none)"}`,
      );
  }
}

/** Refresh a subscription provider's models after a sign-in; the outcome as a line. */
async function refreshSubscriptionModels(
  client: HarnessHubClient,
  provider: string,
): Promise<string> {
  try {
    const refreshed = await client.providers.refreshModels(provider);
    return `${refreshed.models.list.length} models listed for ${provider}.`;
  } catch (error) {
    return `The model list of ${provider} could not be read yet (${error instanceof Error ? error.message : "unknown"}); retry with hh provider models ${provider} --refresh.`;
  }
}

/**
 * `hh subscription login copilot`: the notice, then Copilot reports who
 * the Copilot CLI's own login (or the given token) is; nothing opens in a
 * browser.
 */
async function copilotLogin(
  ctx: Context,
  client: HarnessHubClient,
  notice: SubscriptionNoticeView,
  values: Record<string, unknown>,
): Promise<void> {
  const tokenGiven = [
    "token",
    "token-from-stdin",
    "token-from-env",
    "token-from-file",
  ].some((name) => values[name] !== undefined && values[name] !== false);
  process.stderr.write(
    `Use your GitHub Copilot plan\nHarnessHub answers your agents' model requests with GitHub Copilot through the Copilot CLI installed on this computer${tokenGiven ? ", signed in with your fine-grained token" : ", signed in with the Copilot CLI's own login"}.\n\n${notice.title} (notice ${notice.version})\n${notice.text}\nManage usage: ${notice.manageUsageUrl}\n\n`,
  );
  if (!values["accept-notice"])
    await confirm(ctx, "Accept this notice and use your Copilot plan?");
  const token = tokenGiven
    ? await readSecret(ctx, values, "token-")
    : undefined;
  const view = await client.subscriptions.startSignIn({
    backend: "copilot",
    acceptNotice: notice.version,
    auth: token === undefined ? "login" : "token",
    ...(token === undefined ? {} : { token }),
    ...(typeof values.provider === "string"
      ? { provider: values.provider }
      : {}),
    ...(typeof values.account === "string"
      ? { credential: values.account }
      : {}),
  });
  if (view.status !== "succeeded")
    throw new Error(`The sign-in failed: ${view.error ?? "unknown"}`);
  const models = await refreshSubscriptionModels(client, view.provider);
  return output(ctx, view, () =>
    [
      view.firstSignIn
        ? `You're using your GitHub Copilot plan as ${view.login ?? "-"}. Requests count against your Copilot plan; review usage in GitHub settings: ${notice.manageUsageUrl}`
        : `Signed in again as ${view.login ?? "-"}.`,
      `Account ${view.credential ?? "-"} of provider ${view.provider}; it serves agents on this computer only.`,
      models,
    ].join("\n"),
  );
}

/**
 * The daemon's presets; when no daemon answers and the `hh` app gave the
 * bundled ones (`AdminOptions.presets`), those, with a note on stderr.
 */
async function presetPage(
  ctx: Context,
  options: AdminOptions,
): Promise<{ items: readonly ProviderPreset[]; nextCursor: string | null }> {
  try {
    return await (await ctx.client()).presets.list();
  } catch (error) {
    if (
      !options.presets ||
      !(
        error instanceof HarnessHubUnavailableError ||
        error instanceof AdminTokenUnavailableError
      )
    )
      throw error;
    process.stderr.write(
      `No daemon answered (${error.message}); listing the presets bundled with this hh, which its daemon serves.\n`,
    );
    return { items: await options.presets(), nextCursor: null };
  }
}

/** What the `hh` app gives the model-plane commands. */
export interface AdminOptions {
  /**
   * The presets this build ships, which `hh provider presets` lists when no
   * daemon answers (they are the daemon's own, so nothing else needs it).
   * Called at most once, only then; it loads the gateway's preset files.
   */
  presets?: () => Promise<readonly ProviderPreset[]>;
}

const COMMANDS: Readonly<
  Record<string, (args: string[], options: AdminOptions) => Promise<void>>
> = {
  subscription: subscriptionCommand,
  import: importCommand,
  provider: providerCommand,
  credential: credentialCommand,
  key: keyCommand,
  group: groupCommand,
  model: modelCommand,
  catalog: catalogCommand,
  usage: usageCommand,
  status: statusCommand,
  gateway: gatewayCommand,
};

function exitCode(status: number): number {
  if (status === 400 || status === 404) return EXIT.usage;
  if (status === 401 || status === 403) return EXIT.auth;
  if ([409, 412, 422].includes(status)) return EXIT.conflict;
  if (status === 429 || status === 503) return EXIT.limit;
  return EXIT.internal;
}

/**
 * Print a failure (problem object on stdout with `--json`) and choose the
 * exit code; a usage error is followed by `usage`.
 */
function report(error: unknown, json: boolean, usage = USAGE): number {
  if (error instanceof HarnessHubError) {
    if (json) write(JSON.stringify(error.problem, null, 2));
    const details = [
      ...(error.problem.errors ?? []).map((item) =>
        `  ${item.pointer ?? item.parameter ?? ""}: ${item.detail}`.trimEnd(),
      ),
      ...(error.problem.references ?? []).map(
        (item) => `  used by ${item.type} ${item.id}`,
      ),
    ];
    process.stderr.write(
      `Error: ${error.message} (${error.code})\n${details.map((line) => `${line}\n`).join("")}`,
    );
    return exitCode(error.status);
  }
  const [code, message] =
    error instanceof UsageError
      ? [EXIT.usage, `${error.message}\n\n${usage}`]
      : error instanceof ConfirmationRequired
        ? [EXIT.confirm, error.message]
        : error instanceof Interrupted
          ? [EXIT.interrupted, "Interrupted"]
          : error instanceof ImportFailed
            ? [EXIT.conflict, error.message]
            : error instanceof HarnessHubUnavailableError ||
                error instanceof AdminTokenUnavailableError
              ? [EXIT.unavailable, `${error.message}. Start it with hh serve.`]
              : [
                  EXIT.internal,
                  error instanceof Error ? error.message : String(error),
                ];
  if (json)
    write(
      JSON.stringify({
        code: code === EXIT.usage ? "USAGE" : "CLI_ERROR",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  process.stderr.write(`Error: ${message}\n`);
  return code;
}

/**
 * Run one model-plane command (`argv` starts with the command name).
 *
 * @param options What the `hh` app gives (the bundled presets).
 * @returns The exit code of 06 section 5: 0, 1 internal, 2 usage or unknown
 *   name, 3 daemon unavailable, 4 confirmation needed, 5 conflict, 6
 *   authentication, 7 limit or not ready, 130 interrupted.
 */
export async function main(
  argv: string[],
  options: AdminOptions = {},
): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "--help" || args.includes("--help")) {
    write(commandUsage(argv));
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    process.stderr.write(`Unknown command: ${name}\n${USAGE}\n`);
    return EXIT.usage;
  }
  try {
    await command(args, options);
    return EXIT.ok;
  } catch (error) {
    return report(error, args.includes("--json"), commandUsage(argv));
  }
}

/** Shared with the agent commands (`agents.ts`), which use the same options, prompts and exit codes. */
export {
  commandWords,
  confirm,
  ConfirmationRequired,
  context,
  credentialGiven,
  EXIT,
  hiddenPrompt,
  Interrupted,
  list,
  localTime,
  NO_TERMINAL,
  output,
  parse,
  positionals,
  readLine,
  readSecret,
  rebase,
  report,
  table,
  usageFor,
  UsageError,
  write,
  type CommandUsage,
  type Context,
};
