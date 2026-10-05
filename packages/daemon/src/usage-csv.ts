// SPDX-License-Identifier: MIT
/**
 * CSV views of the ledger (Magpie parity §6): every call with Magpie's
 * columns in Magpie's order (`internal/usage/ledger.go` `CSVHeader`), so a
 * sheet or script made for `magpie usage --csv` reads it unchanged, and
 * usage buckets with the same token and cost columns.
 *
 * Quoting is RFC 4180 as Go's encoding/csv (Magpie's writer) does it: a
 * field is quoted when it holds a comma, a quote, CR or LF, or starts with
 * white space; records end with LF; no byte order mark. Unlike Magpie, a
 * field a spreadsheet would read as a formula (starting with `=`, `+`, `-`,
 * `@`, tab or CR) is prefixed with `'`, except a plain number.
 */
import type {
  GatewayKeyRecord,
  ModelCallEntry,
  ProviderConfig,
  UsageBucket,
  UsageGroupBy,
  WireProtocol,
} from "@harnesshub/core/model-plane";

/** Magpie's `CSVHeader`, column for column. */
export const CALL_CSV_COLUMNS = [
  "time",
  "agent",
  "requested_model",
  "provider",
  "host",
  "model",
  "served_model",
  "swapped",
  "effort",
  "input_tokens",
  "output_tokens",
  "cache_write_tokens",
  "cache_read_tokens",
  "reasoning_tokens",
  "cost_usd",
  "duration_ms",
  "ttft_ms",
  "status",
  "error",
  "session",
  "kind",
  "provider_key_id",
  "provider_key_name",
  "provider_account",
  "route_id",
  "request_id",
  "endpoint",
  "error_message",
  "error_type",
  "source",
  "rejected",
  "session_provider",
  "session_account",
  "session_official_login",
  "caller_key_id",
  "caller_key_name",
] as const;

/** The columns of a usage bucket after its key, named and ordered as the call columns are. */
export const USAGE_CSV_COLUMNS = [
  "calls",
  "failed_calls",
  "input_tokens",
  "output_tokens",
  "cache_write_tokens",
  "cache_read_tokens",
  "reasoning_tokens",
  "cost_usd",
  "unpriced_calls",
] as const;

