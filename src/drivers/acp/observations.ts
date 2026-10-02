import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AcpRuntimeSessionUsage } from "acpx/runtime";
import type { ExecutionSpec } from "../../domain/ports.js";
import type {
  ObservedCost,
  ObservedTokens,
  UsageObservation,
} from "../../domain/observability.js";
import { unknownCost, unknownTokens } from "../../domain/observability.js";

const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_RECORDS = 2_048;
const TOKEN_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
] as const;
type RecordValue = Record<string, unknown>;
interface NativeItem {
  id: string;
  tokens: ObservedTokens;
  cost: ObservedCost;
  model: string | null;
}
export interface NativeUsageSnapshot {
  source: string;
  items: NativeItem[];
  cumulative: boolean;
  revision?: number;
  missingReason: string | null;
}
class ObservationReadError extends Error {}
const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 255
    ? value
    : null;
const sum = (values: (number | null)[]) =>
  values.every((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : null;

/** Only Worker-private files below stateDir/home are readable; links and oversized evidence are rejected. */
class PrivateReader {
  private remaining = MAX_TOTAL;
  constructor(private readonly root: string) {}
  private async contained(file: string) {
    const relative = path.relative(this.root, file);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new ObservationReadError("native-evidence-outside-private-home");
    let cursor = this.root;
    for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
      cursor = part ? path.join(cursor, part) : cursor;
      if ((await lstat(cursor)).isSymbolicLink())
        throw new ObservationReadError("native-evidence-symlink-rejected");
    }
    if ((await realpath(file)) !== file)
      throw new ObservationReadError("native-evidence-path-changed");
  }
  async bytes(file: string): Promise<Buffer> {
    await this.contained(file);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.size > MAX_FILE ||
        before.size > this.remaining
      )
        throw new ObservationReadError("native-evidence-read-limit");
      const bytes = Buffer.alloc(before.size);
      let read = 0;
      while (read < bytes.length) {
        const current = await handle.read(
          bytes,
          read,
          bytes.length - read,
          read,
        );
        if (!current.bytesRead) break;
        read += current.bytesRead;
      }
      const after = await handle.stat();
      if (
        read !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino
      )
        throw new ObservationReadError("native-evidence-changing");
      this.remaining -= read;
      await this.contained(file);
      return bytes;
    } finally {
      await handle.close();
    }
  }
  async json(file: string): Promise<unknown> {
    return JSON.parse((await this.bytes(file)).toString("utf8")) as unknown;
  }
  async files(directory: string): Promise<string[]> {
    await this.contained(directory);
    const files: string[] = [];
    const handle = await opendir(directory);
    let count = 0;
    for await (const entry of handle) {
      if (++count > MAX_RECORDS)
        throw new ObservationReadError("native-evidence-record-limit");
      if (entry.isSymbolicLink())
        throw new ObservationReadError("native-evidence-symlink-rejected");
      if (entry.isFile() && entry.name.endsWith(".json"))
        files.push(path.join(directory, entry.name));
    }
    return files;
  }
}
function nativeTokens(
  input: unknown,
  output: unknown,
  read: unknown,
  write: unknown,
  reasoning: unknown,
  total?: unknown,
): ObservedTokens {
  const cacheRead = integer(read),
    cacheWrite = integer(write),
    uncached = integer(input),
    out = integer(output);
  const prompt = sum([uncached, cacheRead, cacheWrite]);
  return {
    input: prompt,
    output: out,
    cacheRead,
    cacheWrite,
    reasoning: integer(reasoning),
    total: integer(total) ?? sum([prompt, out]),
  };
}
function nativeCost(value: unknown, source: string): ObservedCost {
  const number = amount(value);
  return number === null
    ? unknownCost()
    : {
        amount: number,
        currency: "USD",
        kind: "estimated",
        source,
        missingReason: null,
      };
}
function nativeModel(provider: unknown, model: unknown): string | null {
  const m = text(model),
    p = text(provider);
  return m ? (p ? `${p}/${m}` : m) : null;
}
async function readPi(
  reader: PrivateReader,
  home: string,
  backend: string,
  cwd: string,
): Promise<NativeUsageSnapshot> {
  const map = object(
    await reader.json(path.join(home, ".pi/pi-acp/session-map.json")),
  );
  const record = object(object(map?.sessions)?.[backend]);
  if (
    map?.version !== 1 ||
    record?.sessionId !== backend ||
    record.cwd !== cwd ||
    typeof record.sessionFile !== "string"
  )
    throw new ObservationReadError("native-session-identity-mismatch");
  const lines = (await reader.bytes(record.sessionFile))
    .toString("utf8")
    .trim()
    .split("\n");
  if (lines.length > MAX_RECORDS)
    throw new ObservationReadError("native-evidence-record-limit");
  const rows = lines.map((line) => object(JSON.parse(line) as unknown));
  const header = rows[0];
  if (header?.type !== "session" || header.id !== backend || header.cwd !== cwd)
    throw new ObservationReadError("native-session-identity-mismatch");
  const items: NativeItem[] = [];
  for (const row of rows.slice(1)) {
    const message = object(row?.message);
    if (row?.type !== "message" || message?.role !== "assistant") continue;
    const usage = object(message.usage);
    if (typeof row.id !== "string" || !usage)
      throw new ObservationReadError("native-usage-shape-unsupported");
    items.push({
      id: row.id,
      tokens: nativeTokens(
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.reasoning,
        usage.totalTokens,
      ),
      cost: nativeCost(object(usage.cost)?.total, "pi-native-price-table"),
      model: nativeModel(message.provider, message.model),
    });
  }
  return {
    source: "pi-private-session-jsonl",
    items,
    cumulative: false,
    missingReason: null,
  };
}
async function readOpenCode(
  reader: PrivateReader,
  home: string,
  backend: string,
  cwd: string,
): Promise<NativeUsageSnapshot> {
  const files = await reader.files(
    path.join(home, ".local/share/opencode/storage/message", backend),
  );
  const items: NativeItem[] = [];
  for (const file of files) {
    const message = object(await reader.json(file));
    if (message?.sessionID !== backend)
      throw new ObservationReadError("native-session-identity-mismatch");
    if (message.role !== "assistant") continue;
    if (object(message.path)?.cwd !== cwd || typeof message.id !== "string")
      throw new ObservationReadError("native-session-identity-mismatch");
    const usage = object(message.tokens),
      cache = object(usage?.cache);
    if (!usage)
      throw new ObservationReadError("native-usage-shape-unsupported");
    if (!integer(object(message.time)?.completed))
      throw new ObservationReadError("native-evidence-incomplete");
    items.push({
      id: message.id,
      tokens: nativeTokens(
        usage.input,
        usage.output,
        cache?.read,
        cache?.write,
        usage.reasoning,
      ),
      cost: nativeCost(message.cost, "opencode-native-price-table"),
      model: nativeModel(message.providerID, message.modelID),
    });
  }
  return {
    source: "opencode-private-messages",
    items,
    cumulative: false,
    missingReason: null,
  };
}
async function readDsh(
  reader: PrivateReader,
  home: string,
  backend: string,
  cwd: string,
): Promise<NativeUsageSnapshot> {
  const cwdKey = `--${cwd.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-")}--`;
  const session = path.join(
    home,
    ".dsh/sessions",
    cwdKey,
    backend,
    "session.jsonl.zstd",
  );
  // DSH appends independent zstd frames; its first frame is the durable session identity.
  const firstFrame = zstdDecompressSync(await reader.bytes(session), {
    maxOutputLength: 64 * 1024,
  }).toString("utf8");
  const header = object(
    JSON.parse(firstFrame.trim().split("\n")[0] ?? "null") as unknown,
  );
  if (header?.type !== "session" || header.id !== backend || header.cwd !== cwd)
    throw new ObservationReadError("native-session-identity-mismatch");
  const cache = object(
    await reader.json(
      path.join(
        home,
        ".dsh/storages/session_projcache/sessions",
        `${backend}.json`,
      ),
    ),
  );
  const record = object(cache?.record),
    rows = object(record?.rows),
    usage = object(rows?.tokenUsage);
  const totals = object(object(usage?.val)?.totals),
    boundary = object(object(rows?.turnBoundary)?.val);
  if (
    cache?.version !== 4 ||
    object(record?.identity)?.cwd !== cwd ||
    usage?.ver !== 2 ||
    integer(usage.seq) === null ||
    !totals ||
    boundary?.openTurnStartSeq !== null
  )
    throw new ObservationReadError("native-usage-shape-unsupported");
  return {
    source: "dsh-private-token-projection-v4",
    cumulative: true,
    revision: usage.seq as number,
    missingReason: null,
    items: [
      {
        id: backend,
        tokens: nativeTokens(
          totals.uncachedInputTokens,
          totals.outputTokens,
          totals.cacheReadTokens,
          totals.cacheWriteTokens,
          undefined,
        ),
        cost: unknownCost(),
        model: null,
      },
    ],
  };
}
/** No discovery scans or user HOME reads. Unknown formats return an explicit coverage gap without affecting execution. */
export async function captureNativeUsage(
  spec: ExecutionSpec,
  backend: string,
): Promise<NativeUsageSnapshot> {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(backend))
    return {
      source: "native-private-session",
      items: [],
      cumulative: false,
      missingReason: "native-session-id-unsupported",
    };
  const home = path.resolve(spec.stateDir, "home"),
    reader = new PrivateReader(home);
  const command = spec.profile.command ?? [];
  let source = "native-private-session";
  try {
    if (command.some((part) => part.includes("pi-acp"))) {
      source = "pi-private-session-jsonl";
      return await readPi(reader, home, backend, spec.cwd);
    }
    if (
      command.some((part) =>
        /(?:^|[/\\])(?:launch-opencode-acp\.mjs|opencode)(?:\.exe)?$/.test(
          part,
        ),
      )
    ) {
      source = "opencode-private-messages";
      return await readOpenCode(reader, home, backend, spec.cwd);
    }
    if (command.some((part) => /(?:^|[/\\])launch-dsh-acp\.mjs$/.test(part))) {
      source = "dsh-private-token-projection-v4";
      return await readDsh(reader, home, backend, spec.cwd);
    }
    return {
      source,
      items: [],
      cumulative: false,
      missingReason: "native-reader-not-supported",
    };
  } catch (error) {
    const reason =
      error instanceof ObservationReadError
        ? error.message
        : error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "native-private-evidence-not-found"
          : "native-private-evidence-unreadable";
    return { source, items: [], cumulative: false, missingReason: reason };
  }
}
function sumTokens(items: NativeItem[]): ObservedTokens {
  const tokens = unknownTokens();
  for (const key of TOKEN_FIELDS)
    tokens[key] = sum(items.map((item) => item.tokens[key]));
  return tokens;
}
function diffTokens(
  after: ObservedTokens,
  before: ObservedTokens,
): ObservedTokens {
  const result = unknownTokens();
  for (const key of TOKEN_FIELDS) {
    const end = after[key],
      start = before[key];
    result[key] =
      end !== null && start !== null && end >= start ? end - start : null;
  }
  return result;
}
const zeroTokens = (): ObservedTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
});
function aggregateCost(items: NativeItem[]): ObservedCost {
  const first = items[0]?.cost;
  if (
    !first ||
    first.kind === "unknown" ||
    items.some(
      (item) =>
        item.cost.kind !== first.kind ||
        item.cost.currency !== first.currency ||
        item.cost.amount === null,
    )
  )
    return unknownCost();
  return { ...first, amount: sum(items.map((item) => item.cost.amount)) };
}
/** Difference immutable message IDs or monotonic totals across the owned turn; never sum session snapshots as runs. */
export function nativeUsageObservation(
  before: NativeUsageSnapshot,
  after: NativeUsageSnapshot,
  identity: {
    backendSessionId: string;
    requestId: string;
    freshSession: boolean;
  },
): UsageObservation {
  const base: UsageObservation = {
    schemaVersion: 1,
    scope: "run",
    source: after.source,
    backendSessionId: identity.backendSessionId,
    requestId: identity.requestId,
    tokens: unknownTokens(),
    cost: unknownCost(),
    model: null,
    missingReason: after.missingReason,
  };
  if (after.missingReason) return base;
  if (before.missingReason && !identity.freshSession)
    return {
      ...base,
      scope: "session",
      tokens: sumTokens(after.items),
      missingReason: "native-run-baseline-unavailable",
    };
  if (
    after.cumulative &&
    before.revision !== undefined &&
    after.revision !== undefined &&
    after.revision <= before.revision
  )
    return { ...base, missingReason: "native-token-projection-not-advanced" };
  const existing = new Set(before.items.map((item) => item.id));
  const items = after.cumulative
    ? after.items
    : after.items.filter((item) => !existing.has(item.id));
  if (!items.length)
    return { ...base, missingReason: "native-turn-usage-not-reported" };
  const tokens = after.cumulative
    ? diffTokens(
        sumTokens(items),
        before.items.length ? sumTokens(before.items) : zeroTokens(),
      )
    : sumTokens(items);
  const models = [
    ...new Set(
      items.map((item) => item.model).filter((model) => model !== null),
    ),
  ];
  return {
    ...base,
    tokens,
    cost: after.cumulative ? unknownCost() : aggregateCost(items),
    model: models.length === 1 ? models[0]! : null,
    missingReason:
      tokens.input === null || tokens.output === null
        ? "native-token-fields-incomplete"
        : null,
  };
}
function acpTokens(
  value: AcpRuntimeSessionUsage["cumulative"],
): ObservedTokens {
  return {
    input: integer(value?.inputTokens),
    output: integer(value?.outputTokens),
    cacheRead: integer(value?.cachedReadTokens),
    cacheWrite: integer(value?.cachedWriteTokens),
    reasoning: integer(value?.thoughtTokens),
    total: integer(value?.totalTokens),
  };
}
/** ACP cumulative cost is a backend report, never represented as a provider invoice. */
export function acpUsageObservation(
  before: AcpRuntimeSessionUsage | undefined,
  after: AcpRuntimeSessionUsage | undefined,
  identity: {
    backendSessionId: string;
    requestId: string;
    freshSession: boolean;
  },
): UsageObservation {
  const base: UsageObservation = {
    schemaVersion: 1,
    scope: "run",
    source: "acp-session-request-usage",
    backendSessionId: identity.backendSessionId,
    requestId: identity.requestId,
    tokens: unknownTokens(),
    cost: unknownCost(),
    model: null,
    missingReason: null,
  };
  const exact = after?.perRequest?.[identity.requestId];
  const known = new Set(Object.keys(before?.perRequest ?? {}));
  const newRequests = Object.entries(after?.perRequest ?? {}).filter(
    ([key]) => !known.has(key),
  );
  const requestScoped =
    !!exact ||
    ((before !== undefined || identity.freshSession) && newRequests.length > 0);
  // In acpx 0.13.2 applyTokenUsage assigns the latest breakdown to the field
  // named cumulative_token_usage. Only request-key association proves turn scope.
  const tokens = exact
    ? acpTokens(exact)
    : requestScoped
      ? sumTokens(
          newRequests.map(([id, value]) => ({
            id,
            tokens: acpTokens(value),
            cost: unknownCost(),
            model: null,
          })),
        )
      : acpTokens(after?.cumulative);
  const endCost = amount(after?.cost?.amount),
    startCost =
      amount(before?.cost?.amount) ?? (identity.freshSession ? 0 : null);
  const currency = text(after?.cost?.currency);
  const cost =
    endCost !== null &&
    startCost !== null &&
    endCost >= startCost &&
    currency &&
    (!before?.cost?.currency || before.cost.currency === currency)
      ? {
          amount: endCost - startCost,
          currency,
          kind: "reported" as const,
          source: "acp-session-cost-delta",
          missingReason: null,
        }
      : unknownCost();
  return {
    ...base,
    scope: requestScoped ? "run" : "session",
    tokens,
    cost: requestScoped
      ? cost
      : unknownCost("session-usage-not-attributable-to-run"),
    missingReason: requestScoped
      ? null
      : Object.values(tokens).some((value) => value !== null)
        ? "acp-session-usage-not-attributable-to-run"
        : "acp-token-usage-not-reported",
  };
}
