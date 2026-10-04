// SPDX-License-Identifier: MIT
/** The gateway features document: what it accepts, and what it refuses with a pointer. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GATEWAY_FEATURES,
  gatewayFeaturesProblems,
  isGatewayFeatures,
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
