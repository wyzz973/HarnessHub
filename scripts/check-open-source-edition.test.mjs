import assert from "node:assert/strict";
import test from "node:test";
import { selectOpenSource } from "./prepare-open-source.mjs";

void test("open-source edition preserves exact selected launchers and fails on missing or duplicate engines", () => {
  const metadata = {
    schemaVersion: 1,
    platform: "win32",
    arch: "arm64",
    nodeVersion: "24.20.0",
    engines: [
      { id: "open", command: ["${node}", "${bundle}/open.js"] },
      { id: "closed", command: ["${bundle}/closed.exe"] },
    ],
    components: [{ id: "open" }, { id: "closed" }, { id: "python" }],
  };
  const edition = {
    schemaVersion: 1,
    id: "open-source-chat-completions",
    engines: ["open"],
    npmDependencies: [],
    extraComponents: ["python"],
  };
  const selected = selectOpenSource(metadata, edition);
  assert.deepEqual(selected.engines, [metadata.engines[0]]);
  assert.deepEqual(selected.components, [{ id: "open" }, { id: "python" }]);
  assert.equal(metadata.engines.length, 2);
  assert.throws(
    () => selectOpenSource(metadata, { ...edition, engines: ["missing"] }),
    /missing/,
  );
  assert.throws(
    () => selectOpenSource(metadata, { ...edition, engines: ["open", "open"] }),
    /Invalid/,
  );
  assert.throws(
    () =>
      selectOpenSource(
        { ...metadata, engines: [...metadata.engines, metadata.engines[0]] },
        edition,
      ),
    /duplicated/,
  );
});
