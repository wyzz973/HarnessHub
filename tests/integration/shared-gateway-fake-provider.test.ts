// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import {
  credentialFingerprint,
  decodeAnswer,
  requestBuilders,
  startFakeProvider,
  type WireProtocol,
} from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "synthetic-shared-matrix-upstream-canary-3d91";
const MODEL = "upstream-sim";
const PROTOCOLS: WireProtocol[] = ["chat", "responses", "messages", "gemini"];

/** The provider id of each upstream protocol; each has only that endpoint. */
const PROVIDER: Record<WireProtocol, string> = {
  chat: "up-chat",
  responses: "up-responses",
  messages: "up-messages",
  gemini: "up-gemini",
};

function route(protocol: WireProtocol, model: string, stream: boolean) {
  switch (protocol) {
    case "chat":
      return "/v1/chat/completions";
    case "responses":
      return "/v1/responses";
    case "messages":
      return "/v1/messages";
    case "gemini":
      return `/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  }
}

function headers(protocol: WireProtocol, key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(protocol === "messages"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : protocol === "gemini"
        ? { "x-goog-api-key": key }
        : { authorization: `Bearer ${key}` }),
  };
}

/** A portable request of the inbound protocol: one user message and a shell tool. */
function request(
  protocol: WireProtocol,
  model: string,
  stream: boolean,
  text: string,
  tools: unknown[],
): Record<string, unknown> {
  switch (protocol) {
    case "chat":
      return {
        model,
        stream,
        max_tokens: 256,
        messages: [{ role: "user", content: text }],
        tools,
      };
    case "responses":
      return {
        model,
        stream,
        max_output_tokens: 256,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        ],
        tools,
      };
    case "messages":
      return {
        model,
        stream,
        max_tokens: 256,
        messages: [{ role: "user", content: text }],
        tools,
      };
    case "gemini":
      return { contents: [{ role: "user", parts: [{ text }] }], tools };
  }
}

/**
 * Known gap, kept visible as a todo: a tool call answered through a Responses
 * upstream needs the call's reasoning item back, and the Responses encoder
 * cannot send it yet (it would need the item's encrypted content).
 */
const RESPONSES_REPLAY_GAP =
  "the Responses encoder does not send a call's reasoning item back";

void test(
  "every inbound protocol reaches every upstream protocol of the strict fake provider in whitelist mode through the daemon",
  { timeout: 120_000 },
  async (t) => {
    // Whitelist mode: only each protocol's portable request fields pass.
    // Translated Chat calls ask for streamed usage with stream_options, which
    // this gateway always sends; it is declared rather than hidden.
    const strict = {
      mode: "whitelist",
      models: [MODEL],
      keys: { upstream: UPSTREAM_KEY },
      fields: { chat: { declared: { topLevel: ["stream_options"] } } },
      chunkDelayMs: 0,
    };
    const fake = await startFakeProvider(strict);
    t.after(() => fake.close());
    // The known gap runs against its own provider, so that its failures do
    // not mix with the records checked below.
    const replay = await startFakeProvider(strict);
    t.after(() => replay.close());
    const { directory, defer } = await temporaryDirectory(t, "hh-matrix-");
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
    const models = {
      source: "manual" as const,
      list: [{ id: MODEL }],
      expose: "all" as const,
    };
    const credential = { value: UPSTREAM_KEY };
    // The Chat upstream returns DeepSeek's reasoning_content and wants it back.
    await client.providers.create({
      id: PROVIDER.chat,
      endpoints: { chat: `${fake.url}/v1` },
      capabilities: { requiresReasoningReplay: true },
      models,
      credential,
    });
    await client.providers.create({
      id: PROVIDER.responses,
      endpoints: { responses: `${fake.url}/v1` },
      models,
      credential,
    });
    await client.providers.create({
      id: "up-responses-replay",
      endpoints: { responses: `${replay.url}/v1` },
      models,
      credential,
    });
    await client.providers.create({
      id: PROVIDER.messages,
      endpoints: { anthropic: fake.url },
      auth: { apiKeyHeader: "x-api-key" },
      models,
      credential,
    });
    await client.providers.create({
      id: PROVIDER.gemini,
      endpoints: { gemini: fake.url },
      auth: { apiKeyHeader: "x-goog-api-key" },
      models,
      credential,
    });
    const key = (
      await client.gatewayKeys.create({
        name: "matrix",
        modelAllow: [
          ...Object.values(PROVIDER).map((id) => `${id}/*`),
          "up-responses-replay/*",
        ],
      })
    ).key;
    const builders = await requestBuilders();
    const call = async (
      inbound: WireProtocol,
      model: string,
      stream: boolean,
      body: Record<string, unknown>,
      where: string,
    ) => {
      const response = await fetch(hub.url + route(inbound, model, stream), {
        method: "POST",
        headers: headers(inbound, key),
        body: JSON.stringify(body),
      });
      const text = await response.text();
      assert.equal(response.status, 200, `${where}: ${text}`);
      return decodeAnswer(inbound, text, { stream, sse: true });
    };

    /** The records the main provider must hold, in order. */
    const expected: { protocol: WireProtocol; turn: string }[] = [];
    for (const upstream of PROTOCOLS)
      for (const inbound of PROTOCOLS)
        for (const stream of [false, true]) {
          const where = `${inbound} -> ${upstream} stream=${stream}`;
          const tools = builders.shellTools(inbound);
          await t.test(`${where}: text`, async () => {
            const model = `${PROVIDER[upstream]}/${MODEL}`;
            const plain = await call(
              inbound,
              model,
              stream,
              request(inbound, model, stream, "hello", tools),
              where,
            );
            assert.equal(plain.text, "OK", where);
          });
          expected.push({ protocol: upstream, turn: "plain" });
          const gap = upstream === "responses" && inbound !== "responses";
          // A tool round trip: the provider requires the reasoning of its
          // call back in its own protocol's place.
          await t.test(
            `${where}: tool round trip`,
            gap ? { todo: RESPONSES_REPLAY_GAP } : {},
            async () => {
              const model = `${gap ? "up-responses-replay" : PROVIDER[upstream]}/${MODEL}`;
              const first = request(
                inbound,
                model,
                stream,
                `HH_MOCK_TOOL ${where}`,
                tools,
              );
              const called = await call(inbound, model, stream, first, where);
              assert.deepEqual(
                called.toolCalls.map((tool) => [
                  tool.name,
                  JSON.parse(tool.arguments) as unknown,
                ]),
                [["bash", { command: "echo mock-ok > mock-ok.txt" }]],
                where,
              );
              const done = await call(
                inbound,
                model,
                stream,
                builders.followUp(inbound, first, called, {
                  echo:
                    called.reasoning !== "" || called.signature !== undefined,
                }),
                where,
              );
              assert.equal(done.text, "DONE", where);
            },
          );
          if (!gap)
            expected.push(
              { protocol: upstream, turn: "tool-call" },
              { protocol: upstream, turn: "tool-result" },
            );
        }

    // With thinking enabled, Messages shows the reasoning and wants the signed
    // thinking block back; the gateway restores it from its signature cache.
    await t.test(
      "chat with reasoning -> messages: signed thinking goes back",
      async () => {
        const model = `${PROVIDER.messages}/${MODEL}`;
        const where = "chat reasoning -> messages";
        const first = {
          ...request(
            "chat",
            model,
            true,
            `HH_MOCK_TOOL ${where}`,
            builders.shellTools("chat"),
          ),
          // Room for the smallest thinking budget (1024 tokens).
          max_tokens: 4096,
          reasoning_effort: "low",
        };
        const called = await call("chat", model, true, first, where);
        assert.notEqual(called.reasoning, "");
        assert.equal(called.toolCalls.length, 1);
        const done = await call(
          "chat",
          model,
          true,
          builders.followUp("chat", first, called),
          where,
        );
        assert.equal(done.text, "DONE");
      },
    );
    expected.push(
      { protocol: "messages", turn: "tool-call" },
      { protocol: "messages", turn: "tool-result" },
    );

    await fake.idle();
    assert.deepEqual(fake.violations(), []);
    const records = fake.records();
    const fingerprint = await credentialFingerprint(UPSTREAM_KEY);
    for (const record of records) {
      assert.equal(record.status, 200);
      assert.equal(record.model, MODEL);
      assert.equal(record.auth, "ok");
      assert.equal(record.keyFingerprint, fingerprint);
    }
    // Every upstream protocol saw its own requests, in order.
    assert.deepEqual(
      records.map((record) => ({
        protocol: record.protocol,
        turn: record.turn,
      })),
      expected,
    );
    // Reasoning came back wherever the provider showed it; Messages shows
    // thinking only when the request enables it, as only the last case does.
    for (const record of records.filter(
      (entry) => entry.turn === "tool-result",
    ))
      assert.equal(
        record.reasoningEcho,
        record === records.at(-1) || record.protocol !== "messages"
          ? true
          : undefined,
        record.protocol,
      );
    const ledger = (await client.modelCalls.list({ limit: 200 })).items.filter(
      (entry) => entry.provider !== "up-responses-replay",
    );
    assert.equal(ledger.length, expected.length);
    for (const entry of ledger) {
      assert.equal(entry.status, 200);
      assert.equal(
        entry.mode,
        entry.inbound.protocol === entry.upstreamProtocol
          ? "passthrough"
          : "translated",
      );
    }
  },
);
