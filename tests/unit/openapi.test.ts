import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpenApiDocument } from "../../src/gateway/openapi.js";
void test("OpenAPI 3.0 projection describes nullable schema and streaming content without mutating original schema", () => {
  const source = {
    paths: {
      "/v1/runs/{id}/events": {
        get: {
          responses: {
            200: {
              content: { "application/json": { schema: { type: "string" } } },
            },
          },
        },
      },
    },
    components: { schemas: { tokens: { type: ["null", "number"] } } },
  };
  const copy = structuredClone(source);
  normalizeOpenApiDocument(copy);
  assert.deepEqual(source.components.schemas.tokens, {
    type: ["null", "number"],
  });
  assert.deepEqual(copy.components.schemas.tokens, {
    type: "number",
    nullable: true,
  });
  assert.ok(
    "text/event-stream" in
      copy.paths["/v1/runs/{id}/events"].get.responses[200].content,
  );
});
