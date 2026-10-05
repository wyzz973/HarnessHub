// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import type { WireProtocol } from "../src/model-plane.js";
import { endpointProblem } from "../src/model-plane-records.js";

void test("provider base URLs follow the official SDK convention", () => {
  const accepted: Array<[WireProtocol, string]> = [
    ["chat", "https://api.openai.com/v1"],
    ["responses", "https://api.openai.com/v1/"],
    ["chat", "https://open.bigmodel.cn/api/paas/v4"],
    ["anthropic", "https://api.anthropic.com"],
    ["anthropic", "https://api.deepseek.com/anthropic"],
    ["gemini", "https://generativelanguage.googleapis.com"],
    // Plain HTTP only for loopback and RFC 1918 hosts.
    ["chat", "http://localhost:11434/v1"],
    ["chat", "http://ollama.localhost/v1"],
    ["chat", "http://127.0.0.1:1234/v1"],
    ["chat", "http://[::1]:8000/v1"],
    ["chat", "http://10.1.2.3/v1"],
    ["chat", "http://172.16.0.1/v1"],
    ["chat", "http://172.31.255.254/v1"],
    ["anthropic", "http://192.168.1.20:4000"],
  ];
  for (const [protocol, url] of accepted)
    assert.equal(endpointProblem(protocol, url), undefined, url);

  const refused: Array<[WireProtocol, string, RegExp]> = [
    ["chat", "api.openai.com/v1", /not a URL/],
    ["chat", "ftp://api.example.test/v1", /HTTPS/],
    ["chat", "http://api.example.test/v1", /HTTPS/],
    ["chat", "http://172.32.0.1/v1", /HTTPS/],
    ["chat", "http://192.169.0.1/v1", /HTTPS/],
    ["chat", "http://8.8.8.8/v1", /HTTPS/],
    ["chat", "https://user:secret@api.example.test/v1", /credentials/],
    ["chat", "https://api.example.test/v1?key=x", /query/],
    ["chat", "https://api.example.test/v1?", /query/],
    ["chat", "https://api.example.test/v1#models", /fragment/],
    ["chat", "https://api.example.test/v1/chat/completions", /operation path/],
    ["chat", "https://api.example.test/v1/chat/completions/", /operation path/],
    ["responses", "https://api.example.test/v1/responses", /operation path/],
    ["anthropic", "https://api.example.test/v1/messages", /operation path/],
    [
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
      /operation path/,
    ],
    [
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent",
      /operation path/,
    ],
    ["anthropic", "https://api.anthropic.com/v1", /API version/],
    ["anthropic", "https://api.anthropic.com/v1/", /API version/],
    [
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta",
      /API version/,
    ],
    ["gemini", "https://generativelanguage.googleapis.com/v1", /API version/],
  ];
  for (const [protocol, url, reason] of refused)
    assert.match(endpointProblem(protocol, url) ?? "", reason, url);
});

void test("a provider's own limits are integers in their ranges, and a provider record with others is invalid", async () => {
  const { providerLimitsProblems } = await import("../src/model-plane.js");
  const { isProviderConfig } = await import("../src/model-plane-records.js");
  assert.deepEqual(providerLimitsProblems({}), []);
  assert.deepEqual(
    providerLimitsProblems({
      concurrentPerCredential: 1,
      queuePerCredential: 0,
    }),
    [],
  );
  assert.deepEqual(
    providerLimitsProblems({
      concurrentPerCredential: 1024,
      queuePerCredential: 65_536,
    }),
    [],
  );
  for (const [value, pointer] of [
    [{ concurrentPerCredential: 0 }, "/concurrentPerCredential"],
    [{ concurrentPerCredential: 1025 }, "/concurrentPerCredential"],
    [{ concurrentPerCredential: 1.5 }, "/concurrentPerCredential"],
    [{ concurrentPerCredential: "2" }, "/concurrentPerCredential"],
    [{ queuePerCredential: -1 }, "/queuePerCredential"],
    [{ queuePerCredential: 65_537 }, "/queuePerCredential"],
    [{ maxConcurrency: 2 }, "/maxConcurrency"],
    [[], ""],
    [null, ""],
  ] as const)
    assert.equal(
      providerLimitsProblems(value)[0]?.pointer,
      pointer,
      JSON.stringify(value),
    );
  const provider = {
    schemaVersion: 1,
    id: "p",
    name: "p",
    kind: "custom",
    endpoints: { chat: "https://api.example.test/v1" },
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [],
    models: { source: "manual", list: [], expose: "all" },
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
  assert.ok(
    isProviderConfig({ ...provider, limits: { concurrentPerCredential: 2 } }),
  );
  assert.ok(
    !isProviderConfig({ ...provider, limits: { concurrentPerCredential: 0 } }),
  );
});
