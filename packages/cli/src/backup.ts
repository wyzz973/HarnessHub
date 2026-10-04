// SPDX-License-Identifier: MIT
/**
 * `hh backup`, `hh restore` and `hh sync` (docs/backup-sync.md). The daemon
 * seals and opens backups; this command reads and writes the file. A
 * passphrase or a target secret is read from a hidden prompt, or, when stdin
 * is piped, from its lines (the first line, then the next): never from the
 * command line, where other users of the machine can see it.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  HarnessHubError,
  type BackupEnvelope,
  type HarnessHubClient,
  type LibraryPlan,
  type RestoreSummary,
  type SyncSettings,
  type SyncStatus,
} from "@harnesshub/sdk/client";
import {
  confirm,
  ConfirmationRequired,
  context,
  EXIT,
  hiddenPrompt,
  localTime,
  output,
  parse,
  positionals,
  report,
  UsageError,
  write,
  type Context,
} from "./admin.js";
import { AGENTS as LIBRARY_AGENTS, planText } from "./library.js";

const DEFAULT_FILE = "harnesshub.harnesshub-backup";

const USAGE = `Usage:
  hh backup [--no-keys] [file]       seal providers, keys, groups, overrides,
                                     agent wirings, the Library and settings
                                     into file (default ${DEFAULT_FILE})
  hh restore [--no-agents] [--no-library] <file>
                                     show what the backup restores, confirm,
                                     restore; agents installed here are re-wired,
                                     then the Library is synced into them after
                                     showing the changes
  hh sync status | now | off
  hh sync webdav on <https://…> [user=NAME] [keys=yes|no] [agents=yes|no]
  hh sync s3 on <s3://bucket[/prefix]> access-key-id=ID [endpoint=URL]
              [region=R] [path-style=yes|no] [keys=yes|no] [agents=yes|no]

The passphrase (and the WebDAV password or S3 secret key) comes from a hidden
prompt, or from the lines of stdin when it is piped: the secret first when one
is needed, then the passphrase. Common options: --url URL, --data-dir DIR,
--json, --yes, --non-interactive.`;

/** Lines of piped stdin, read once to the end and handed out in order. */
class PipedLines {
  private lines: string[] | undefined;

  async next(what: string): Promise<string> {
    if (this.lines === undefined) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin)
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      this.lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
    }
    const line = this.lines.shift();
    if (line === undefined || line === "")
      throw new UsageError(`stdin has no line for the ${what}`);
    return line;
  }
}

const piped = new PipedLines();

/** A secret from the hidden prompt (asked twice with `confirmTwice`) or the next stdin line. */
async function secret(
  ctx: Context,
  what: string,
  confirmTwice = false,
): Promise<string> {
  if (!process.stdin.isTTY) return piped.next(what);
  if (!ctx.interactive)
    throw new UsageError(
      `No terminal for a hidden prompt: pipe the ${what} on stdin`,
    );
  const value = await hiddenPrompt(`${capitalized(what)} (hidden): `);
  if (!value) throw new UsageError(`The ${what} must not be empty`);
  if (confirmTwice && (await hiddenPrompt(`Repeat the ${what}: `)) !== value)
    throw new UsageError(`The two ${what}s differ`);
  return value;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function backupCommand(args: string[]): Promise<number> {
  const { values, positionals: given } = parse(args, {
    "no-keys": { type: "boolean" },
  });
  const ctx = context(values);
  if (given.length > 1) throw new UsageError("Expected at most one file");
  const file = given[0] ?? DEFAULT_FILE;
  const exists = await readFile(file).then(
    () => true,
    () => false,
  );
  if (exists) await confirm(ctx, `${file} exists. Replace it?`);
  const passphrase = await secret(ctx, "passphrase", true);
  const keys = values["no-keys"] !== true;
  const envelope = await (
    await ctx.client()
  ).backup.create({ passphrase, keys });
  await writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600,
  });
  output(ctx, { file, keys }, () =>
    [
      `Wrote ${file} ${keys ? "with credential values" : "without credential values"}, sealed with the passphrase.`,
      "Keep the passphrase: the backup cannot be opened without it. Gateway Keys are never in a backup.",
    ].join("\n"),
  );
  return EXIT.ok;
}

