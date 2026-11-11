// Installs (or removes, or only views) the Hub's own tools through the manager's routes of this build.
// usage: node hub-tools.mjs <dist dir> <data root> view|install|uninstall [harness...]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [dist, root, action, ...ids] = process.argv.slice(2);
const { startWebServer } = await import(join(dist, "src/web/server.js"));
const { prepareConfiguration } = await import(join(dist, "src/infrastructure/session/binding-factory.js"));
const workspace = await mkdtemp(join(tmpdir(), "hub-tools-ws-"));
const server = await startWebServer({ providerManagement: false, root, configuration: await prepareConfiguration({ workspace }), port: 0 });
try {
  const url = new URL(server.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = (await boot.json()).csrfToken, cookie = boot.headers.get("set-cookie").split(";", 1)[0];
  const call = async (path, body) => { const r = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, value: await r.json() }; };
  const view = async () => { const v = (await call("/capabilities/hub-tools")).value; console.log("tool:", JSON.stringify(v.tool)); for (const h of v.harnesses ?? []) console.log(" ", h.harnessId, h.state, h.writable ? "writable" : "-"); };
  await view();
  if (action === "install" || action === "uninstall") {
    for (const harnessId of ids) { const r = await call("/capabilities/hub-tools/" + action, { harnessId }); console.log(action, harnessId, r.status, r.value.status ?? r.value.code, r.value.state ?? "", JSON.stringify((r.value.changes ?? []).map(c => c.kind)), r.value.message ?? ""); }
    await view();
  }
} finally { await server.close(); await rm(workspace, { recursive: true, force: true }); }
