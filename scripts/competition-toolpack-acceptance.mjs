#!/usr/bin/env node
/**
 * Tool Pack acceptance for one engine of a competition layout with a real model.
 *
 * Starts the layout launcher with only `AGENT_ENGINE=<engine>` selecting the engine, imports a
 * local Tool Pack through POST /v1/tool-packs/import with `applyTo:"all"` (the one-click path),
 * then asks the engine in a new Session to call the pack's MCP tool (`workspace_overview`) and
 * CLI tool (`cli_wordcount`). PASS requires the engine to be `applied`, both tool calls to appear
 * in GET /session/{id}/message and the reply to carry values only those tools return (a random
 * marker file name and an exact byte count). An engine the pack cannot be applied to is reported
 * as UNSUPPORTED with the Gateway's reason.
 *
 * Usage: node scripts/competition-toolpack-acceptance.mjs --layout DIR --entry LAUNCHER
 *   --engine ID --out DIR [--pack DIR] [--timeout-ms 900000] [--summary FILE]
 * Exit code: 0 PASS or UNSUPPORTED, 1 FAIL, 2 usage error.
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { httpRequest, waitUntil } from "./lib/competition-client.mjs";
import {
  freePort,
  redactor,
  startLoggedProcess,
  withoutVendorCredentials,
} from "./lib/competition-process.mjs";

const isObject = (value) => typeof value === "object" && value !== null;

function randomWords(count) {
  const words = [];
  for (let index = 0; index < count; index++)
    words.push(randomBytes(1 + (index % 7)).toString("hex"));
  const lines = [];
  for (let index = 0; index < words.length; index += 11)
    lines.push(words.slice(index, index + 11).join(" "));
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      layout: { type: "string" },
      entry: { type: "string" },
      engine: { type: "string" },
      out: { type: "string" },
      pack: { type: "string" },
      "timeout-ms": { type: "string", default: "900000" },
      summary: { type: "string" },
    },
  });
  if (!values.layout || !values.entry || !values.engine || !values.out) {
    console.error(
      "Usage: node scripts/competition-toolpack-acceptance.mjs --layout DIR --entry LAUNCHER --engine ID --out DIR [--pack DIR] [--timeout-ms 900000] [--summary FILE]",
    );
    return 2;
  }
  const engine = values.engine;
  const out = path.resolve(values.out);
  const pack = path.resolve(
    values.pack ?? path.join(values.layout, "tool-packs", "simple-toolkit"),
  );
  const timeoutMs = Number(values["timeout-ms"]);
  await mkdir(out, { recursive: true });
  const env = withoutVendorCredentials(process.env);
  const redact = redactor(
    [env.HARNESSHUB_MODEL_API_KEY].filter((value) => typeof value === "string"),
  );
  const result = {
    engine,
    status: "FAIL",
    pack,
    problems: [],
    import: null,
    engineResult: null,
    prompt: null,
  };
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const gateway = startLoggedProcess({
    entry: path.resolve(values.entry),
    args: ["--port", String(port), "--no-console"],
    cwd: path.dirname(path.resolve(values.entry)),
    env: { ...env, AGENT_ENGINE: engine },
    logFile: path.join(out, `toolpack-gateway-${engine}.log`),
    redact,
  });
  const started = Date.now();
  try {
    const ready = await waitUntil(
      async () =>
        (
          await httpRequest(`${base}/health/ready`, { timeoutMs: 5000 }).catch(
            () => ({ status: 0 }),
          )
        ).status === 200,
      { timeoutMs: 240_000, intervalMs: 1000 },
    );
    if (!ready) throw new Error("Gateway did not become ready within 240 s");

    const imported = await httpRequest(`${base}/v1/tool-packs/import`, {
      method: "POST",
      body: { source: pack, applyTo: "all", replace: true },
      timeoutMs: 600_000,
    });
    const results = imported.json?.apply?.results;
    result.import = {
      status: imported.status,
      package: imported.json?.package ?? null,
      counts: imported.json?.counts ?? null,
      results: Array.isArray(results)
        ? results.map((entry) => ({
            engineId: entry?.engineId,
            status: entry?.status,
            reason: entry?.reason,
          }))
        : null,
    };
    if (imported.status !== 200 || !Array.isArray(results))
      throw new Error(
        `tool-packs/import returned ${imported.status} ${imported.text.slice(0, 400)}`,
      );
    const mine =
      results.find((entry) => entry?.engineId === engine) ??
      results.find(
        (entry) =>
          typeof entry?.engineId === "string" &&
          entry.engineId.startsWith(engine),
      );
    result.engineResult = mine ?? null;
    if (!mine) throw new Error(`import result has no entry for ${engine}`);
    if (mine.status !== "applied") {
      result.status = mine.status === "skipped" ? "UNSUPPORTED" : "FAIL";
      result.problems.push(
        `engine ${mine.status}: ${String(mine.reason ?? "no reason").slice(0, 300)}`,
      );
      return result.status === "UNSUPPORTED" ? 0 : 1;
    }

    const nonce = randomBytes(6).toString("hex");
    const directory = path.join(out, "workspaces", `${engine}-toolpack-${nonce}`);
    await mkdir(directory, { recursive: true });
    const notes = randomWords(233);
    await writeFile(path.join(directory, "notes.txt"), notes);
    const marker = `marker-${nonce}.txt`;
    await writeFile(path.join(directory, marker), "marker\n");
    const bytes = Buffer.byteLength(notes);

    const session = await httpRequest(`${base}/session`, {
      method: "POST",
      body: { title: `toolpack ${engine}`, directory },
      timeoutMs: 120_000,
    });
    if (session.status !== 200 || typeof session.json?.id !== "string")
      throw new Error(
        `POST /session returned ${session.status} ${session.text.slice(0, 300)}`,
      );
    const id = session.json.id;
    const text = [
      "This task checks the tools installed from the simple-toolkit Tool Pack. Do not use shell commands or built-in file tools for it.",
      "1. Call the MCP tool `workspace_overview` to list the files in the current workspace. One file name starts with `marker-`.",
      '2. Call the tool `cli_wordcount` with args ["notes.txt"].',
      "Reply with exactly two lines: `marker: <the marker file name>` and `bytes: <the bytes value reported by cli_wordcount>`.",
    ].join("\n");
    const promptStarted = Date.now();
    const prompted = await httpRequest(
      `${base}/session/${encodeURIComponent(id)}/prompt_async`,
      {
        method: "POST",
        body: {
          parts: [{ type: "text", text }],
          model: {
            providerID: "harnesshub",
            modelID: env.HARNESSHUB_MODEL ?? "harnesshub-model",
          },
        },
        timeoutMs,
      },
    );
    const messages = await httpRequest(
      `${base}/session/${encodeURIComponent(id)}/message`,
      { timeoutMs: 60_000 },
    );
    const all = Array.isArray(messages.json) ? messages.json : [];
    await writeFile(
      path.join(out, `toolpack-messages-${engine}.json`),
      `${redact(JSON.stringify(all, null, 2))}\n`,
    );
    const assistant = [...all]
      .reverse()
      .find(
        (message) =>
          isObject(message) &&
          (message.role === "assistant" || message.info?.role === "assistant"),
      );
    const toolParts = all
      .flatMap((message) =>
        isObject(message) && Array.isArray(message.parts) ? message.parts : [],
      )
      .filter((part) => isObject(part) && part.type === "tool");
    const toolText = toolParts
      .map((part) =>
        `${part.tool ?? ""} ${part.state?.title ?? ""} ${JSON.stringify(part.state?.input ?? {})}`.toLowerCase(),
      )
      .join("\n");
    // The turn's text can be spread over several assistant messages (one per step). The
    // specification carries assistant text in `content` (message and text part).
    const role = (message) => message?.role ?? message?.info?.role;
    const lastUser = all.findLastIndex((message) => role(message) === "user");
    const reply = all
      .slice(lastUser + 1)
      .filter((message) => isObject(message) && role(message) === "assistant")
      .map((message) =>
        typeof message.content === "string" && message.content
          ? message.content
          : (Array.isArray(message.parts) ? message.parts : [])
              .filter((part) => isObject(part) && part.type === "text")
              .map((part) => String(part.content ?? part.text ?? ""))
              .join(""),
      )
      .join("\n");
    result.prompt = {
      httpStatus: prompted.status,
      durationMs: Date.now() - promptStarted,
      finish: assistant?.info?.finish ?? null,
      tools: toolParts
        .map((part) => `${part.tool}:${part.state?.status ?? "?"}`)
        .slice(-12),
      reply: reply.slice(0, 400),
      expected: { marker, bytes },
    };
    if (prompted.status !== 204)
      result.problems.push(
        `prompt_async returned ${prompted.status} ${prompted.text.slice(0, 300)}`,
      );
    if (!toolText.includes("workspace_overview"))
      result.problems.push("no workspace_overview (MCP) tool call in the session");
    if (!toolText.includes("wordcount"))
      result.problems.push("no cli_wordcount (CLI) tool call in the session");
    if (!reply.includes(nonce))
      result.problems.push("reply does not name the marker file");
    if (!reply.includes(String(bytes)))
      result.problems.push(`reply does not carry the byte count ${bytes}`);
    await httpRequest(`${base}/session/${encodeURIComponent(id)}`, {
      method: "DELETE",
      timeoutMs: 60_000,
    }).catch(() => undefined);
    result.status = result.problems.length ? "FAIL" : "PASS";
    return result.status === "PASS" ? 0 : 1;
  } catch (error) {
    result.problems.push(redact(String(error?.message ?? error)));
    return 1;
  } finally {
    await gateway.stop();
    result.durationMs = Date.now() - started;
    await writeFile(
      path.join(out, `toolpack-${engine}.json`),
      `${redact(JSON.stringify(result, null, 2))}\n`,
    );
    console.log(redact(JSON.stringify({ event: "competition.toolpack", ...result })));
    if (values.summary)
      await appendFile(
        values.summary,
        redact(
          [
            "",
            `### Tool Pack (Skill + MCP + CLI) — ${engine}: **${result.status}**`,
            "",
            `- import: ${result.import?.status ?? "-"}; counts ${JSON.stringify(result.import?.counts ?? null)}; this engine: ${result.engineResult?.status ?? "-"}${result.engineResult?.reason ? ` (${String(result.engineResult.reason).slice(0, 200)})` : ""}`,
            `- tool calls: ${(result.prompt?.tools ?? []).join(", ") || "-"}`,
            `- reply: ${(result.prompt?.reply ?? "-").replace(/\s+/g, " ").slice(0, 200)}`,
            ...(result.problems.length
              ? [`- problems: ${result.problems.join("; ")}`]
              : []),
            "",
          ].join("\n"),
        ),
      );
  }
}

process.exitCode = await main();