function summaryText(summary: RestoreSummary, done: boolean): string {
  const list = (items: string[]) => items.join(", ");
  const lines = [
    `Backup made by ${summary.app} at ${localTime(summary.createdAt)}, ${summary.keys ? "with" : "without"} credential values.`,
  ];
  const { providers, groups } = summary;
  const verb = (future: string, past: string) => (done ? past : future);
  if (providers.added.length || providers.replaced.length)
    lines.push(
      `Providers: ${[
        providers.added.length
          ? `${verb("add", "added")} ${list(providers.added)}`
          : "",
        providers.replaced.length
          ? `${verb("replace", "replaced")} ${list(providers.replaced)}`
          : "",
      ]
        .filter(Boolean)
        .join("; ")}`,
    );
  else lines.push("Providers: none in the backup");
  if (providers.needKey.length)
    lines.push(
      `  Without a key here and in the backup (add one with hh credential add): ${list(providers.needKey)}`,
    );
  if (providers.signInAgain.length)
    lines.push(
      `  Subscriptions, not restored: sign in again on this machine (hh subscription login chatgpt|copilot): ${list(providers.signInAgain)}`,
    );
  if (providers.signedInHere.length)
    lines.push(
      `  Kept as signed in on this machine, not replaced: ${list(providers.signedInHere)}`,
    );
  if (groups.added.length || groups.replaced.length || groups.skipped.length)
    lines.push(
      `Route groups: ${[
        groups.added.length
          ? `${verb("add", "added")} ${list(groups.added)}`
          : "",
        groups.replaced.length
          ? `${verb("replace", "replaced")} ${list(groups.replaced)}`
          : "",
        groups.skipped.length
          ? `skip ${list(groups.skipped)} (a member's provider is missing)`
          : "",
      ]
        .filter(Boolean)
        .join("; ")}`,
    );
  if (summary.overrides) lines.push(`Model overrides: ${summary.overrides}`);
  if (summary.profiles.added.length || summary.profiles.replaced.length)
    lines.push(
      `Wiring profiles: ${[
        summary.profiles.added.length
          ? `${verb("add", "added")} ${list(summary.profiles.added)}`
          : "",
        summary.profiles.replaced.length
          ? `${verb("replace", "replaced")} ${list(summary.profiles.replaced)}`
          : "",
      ]
        .filter(Boolean)
        .join("; ")} (apply one with hh profile apply)`,
    );
  const library = summary.library;
  if (library) {
    const kinds = [
      ["instructions", "instruction sets", library.instructions],
      ["mcp", "MCP servers", library.mcp],
      ["skills", "skills", library.skills],
    ] as const;
    const parts = kinds.flatMap(([, label, change]) => {
      const done = [
        change.added.length
          ? `${verb("add", "added")} ${list(change.added)}`
          : "",
        change.replaced.length
          ? `${verb("replace", "replaced")} ${list(change.replaced)}`
          : "",
      ].filter(Boolean);
      return done.length ? [`${label}: ${done.join(", ")}`] : [];
    });
    lines.push(`Library: ${parts.join("; ") || "nothing to bring in"}`);
    if (library.mcp.needSecret.length)
      lines.push(
        `  Secrets with no value in the backup or here, left out (set them with hh library add mcp --replace): ${list(library.mcp.needSecret)}`,
      );
    if (library.skills.incomplete.length)
      lines.push(
        `  Skills without their files over 2 MiB, which backups leave out: ${list(library.skills.incomplete)}`,
      );
    for (const item of library.refused)
      lines.push(`  Not restored: ${item.kind} ${item.name}: ${item.reason}`);
  }
  const share = summary.gatewayShare;
  if (share.action === "apply" && share.settings)
    lines.push(
      share.error
        ? `LAN sharing: not applied: ${share.error}`
        : `LAN sharing: ${verb("set", "set")} ${share.settings.lan.enabled ? `on at ${share.settings.lan.host ?? "?"}${share.settings.lan.port !== undefined ? `:${share.settings.lan.port}` : ""}` : "off"}`,
    );
  if (summary.catalog?.differs)
    lines.push(
      `Catalog settings differ (backup: autoRefresh=${summary.catalog.backup.autoRefresh}, url=${summary.catalog.backup.url}); they come from the configuration file and are not changed.`,
    );
  if (summary.agents.length) {
    lines.push("Agents:");
    for (const agent of summary.agents) {
      const target =
        agent.model === undefined
          ? `its own sign-in (${Object.entries(agent.options ?? {})
              .map(([name, value]) => `${name}=${value}`)
              .join(", ")})`
          : [
              agent.model,
              ...Object.entries(agent.tiers ?? {}).map(
                ([tier, model]) => `${tier}=${model}`,
              ),
              ...(agent.effort ? [`effort ${agent.effort}`] : []),
            ].join(", ") +
            ` (${agent.models.includes("*") ? "every model" : `${agent.models.length} model${agent.models.length === 1 ? "" : "s"}`}${agent.deny?.length ? `, ${agent.deny.length} hidden` : ""})`;
      const text =
        agent.outcome === "wired"
          ? `wired to ${target}`
          : agent.outcome === "failed"
            ? `not wired: ${agent.error ?? "failed"}`
            : {
                wire: `wire to ${target}`,
                unchanged: `already wired to ${target}`,
                "skip-disabled": "skipped (--no-agents)",
                "skip-not-installed": "skipped: not installed here",
                "skip-unknown": "skipped: not an agent this HarnessHub knows",
                "skip-unavailable":
                  "skipped: agent wiring is not available in this daemon",
              }[agent.action];
      lines.push(`  ${agent.agent.padEnd(14)} ${text}`);
    }
  }
  if (summary.clientKeys.length) {
    lines.push(
      "Client keys to issue again (hh key create); their text is never in a backup:",
    );
    for (const key of summary.clientKeys)
      lines.push(
        `  ${key.name}: ${key.modelAllow.join(", ") || "(no models)"}${key.allowLan ? " (LAN)" : ""}`,
      );
  }
  return lines.join("\n");
}

/**
 * After a restore that brought Library items in: the Library synced into
 * the agents installed here, after showing the plan and asking. Resolves
 * to the plan applied (undefined when there was nothing to do or it was
 * declined), or rejects with the daemon's error.
 */
async function syncRestoredLibrary(
  ctx: Context,
  client: HarnessHubClient,
): Promise<LibraryPlan | undefined> {
  const agents = (await client.agents.list()).items
    .filter(
      (agent) =>
        agent.installation.status !== "not-found" &&
        (LIBRARY_AGENTS as readonly string[]).includes(agent.id),
    )
    .map((agent) => agent.id) as (typeof LIBRARY_AGENTS)[number][];
  if (!agents.length) return undefined;
  const plan = await client.library.sync.plan({ agents });
  if (!plan.changed) return undefined;
  if (!ctx.json) write(planText(plan));
  try {
    await confirm(
      ctx,
      `Sync the restored Library into ${plan.agents
        .filter((agent) => agent.changed)
        .map((agent) => agent.agent)
        .join(", ")}?`,
    );
  } catch (error) {
    if (!(error instanceof ConfirmationRequired)) throw error;
    process.stderr.write(
      "The Library was not synced into the agents; run hh library sync to do it later.\n",
    );
    return undefined;
  }
  return client.library.sync.apply({ agents, expect: plan });
}

async function restoreCommand(args: string[]): Promise<number> {
  const { values, positionals: given } = parse(args, {
    "no-agents": { type: "boolean" },
    "no-library": { type: "boolean" },
  });
  const ctx = context(values);
  const [file] = positionals(given, ["file"]) as [string];
  let backup: BackupEnvelope;
  try {
    backup = JSON.parse(await readFile(file, "utf8")) as BackupEnvelope;
  } catch (error) {
    throw new UsageError(
      `${file} is not a readable backup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const passphrase = await secret(ctx, "passphrase");
  const client = await ctx.client();
  const input = {
    backup,
    passphrase,
    agents: values["no-agents"] !== true,
    library: values["no-library"] !== true,
  };
  const plan = await client.backup.restore({ ...input, dryRun: true });
  if (!ctx.json) write(summaryText(plan, false));
  await confirm(ctx, "Restore this backup?");
  const result = await client.backup.restore({ ...input, dryRun: false });
  if (!ctx.json) write(summaryText(result, true));
  let librarySync: LibraryPlan | undefined;
  let libraryError: string | undefined;
  if (result.library)
    try {
      librarySync = await syncRestoredLibrary(ctx, client);
    } catch (error) {
      if (!(error instanceof HarnessHubError)) throw error;
      libraryError = `${error.code}: ${error.message}`;
      process.stderr.write(
        `The Library was not synced into the agents: ${libraryError}\n`,
      );
    }
  if (ctx.json)
    write(
      JSON.stringify({ ...result, librarySync: librarySync ?? null }, null, 2),
    );
  else if (librarySync)
    write(
      librarySync.agents
        .filter((agent) => agent.changed)
        .map((agent) => `Library synced into ${agent.agent}`)
        .join("\n"),
    );
  return result.agents.some((agent) => agent.outcome === "failed") ||
    result.gatewayShare.error !== undefined ||
    libraryError !== undefined
    ? EXIT.internal
    : EXIT.ok;
}

