// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  CredentialId,
  GatewayKeyId,
  ModelCallEntry,
  ModelCallId,
  ModelRef,
  ProviderId,
} from "@harnesshub/core/model-plane";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal, readAdminToken } from "@harnesshub/sdk/local";
import { SqliteModelPlaneStore } from "@harnesshub/store/storage/model-plane-store";
import { HH_ENTRY } from "../support/entries.js";
import { temporaryDirectory } from "../support/temporary.js";

/** Magpie's `CSVHeader` (internal/usage/ledger.go), copied here on purpose. */
const MAGPIE_COLUMNS = [
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
];

/**
 * An RFC 4180 reader written apart from the writer under test: quoted
 * fields with doubled quotes and line breaks, LF or CRLF record ends.
 */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
      index++;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += char;
    index++;
  }
  assert.equal(quoted, false, "an unterminated quoted field");
  assert.equal(field, "", "the last record has no line end");
  assert.deepEqual(record, []);
  return records;
}

/** Records as objects by header. */
function rows(text: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(text);
  return body.map((record) => {
    assert.equal(record.length, header!.length);
    return Object.fromEntries(header!.map((name, i) => [name, record[i]!]));
  });
}

const INJECTED =
  '=HYPERLINK("http://evil.example","x"), with "quotes"\nand a line break';