const FORMULA = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * One field as encoding/csv writes it, guarded against formula injection:
 * also after leading whitespace (Unicode's too), which a spreadsheet may
 * trim on import.
 */
export function csvField(value: string): string {
  const head = value.trimStart();
  const text =
    (FORMULA.test(value) || FORMULA.test(head)) && !NUMBER.test(head)
      ? `'${value}`
      : value;
  // encoding/csv also quotes `\.` alone, which PostgreSQL reads as the end of data.
  return /[",\r\n]/.test(text) || /^\s/u.test(text) || text === "\\."
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

/** One record, LF-terminated. */
export function csvRecord(fields: readonly string[]): string {
  return `${fields.map(csvField).join(",")}\n`;
}

/**
 * The names and places the ledger keeps only as IDs, from the current
 * configuration: what a credential, a provider's endpoint or a key is called
 * now, not necessarily when the call was made.
 */
export interface CallCsvNames {
  credential(
    provider: string,
    id: string,
  ): { name: string; account?: string } | undefined;
  /** The provider's base URL for an upstream protocol. */
  endpoint(provider: string, protocol: WireProtocol): string | undefined;
  key(id: string): string | undefined;
}

/** {@link CallCsvNames} over a snapshot of the providers and keys. */
export function callCsvNames(
  providers: readonly ProviderConfig[],
  keys: readonly GatewayKeyRecord[],
): CallCsvNames {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const keyNames = new Map(keys.map((key) => [key.keyId, key.name]));
  return {
    credential(provider, id) {
      const credential = byId
        .get(provider as ProviderConfig["id"])
        ?.credentials.find((item) => item.id === id);
      if (!credential) return undefined;
      const account = credential.account;
      // An email or a GitHub login, as Magpie's provider_account; never a token.
      const user =
        account?.email ??
        (account?.backend === "copilot" ? account.subject : undefined);
      return { name: credential.name, ...(user ? { account: user } : {}) };
    },
    endpoint: (provider, protocol) =>
      byId.get(provider as ProviderConfig["id"])?.endpoints[protocol],
    key: (id) => keyNames.get(id as GatewayKeyRecord["keyId"]),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** RFC 3339 in the daemon's time zone, to the second, as Go's `time.RFC3339`. */
export function localRfc3339(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const offset = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60_000)
    .toISOString()
    .slice(0, 19);
  if (offset === 0) return `${local}Z`;
  const minutes = Math.abs(offset);
  return `${local}${offset > 0 ? "+" : "-"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// Magpie's served.go: a vendor that answers with the dated or pinned name of
// the model asked for, or with its maker or path in front, did not swap it.
const VERSION_TAIL =
  /(?:[-_@:](?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}|\d{6,8}|\d{3,4}|v\d+:\d+|latest|preview|exp))+$/;
const VENDOR_DOT =
  /^(?:[a-z]{2,4}\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|openai|google|moonshotai|minimax|zai)\./;
const CONTEXT_TAIL = /\[[^\]]*\]$/;

function bareModel(model: string): string {
  let name = model.trim().toLowerCase().replace(CONTEXT_TAIL, "");
  name = name.slice(name.lastIndexOf("/") + 1).replace(VENDOR_DOT, "");
  const tail = VERSION_TAIL.exec(name);
  return tail && tail.index > 0 ? name.slice(0, tail.index) : name;
}

/** Whether the reply named another model than the one sent (Magpie's `Swapped`). */
export function swappedModel(sent: string, served: string): boolean {
  const a = bareModel(sent);
  const b = bareModel(served);
  return a !== "" && b !== "" && a !== b && a !== "auto";
}

/** The operation path an upstream protocol is called at, after its base URL. */
function operationPath(entry: ModelCallEntry, protocol: WireProtocol): string {
  switch (protocol) {
    case "chat":
      return "/chat/completions";
    case "responses":
      return "/responses";
    case "anthropic":
      return "/messages";
    case "gemini":
      return `/models/${entry.wireModel ?? ""}:${entry.inbound.stream ? "streamGenerateContent" : "generateContent"}`;
  }
}

/** The reasoning a route group chose for the call (`member-effort:`, `effort:auto:`); the client's own is not kept. */
function effort(patches: readonly string[]): string {
  let chosen = "";
  for (const patch of patches) {
    const match = /^(?:member-effort|effort:auto):(.+)$/.exec(patch);
    if (match) chosen = match[1]!;
  }
  return chosen;
}

const count = (value: number | undefined) => String(value ?? 0);
const usd = (amount: number) => amount.toFixed(6);

/** One call as a {@link CALL_CSV_COLUMNS} record. */
export function callCsvFields(
  entry: ModelCallEntry,
  names: CallCsvNames,
): string[] {
  const usage = entry.usage;
  const sent =
    entry.wireModel ??
    (entry.modelRef
      ? entry.modelRef.slice(entry.modelRef.indexOf("/") + 1)
      : "");
  const credential =
    entry.provider && entry.credentialId
      ? names.credential(entry.provider, entry.credentialId)
      : undefined;
  const base =
    entry.provider && entry.upstreamProtocol
      ? names.endpoint(entry.provider, entry.upstreamProtocol)
      : undefined;
  let host = "";
  let basePath = "";
  if (base)
    try {
      const url = new URL(base);
      host = url.host;
      basePath = url.pathname.replace(/\/+$/, "");
    } catch {
      // A base URL the provider check let through but URL cannot read: no host.
    }
  const endpoint =
    entry.mode === "translated" && entry.upstreamProtocol
      ? `${entry.inbound.path} → ${basePath}${operationPath(entry, entry.upstreamProtocol)}`
      : entry.inbound.path;
  const firstContent = entry.timing.firstContentMs;
  // Magpie's `Failed`: an error status, or an error the call ended with.
  const failed = entry.status >= 400 || entry.error !== undefined;
  const keyName = entry.keyId ? names.key(entry.keyId) : undefined;
  return [
    localRfc3339(entry.occurredAt),
    entry.agent?.id ?? "",
    entry.requestedModel ?? "",
    entry.provider ?? "",
    host,
    sent,
    entry.servedModel ?? "",
    String(
      entry.servedModel !== undefined && swappedModel(sent, entry.servedModel),
    ),
    effort(entry.patches),
    count(usage?.input),
    count(usage?.output),
    count(usage?.cacheWrite),
    count(usage?.cacheRead),
    count(usage?.reasoning),
    entry.cost ? usd(entry.cost.amountUsd) : "",
    String(Math.round(entry.timing.durationMs)),
    firstContent ? String(Math.round(firstContent)) : "",
    String(entry.status),
    String(failed),
    entry.conversationKey ?? "",
    entry.purpose ?? "",
    entry.credentialId ?? "",
    credential?.name ?? "",
    credential?.account ?? "",
    "",
    "",
    endpoint,
    entry.error ?? "",
    entry.errorClass ?? "",
    "",
    String(entry.rejected === true),
    "",
    "",
    "false",
    entry.keyId ?? "",
    keyName ?? "",
  ];
}

/** One usage bucket as a record: its key, then {@link USAGE_CSV_COLUMNS}. */
export function usageCsvFields(bucket: UsageBucket): string[] {
  return [
    bucket.key,
    String(bucket.calls),
    String(bucket.failedCalls),
    String(bucket.usage.input),
    String(bucket.usage.output),
    String(bucket.usage.cacheWrite),
    String(bucket.usage.cacheRead),
    String(bucket.usage.reasoning),
    usd(bucket.costUsd),
    String(bucket.unpricedCalls),
  ];
}

/** The header of a usage CSV: the grouping, then {@link USAGE_CSV_COLUMNS}. */
export function usageCsvHeader(groupBy: UsageGroupBy): string[] {
  return [groupBy, ...USAGE_CSV_COLUMNS];
}

/** `harnesshub-<what>-<YYYY-MM-DD>.csv` in the daemon's time zone, as Magpie names its downloads. */
export function csvFileName(what: string, now: Date): string {
  return `harnesshub-${what}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
