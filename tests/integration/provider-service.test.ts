import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ProviderError, type ProviderTarget, type ProviderView } from "../../src/contracts/provider.js";
import { LocalProviderService } from "../../src/infrastructure/provider/service.js";
import { PROVIDER_KEY_ENV } from "../../src/adapters/provider/materialize.js";

const secretA = "synthetic-provider-key-A-unique", secretB = "synthetic-provider-key-B-unique";
const write = { name: "Local", protocol: "openai-responses", baseUrl: "http://127.0.0.1:1234/v1", models: ["m1", "m2"], defaultModel: "m1", enabled: true };
function target(view: ProviderView, model = view.defaultModel): ProviderTarget { return { providerId: view.id, revision: view.revision, model }; }
function hasCode(expected: string): (error: unknown) => boolean { return error => error instanceof ProviderError && error.code === expected; }
async function fixture(fn: (root: string, service: LocalProviderService) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "harness-provider-test-")); const service = new LocalProviderService(root, () => {});
  try { await fn(root, service); } finally { await service.shutdown(); await rm(root, { recursive: true, force: true }); }
}
function home(root: string, name: string): string { const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return realpathSync(path); }
async function http(fn: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  const server = createServer(fn);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  return { server, base: "http://127.0.0.1:" + address.port, close: () => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  }) };
}
test("the store has no count or byte bound that could keep the service from starting: 200 Providers, a Provider edited 1,100 times, and a record too large to read back is refused at its write", async () => fixture(async (root, service) => {
  // 128 Providers, 1,024 revisions of one and 4,096 in all were the bounds; a store that reached one threw at startup.
  let first: ProviderView | null = null;
  for (let index = 0; index < 200; index++) { const view = service.create({ ...write, name: "Provider " + index, apiKey: index === 0 ? secretA : undefined }, "create-many-" + index); first ??= view; }
  assert.equal(service.list().length, 200);
  let latest = first!;
  for (let revision = 1; revision <= 1100; revision++) latest = service.update(first!.id, { ...write, name: "Edited " + revision }, latest.revision, "edit-" + revision);
  assert.equal(latest.revision, 1101); assert.equal(latest.hasCredential, true, "the credential follows the revisions");
  // A model list the 64 KiB record cannot hold is the user's input to refuse, not something to store and then fail to read.
  const crowded = Array.from({ length: 1000 }, (_, index) => "model-" + "x".repeat(200) + index);
  assert.throws(() => service.create({ ...write, models: crowded, defaultModel: crowded[0] }, "too-crowded"), hasCode("INVALID_INPUT"));
  assert.equal(service.list().length, 200, "nothing of it was stored");
  service.close(); const reopened = new LocalProviderService(root, () => {});
  try { assert.equal(reopened.list().length, 200); assert.equal(reopened.list().find(view => view.id === first!.id)?.revision, 1101); }
  finally { reopened.close(); }
}));
test("Provider revisions and idempotency persist through reopen with AES-GCM credentials", async () => fixture(async (root, service) => {
  const first = service.create({ ...write, apiKey: secretA }, "create-1");
  assert.equal(first.revision, 1); assert.equal(first.hasCredential, true); assert.deepEqual(service.list(), [first]);
  assert.equal(JSON.stringify(first).includes(secretA), false);
  assert.deepEqual(service.create({ ...write, apiKey: secretA }, "create-1"), first);
  assert.throws(() => service.create({ ...write, apiKey: secretB }, "create-1"), hasCode("COMMAND_CONFLICT"));
  const second = service.update(first.id, { ...write, name: "Updated", apiKey: secretB }, 1, "update-1");
  assert.equal(second.revision, 2);
  const third = service.update(first.id, { ...write, name: "Preserved" }, 2, "update-2");
  assert.equal(third.hasCredential, true); assert.equal(third.revision, 3);
  assert.deepEqual(service.update(first.id, { ...write, name: "Updated", apiKey: secretB }, 1, "update-1"), second);
  assert.throws(() => service.update(first.id, write, 1, "stale-update"), hasCode("REVISION_CONFLICT"));
  for (const file of readdirSync(join(root, "providers"))) {
    assert.equal(statSync(join(root, "providers", file)).mode & 0o077, 0);
    if (file !== "master.key") { const bytes = readFileSync(join(root, "providers", file)); assert.equal(bytes.includes(secretA), false); assert.equal(bytes.includes(secretB), false); }
  }
  const db = new DatabaseSync(join(root, "providers", "providers.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM provider_credentials").get()?.n, 3); } finally { db.close(); }
  service.close(); const reopened = new LocalProviderService(root, () => {});
  try {
    assert.deepEqual(reopened.list(), [third]); assert.deepEqual(reopened.create({ ...write, apiKey: secretA }, "create-1"), first);
    assert.equal(reopened.redact(secretA + "|" + secretB), "[redacted]|[redacted]");
    const envA = await reopened.materialize(target(first), "codex", home(root, "home-a"));
    const envB = await reopened.materialize(target(third), "codex", home(root, "home-b"));
    assert.equal(envA[PROVIDER_KEY_ENV], secretA); assert.equal(envB[PROVIDER_KEY_ENV], secretB);
  } finally { reopened.close(); }
}));
test("Provider model and endpoint stay pinned to the admitted revision", async () => fixture(async (root, service) => {
  const first = service.create({ ...write, apiKey: secretA }, "create");
  service.update(first.id, { ...write, baseUrl: "http://127.0.0.1:5678/v1", models: ["new-model"], defaultModel: "new-model", apiKey: secretB }, 1, "update");
  const directory = home(root, "private"), env = await service.materialize(target(first, "m2"), "codex", directory);
  assert.equal(env[PROVIDER_KEY_ENV], secretA);
  const config = readFileSync(join(directory, "codex", "config.toml"), "utf8");
  assert.ok(config.includes('model = "m2"')); assert.ok(config.includes('base_url = "' + write.baseUrl + '"'));
  assert.equal(config.includes("5678"), false); assert.equal(config.includes(secretA), false); assert.equal(config.includes(secretB), false);
  assert.throws(() => service.validate(target(first, "new-model"), "codex"), hasCode("MODEL_UNAVAILABLE"));
}));
test("Current disabled Provider blocks even its old enabled revisions", async () => fixture((_root, service) => {
  const first = service.create(write, "create"); service.update(first.id, { ...write, enabled: false }, 1, "disable");
  assert.throws(() => service.validate(target(first), "codex"), hasCode("PROVIDER_DISABLED"));
  const enabled = service.update(first.id, write, 2, "enable"); service.validate(target(enabled), "codex");
  assert.throws(() => service.validate({ providerId: first.id, revision: 2, model: "m1" }, "codex"), hasCode("PROVIDER_DISABLED"));
}));
test("Provider mutation rejects invalid identities, commands and empty key before changing storage", async () => fixture((_root, service) => {
  assert.throws(() => service.create({ ...write, apiKey: "" }, "invalid-key"), hasCode("INVALID_INPUT"));
  assert.throws(() => service.create(write, ""), hasCode("INVALID_INPUT"));
  assert.throws(() => service.create(write, "with\nnewline"), hasCode("INVALID_INPUT"));
  assert.throws(() => service.update("bad", write, 1, "update"), hasCode("INVALID_INPUT"));
  const first = service.create(write, "good");
  assert.throws(() => service.update(first.id, write, 0, "update"), hasCode("INVALID_INPUT"));
  assert.throws(() => service.update(first.id, { ...write, unknown: true }, 1, "update"), hasCode("INVALID_INPUT"));
  assert.deepEqual(service.list(), [first]);
}));
test("Codex can use a no-auth local Provider and unsupported combinations fail before materialization", async () => fixture(async (root, service) => {
  const first = service.create(write, "create"); service.validate(target(first), "codex");
  const directory = home(root, "private"), env = await service.materialize(target(first), "codex", directory);
  assert.equal(env[PROVIDER_KEY_ENV], undefined); assert.equal(readFileSync(join(directory, "codex", "config.toml"), "utf8").includes("env_key"), false);
  for (const harness of ["gemini", "opencode", "claude"]) assert.throws(() => service.validate(target(first), harness), hasCode("UNSUPPORTED_PROVIDER"));
  const unused = home(root, "unused"); await assert.rejects(service.materialize(target(first), "opencode", unused), hasCode("UNSUPPORTED_PROVIDER"));
  assert.deepEqual(readdirSync(unused), []);
}));
test("Gemini config uses a private highest-priority settings file and exact explicit key/model/endpoint", async () => fixture(async (root, service) => {
  const first = service.create({ ...write, protocol: "gemini", baseUrl: "http://127.0.0.1:1234", apiKey: secretA }, "gemini");
  const directory = home(root, "private"); const env = await service.materialize(target(first, "m2"), "gemini", directory);
  assert.equal(env.GEMINI_API_KEY, secretA); assert.equal(env.GEMINI_MODEL, "m2"); assert.equal(env.GOOGLE_GEMINI_BASE_URL, first.baseUrl);
  assert.equal(env.GEMINI_CLI_HOME, undefined);
  assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, join(directory, "gemini", "settings.json"));
  assert.equal(env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, join(directory, "gemini", "system-defaults.json"));
  const config = readFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, "utf8"); assert.equal(config.includes(secretA), false);
  assert.equal(JSON.parse(config).security.auth.selectedType, "gemini-api-key");
  assert.equal(statSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!).mode & 0o077, 0);
  const without = service.create({ ...write, protocol: "gemini" }, "no-key");
  assert.throws(() => service.validate(target(without), "gemini"), hasCode("CREDENTIAL_REQUIRED"));
  await assert.rejects(service.materialize(target(without), "gemini", home(root, "no-key")), hasCode("CREDENTIAL_REQUIRED"));
}));
test("Managed config never overwrites a config, follows a link or accepts a public home", async () => fixture(async (root, service) => {
  const first = service.create(write, "create"), existing = home(root, "existing");
  mkdirSync(join(existing, "codex"), { mode: 0o700 }); writeFileSync(join(existing, "codex", "config.toml"), "preserve", { mode: 0o600 });
  await assert.rejects(service.materialize(target(first), "codex", existing), hasCode("CONFIGURATION_FAILED"));
  assert.equal(readFileSync(join(existing, "codex", "config.toml"), "utf8"), "preserve");
  const outside = home(root, "outside"), linked = home(root, "linked"); symlinkSync(outside, join(linked, "codex"));
  await assert.rejects(service.materialize(target(first), "codex", linked), hasCode("INVALID_CONFIGURATION")); assert.deepEqual(readdirSync(outside), []);
  const link = join(root, "home-link"); symlinkSync(outside, link);
  await assert.rejects(service.materialize(target(first), "codex", link), hasCode("INVALID_CONFIGURATION"));
  const publicHome = home(root, "public"); chmodSync(publicHome, 0o755);
  await assert.rejects(service.materialize(target(first), "codex", publicHome), hasCode("INVALID_CONFIGURATION"));
}));
test("Provider key redaction covers unused and immutable old credential versions through all stream split points", async () => fixture((_root, service) => {
  const first = service.create({ ...write, apiKey: secretA }, "create"); service.update(first.id, { ...write, apiKey: secretB }, 1, "update");
  const text = "prefix " + secretA + " and " + secretB + " suffix";
  assert.equal(service.redact(text), "prefix [redacted] and [redacted] suffix");
  for (let split = 0; split <= text.length; split++) {
    const redactor = service.createTextRedactor(); const clean = redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.flush();
    assert.equal(clean, "prefix [redacted] and [redacted] suffix", "split " + split);
  }
  const redactor = service.createTextRedactor(); let output = "";
  for (const char of text) output += redactor.push(char); output += redactor.flush(); assert.equal(output, "prefix [redacted] and [redacted] suffix");
  const partial = service.createTextRedactor(); assert.equal(partial.push("end " + secretA.slice(0, 9)), "end "); assert.equal(partial.flush(), "[redacted]");
  assert.equal(partial.flush(), "");
}));
test("Streaming redaction handles overlapping prefixes, prefix keys, mismatch and consecutive keys", async () => fixture((_root, service) => {
  for (const [index, key] of ["abcdef", "abcxyz", "abc", "xyzabcxyz"].entries()) service.create({ ...write, apiKey: key }, "key-" + index);
  for (const text of ["abcdef abcxyz", "xyzabcxyz", "abcabcdefabcxyz", "aabxx", "abqz", "xyzabcxyzabcxyz"]) {
    for (let split = 0; split <= text.length; split++) {
      const redactor = service.createTextRedactor(), out = redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.flush();
      for (const secret of ["abcdef", "abcxyz", "abc", "xyzabcxyz"]) assert.equal(out.includes(secret), false, `${text} at ${split}`);
      const expected = text === "aabxx" ? "aabx[redacted]" : service.redact(text);
      assert.equal(out, expected, `${text} has consistent output at ${split}`);
    }
  }
}));
test("Provider Vault detects ciphertext tampering without plaintext errors or partial updates", async () => fixture((root, service) => {
  const first = service.create({ ...write, apiKey: secretA }, "create");
  const db = new DatabaseSync(join(root, "providers", "providers.sqlite"));
  try { db.prepare("UPDATE provider_credentials SET tag=? WHERE provider_id=?").run(Buffer.alloc(16, 1).toString("base64"), first.id); } finally { db.close(); }
  assert.throws(() => service.validate(target(first), "codex"), hasCode("INVALID_VAULT"));
  assert.throws(() => service.update(first.id, write, 1, "update"), hasCode("INVALID_VAULT"));
  assert.equal(service.list()[0]?.revision, 1);
}));
test("Provider list and reopen reject dangling current pointers instead of returning an empty list", async () => fixture((root, service) => {
  const first = service.create(write, "create"), path = join(root, "providers", "providers.sqlite");
  const db = new DatabaseSync(path);
  try { db.prepare("UPDATE providers SET current_revision=99 WHERE id=?").run(first.id); } finally { db.close(); }
  assert.throws(() => service.list(), hasCode("INVALID_DATA"));
  assert.throws(() => service.validate(target(first), "codex"), hasCode("INVALID_DATA"));
  service.close(); assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_DATA"));
}));
test("Provider metadata detects credential flag mismatch before listing or reopening", async () => fixture((root, service) => {
  const first = service.create({ ...write, apiKey: secretA }, "create"), db = new DatabaseSync(join(root, "providers", "providers.sqlite"));
  try { db.prepare("UPDATE provider_revisions SET view_json=? WHERE provider_id=?").run(JSON.stringify({ ...first, hasCredential: false }), first.id); } finally { db.close(); }
  assert.throws(() => service.list(), hasCode("INVALID_VAULT"));
  service.close(); assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_VAULT"));
}));
test("Provider reopen detects orphan revisions, orphan credentials and dangling command references", async () => {
  for (const mutation of ["DELETE FROM providers", "DELETE FROM provider_revisions", "UPDATE provider_commands SET revision=99"]) await fixture((root, service) => {
    service.create({ ...write, apiKey: secretA }, "create"); service.close();
    const db = new DatabaseSync(join(root, "providers", "providers.sqlite")); try { db.exec(mutation); } finally { db.close(); }
    assert.throws(() => new LocalProviderService(root, () => {}), error => hasCode("INVALID_DATA")(error) || hasCode("INVALID_VAULT")(error));
  });
});
test("Provider stored view unknown fields and mismatched revision identity fail explicitly", async () => {
  for (const patch of [{ schemaVersion: 99 }, { revision: 99 }, { id: "provider-00000000-0000-0000-0000-000000000000" }]) await fixture((root, service) => {
    const first = service.create(write, "create"), db = new DatabaseSync(join(root, "providers", "providers.sqlite"));
    try { db.prepare("UPDATE provider_revisions SET view_json=? WHERE provider_id=?").run(JSON.stringify({ ...first, ...patch }), first.id); } finally { db.close(); }
    assert.throws(() => service.list(), hasCode("INVALID_DATA"));
    service.close(); assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_DATA"));
  });
});
test("Provider encrypted key, revision, parent and command remain atomic when SQLite rejects a write", async () => fixture((root, service) => {
  const path = join(root, "providers", "providers.sqlite"), db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER reject_provider_write BEFORE INSERT ON provider_revisions BEGIN SELECT RAISE(ABORT,'injected storage failure'); END");
    assert.throws(() => service.create({ ...write, apiKey: secretA }, "create"), hasCode("STORAGE_FAILED"));
    assert.deepEqual(service.list(), []);
    for (const table of ["providers", "provider_revisions", "provider_credentials", "provider_commands"])
      assert.equal(db.prepare("SELECT count(*) AS n FROM " + table).get()?.n, 0);
    db.exec("DROP TRIGGER reject_provider_write");
    const first = service.create({ ...write, apiKey: secretA }, "create"); assert.equal(first.revision, 1); assert.equal(first.hasCredential, true);
  } finally { db.close(); }
}));
test("Provider payload budgets reject oversized SQLite metadata before materializing public JSON", async () => fixture((root, service) => {
  const first = service.create(write, "create"), db = new DatabaseSync(join(root, "providers", "providers.sqlite"));
  try { db.prepare("UPDATE provider_revisions SET view_json=? WHERE provider_id=?").run("x".repeat(65537), first.id); } finally { db.close(); }
  assert.throws(() => service.list(), hasCode("INVALID_DATA"));
  assert.throws(() => service.validate(target(first), "codex"), hasCode("INVALID_DATA"));
  service.close(); assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_DATA"));
}));
test("Provider payload budgets reject oversized credential envelopes before base64 decoding", async () => {
  for (const [column, value] of [["nonce", "x".repeat(17)], ["tag", "x".repeat(25)], ["ciphertext", "x".repeat(10925)]] as const) await fixture((root, service) => {
    const first = service.create({ ...write, apiKey: secretA }, "create"), db = new DatabaseSync(join(root, "providers", "providers.sqlite"));
    try { db.prepare("UPDATE provider_credentials SET " + column + "=? WHERE provider_id=?").run(value, first.id); } finally { db.close(); }
    assert.throws(() => service.validate(target(first), "codex"), hasCode("INVALID_VAULT"));
    service.close(); assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_VAULT"));
  });
});
test("Provider private master and ownership marker have fixed read byte budgets", async () => {
  for (const [file, length] of [["master.key", 33], [".harness-gateway-provider.json", 4097]] as const) {
    const root = await mkdtemp(join(tmpdir(), "harness-provider-file-budget-"));
    try {
      const service = new LocalProviderService(root, () => {}); service.close();
      writeFileSync(join(root, "providers", file), Buffer.alloc(length), { mode: 0o600 });
      assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_STORAGE"));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
test("Provider malformed identity and command column budgets reject before row payload reads", async () => {
  for (const mutation of ["UPDATE provider_commands SET command_id='" + "x".repeat(129) + "'", "UPDATE provider_commands SET fingerprint='" + "x".repeat(65) + "'", "UPDATE providers SET current_revision=9223372036854775807"]) await fixture((root, service) => {
    const first = service.create(write, "create"), db = new DatabaseSync(join(root, "providers", "providers.sqlite"));
    try { db.exec(mutation); } finally { db.close(); }
    assert.throws(() => service.list(), hasCode("INVALID_DATA"));
    assert.throws(() => service.validate(target(first), "codex"), hasCode("INVALID_DATA"));
    service.close(); assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_DATA"));
  });
});
test("Provider storage rejects ownership replacement and broad key permissions", async () => fixture((root, service) => {
  service.create(write, "create"); const master = join(root, "providers", "master.key");
  chmodSync(master, 0o644); assert.throws(() => service.list(), hasCode("INVALID_STORAGE")); chmodSync(master, 0o600);
  const db = join(root, "providers", "providers.sqlite"); renameSync(db, db + ".old"); writeFileSync(db, "", { mode: 0o600 });
  assert.throws(() => service.list(), hasCode("OWNERSHIP_LOST"));
}));
test("Provider storage rejects unmarked directories, symlinked keys, missing master and unknown schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-provider-corrupt-"));
  try {
    mkdirSync(join(root, "providers"), { mode: 0o700 }); writeFileSync(join(root, "providers", "unrelated"), "do not touch", { mode: 0o600 });
    assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_STORAGE"));
    rmSync(join(root, "providers"), { recursive: true });
    const service = new LocalProviderService(root, () => {}); service.create(write, "create"); service.close();
    const master = join(root, "providers", "master.key"); renameSync(master, master + ".owned"); symlinkSync(master + ".owned", master);
    assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_STORAGE")); rmSync(master);
    assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_VAULT")); renameSync(master + ".owned", master);
    const db = new DatabaseSync(join(root, "providers", "providers.sqlite")); try { db.exec("PRAGMA user_version=99"); } finally { db.close(); }
    assert.throws(() => new LocalProviderService(root, () => {}), hasCode("INVALID_STORAGE"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("Provider service checks the external owner and closes idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-provider-owner-")); let owned = true;
  const service = new LocalProviderService(root, () => { if (!owned) throw new ProviderError("OWNERSHIP_LOST", "owner lost"); });
  try {
    service.create(write, "create"); owned = false; assert.throws(() => service.list(), hasCode("OWNERSHIP_LOST"));
    service.close(); service.close(); assert.throws(() => service.list(), hasCode("SERVICE_CLOSED"));
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});
test("Model probes use protocol-specific endpoints and headers without changing configured models", async () => fixture(async (_root, service) => {
  const requests: { url: string | undefined; authorization: string | undefined; google: string | string[] | undefined; anthropic: string | string[] | undefined }[] = [];
  const endpoint = await http((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization, google: request.headers["x-goog-api-key"], anthropic: request.headers["x-api-key"] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url?.includes("v1beta") ? JSON.stringify({ models: [{ name: "models/discovered" }, { name: "models/discovered" }] }) : JSON.stringify({ data: [{ id: "discovered" }, { id: "discovered" }] }));
  });
  try {
    for (const [index, protocol] of ["openai-responses", "openai-chat-completions", "anthropic-messages", "gemini"].entries()) {
      const view = service.create({ ...write, protocol, baseUrl: endpoint.base + (protocol === "gemini" ? "" : "/v1"), apiKey: secretA }, "create-" + index);
      assert.deepEqual(await service.probe(view.id), { status: "models_reachable", models: ["discovered"] });
      assert.deepEqual(service.list().find(item => item.id === view.id)?.models, ["m1", "m2"]);
    }
    assert.deepEqual(requests.map(item => item.url), ["/v1/models", "/v1/models", "/v1/models", "/v1beta/models"]);
    assert.equal(requests[0]?.authorization, "Bearer " + secretA); assert.equal(requests[1]?.authorization, "Bearer " + secretA);
    assert.equal(requests[2]?.anthropic, secretA); assert.equal(requests[3]?.google, secretA);
  } finally { await endpoint.close(); }
}));
test("Probe HTTP failures and bodies cannot leak a key and redirects are never followed", async () => fixture(async (_root, service) => {
  let followed = false;
  const sink = await http((_request, response) => { followed = true; response.end("{}"); });
  const endpoint = await http((request, response) => {
    if (request.url?.startsWith("/redirect")) { response.writeHead(302, { location: sink.base + "/models" }); response.end(); }
    else { response.writeHead(401); response.end(secretA); }
  });
  try {
    const unauthorized = service.create({ ...write, baseUrl: endpoint.base, apiKey: secretA }, "unauthorized");
    await assert.rejects(service.probe(unauthorized.id), error => hasCode("PROBE_HTTP_ERROR")(error) && error instanceof Error && !error.message.includes(secretA));
    const redirect = service.create({ ...write, baseUrl: endpoint.base + "/redirect", apiKey: secretA }, "redirect");
    await assert.rejects(service.probe(redirect.id), hasCode("PROBE_FAILED")); assert.equal(followed, false);
  } finally { await endpoint.close(); await sink.close(); }
}));
test("Probe rejects malformed JSON, invalid/empty model fields and bounded oversized responses", async () => fixture(async (_root, service) => {
  let body = "bad JSON";
  const endpoint = await http((_request, response) => { response.writeHead(200); response.end(body); });
  try {
    const view = service.create({ ...write, baseUrl: endpoint.base }, "create");
    await assert.rejects(service.probe(view.id), hasCode("PROBE_FAILED"));
    for (const value of [null, {}, { data: [1] }, { data: [{ id: "" }] }, { data: [{ id: "x".repeat(257) }] }, { data: [{ id: "model\n" }] }, { data: Array.from({ length: 4097 }, () => ({ id: "model" })) }]) {
      body = JSON.stringify(value); await assert.rejects(service.probe(view.id), hasCode("INVALID_PROBE"));
    }
    body = "x".repeat(1024 * 1024 + 1); await assert.rejects(service.probe(view.id), hasCode("PROBE_TOO_LARGE"));
  } finally { await endpoint.close(); }
}));
test("Probe timeout and service close abort in-flight network work", async () => fixture(async (_root, service) => {
  let signalRequest: (() => void) | null = null;
  const endpoint = await http((_request, _response) => { signalRequest?.(); });
  try {
    const view = service.create({ ...write, baseUrl: endpoint.base }, "create");
    await assert.rejects(service.probe(view.id), hasCode("PROBE_TIMEOUT"));
    const received = new Promise<void>(resolve => { signalRequest = resolve; });
    const probe = service.probe(view.id); await received;
    assert.throws(() => service.close(), hasCode("PROBE_ACTIVE"));
    const stopping = service.shutdown(); await assert.rejects(probe, hasCode("PROBE_TIMEOUT")); await stopping;
  } finally { await endpoint.close(); }
}));
test("Provider probe concurrency is bounded and shutdown waits for all admitted probes", async () => fixture(async (_root, service) => {
  const endpoint = await http((_request, _response) => {});
  try {
    const view = service.create({ ...write, baseUrl: endpoint.base }, "create");
    const probes = Array.from({ length: 16 }, () => service.probe(view.id));
    const settled = Promise.allSettled(probes);
    await assert.rejects(service.probe(view.id), hasCode("PROBE_LIMIT"));
    const shutdown = service.shutdown(); assert.equal(service.shutdown(), shutdown);
    await shutdown; const results = await settled;
    assert.equal(results.length, 16); assert.ok(results.every(result => result.status === "rejected" && hasCode("PROBE_TIMEOUT")(result.reason)));
    await assert.rejects(service.probe(view.id), hasCode("SERVICE_CLOSED"));
  } finally { await endpoint.close(); }
}));
