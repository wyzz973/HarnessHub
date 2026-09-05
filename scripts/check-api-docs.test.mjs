import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { checkApiCatalog } from "./check-api-docs.mjs";
test("API documentation accepts exact coverage and rejects missing, stale, duplicate and broken-source entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-doc-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.ts"), "");
  await writeFile(path.join(root, "test.ts"), "");
  const entry = {
    method: "GET",
    path: "/health/live",
    title: "Live",
    group: "health",
    request: "none",
    response: "200",
    implementation: "route",
    effects: "read only",
    errors: "403",
    source: "source.ts",
    operationId: "live",
    tests: ["test.ts"],
  };
  const spec = {
    paths: { "/health/live": { get: { responses: { 200: {} } } } },
  };
  assert.equal(await checkApiCatalog([entry], spec, root), 1);
  await assert.rejects(
    checkApiCatalog(
      [entry],
      {
        ...spec,
        openapi: "3.0.3",
        components: { schemas: { invalid: { type: ["string", "null"] } } },
      },
      root,
    ),
    /scalar type/,
  );
  await assert.rejects(checkApiCatalog([], spec, root), /Undocumented/);
  await assert.rejects(
    checkApiCatalog([entry, entry], spec, root),
    /Duplicate/,
  );
  await assert.rejects(
    checkApiCatalog([{ ...entry, path: "/removed" }], spec, root),
    /Stale/,
  );
  await assert.rejects(
    checkApiCatalog([{ ...entry, source: "missing.ts" }], spec, root),
  );
  await assert.rejects(
    checkApiCatalog([{ ...entry, source: "../outside.ts" }], spec, root),
    /escapes/,
  );
  await assert.rejects(
    checkApiCatalog([{ ...entry, implementation: "" }], spec, root),
    /Missing/,
  );
});