function statusText(status: SyncStatus): string {
  if (!status.enabled) return "Sync is off.";
  const lines = [
    `Sync to ${status.kind === "s3" ? "S3" : "WebDAV"} ${status.url}${status.user ? ` as ${status.user}` : ""}, every ${Math.round(status.intervalMs / 60000)} min; credential values ${status.keys ? "included" : "left out"}, agent wirings ${status.agents ? "synced" : "not synced"}.`,
    `Last sync: ${status.lastSyncAt ? localTime(status.lastSyncAt) : "never"}${status.nextSyncAt ? `; next: ${localTime(status.nextSyncAt)}` : ""}`,
  ];
  if (status.lastError) lines.push(`Last error: ${status.lastError}`);
  const notice = status.notice;
  if (notice) {
    if (notice.here.length)
      lines.push(
        `Changed on both sides; the server's ${notice.here.join(" and ")} replaced this machine's.`,
      );
    if (notice.there.length)
      lines.push(
        `Changed on both sides; this machine's ${notice.there.join(" and ")} replaced the server's.`,
      );
    if (notice.saved) lines.push(`The replaced copies are in ${notice.saved}.`);
    if (notice.kept?.length)
      lines.push(
        `Kept although the server no longer has them (Gateway Keys allow them): ${notice.kept.join(", ")}`,
      );
  }
  for (const warning of status.warnings ?? []) lines.push(`Note: ${warning}`);
  return lines.join("\n");
}

