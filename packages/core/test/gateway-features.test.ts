// SPDX-License-Identifier: MIT
/** The gateway features document: what it accepts, and what it refuses with a pointer. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GATEWAY_FEATURES,
  gatewayFeaturesProblems,
  isGatewayFeatures,
  redactionRuleProblem,
  searchBackendProblem,
} from "../src/gateway-features.js";

const pointers = (value: unknown) =>
  gatewayFeaturesProblems(value).map((problem) => problem.pointer);

void test("a full document and the defaults are valid", () => {
  assert.ok(isGatewayFeatures(DEFAULT_GATEWAY_FEATURES));
  assert.ok(
    isGatewayFeatures({
      schemaVersion: 1,
      redaction: {
        enabled: false,
        rules: [{ name: "codename", pattern: "falcon-[0-9]+", flags: "i" }],
      },
      vision: { model: "group/vision" },
      search: {
        backends: [
          {
            id: "search-1",
            kind: "tavily",
            credential: { kind: "store", value: "x" },
          },
          { id: "search-2", kind: "searxng", baseUrl: "http://127.0.0.1:8888" },
        ],
      },
    }),
  );
});

void test("invalid settings are refused with the field", () => {
  assert.deepEqual(pointers(null), [""]);
  assert.deepEqual(
    pointers({ schemaVersion: 2, redaction: { enabled: true, rules: [] } }),
    ["/schemaVersion"],
  );
  assert.deepEqual(
    pointers({
      schemaVersion: 1,
      redaction: {
        enabled: "yes",
        rules: [
          { name: "a", pattern: "x+" },
          { name: "A", pattern: "y+" },
          { name: "b", pattern: "(" },
          { name: "c", pattern: ".*" },
          { name: "d", pattern: "x", extra: 1 },
        ],
      },
    }),
    [
      "/redaction/enabled",
      "/redaction/rules/1/name",
      "/redaction/rules/2",
      "/redaction/rules/3",
      "/redaction/rules/4",
    ],
  );
  assert.deepEqual(
    pointers({
      schemaVersion: 1,
      redaction: { enabled: true, rules: [] },
      vision: { model: "no-slash" },
      search: {
        backends: [
          { id: "search-1", kind: "tavily" },
          { id: "search-2", kind: "searxng" },
          {
            id: "search-2",
            kind: "bing",
            credential: { kind: "store", value: "k" },
          },
          {
            id: "x",
            kind: "brave",
            credential: { kind: "store", value: "k" },
            baseUrl: "ftp://h",
          },
        ],
      },
      other: true,
    }),
    [
      "/vision/model",
      "/search/backends/0",
      "/search/backends/1",
      "/search/backends/2",
      "/search/backends/2/id",
      "/search/backends/3",
      "/other",
    ],
  );
});

void test("rules that can backtrack without bound are refused; ordinary secret patterns pass", () => {
  // Second security review M6: 45 characters of prose took over 40 s.
  for (const pattern of [
    String.raw`(\w+\s?)+$`,
    "(a+)+b",
    "(a|aa)*c",
    "(a|b)+c",
    "(ab?)+c",
    String.raw`(?:\d+,?){2,}x`,
    String.raw`(.*a){12}`,
    String.raw`([a-z])\1`,
    String.raw`(?<w>\w)\k<w>`,
    String.raw`\w+\w+!`,
    ".*.*=",
    String.raw`\s*\s*x`,
    "[a-z]+-?[a-z0-9]+!",
    String.raw`\w+(?:\s?\w+)?!`,
    String.raw`(?:x\w*)\d+y`,
    "[A-Z]+[a-z]*[a-z]{20,}",
  ]) {
    const problem = redactionRuleProblem({ name: "slow", pattern });
    assert.ok(problem, pattern);
    assert.match(problem, /nested|repetitions|backreferences/, pattern);
  }
  for (const pattern of [
    "TCK-[0-9]+",
    "sk-[A-Za-z0-9]{20,}",
    String.raw`(?:token|key)=([^&\s]+)`,
    "[a-z]+(?:-[0-9]+)?",
    String.raw`\s*=\s*\S+`,
    "falcon-([0-9]+)",
    String.raw`AKIA[0-9A-Z]{16}`,
    String.raw`ghp_[A-Za-z0-9]{36}`,
    String.raw`(?:ab)+c`,
    String.raw`\d{3}-\d{4}`,
    String.raw`(?=\w*\d)\w{12,}`,
    String.raw`[a-z]+@[a-z]+\.[a-z]{2,}`,
  ])
    assert.equal(
      redactionRuleProblem({ name: "ok", pattern }),
      undefined,
      pattern,
    );
  // Case folding is taken into account: `[a-z]+` and `[A-Z]+` overlap with i.
  assert.equal(
    redactionRuleProblem({ name: "ok", pattern: "[a-z]+[A-Z]+!" }),
    undefined,
  );
  assert.ok(
    redactionRuleProblem({
      name: "slow",
      pattern: "[a-z]+[A-Z]+!",
      flags: "i",
    }),
  );
});

void test("a search backend's address carries no credentials", () => {
  assert.match(
    searchBackendProblem({
      id: "search-1",
      kind: "searxng",
      baseUrl: "https://alice:secret@search.example",
    }) ?? "",
    /credentials/,
  );
  assert.equal(
    searchBackendProblem({
      id: "search-1",
      kind: "searxng",
      baseUrl: "https://search.example/searx",
    }),
    undefined,
  );
});
