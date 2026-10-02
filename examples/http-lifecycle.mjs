import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const base = (process.argv[2] ?? "http://127.0.0.1:3180").replace(/\/$/, "");
const terminal = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
async function request(route, body, headers = {}) {
  const response = await fetch(base + route, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json", ...headers },
        }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response;
}
const engines = await (await request("/v1/engines")).json();
assert.ok(
  engines.engines.some((e) => e.id === "fake" && e.driver === "fake"),
  "This example requires an explicit --demo Gateway; no task created",
);
let session, run;
try {
  session = await (await request("/v1/sessions", { engineId: "fake" })).json();
  const text = "HarnessHub demo: 中文 / events / artifact";
  const body = {
    text,
    timeoutMs: 10000,
    fixture: { scenario: "artifact", chunks: 3 },
  };
  const headers = { "Idempotency-Key": randomUUID() };
  run = await (
    await request(`/v1/sessions/${session.id}/runs`, body, headers)
  ).json();
  const replay = await (
    await request(`/v1/sessions/${session.id}/runs`, body, headers)
  ).json();
  assert.equal(replay.id, run.id);
  assert.equal(replay.replayed, true);
  const deadline = Date.now() + 15000;
  while (!terminal.has(run.status)) {
    assert.ok(Date.now() < deadline, "Run did not reach terminal state");
    await delay(25);
    run = await (await request(`/v1/runs/${run.id}`)).json();
  }
  run = await (await request(`/v1/runs/${run.id}`)).json();
  assert.equal(run.status, "completed");
  assert.equal(run.output, text);
  const events = await (await request(`/v1/runs/${run.id}/event-log`)).json();
  assert.ok(events.events.length > 0);
  assert.ok(events.events.every((e, i) => e.seq === i + 1));
  const sse = await (
    await request(`/v1/runs/${run.id}/events?afterSeq=0`)
  ).text();
  assert.ok(sse.includes("event: ") && sse.includes("data: "));
  const rollout = await (await request(`/v1/runs/${run.id}/rollout`)).text();
  assert.equal(rollout.trim().split("\n").length, events.events.length);
  assert.equal(run.artifacts.length, 1);
  const artifact = run.artifacts[0];
  const bytes = Buffer.from(
    await (await request(`/v1/artifacts/${artifact.id}`)).arrayBuffer(),
  );
  assert.equal(bytes.toString(), text);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    artifact.sha256,
  );
  console.log(
    JSON.stringify(
      {
        status: run.status,
        sessionId: session.id,
        runId: run.id,
        idempotency: "verified",
        events: events.events.length,
        artifactSha256: artifact.sha256,
      },
      null,
      2,
    ),
  );
} finally {
  if (session) await request(`/v1/sessions/${session.id}/close`, {});
}
