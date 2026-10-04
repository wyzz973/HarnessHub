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
  type GatewayShareStatus,
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
import { choosePreset } from "@harnesshub/core/provider-presets";
import type { ImportPreview } from "@harnesshub/core/import-links";

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
              | add [<id>] --preset P [--region R] [--plan P] [--name N]
                [--base URL | --chat URL ...]
                [--credential-from-stdin | --credential-from-env VAR
                 | --credential-from-file PATH]
              | remove <id>
  hh import <link> | - (link on stdin) | --from claude-code|codex [--only REF]...
              shows what would be added, then asks (--yes adds without asking)
  hh credential list <provider> | add <provider> [--name N] [--id ID]
              [--protocol P]... | rotate <provider> <credential>
              | remove <provider> <credential>
              secret from a hidden prompt, --from-stdin, --from-env VAR or --from-file PATH
  hh key list | create --name N --allow REF... [--expires-at TIME | --no-expiry]
              [--lan] | revoke <keyId>
  hh gateway share status | off | on [--host IP] [--port N] [--name HOST]...
              [--public-base-url URL]
  hh group list | add <id> --member REF... [--strategy S] [--stickiness S]
              | remove <id> | auto | hide <auto-id> | restore <auto-id>
  hh model show <provider/model | provider/*>
              | set <provider/model | provider/*> KEY=VALUE... | unset <ref>
              keys: context, output (tokens), reasoning, toolcall (yes|no),
              modalities (text,image,pdf,audio,video), price.input,
              price.output, price.cacheRead, price.cacheWrite (USD per
              million tokens); KEY= removes one key of the override
  hh subscription notice | list | login chatgpt [--provider ID] [--account ID]
              [--accept-notice] | logout <provider> <account>
              accounts are off until their risk notice is accepted, and serve
              agents on this computer only
  hh catalog status | refresh
  hh usage [--by model|provider|day|key|adapter|credential|conversation]
              [--since 7d] [--from TIME] [--to TIME] [--provider P]
              [--model REF] [--key KEY_ID] [--agent A]
  hh status

Common options: --url URL (default ${DEFAULT_DAEMON_URL}), --data-dir DIR
(the daemon's data directory holding admin.token, default ./data), --json,
--yes, --non-interactive.`;

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
      const page = await (await ctx.client()).presets.list();
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
          ...(item.preset !== undefined
            ? [
                `Preset:   ${item.preset}${item.region !== undefined ? `, region ${item.region}` : ""}${item.plan !== undefined ? `, plan ${item.plan}` : ""}`,
              ]
            : []),
          ...(item.catalog !== undefined ? [`Catalog:  ${item.catalog}`] : []),
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
    lan: { type: "boolean" },
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
      const created = await (
        await ctx.client()
      ).gatewayKeys.create({
        name: values.name,
        modelAllow: allow,
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

/** Conversations shown by `hh usage --by conversation`; `--json` prints the API page. */
const CONVERSATION_ROWS = 200;

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
  });
  const ctx = context(values);
  positionals(given, []);
  if (values.since !== undefined && values.from !== undefined)
    throw new UsageError("Use either --since or --from");
  const by = values.by ?? "model";
  const groups = ["model", "provider", "day", "key", "adapter", "credential"];
  if (by !== "conversation" && !groups.includes(by))
    throw new UsageError(
      "--by is model, provider, day, key, adapter, credential or conversation",
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
  const report = await client.usage.aggregate({ groupBy, ...filter });
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

async function gatewayCommand(args: string[]): Promise<void> {
  const [group = "", action = "", ...rest] = args;
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
};

function accountStatus(account: SubscriptionAccountView): string {
  if (!account.signedIn) return "signed out";
  if (!account.noticeAccepted) return "notice not accepted";
  return account.enabled ? "usable" : "disabled";
}

/**
 * `hh subscription notice | list | login chatgpt | logout <provider>
 * <account>` (ADR-P09). Login shows the risk notice and asks before it
 * starts OpenAI's own sign-in in the browser; the account is used only
 * after that acceptance.
 */
async function subscriptionCommand(args: string[]): Promise<void> {
  const [action = "", ...rest] = args;
  const { values, positionals: given } = parse(rest, {
    provider: { type: "string" },
    account: { type: "string" },
    "accept-notice": { type: "boolean" },
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
          ["PROVIDER", "ACCOUNT", "EMAIL", "STATUS", "ACCEPTED"],
          accounts.items.map((account) => [
            account.provider,
            account.credential,
            account.email ?? "-",
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
        `Continue with ChatGPT in your browser:\n  ${view.authorizeUrl}\nWaiting for the sign-in to finish (until ${localTime(view.expiresAt)})...\n`,
      );
      while (view.status === "pending") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        view = await client.subscriptions.signIn(view.id);
      }
      if (view.status === "failed")
        throw new Error(`The sign-in failed: ${view.error ?? "unknown"}`);
      let models = "";
      try {
        const provider = await client.providers.refreshModels(view.provider);
        models = `${provider.models.list.length} models listed for ${view.provider}.`;
      } catch (error) {
        models = `The model list of ${view.provider} could not be read yet (${error instanceof Error ? error.message : "unknown"}); retry with hh provider models ${view.provider} --refresh.`;
      }
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
    case "logout": {
      const [provider, account] = positionals(given, ["provider", "account"]);
      await confirm(
        ctx,
        `Sign account ${account} of ${provider} out and clear its tokens?`,
      );
      const result = await client.subscriptions.signOut(provider!, account!);
      return output(ctx, result, () =>
        result.revoked
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

const COMMANDS: Readonly<Record<string, (args: string[]) => Promise<void>>> = {
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

/** Shared with the agent commands (`agents.ts`), which use the same options, prompts and exit codes. */
export {
  confirm,
  context,
  EXIT,
  hiddenPrompt,
  list,
  localTime,
  output,
  parse,
  positionals,
  report,
  table,
  UsageError,
  write,
  type Context,
};
