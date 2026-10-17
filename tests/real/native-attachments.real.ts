import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { application } from "../../src/cli/session-application.js";
import type { ContentRef } from "../../src/contracts/content.js";
import type { PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;

/**
 * Original-installation acceptance of attachments: a text file whose code word exists nowhere else, and a solid red image
 * when the installed agent or model declares image input (otherwise the Hub must refuse it before dispatch). The reply is
 * checked against facts only the attachment carries. Evidence keeps flags and short replies, never file contents or paths.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const home = process.env.HOME ?? homedir();
const configFiles: Readonly<Record<string, readonly string[]>> = {
  codex: [join(home, ".codex", "config.toml")],
  claude: [join(home, ".claude", "settings.json")],
  opencode: [join(home, ".config", "opencode", "opencode.json")],
  openclaw: [join(home, ".openclaw", "openclaw.json")],
  pi: [join(home, ".pi", "agent", "settings.json"), join(home, ".pi", "agent", "models.json")],
  gemini: [join(home, ".gemini", "settings.json")],
  hermes: [join(home, ".hermes", "config.yaml")],
  dsh: [join(home, ".dsh", "settings.yaml"), join(home, ".dsh", "profiles", "acp", "cordis.patch.yml")],
};
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
async function digest(path: string): Promise<string> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing"; throw error; }
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(data: Buffer): number { let c = 0xffffffff; for (const byte of data) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]);
}
/** A 64×64 solid red PNG, written without image libraries. */
function redPng(): Buffer {
  const size = 64, header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([0xe0, 0x10, 0x10]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
/** Reading the attachment copy can need the Harness's own approval (it lives outside the workspace); it is allowed once and recorded. */
async function settle(app: App, id: SessionId, deadline: number, permissions: Record<string, unknown>[]): Promise<PublicRun> {
  for (;;) {
    const run = app.runtime.read(id).runs.at(-1)!;
    if (TERMINAL.has(run.status)) { await app.runtime.wait(id); return app.runtime.read(id).runs.at(-1)!; }
    for (const request of app.runtime.permissionRequests(id).filter(item => !item.decided)) {
      const option = request.options.find(item => /^(allow|accept|approve|once|yes|proceed)/iu.test(item.id) && !/\b(always|session|forever|remember)\b/iu.test(item.id + " " + item.name));
      permissions.push({ title: request.title.slice(0, 160), options: request.options.map(item => item.id), chosen: option?.id ?? null });
      if (!option) throw new Error("no one-time allow option among the native approval options");
      await app.runtime.decidePermission(id, request.id, option.id, "allow-" + randomUUID());
    }
    if (Date.now() > deadline) throw new Error("native attachment turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
async function* bytes(value: Buffer) { yield value; }

test("installed Harness reads a text attachment, sees an image it declares, and an undeclared image is refused before dispatch", { timeout: 20 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES to the installed Harness identities under acceptance");
  assert.ok(evidencePath, "set HH_REAL_EVIDENCE to an ignored evidence file path");
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-attachments-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  try {
    for (const harnessId of harnesses) {
      const files = configFiles[harnessId] ?? [], before = await Promise.all(files.map(digest));
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace");
      await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const app = application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
      try {
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const catalog = await app.factory.discoverModels({ harnessId }, configuration, new AbortController().signal);
        const model = requested ?? catalog.defaultModel ?? undefined, inputs = catalog.models.find(row => row.id === model)?.inputs ?? catalog.inputs;
        proof.inputs = inputs ?? null; proof.model = model ?? null;
        const code = "HH-" + randomUUID().slice(0, 8).toUpperCase();
        const stage = (name: string, type: string, body: Buffer): Promise<ContentRef> => app.content.stage({ workspace: configuration.workspace, name, mediaType: type, commandId: "upload-" + randomUUID(), declaredBytes: body.length, source: bytes(body) });
        const note = await stage("note.txt", "text/plain", Buffer.from("这份附件只包含一个代码：" + code + "\n"));
        const created = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }) }, "create-" + randomUUID());
        app.runtime.send(created.id, "请读取我附上的 note.txt，告诉我里面的代码。只回复代码本身，不要调用除读取附件之外的工具。", "file-" + randomUUID(), [note.id]);
        const permissions: Record<string, unknown>[] = []; proof.permissions = permissions;
        const fileRun = await settle(app, created.id, Date.now() + 6 * 60 * 1000, permissions);
        const fileReply = app.runtime.read(created.id).messages.find(row => row.id === fileRun.assistantMessageId)?.text ?? "";
        proof.file = { status: fileRun.status, error: fileRun.error, matched: fileReply.includes(code), reply: fileReply.slice(0, 200), tools: (fileRun.tools ?? []).map(tool => tool.title.slice(0, 80)) };
        if (fileRun.status !== "completed" || !fileReply.includes(code)) failures.push(harnessId + ": text attachment");
        const image = await stage("color.png", "image/png", redPng());
        app.runtime.send(created.id, "这张图片的主要颜色是什么？只用一个中文颜色词回答，不要调用工具。", "image-" + randomUUID(), [image.id]);
        const imageRun = await settle(app, created.id, Date.now() + 6 * 60 * 1000, permissions);
        const imageReply = app.runtime.read(created.id).messages.find(row => row.id === imageRun.assistantMessageId)?.text ?? "";
        proof.image = { declared: inputs?.image ?? null, status: imageRun.status, error: imageRun.error, matched: imageReply.includes("红"), reply: imageReply.slice(0, 200) };
        if (inputs?.image === true) { if (imageRun.status !== "completed" || !imageReply.includes("红")) failures.push(harnessId + ": image attachment"); }
        else if (imageRun.status !== "failed" || imageRun.error?.code !== "ATTACHMENT_UNSUPPORTED" || imageRun.backend !== null) failures.push(harnessId + ": undeclared image was not refused before dispatch");
        proof.sessionStatus = app.runtime.read(created.id).status;
        proof.copies = { stable: (await app.content.materialize([note]))[0]!.path.includes(join("content", "files", note.id)) };
      } catch (error) {
        proof.failure = { code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : "ASSERTION", message: error instanceof Error ? error.message.slice(0, 512) : "failed" };
        failures.push(harnessId + ": " + (proof.failure as { code: string }).code);
      } finally {
        await closeApp(app);
        const after = await Promise.all(files.map(digest));
        proof.configuration = files.map((path, index) => ({ path, unchanged: before[index] === after[index] }));
        if (!(proof.configuration as { unchanged: boolean }[]).every(row => row.unchanged)) failures.push(harnessId + ": configuration changed");
        proof.finishedAt = new Date().toISOString();
        results.push(proof);
        await writeFile(evidencePath, JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(failures, [], "native attachment acceptance failed");
});