void test(
  "calls and usage export as CSV with Magpie's columns through the API, the SDK and hh",
  { timeout: 120_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(t, "hh-usage-csv-");
    const dataDir = path.join(directory, "data");
    const hub = await startHub({
      dataDir,
      configDir: path.join(directory, "config"),
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
    });
    defer(() => hub.server.close());
    const client = await connectLocal({ dataDir, url: hub.url });
    const token = await readAdminToken(dataDir);
    const provider = await client.providers.create({
      id: "alpha",
      endpoints: {
        chat: "https://alpha.example/api/v1",
        anthropic: "https://alpha.example/anthropic",
      },
      models: { source: "manual", list: [{ id: "chat-1" }], expose: "all" },
      credential: { name: 'Work, "main"', value: "sk-synthetic-csv-0001" },
    });
    const credential = provider.credentials[0]!;
    const { gatewayKey } = await client.gatewayKeys.create({
      name: "@laptop",
      modelAllow: ["alpha/*"],
    });

    const base = (index: number): ModelCallEntry => ({
      callId: `call-${String(index).padStart(4, "0")}` as ModelCallId,
      occurredAt: new Date(
        Date.UTC(2026, 9, 1, 0, 0, index, 250),
      ).toISOString(),
      keyId: gatewayKey.keyId as GatewayKeyId,
      inbound: { protocol: "chat", path: "/v1/chat/completions", stream: true },
      modelRef: "alpha/chat-1" as ModelRef,
      provider: "alpha" as ProviderId,
      credentialId: credential.id as CredentialId,
      wireModel: "chat-1",
      upstreamProtocol: "chat",
      mode: "passthrough",
      patches: [],
      unmapped: [],
      status: 200,
      usage: {
        input: 100 + index,
        cacheRead: 10,
        cacheWrite: 2,
        output: 50,
        reasoning: 7,
        source: "reported",
      },
      timing: { durationMs: 1500, firstContentMs: 300 },
      attempts: [],
      cost: { amountUsd: 0.1234567, priceSource: "user" },
    });
    // More calls than one page of the export (200), so it reads several.
    const FILLER = 205;
    const plane = new SqliteModelPlaneStore(
      path.join(dataDir, "harnesshub.sqlite"),
    );
    try {
      for (let index = 0; index < FILLER; index++)
        await plane.appendModelCall(base(index));
      await plane.appendModelCall({
        ...base(FILLER),
        callId: "call-tuned" as ModelCallId,
        agent: { id: "claude", source: "key" },
        requestedModel: "group/fast",
        servedModel: "chat-1-2026-01-01",
        conversationKey: "a".repeat(64),
        patches: ["sticky:hit", "member-effort:high"],
      });
      await plane.appendModelCall({
        ...base(FILLER + 1),
        callId: "call-failed" as ModelCallId,
        inbound: { protocol: "anthropic", path: "/v1/messages", stream: false },
        requestedModel: "@SUM(A1)",
        mode: "translated",
        servedModel: "other-model",
        purpose: "vision",
        status: 502,
        errorClass: "upstream_5xx",
        errorSource: "upstream",
        error: INJECTED,
        cost: null,
        timing: { durationMs: 80 },
      });
      await plane.appendModelCall({
        callId: "call-rejected" as ModelCallId,
        occurredAt: new Date(Date.UTC(2026, 9, 1, 1)).toISOString(),
        keyId: gatewayKey.keyId as GatewayKeyId,
        inbound: {
          protocol: "chat",
          path: "/v1/chat/completions",
          stream: false,
        },
        requestedModel: "-2+3",
        patches: [],
        unmapped: [],
        status: 403,
        errorClass: "model_not_allowed",
        error: "+not allowed",
        timing: { durationMs: 1 },
        attempts: [],
        cost: null,
        rejected: true,
        rejectReason: "model_not_allowed",
      });
    } finally {
      plane.close();
      await plane.whenClosed();
    }
    const total = FILLER + 3;

    const api = (pathAndQuery: string, accept?: string) =>
      fetch(`${hub.url}/api/v1/${pathAndQuery}`, {
        headers: {
          authorization: `Bearer ${token}`,
          ...(accept ? { accept } : {}),
        },
      });

    const response = await api("model-calls?format=csv");
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/csv; charset=utf-8",
    );
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename="harnesshub-calls-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    // UTF-8 without a byte order mark, as Magpie writes it.
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.equal(text.includes("\r\n"), false);
    assert.deepEqual(parseCsv(text)[0], MAGPIE_COLUMNS);
    const calls = rows(text);
    assert.equal(calls.length, total);
    // Newest first, as the ledger lists them, across pages, each call once.
    const times = calls.map((row) => Date.parse(row.time!));
    assert.deepEqual(
      times,
      [...times].sort((a, b) => b - a),
    );
    for (const row of calls)
      assert.match(
        row.time!,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/,
      );

    const [rejected, failed, tuned, newestFiller] = calls;
    assert.equal(Date.parse(rejected!.time!), Date.UTC(2026, 9, 1, 1));
    // Cells a spreadsheet would take for formulas are prefixed; a number is not.
    assert.deepEqual(
      {
        requested: rejected!.requested_model,
        message: rejected!.error_message,
        status: rejected!.status,
        error: rejected!.error,
        rejected: rejected!.rejected,
        provider: rejected!.provider,
        tokens: rejected!.input_tokens,
        cost: rejected!.cost_usd,
        ttft: rejected!.ttft_ms,
        type: rejected!.error_type,
        caller: [rejected!.caller_key_id, rejected!.caller_key_name],
      },
      {
        requested: "'-2+3",
        message: "'+not allowed",
        status: "403",
        error: "true",
        rejected: "true",
        provider: "",
        tokens: "0",
        cost: "",
        ttft: "",
        type: "model_not_allowed",
        caller: [gatewayKey.keyId, "'@laptop"],
      },
    );
    assert.deepEqual(
      {
        requested: failed!.requested_model,
        message: failed!.error_message,
        swapped: failed!.swapped,
        endpoint: failed!.endpoint,
        kind: failed!.kind,
        error: failed!.error,
        cost: failed!.cost_usd,
        host: failed!.host,
      },
      {
        requested: "'@SUM(A1)",
        message: `'${INJECTED}`,
        swapped: "true",
        endpoint: "/v1/messages → /api/v1/chat/completions",
        kind: "vision",
        error: "true",
        cost: "",
        host: "alpha.example",
      },
    );
    assert.equal(Date.parse(tuned!.time!), Date.UTC(2026, 9, 1, 0, 0, FILLER));
    assert.deepEqual(
      Object.fromEntries(
        MAGPIE_COLUMNS.slice(1).map((name) => [name, tuned![name]]),
      ),
      {
        agent: "claude",
        requested_model: "group/fast",
        provider: "alpha",
        host: "alpha.example",
        model: "chat-1",
        served_model: "chat-1-2026-01-01",
        // The dated name of the model sent is the same model.
        swapped: "false",
        effort: "high",
        input_tokens: String(100 + FILLER),
        output_tokens: "50",
        cache_write_tokens: "2",
        cache_read_tokens: "10",
        reasoning_tokens: "7",
        cost_usd: "0.123457",
        duration_ms: "1500",
        ttft_ms: "300",
        status: "200",
        error: "false",
        session: "a".repeat(64),
        kind: "",
        provider_key_id: credential.id,
        provider_key_name: 'Work, "main"',
        provider_account: "",
        route_id: "",
        request_id: "",
        endpoint: "/v1/chat/completions",
        error_message: "",
        error_type: "",
        source: "",
        rejected: "false",
        session_provider: "",
        session_account: "",
        session_official_login: "false",
        caller_key_id: gatewayKey.keyId,
        caller_key_name: "'@laptop",
      },
    );
    assert.equal(newestFiller!.input_tokens, String(100 + FILLER - 1));
    assert.equal(calls.at(-1)!.input_tokens, "100");
    // The raw text carries the quoting the reader undid.
    assert.ok(
      text.includes(
        `"'=HYPERLINK(""http://evil.example"",""x""), with ""quotes""\nand a line break"`,
      ),
    );
    assert.ok(text.includes(`"Work, ""main"""`));

    // The same through the Accept header; the filter applies; JSON stays the default.
    const accepted = await api("model-calls?provider=alpha", "text/csv");
    assert.equal(
      accepted.headers.get("content-type"),
      "text/csv; charset=utf-8",
    );
    assert.equal(rows(await accepted.text()).length, total - 1);
    for (const accept of [
      undefined,
      "*/*",
      "application/json, text/csv",
      "text/csv;q=0.5, application/json",
    ]) {
      const answer = await api("model-calls?limit=1", accept);
      assert.match(
        answer.headers.get("content-type") ?? "",
        /^application\/json/,
        accept,
      );
      assert.equal(
        ((await answer.json()) as { items: unknown[] }).items.length,
        1,
      );
    }
    assert.equal(
      (await api("model-calls?format=json", "text/csv")).headers
        .get("content-type")
        ?.startsWith("application/json"),
      true,
    );
    // A cursor has no meaning for an export of every call; a bad filter is a 400 before any CSV.
    const cursor = await api("model-calls?format=csv&cursor=abc");
    assert.equal(cursor.status, 400);
    assert.match(cursor.headers.get("content-type") ?? "", /problem\+json/);
    const badFilter = await api(
      "model-calls?format=csv&from=2026-02-30T00:00:00Z",
    );
    assert.equal(badFilter.status, 400);
    assert.match(badFilter.headers.get("content-type") ?? "", /problem\+json/);
    assert.equal((await api("model-calls?format=xml")).status, 400);

    // Usage buckets: the grouping, then the same token and cost columns.
    const usage = await api("usage?format=csv&groupBy=provider");
    assert.match(
      usage.headers.get("content-disposition") ?? "",
      /filename="harnesshub-usage-by-provider-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const usageText = await usage.text();
    assert.deepEqual(parseCsv(usageText)[0], [
      "provider",
      "calls",
      "failed_calls",
      "input_tokens",
      "output_tokens",
      "cache_write_tokens",
      "cache_read_tokens",
      "reasoning_tokens",
      "cost_usd",
      "unpriced_calls",
    ]);
    const report = await client.usage.aggregate({ groupBy: "provider" });
    assert.deepEqual(
      rows(usageText),
      report.items.map((bucket) => ({
        provider: bucket.key,
        calls: String(bucket.calls),
        failed_calls: String(bucket.failedCalls),
        input_tokens: String(bucket.usage.input),
        output_tokens: String(bucket.usage.output),
        cache_write_tokens: String(bucket.usage.cacheWrite),
        cache_read_tokens: String(bucket.usage.cacheRead),
        reasoning_tokens: String(bucket.usage.reasoning),
        cost_usd: Number(bucket.cost.amount).toFixed(6),
        unpriced_calls: String(bucket.unpricedCalls),
      })),
    );
    const alpha = rows(usageText).find((row) => row.provider === "alpha")!;
    assert.equal(alpha.calls, String(FILLER + 2));
    assert.equal(alpha.unpriced_calls, "1");

    // The SDK streams the same bytes.
    assert.equal(
      await new Response(await client.modelCalls.csv()).text(),
      text,
    );
    assert.equal(
      await new Response(
        await client.usage.csv({ groupBy: "provider" }),
      ).text(),
      usageText,
    );
    await assert.rejects(
      client.modelCalls.csv({ from: "2026-02-30T00:00:00Z" }),
      {
        status: 400,
      },
    );

    // hh writes them to standard output.
    const hh = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        execFile(
          process.execPath,
          [
            fileURLToPath(HH_ENTRY),
            ...args,
            "--url",
            hub.url,
            "--data-dir",
            dataDir,
          ],
          { cwd: directory, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) =>
            resolve({
              code: error ? Number(error.code ?? 1) : 0,
              stdout,
              stderr,
            }),
        ),
      );
    const exported = await hh(["usage", "--by", "call", "--format", "csv"]);
    assert.equal(exported.code, 0, exported.stderr);
    assert.equal(exported.stdout, text);
    // A reader that has gone before hh writes (`| true`; with `| head` the
    // pipe's buffer may take it all first): the export stops at the first
    // write that fails, and hh ends as it would have, with no EPIPE.
    const headed = await new Promise<{
      code: number | null;
      signal: string | null;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(HH_ENTRY),
          ...["usage", "--by", "call", "--format", "csv"],
          ...["--url", hub.url, "--data-dir", dataDir],
        ],
        { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr
        .setEncoding("utf8")
        .on("data", (chunk: string) => (stderr += chunk));
      child.stdout.destroy();
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stderr }));
    });
    assert.deepEqual([headed.code, headed.signal], [0, null], headed.stderr);
    assert.equal(headed.stderr, "");
    const summed = await hh(["usage", "--by", "provider", "--format", "csv"]);
    assert.equal(summed.code, 0, summed.stderr);
    assert.equal(summed.stdout, usageText);
    const listed = await hh(["usage", "--by", "call", "--format", "json"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(
      (JSON.parse(listed.stdout) as { items: { callId: string }[] }).items
        .slice(0, 3)
        .map((item) => item.callId),
      ["call-rejected", "call-failed", "call-tuned"],
    );
    const table = await hh(["usage", "--by", "call"]);
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /^TIME\s+AGENT\s+MODEL\s+STATUS/);
    assert.match(table.stdout, /export them all with --format csv/);
    for (const wrong of [
      ["usage", "--format", "xml"],
      ["usage", "--json", "--format", "csv"],
      ["usage", "--by", "conversation", "--format", "csv"],
    ])
      assert.equal((await hh(wrong)).code, 2, wrong.join(" "));
  },
);
