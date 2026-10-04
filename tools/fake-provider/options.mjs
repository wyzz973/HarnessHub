// SPDX-License-Identifier: MIT
/**
 * The fake provider's settings: one parser that validates every option and
 * applies the defaults, producing an immutable specification.
 */
import { BlockList, isIP } from "node:net";
import { isObject } from "./common.mjs";
import { resolveFields } from "./fields.mjs";
import { NO_QUIRKS, resolveQuirks } from "./quirks.mjs";
import { parseScript } from "./script.mjs";

const MAX_MS = 2 ** 31 - 1;

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
loopback.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

/**
 * Whether a host names the loopback interface: `localhost`, an IPv4 address in
 * 127.0.0.0/8, `::1` or an IPv4-mapped loopback address.
 */
export function isLoopback(host) {
  if (host === "localhost") return true;
  const version = isIP(host);
  return version !== 0 && loopback.check(host, version === 4 ? "ipv4" : "ipv6");
}

const KEYS = [
  "host",
  "port",
  "mode",
  "models",
  "keys",
  "fields",
  "script",
  "quirks",
  "chunkDelayMs",
  "slowMs",
  "streamOnly",
  "reasoningReplay",
  "maxBodyBytes",
  "logFile",
  "platform",
  "forbiddenHeaders",
];

function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean")
    throw new Error(`${name} must be true or false`);
  return value;
}

/**
 * Validate the options of `startFakeProvider` and apply the defaults.
 *
 * @param {unknown} raw See `startFakeProvider`.
 * @returns {Readonly<{host: string, port: number, mode: "blacklist" | "whitelist",
 *   models: readonly string[], keys: ReadonlyMap<string, string>,
 *   fields: ReturnType<typeof resolveFields>, script: ReturnType<typeof parseScript> | null,
 *   quirks: typeof NO_QUIRKS, chunkDelayMs: number, slowMs: number, streamOnly: boolean,
 *   reasoningReplay: boolean, maxBodyBytes: number, logFile: string | undefined,
 *   platform: string, forbiddenHeaders: readonly string[]}>}
 * @throws {Error} For an unknown option, an invalid value or a host that is not loopback.
 */
export function resolveOptions(raw = {}) {
  if (!isObject(raw))
    throw new Error("Fake provider options must be an object");
  for (const key of Object.keys(raw))
    if (!KEYS.includes(key))
      throw new Error(`Unknown fake provider option ${key}`);
  const host = raw.host ?? "127.0.0.1";
  if (typeof host !== "string" || !isLoopback(host))
    throw new Error(
      `The fake provider listens on loopback only; host ${JSON.stringify(host)} is not a loopback address (use 127.0.0.1, ::1 or localhost)`,
    );
  const mode = raw.mode ?? "blacklist";
  if (mode !== "blacklist" && mode !== "whitelist")
    throw new Error("mode must be blacklist or whitelist");
  const models = raw.models ?? ["upstream-sim"];
  if (
    !Array.isArray(models) ||
    !models.length ||
    !models.every((model) => typeof model === "string" && model.length > 0)
  )
    throw new Error("models must be a non-empty array of model ids");
  const keys = new Map();
  if (raw.keys !== undefined) {
    if (!isObject(raw.keys))
      throw new Error("keys must map key ids to key values");
    for (const [id, value] of Object.entries(raw.keys)) {
      if (!id || typeof value !== "string" || !value)
        throw new Error(
          "keys must map non-empty key ids to non-empty key values",
        );
      keys.set(id, value);
    }
  }
  if (
    raw.logFile !== undefined &&
    (typeof raw.logFile !== "string" || !raw.logFile)
  )
    throw new Error("logFile must be a path");
  const forbiddenHeaders = raw.forbiddenHeaders ?? [];
  if (
    !Array.isArray(forbiddenHeaders) ||
    forbiddenHeaders.length > 32 ||
    !forbiddenHeaders.every(
      (name) => typeof name === "string" && /^[a-z0-9-]{1,64}$/.test(name),
    )
  )
    throw new Error(
      "forbiddenHeaders must be at most 32 lowercase header names",
    );
  return Object.freeze({
    host,
    port: integer(raw.port ?? 0, "port", 0, 65535),
    mode,
    models: Object.freeze([...models]),
    keys,
    fields: resolveFields(raw.fields ?? {}),
    script: raw.script === undefined ? null : parseScript(raw.script),
    quirks: Object.freeze({ ...NO_QUIRKS, ...resolveQuirks(raw.quirks ?? {}) }),
    chunkDelayMs: integer(raw.chunkDelayMs ?? 15, "chunkDelayMs", 0, MAX_MS),
    slowMs: integer(raw.slowMs ?? 120_000, "slowMs", 1, MAX_MS),
    streamOnly: boolean(raw.streamOnly ?? false, "streamOnly"),
    reasoningReplay: boolean(raw.reasoningReplay ?? true, "reasoningReplay"),
    maxBodyBytes: integer(
      raw.maxBodyBytes ?? 8 * 1024 * 1024,
      "maxBodyBytes",
      1,
      2 ** 31 - 1,
    ),
    logFile: raw.logFile,
    platform: raw.platform ?? process.platform,
    forbiddenHeaders: Object.freeze([...forbiddenHeaders]),
  });
}
