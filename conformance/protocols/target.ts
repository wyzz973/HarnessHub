// SPDX-License-Identifier: MIT
/**
 * The system the protocol suite drives (10-engineering section 3.3): the
 * strict fake upstream (`tools/fake-provider`, whitelist mode, loopback) and
 * HarnessHub started with the `hh serve` command, configured only through
 * `@harnesshub/sdk`. Paths are resolved from the working directory, which is
 * the repository root under `node tools/run-tests.mjs protocol`.
 *
 * Every key is a synthetic canary; nothing here reads a real credential or
 * reaches the network beyond loopback.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { ApiKeyHeader, WireProtocol } from "@harnesshub/core/model-plane";
import type { HarnessHubClient } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";

/** The four protocols, by HarnessHub's names. */
export const PROTOCOLS = ["chat", "responses", "anthropic", "gemini"] as const;
export type Protocol = (typeof PROTOCOLS)[number] & WireProtocol;

/** The served model: its id at the upstream and its id at each provider. */
export const UPSTREAM_MODEL = "upstream-sim";
export const MODEL = "sim";

const HH = path.resolve("apps/hh/bin/hh.mjs");
const FAKE = path.resolve("tools/fake-provider/index.mjs");
const KEY_VARIABLE = "HH_PROTOCOL_SUITE_UPSTREAM_KEY";
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

/** The fake provider's name of a protocol. */
export function fakeProtocol(protocol: Protocol): string {
  return protocol === "anthropic" ? "messages" : protocol;
}

/** One scripted upstream turn, as tools/fake-provider/script.mjs reads it. */
export interface ScriptTurn {
  when?: {
    contains?: string;
    toolResult?: boolean;
    toolResultContains?: string;
    offersTool?: string;
  };
  repeat?: boolean;
  reasoning?: string | string[];
  text?: string | string[];
  toolCalls?: (
    | { name: string; arguments: Record<string, unknown> | string }
    | { name: string; input: string }
  )[];
  finish?: string;
  usage?:
    | false
    | { input: number; output: number; reasoning?: number; cached?: number };
  status?: number;
  error?: string;
  firstByteDelayMs?: number;
  chunkDelayMs?: number;
  quirks?: Record<string, unknown>;
}

/** One request as the fake provider recorded it (no prompts, no key values). */
export interface UpstreamRecord {
  seq: number;
  at: string;
  path: string;
  protocol: string;
  status: number;
  auth: string;
  model?: string | null;
  stream?: boolean;
  turn?: string;
  script?: number;
  messages?: number;
  tools?: number;
  images?: number;
  reasoningEcho?: boolean | "mismatch";
  violations: { path: string; rule: string; message: string }[];
  aborted?: boolean;
  disconnected?: boolean;
  midStreamError?: boolean;
}

/**
 * A provider the suite creates: one upstream protocol, one credential. With
 * `retry`, clients reach it through a route group of the same id with that
 * retry policy.
 */
export interface UpstreamProvider {
  id: string;
  protocol: Protocol;
  retry?: Record<string, number>;
}

export interface Target {
  /** The gateway's origin; OpenAI clients use `${url}/v1`. */
  gatewayUrl: string;
  /** A `client:` gateway key allowed every provider the suite created. */
  gatewayKey: string;
  /** The model a client names to reach `provider`. */
  model(provider: string): string;
  /** Requests the upstream recorded after `after` (sequence number). */
  upstream(after?: number): Promise<UpstreamRecord[]>;
  admin: HarnessHubClient;
  close(): Promise<void>;
}

/** The upstream authentication of each protocol, as its vendor's API has it. */
const AUTH: Record<Protocol, ApiKeyHeader> = {
  chat: "authorization-bearer",
  responses: "authorization-bearer",
  anthropic: "x-api-key",
  gemini: "x-goog-api-key",
};

/** The JSON line a child prints on stdout when ready, within the start timeout. */
async function readyLine(
  child: ChildProcess,
  name: string,
  match: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const lines = createInterface({ input: child.stdout! });
  const timeout = AbortSignal.timeout(START_TIMEOUT_MS);
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (text: string) => {
    stderr = (stderr + text).slice(-4000);
  });
  const exited = once(child, "exit").then(([code]) => {
    throw new Error(`${name} exited with ${String(code)}: ${stderr}`);
  });
  const found = (async () => {
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        value !== null &&
        typeof value === "object" &&
        match(value as Record<string, unknown>)
      )
        return value as Record<string, unknown>;
    }
    throw new Error(`${name} closed its output before it was ready`);
  })();
  const expired = once(timeout, "abort").then(() => {
    throw new Error(
      `${name} was not ready within ${START_TIMEOUT_MS} ms: ${stderr}`,
    );
  });
  try {
    return await Promise.race([found, exited, expired]);
  } finally {
    lines.close();
    // Keep draining stdout so that the child never blocks on a full pipe.
    child.stdout!.resume();
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(STOP_TIMEOUT_MS, false),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await exited;
  }
}