/** `key=value` options of `hh sync … on`. */
function options(
  given: string[],
  allowed: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of given) {
    const equals = item.indexOf("=");
    const name = equals > 0 ? item.slice(0, equals) : "";
    if (!allowed.includes(name))
      throw new UsageError(
        `Unknown option ${JSON.stringify(item.slice(0, 80))}; expected ${allowed.map((option) => `${option}=…`).join(", ")}`,
      );
    result[name] = item.slice(equals + 1);
  }
  return result;
}

function yes(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(yes|true|on)$/i.test(value)) return true;
  if (/^(no|false|off)$/i.test(value)) return false;
  throw new UsageError(`${name} must be yes or no`);
}

async function syncCommand(args: string[]): Promise<number> {
  const { values, positionals: given } = parse(args, {});
  const ctx = context(values);
  const [action, ...rest] = given;
  if (action === "status" || action === "now" || action === "off") {
    positionals(rest, []);
    const client = await ctx.client();
    if (action === "off") {
      await confirm(
        ctx,
        "Turn sync off? Its stored secret and passphrase are forgotten; the copy on the server stays.",
      );
      const status = await client.sync.disable();
      output(ctx, status, () => statusText(status));
      return EXIT.ok;
    }
    const status =
      action === "now" ? await client.sync.now() : await client.sync.status();
    output(ctx, status, () => statusText(status));
    return EXIT.ok;
  }
  if ((action !== "webdav" && action !== "s3") || rest[0] !== "on" || !rest[1])
    throw new UsageError(
      "Expected hh sync status|now|off, or hh sync webdav|s3 on <address> …",
    );
  const kind = action;
  const url = rest[1];
  const given_ = options(
    rest.slice(2),
    kind === "webdav"
      ? ["user", "keys", "agents"]
      : ["access-key-id", "endpoint", "region", "path-style", "keys", "agents"],
  );
  const user = kind === "webdav" ? given_.user : given_["access-key-id"];
  if (kind === "s3" && !user)
    throw new UsageError("S3 sync needs access-key-id=ID");
  const settings: SyncSettings = { kind, url };
  if (user) settings.user = user;
  if (given_.endpoint) settings.endpoint = given_.endpoint;
  if (given_.region) settings.region = given_.region;
  const pathStyle = yes(given_["path-style"], "path-style");
  if (pathStyle !== undefined) settings.pathStyle = pathStyle;
  const keys = yes(given_.keys, "keys");
  if (keys !== undefined) settings.keys = keys;
  const agents = yes(given_.agents, "agents");
  if (agents !== undefined) settings.agents = agents;
  if (user)
    settings.secret = await secret(
      ctx,
      kind === "s3" ? "S3 secret access key" : "WebDAV password",
    );
  settings.passphrase = await secret(ctx, "sync passphrase", true);
  const client = await ctx.client();
  const configured = await client.sync.configure(settings);
  if (!ctx.json) write(statusText(configured));
  // The first sync now, so that a wrong address, password or passphrase
  // shows here rather than in the background.
  const synced = await client.sync.now();
  output(ctx, { configured, synced }, () => statusText(synced));
  return EXIT.ok;
}

const COMMANDS: Readonly<Record<string, (args: string[]) => Promise<number>>> =
  { backup: backupCommand, restore: restoreCommand, sync: syncCommand };

/**
 * Run `backup`, `restore` or `sync` (`argv` starts with the command name).
 * Exit codes are those of the other `hh` commands: 0, 1 internal (also a
 * restore whose agent wiring or sharing settings failed in part), 2 usage, 3
 * daemon unavailable, 4 confirmation needed, 5 conflict, 6 authentication,
 * 7 limit, 130 interrupted.
 */
export async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || args.includes("--help")) {
    write(USAGE);
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    process.stderr.write(`Unknown command: ${name}\n${USAGE}\n`);
    return EXIT.usage;
  }
  try {
    return await command(args);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${error.message}\n\n${USAGE}\n`);
      return EXIT.usage;
    }
    return report(error, args.includes("--json"));
  }
}
