// CI-only relay between the Gateway under test and the developer's temporary model endpoint.
// It forwards requests unchanged to the first working upstream (RELAY_UPSTREAMS, comma separated
// base URLs ending in /v1) and retries only transport failures of the tunnels themselves:
// network errors and non-JSON 502/503/504/530 answers received before any byte reached the
// Gateway. Model and gateway errors (JSON bodies) pass through untouched.
import { appendFileSync } from "node:fs";
import http from "node:http";

const port = Number(process.env.RELAY_PORT ?? 18181);
const upstreams = (process.env.RELAY_UPSTREAMS ?? "").split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean);
const logFile = process.env.RELAY_LOG ?? "model-relay.jsonl";
const attempts = Number(process.env.RELAY_ATTEMPTS ?? 8);
if (!upstreams.length) throw new Error("RELAY_UPSTREAMS is required");
let preferred = 0;
let sequence = 0;
const log = (entry) => appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
const transient = (status, type) => [502, 503, 504, 530].includes(status) && !/application\/json/i.test(type ?? "");

http
  .createServer(async (req, res) => {
    const id = ++sequence;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const path = req.url.replace(/^\/v1/, "");
    const failures = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      const index = (preferred + attempt) % upstreams.length;
      let upstream;
      try {
        upstream = await fetch(`${upstreams[index]}${path}`, {
          method: req.method,
          headers: {
            ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
            "content-type": req.headers["content-type"] ?? "application/json",
            accept: req.headers.accept ?? "*/*",
          },
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        failures.push(`#${index}: ${error.cause?.code ?? error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.min(attempt + 1, 4)));
        continue;
      }
      const type = upstream.headers.get("content-type") ?? "";
      if (transient(upstream.status, type)) {
        failures.push(`#${index}: HTTP ${upstream.status} ${(await upstream.text().catch(() => "")).slice(0, 80)}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.min(attempt + 1, 4)));
        continue;
      }
      preferred = index;
      if (failures.length) log({ id, recovered: true, upstream: index, failures });
      res.writeHead(upstream.status, { "content-type": type || "application/json", "cache-control": "no-cache" });
      try {
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      } catch (error) {
        log({ id, streamError: error.cause?.code ?? error.message, upstream: index });
        res.destroy(error);
      }
      return;
    }
    log({ id, exhausted: true, failures });
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`model relay: every tunnel attempt failed (${failures.join("; ")})`);
  })
  .listen(port, "127.0.0.1", () => console.log(`model relay on http://127.0.0.1:${port}/v1 -> ${upstreams.length} upstream(s)`));