/**
 * Start the fake upstream with `script` in whitelist mode, start `hh serve`
 * and create `providers` (each serving {@link MODEL} with the vendor's own
 * authentication) and one gateway key for all of them.
 *
 * @param options.chunkDelayMs Wait between the upstream's stream frames.
 * @param options.fields An extra field manifest for the whitelist (fields.mjs).
 * @returns The running target; `close` stops both processes and removes
 *   their directories, also after a failed start.
 */
export async function startTarget(options: {
  script: { turns: ScriptTurn[] };
  providers: UpstreamProvider[];
  chunkDelayMs?: number;
  fields?: Record<string, unknown>;
}): Promise<Target> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-protocol-"));
  const children: ChildProcess[] = [];
  const close = async () => {
    await Promise.all(children.map(stop));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    const key = `sk-synthetic-protocol-${randomBytes(12).toString("hex")}`;
    const scriptFile = path.join(root, "script.json");
    await writeFile(scriptFile, JSON.stringify(options.script));
    const fieldArgs: string[] = [];
    if (options.fields) {
      const fieldsFile = path.join(root, "fields.json");
      await writeFile(fieldsFile, JSON.stringify(options.fields));
      fieldArgs.push("--fields", fieldsFile);
    }
    const fake = spawn(
      process.execPath,
      [
        FAKE,
        "--port",
        "0",
        "--mode",
        "whitelist",
        "--model",
        UPSTREAM_MODEL,
        "--key-env",
        KEY_VARIABLE,
        "--script",
        scriptFile,
        "--chunk-delay-ms",
        String(options.chunkDelayMs ?? 2),
        ...fieldArgs,
      ],
      {
        env: { ...process.env, [KEY_VARIABLE]: key },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(fake);
    const upstreamUrl = String(
      (
        await readyLine(
          fake,
          "the fake provider",
          (value) => value.event === "fake-provider.ready",
        )
      ).url,
    );

    const dataDir = path.join(root, "data");
    const hub = spawn(
      process.execPath,
      [
        HH,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--data-dir",
        dataDir,
        "--config-dir",
        path.join(root, "config"),
        "--secrets-backend",
        "file",
      ],
      { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(hub);
    const gatewayUrl = String(
      (await readyLine(hub, "hh serve", (value) => value.event === "ready"))
        .url,
    ).replace(/\/$/, "");

    const admin = await connectLocal({ dataDir, url: gatewayUrl });
    for (const provider of options.providers) {
      await admin.providers.create({
        id: provider.id,
        name: provider.id,
        kind: "custom",
        endpoints: {
          [provider.protocol]:
            provider.protocol === "chat" || provider.protocol === "responses"
              ? `${upstreamUrl}/v1`
              : upstreamUrl,
        },
        auth: { apiKeyHeader: AUTH[provider.protocol] },
        models: {
          source: "manual",
          list: [
            {
              id: MODEL,
              wire: UPSTREAM_MODEL,
              contextWindow: 128_000,
              maxOutputTokens: 8192,
              reasoning: true,
              inputModalities: ["text", "image"],
            },
          ],
          expose: "all",
        },
        credential: { value: key },
      });
      if (provider.retry)
        await admin.routeGroups.create({
          id: provider.id,
          members: [`${provider.id}/${MODEL}`],
          retry: provider.retry,
        });
    }
    const created = await admin.gatewayKeys.create({
      name: "protocol-suite",
      modelAllow: options.providers.flatMap((provider) => [
        `${provider.id}/*`,
        ...(provider.retry ? [`group/${provider.id}`] : []),
      ]),
      expiresAt: null,
    });
    return {
      gatewayUrl,
      gatewayKey: created.key,
      model: (id) =>
        options.providers.find((provider) => provider.id === id)?.retry
          ? `group/${id}`
          : `${id}/${MODEL}`,
      async upstream(after = 0) {
        const response = await fetch(
          `${upstreamUrl}/__fake/requests?after=${after}`,
        );
        const body = (await response.json()) as {
          requests: UpstreamRecord[];
        };
        return body.requests;
      },
      admin,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
