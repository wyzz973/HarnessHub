// SPDX-License-Identifier: MIT
/**
 * The model-plane commands of `hh` (06-interfaces section 5): `provider`,
 * `credential`, `key`, `group`, `model`, `catalog`, `usage` and `status`. They talk to the
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
  type HarnessHubClient,
  type MetadataField,
  type ModelOverride,
  type OverrideValues,
} from "@harnesshub/sdk/client";
import {
  AdminTokenUnavailableError,
  connectLocal,
  DEFAULT_DAEMON_URL,
} from "@harnesshub/sdk/local";
import type { UsageGroupBy, WireProtocol } from "@harnesshub/core/model-plane";

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

const USAGE = `Usage: hh <command> [options]

  hh provider list | show <id> | presets | models <id> [--refresh]
              | add <id> --chat URL [--responses URL] [--anthropic URL]
                [--gemini URL] [--name N] [--kind K] [--api-key-header H]
                [--model ID]...
              | add [<id>] --preset P [--name N] [--chat URL ...]
                [--credential-from-stdin | --credential-from-env VAR
                 | --credential-from-file PATH]
              | remove <id>
  hh credential list <provider> | add <provider> [--name N] [--id ID]
              [--protocol P]... | rotate <provider> <credential>
              | remove <provider> <credential>
              secret from a hidden prompt, --from-stdin, --from-env VAR or --from-file PATH
  hh key list | create --name N --allow REF... [--expires-at TIME | --no-expiry]
              | revoke <keyId>
  hh group list | add <id> --member REF... [--strategy S] [--stickiness S]
              | remove <id>
  hh model show <provider/model | provider/*>
              | set <provider/model | provider/*> KEY=VALUE... | unset <ref>
              keys: context, output (tokens), reasoning, toolcall (yes|no),
              modalities (text,image,pdf,audio,video), price.input,
              price.output, price.cacheRead, price.cacheWrite (USD per
              million tokens); KEY= removes one key of the override
  hh catalog status | refresh
  hh usage [--by model|provider|day|key|adapter] [--since 7d] [--from TIME]
              [--to TIME] [--provider P] [--model REF] [--key KEY_ID]
  hh status

Common options: --url URL (default ${DEFAULT_DAEMON_URL}), --data-dir DIR
(the daemon's data directory holding admin.token, default ./data), --json,
--yes, --non-interactive.`;

class UsageError extends Error {}
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
async function confirm(ctx: Context, question: string): Promise<void> {
  if (ctx.yes) return;
  if (!ctx.interactive)
    throw new ConfirmationRequired(
      `${question} Confirmation needed; pass --yes to proceed without a prompt.`,
    );
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

async function providerCommand(args: string[]): Promise<void> {
  const [action = "", ...rest] = args;
  const { values, positionals: given } = parse(rest, {
    name: { type: "string" },
    kind: { type: "string" },
    chat: { type: "string" },
    responses: { type: "string" },
    anthropic: { type: "string" },
    gemini: { type: "string" },
    "api-key-header": { type: "string" },
    model: { type: "string", multiple: true },
    preset: { type: "string" },
    refresh: { type: "boolean" },
    "credential-from-stdin": { type: "boolean" },
    "credential-from-env": { type: "string" },
    "credential-from-file": { type: "string" },
  });
  const ctx = context(values);
  switch (action) {
    case "presets": {
      positionals(given, []);
      const page = await (await ctx.client()).presets.list();
      return output(ctx, page, () =>
        table(
          ["PRESET", "NAME", "KIND", "ENDPOINTS", "KEY", "VERIFIED"],
          page.items.map((item) => [
            item.id,
            item.name,
            item.kind,
            Object.keys(item.endpoints).join(","),
            item.auth.methods.includes("api-key") ? "required" : "none",
            item.verified,
          ]),
        ),
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
          ["ID", "NAME", "KIND", "ENDPOINTS", "CREDENTIALS", "MODELS"],
          page.items.map((item) => [
            item.id,
            item.name,
            item.kind,
            Object.keys(item.endpoints).join(","),
            String(item.credentials.length),
            String(item.models.list.length),
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
      const endpoints = Object.fromEntries(
        (["chat", "responses", "anthropic", "gemini"] as const)
          .filter((protocol) => typeof values[protocol] === "string")
          .map((protocol) => [protocol, values[protocol] as string]),
      );
      if (!preset && !Object.keys(endpoints).length)
        throw new UsageError(
          "Give at least one of --chat, --responses, --anthropic, --gemini",
        );
      const client = await ctx.client();
      const credential = credentialGiven(values)
        ? { value: await readSecret(ctx, values, "credential-") }
        : undefined;
      const models = list(values.model);
      const created = await client.providers.create({
        ...(preset
          ? {
              preset,
              ...(id !== undefined ? { id } : {}),
              ...(Object.keys(endpoints).length ? { endpoints } : {}),
            }
          : { id: id!, endpoints }),
        ...(credential ? { credential } : {}),
        ...(typeof values.name === "string" ? { name: values.name } : {}),
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
          `Added provider ${created.id}${created.preset ? ` from preset ${created.preset}` : ""}${created.credentials.length ? " with a stored credential" : ""}`,
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

async function keyCommand(args: string[]): Promise<void> {
  const [action = "", ...rest] = args;
  const { values, positionals: given } = parse(rest, {
    name: { type: "string" },
    allow: { type: "string", multiple: true },
    "expires-at": { type: "string" },
    "no-expiry": { type: "boolean" },
  });
  const ctx = context(values);
  switch (action) {
    case "list": {
      positionals(given, []);
      const page = await (await ctx.client()).gatewayKeys.list();
      const now = Date.now();
      return output(ctx, page, () =>
        table(
          ["KEY ID", "NAME", "SCOPE", "ALLOW", "EXPIRES", "STATUS"],
          page.items.map((item) => [
            item.keyId,
            item.name,
            item.scope.kind,
            item.modelAllow.join(","),
            localTime(item.expiresAt),
            item.revokedAt
              ? "revoked"
              : item.expiresAt && Date.parse(item.expiresAt) <= now
                ? "expired"
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
      const created = await (
        await ctx.client()
      ).gatewayKeys.create({
        name: values.name,
        modelAllow: allow,
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
    default:
      throw new UsageError(`Unknown group command: ${action || "(none)"}`);
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

async function usageCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {
    by: { type: "string" },
    since: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    key: { type: "string" },
  });
  const ctx = context(values);
  positionals(given, []);
  if (values.since !== undefined && values.from !== undefined)
    throw new UsageError("Use either --since or --from");
  const groupBy = (values.by ?? "model") as UsageGroupBy;
  if (!["model", "provider", "day", "key", "adapter"].includes(groupBy))
    throw new UsageError("--by is model, provider, day, key or adapter");
  const from = values.since !== undefined ? since(values.since) : values.from;
  const report = await (
    await ctx.client()
  ).usage.aggregate({
    groupBy,
    ...(from !== undefined ? { from } : {}),
    ...(values.to !== undefined ? { to: values.to } : {}),
    ...(values.provider !== undefined ? { provider: values.provider } : {}),
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(values.key !== undefined ? { keyId: values.key } : {}),
  });
  output(ctx, report, () =>
    table(
      [
        groupBy.toUpperCase(),
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
  const activeKeys = keys.items.filter((key) => !key.revokedAt).length;
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

const COMMANDS: Readonly<Record<string, (args: string[]) => Promise<void>>> = {
  provider: providerCommand,
  credential: credentialCommand,
  key: keyCommand,
  group: groupCommand,
  model: modelCommand,
  catalog: catalogCommand,
  usage: usageCommand,
  status: statusCommand,
};

function exitCode(status: number): number {
  if (status === 400 || status === 404) return EXIT.usage;
  if (status === 401 || status === 403) return EXIT.auth;
  if ([409, 412, 422].includes(status)) return EXIT.conflict;
  if (status === 429 || status === 503) return EXIT.limit;
  return EXIT.internal;
}

/** Print a failure (problem object on stdout with `--json`) and choose the exit code. */
function report(error: unknown, json: boolean): number {
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
      ? [EXIT.usage, `${error.message}\n\n${USAGE}`]
      : error instanceof ConfirmationRequired
        ? [EXIT.confirm, error.message]
        : error instanceof Interrupted
          ? [EXIT.interrupted, "Interrupted"]
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
 * @returns The exit code of 06 section 5: 0, 1 internal, 2 usage or unknown
 *   name, 3 daemon unavailable, 4 confirmation needed, 5 conflict, 6
 *   authentication, 7 limit or not ready, 130 interrupted.
 */
export async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "--help" || args.includes("--help")) {
    write(USAGE);
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    process.stderr.write(`Unknown command: ${name}\n${USAGE}\n`);
    return EXIT.usage;
  }
  try {
    await command(args);
    return EXIT.ok;
  } catch (error) {
    return report(error, args.includes("--json"));
  }
}
