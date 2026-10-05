// SPDX-License-Identifier: MIT
/**
 * Usage alerts (Magpie's `usageAlert`, internal/provider/quota_alert.go):
 * when a credential's allowance window has reached the share of it the user
 * chose (`alerts.usagePercent` in the gateway features), the daemon writes
 * a `usage.alert` log line and lists the alert in `GET /api/v1/usage/alerts`.
 * Each window is said once each time it runs: a window read again with a
 * reset within ten minutes of the one it was said for is the same run.
 *
 * What was said is kept in `<dataDir>/usage-alerts.json` (replaced
 * atomically, mode 0600), so a restart does not say it again. A mark of a
 * window no longer read (a credential removed) is dropped after 40 days, as
 * are listed alerts. The readings are the gateway's: rate-limit headers and
 * Copilot's allowances, as `GET /api/v1/routing/state` shows them; HarnessHub
 * does not poll vendors' usage endpoints and reads no balances.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import type { CredentialRoutingView } from "./http/routing-state-routes.js";

export const USAGE_ALERTS_FILE = "usage-alerts.json";

/** One window that reached the threshold. */
export interface UsageAlert {
  /** When it was said (ISO 8601). */
  at: string;
  provider: string;
  credential: string;
  /** The window's name as its source calls it (`requests`, `premium_interactions`). */
  window: string;
  usedPercent: number;
  /** When the window renews, when known. */
  resetsAt?: string;
}

/** What was said of one window: when, and the reset it was said before. */
interface Mark {
  at: string;
  until?: string;
}

interface AlertsFile {
  schemaVersion: 1;
  marks: Record<string, Mark>;
  /** Newest first. */
  alerts: UsageAlert[];
}

/** How far apart two readings of a window's reset may be and still be one run of it. */
const SAME_RUN_MS = 10 * 60_000;
/** How long a mark of a window no longer read, and a listed alert, is kept. */
const KEEP_MS = 40 * 24 * 60 * 60_000;
/** Alerts listed at most. */
const MAX_ALERTS = 100;
/** The first look after the start, then every five minutes (Magpie's cadence). */
export const FIRST_CHECK_MS = 60_000;
export const CHECK_EVERY_MS = 5 * 60_000;

const time = (value: string | undefined) =>
  value === undefined ? undefined : Date.parse(value);

/** Whether `was` and `now`, the resets a window was said before and is read with, are one run. */
function sameRun(was: string | undefined, now: string | undefined): boolean {
  if (was === undefined || now === undefined)
    return was === undefined && now === undefined;
  return Math.abs(time(was)! - time(now)!) < SAME_RUN_MS;
}

/**
 * A reading that no longer describes its window: it renewed since (by its
 * reset, or by its span after it was read). Such a reading neither alerts
 * nor clears a mark: nothing new is known.
 */
function outdated(
  reading: CredentialRoutingView["readings"][number],
  now: number,
): boolean {
  const resets = time(reading.resetsAt);
  if (resets !== undefined && Number.isFinite(resets)) return resets <= now;
  const observed = time(reading.observedAt);
  return (
    reading.spanSeconds !== undefined &&
    observed !== undefined &&
    observed + reading.spanSeconds * 1000 <= now
  );
}

/**
 * The alerts `credentials` call for at `percent`, and `marks` brought up to
 * date with them (Magpie's `dueAlerts`, windows only): a window at or past
 * the share is said unless it was said in this run; one under it is
 * forgotten; a mark of a window not read for 40 days is dropped.
 */
