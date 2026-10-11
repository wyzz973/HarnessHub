import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeModelCatalog } from "../../src/contracts/control.js";
import { NATIVE_CATALOG_TTL_MS, NativeCatalogCache } from "../../src/web/native-catalog-cache.js";

const KEY = "a".repeat(64), OTHER = "b".repeat(64), PRINT = "c".repeat(64), CHANGED = "d".repeat(64);
const catalog: NativeModelCatalog = { models: [{ id: "deepseek:deepseek-v4-pro", name: "deepseek-v4-pro", inputs: { image: false, audio: false, file: true } }], defaultModel: "deepseek:deepseek-v4-pro",
  authentication: "ready", canSelect: true, options: [{ id: "__mode", name: "模式", category: "mode", currentValue: "default", values: [{ value: "default", name: "Default" }] }],
  commands: [{ name: "compact", description: "压缩上下文\n保留要点" }] };
async function root(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "native-catalog-cache-")); t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test("catalog observations outlive the process for a day while their fingerprint holds", async t => {
  const directory = await root(t), problems: string[] = [];
  let now = 1_800_000_000_000;
  const first = new NativeCatalogCache(directory, () => {}, problem => problems.push(problem), () => now);
  first.putCatalog({ key: KEY, fingerprint: PRINT, harnessId: "hermes", controlId: "hermes", catalog });
  first.observe({ harnessId: "hermes", controlId: "hermes", state: "ready", signedIn: true });
  now += 1000; first.observe({ harnessId: "openclaw", controlId: "openclaw", state: "signed_out" });
  first.recordProbeSession("dsh", "dsh-native", "session-probe");
  // Fields outside the contract never reach the file, and a catalog outside its bounds is served but not kept.
  first.putCatalog({ key: OTHER, fingerprint: PRINT, harnessId: "codex", controlId: "codex", catalog: { ...catalog, private: "never-kept" } as unknown as NativeModelCatalog });
  first.putCatalog({ key: CHANGED, fingerprint: PRINT, harnessId: "codex", controlId: "codex", catalog: { ...catalog, models: [{ id: "bad\nid", name: "bad" }] } });
  await first.close();
  const file = join(directory, "native-catalogs.json"), text = await readFile(file, "utf8");
  assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal(text.includes("never-kept"), false); assert.equal(text.includes("bad\\nid"), false);
  assert.deepEqual((await readdir(directory)).sort(), ["native-catalogs.json"]);

  now += 60_000;
  const second = new NativeCatalogCache(directory, () => {}, problem => problems.push(problem), () => now);
  assert.deepEqual(second.catalog(KEY, PRINT), catalog);
  assert.deepEqual(second.catalog(OTHER, PRINT), catalog);
  assert.equal(second.catalog(KEY, CHANGED), null, "a changed installation or configuration is read again");
  assert.equal(second.catalog(CHANGED, PRINT), null);
  assert.deepEqual(second.readinessList().map(item => [item.harnessId, item.state, item.signedIn]), [["openclaw", "signed_out", undefined], ["hermes", "ready", true]]);
  assert.deepEqual([...second.probeSessions("dsh", "dsh-native")], ["session-probe"]);
  assert.equal(second.probeSessions("dsh", "other-entry").size, 0);
  second.dropCatalog(OTHER); await second.close();

  now += NATIVE_CATALOG_TTL_MS;
  const later = new NativeCatalogCache(directory, () => {}, problem => problems.push(problem), () => now);
  assert.equal(later.catalog(KEY, PRINT), null, "a day-old read is not reused");
  assert.equal(later.readinessList().length, 2, "the latest readiness stays, with the time it was observed");
  await later.close();
  assert.deepEqual(problems, []);
});

test("a cache file this version cannot adopt is left as it is, reported, and observations stay in memory", async t => {
  const directory = await root(t), file = join(directory, "native-catalogs.json");
  const cases: { readonly name: string; readonly prepare: () => Promise<void>; readonly reason: RegExp }[] = [
    { name: "newer version", prepare: () => writeFile(file, JSON.stringify({ application: "harness-native-catalogs", version: 2, catalogs: [], readiness: [], probeSessions: [] }), { mode: 0o600 }), reason: /version 2/u },
    { name: "damaged", prepare: () => writeFile(file, "{\"application\":\"harness-native-catalogs\",", { mode: 0o600 }), reason: /contents/u },
    { name: "unknown field", prepare: () => writeFile(file, JSON.stringify({ application: "harness-native-catalogs", version: 1, catalogs: [], readiness: [], probeSessions: [], extra: true }), { mode: 0o600 }), reason: /contents/u },
    { name: "shared with others", prepare: async () => { await writeFile(file, JSON.stringify({ application: "harness-native-catalogs", version: 1, catalogs: [], readiness: [], probeSessions: [] })); await chmod(file, 0o644); }, reason: /private regular file/u },
    { name: "link", prepare: async () => { await writeFile(join(directory, "elsewhere.json"), "{}", { mode: 0o600 }); await symlink(join(directory, "elsewhere.json"), file); }, reason: /regular file/u },
  ];
  for (const item of cases) {
    await rm(file, { force: true }); await rm(join(directory, "elsewhere.json"), { force: true }); await item.prepare();
    const before = await readFile(file), problems: string[] = [];
    const cache = new NativeCatalogCache(directory, () => {}, problem => problems.push(problem));
    assert.equal(problems.length, 1, item.name); assert.match(problems[0]!, item.reason, item.name);
    cache.observe({ harnessId: "hermes", controlId: "hermes", state: "ready", signedIn: null });
    cache.putCatalog({ key: KEY, fingerprint: PRINT, harnessId: "hermes", controlId: "hermes", catalog });
    assert.deepEqual(cache.catalog(KEY, PRINT), catalog, item.name);
    assert.equal(cache.readinessList()[0]?.state, "ready", item.name);
    await cache.close();
    assert.deepEqual(await readFile(file), before, item.name + " must stay untouched");
  }
});

test("an interrupted write's own temporary file is removed and other files are not", async t => {
  const directory = await root(t);
  await writeFile(join(directory, ".native-catalogs.json.123.0123456789ab.tmp"), "partial", { mode: 0o600 });
  await writeFile(join(directory, ".native-catalogs.json.backup"), "kept", { mode: 0o600 });
  const cache = new NativeCatalogCache(directory, () => {}, () => assert.fail("nothing to report")); await cache.close();
  assert.deepEqual((await readdir(directory)).sort(), [".native-catalogs.json.backup"]);
});

test("a write that ownership cannot confirm is reported once and never fails an observation", async t => {
  const directory = await root(t), problems: string[] = [];
  const cache = new NativeCatalogCache(directory, () => { throw Object.assign(new Error("owner changed"), { code: "OWNER_LOST" }); }, problem => problems.push(problem));
  cache.observe({ harnessId: "hermes", controlId: "hermes", state: "failed", failureCode: "NATIVE_CATALOG_TIMEOUT" });
  await new Promise(resolve => setTimeout(resolve, 20));
  cache.observe({ harnessId: "dsh", controlId: "dsh-native", state: "ready", signedIn: null });
  await cache.close();
  assert.deepEqual(problems, ["write failed (OWNER_LOST); catalog observations stay in memory"]);
  assert.deepEqual(cache.readinessList().map(item => item.harnessId), ["dsh", "hermes"]);
  assert.deepEqual(await readdir(directory), [], "no file and no temporary file remain");
});