export function dueAlerts(
  credentials: readonly CredentialRoutingView[],
  marks: Record<string, Mark>,
  percent: number,
  now: number,
): UsageAlert[] {
  const due: UsageAlert[] = [];
  const seen = new Set<string>();
  const at = new Date(now).toISOString();
  for (const credential of credentials)
    for (const reading of credential.readings) {
      const key = `${credential.provider}\u0000${credential.credential}\u0000${reading.window}`;
      seen.add(key);
      if (outdated(reading, now)) continue;
      if (reading.usedPercent < percent) {
        delete marks[key];
        continue;
      }
      const mark = marks[key];
      if (mark && sameRun(mark.until, reading.resetsAt)) continue;
      marks[key] = {
        at,
        ...(reading.resetsAt !== undefined ? { until: reading.resetsAt } : {}),
      };
      due.push({
        at,
        provider: credential.provider,
        credential: credential.credential,
        window: reading.window,
        usedPercent: reading.usedPercent,
        ...(reading.resetsAt !== undefined
          ? { resetsAt: reading.resetsAt }
          : {}),
      });
    }
  for (const [key, mark] of Object.entries(marks))
    if (!seen.has(key) && now - Date.parse(mark.at) > KEEP_MS)
      delete marks[key];
  return due;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

function isMark(value: unknown): value is Mark {
  return (
    object(value) &&
    iso(value.at) &&
    (value.until === undefined || iso(value.until)) &&
    Object.keys(value).every((key) => key === "at" || key === "until")
  );
}

function isAlert(value: unknown): value is UsageAlert {
  return (
    object(value) &&
    iso(value.at) &&
    typeof value.provider === "string" &&
    typeof value.credential === "string" &&
    typeof value.window === "string" &&
    typeof value.usedPercent === "number" &&
    Number.isFinite(value.usedPercent) &&
    (value.resetsAt === undefined || iso(value.resetsAt))
  );
}

/** Whether `value` is the file's content. */
export function isAlertsFile(value: unknown): value is AlertsFile {
  return (
    object(value) &&
    value.schemaVersion === 1 &&
    object(value.marks) &&
    Object.values(value.marks).every(isMark) &&
    Array.isArray(value.alerts) &&
    value.alerts.length <= MAX_ALERTS &&
    value.alerts.every(isAlert)
  );
}

export interface UsageAlertsOptions {
  dataDir: string;
  /** The gateway's per-credential readings (`GatewayHandler.routingState`). */
  readings(): readonly CredentialRoutingView[];
  /** The threshold in force (`alerts.usagePercent`); undefined: off. */
  percent(): number | undefined;
  log?: LogSink;
  clock?: () => number;
  /** For tests: the first look and the interval. */
  firstCheckMs?: number;
  checkEveryMs?: number;
}

/**
 * Watches the readings while an alert is set. The owner calls `load()`,
 * then `start()`, and awaits `close()` before the process exits.
 */
export class UsageAlerts {
  #state: AlertsFile = { schemaVersion: 1, marks: {}, alerts: [] };
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(private readonly options: UsageAlertsOptions) {}

  get #file(): string {
    return path.join(this.options.dataDir, USAGE_ALERTS_FILE);
  }

  get #log(): LogSink {
    return this.options.log ?? NO_LOG;
  }

  /**
   * Read what was said before. A missing file is none; a file that cannot
   * be read or is not valid is logged and taken as none, never failing the
   * start (an alert may then be said again).
   */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.#log.info("usage.alerts_unreadable", {
          error: (error as NodeJS.ErrnoException).code ?? "unknown",
        });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (isAlertsFile(value)) this.#state = value;
    else this.#log.info("usage.alerts_invalid", { file: USAGE_ALERTS_FILE });
  }

  /** Look 1 minute from now, then every 5 minutes; the timer keeps no process alive. */
  start(): void {
    this.#schedule(this.options.firstCheckMs ?? FIRST_CHECK_MS);
  }

  /** Look at once (an alert was just turned on), then on the usual interval. */
  wake(): void {
    if (this.#closed) return;
    this.#schedule(0);
  }

  #schedule(ms: number): void {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.check().finally(() =>
        this.#schedule(this.options.checkEveryMs ?? CHECK_EVERY_MS),
      );
    }, ms);
    this.#timer.unref();
  }

  /**
   * Look at the readings once: log and list what is due, and save the marks
   * when they changed. Nothing happens while no alert is set. Never throws;
   * a failed save is logged and the alerts still stand.
   */
  check(): Promise<UsageAlert[]> {
    const run = async (): Promise<UsageAlert[]> => {
      const percent = this.options.percent();
      if (percent === undefined || this.#closed) return [];
      const now = this.options.clock?.() ?? Date.now();
      const before = JSON.stringify(this.#state);
      const marks = { ...this.#state.marks };
      let due: UsageAlert[];
      try {
        due = dueAlerts(this.options.readings(), marks, percent, now);
      } catch (error) {
        this.#log.info("usage.alerts_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
        return [];
      }
      for (const alert of due)
        this.#log.info("usage.alert", {
          provider: alert.provider,
          credential: alert.credential,
          window: alert.window,
          usedPercent: alert.usedPercent,
          threshold: percent,
          resetsAt: alert.resetsAt ?? null,
        });
      const alerts = [...due]
        .reverse()
        .concat(this.#state.alerts)
        .filter((alert) => now - Date.parse(alert.at) <= KEEP_MS)
        .slice(0, MAX_ALERTS);
      this.#state = { schemaVersion: 1, marks, alerts };
      if (JSON.stringify(this.#state) !== before) await this.#save();
      return due;
    };
    const result = this.#running.then(run, run);
    this.#running = result.catch(() => undefined);
    return result;
  }

  async #save(): Promise<void> {
    try {
      await mkdir(this.options.dataDir, { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, this.#file);
    } catch (error) {
      this.#log.info("usage.alerts_unsaved", {
        error: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
    }
  }

  /** The alerts said in the last 40 days, newest first (at most 100). */
  list(): UsageAlert[] {
    return structuredClone(this.#state.alerts);
  }

  /** Stop looking and wait for a look in progress. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    await this.#running;
  }
}
