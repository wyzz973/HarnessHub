// SPDX-License-Identifier: MIT
/**
 * The gateway features through the daemon: the settings API and file, the
 * `hh gateway` commands, and outbound redaction of the admin token and the
 * provider's own credential on a real gateway call to a loopback upstream.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-upstream-features-0001";
const SEARCH_KEY = "tvly-synthetic-search-key-0002";

/** A Chat upstream that records bodies and answers "ok". */
async function chatUpstream(t: TestContext) {
  const bodies: string[] = [];
  const paths: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      paths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.startsWith("/v1/images/")) {
        response.end(
          JSON.stringify({
            created: 1,
            data: [{ b64_json: "iVBORw0KGgo=" }],
            usage: { input_tokens: 7, output_tokens: 100 },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "c",
          object: "chat.completion",
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, bodies, paths };
}

function hh(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(HH_ENTRY), ...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end();
  });
}

void test(
  "gateway features are set through the API and hh, and the admin token and credentials never go upstream",
  { timeout: 120_000 },
  async (t) => {
    const upstream = await chatUpstream(t);
    const { directory, defer } = await temporaryDirectory(t, "hh-features-");
    const dataDir = path.join(directory, "data");
    const hub = await startHub({
      dataDir,
      configDir: path.join(directory, "config"),
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
    });
    defer(() => hub.server.close());
    const client = await connectLocal({ dataDir, url: hub.url });
    const admin = (
      await readFile(path.join(dataDir, "admin.token"), "utf8")
    ).trim();

    // Defaults: redaction on, no vision, no search.
    assert.deepEqual(await client.gatewayFeatures.get(), {
      schemaVersion: 1,
      redaction: { enabled: true, rules: [] },
    });

    await client.providers.create({
      id: "up",
      name: "Up",
      kind: "custom",
      endpoints: { chat: `${upstream.url}/v1` },
      imageEndpoint: `${upstream.url}/v1`,
      models: { source: "manual", list: [{ id: "m" }], expose: "all" },
      credential: { value: UPSTREAM_KEY },
    });
    const { key } = await client.gatewayKeys.create({
      name: "features",
      modelAllow: ["up/*"],
    });
    const call = (content: string) =>
      fetch(`${hub.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "up/m",
          messages: [{ role: "user", content }],
        }),
      }).then((response) => response.status);
    assert.equal(await call("warm up"), 200);
    assert.equal(
      await call(
        `admin ${admin}, upstream ${UPSTREAM_KEY}, mine ${key}, codename falcon-7`,
      ),
      200,
    );
    const sent = upstream.bodies.at(-1)!;
    for (const secret of [admin, UPSTREAM_KEY, key])
      assert.ok(!sent.includes(secret), "a known secret went upstream");
    assert.match(sent, /\{\{HH_ADMIN_TOKEN_[a-z2-7]{8}\}\}/);
    assert.match(sent, /falcon-7/);

    // Image generation through the daemon's gateway.
    const image = await fetch(`${hub.url}/v1/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "up/m", prompt: `a cat, ${admin}` }),
    });
    assert.equal(image.status, 200);
    assert.deepEqual(((await image.json()) as { data: unknown[] }).data, [
      { b64_json: "iVBORw0KGgo=" },
    ]);
    assert.equal(upstream.paths.at(-1), "/v1/images/generations");
    assert.ok(!upstream.bodies.at(-1)!.includes(admin));
    // An edit, as a multipart form, reaches the provider as one.
    const form = new FormData();
    form.append("model", "up/m");
    form.append("prompt", "make it blue");
    form.append(
      "image",
      new Blob([Buffer.from("an-image")], { type: "image/png" }),
      "cat.png",
    );
    const edit = await fetch(`${hub.url}/v1/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    assert.equal(edit.status, 200, await edit.clone().text());
    assert.equal(upstream.paths.at(-1), "/v1/images/edits");
    assert.match(upstream.bodies.at(-1)!, /name="model"\r\n\r\nm\r\n/);
    assert.match(upstream.bodies.at(-1)!, /an-image/);

    // The routing state lists the credential, closed, with no message text.
    const routing = await client.routing.state();
    assert.deepEqual(
      routing.items.map((item) => [
        item.provider,
        item.credentialName,
        item.enabled,
        item.state,
      ]),
      [["up", "default", true, "closed"]],
    );

    // A user rule, then redaction off.
    const ruled = await client.gatewayFeatures.setRedaction({
      rules: [{ name: "codename", pattern: "falcon-[0-9]+" }],
    });
    assert.deepEqual(ruled.redaction.rules, [
      { name: "codename", pattern: "falcon-[0-9]+" },
    ]);
    assert.equal(await call("codename falcon-7"), 200);
    assert.match(upstream.bodies.at(-1)!, /\{\{HH_CODENAME_/);
    await assert.rejects(
      client.gatewayFeatures.setRedaction({
        rules: [{ name: "bad", pattern: "a*" }],
      }),
      (error: unknown) =>
        error instanceof HarnessHubError &&
        error.code === "GATEWAY_FEATURES_INVALID",
    );

    // Vision and search settings; the search key goes to the secret store.
    await client.gatewayFeatures.setVision("up/m");
    await assert.rejects(
      client.gatewayFeatures.setVision("not a ref"),
      (error: unknown) =>
        error instanceof HarnessHubError &&
        error.code === "GATEWAY_FEATURES_INVALID",
    );
    const searched = await client.gatewayFeatures.addSearch({
      kind: "tavily",
      key: SEARCH_KEY,
    });
    assert.deepEqual(searched.search?.backends, [
      { id: "search-1", kind: "tavily", hasKey: true },
    ]);
    await assert.rejects(
      client.gatewayFeatures.addSearch({ kind: "searxng" }),
      (error: unknown) =>
        error instanceof HarnessHubError &&
        error.code === "GATEWAY_FEATURES_INVALID",
    );
    const file = await readFile(
      path.join(dataDir, "gateway-features.json"),
      "utf8",
    );
    assert.ok(!file.includes(SEARCH_KEY), "the file holds a reference only");
    assert.deepEqual(JSON.parse(file).vision, { model: "up/m" });

    const daemon = ["--url", hub.url, "--data-dir", dataDir];
    const shown = await hh(directory, ["gateway", "features", ...daemon]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /Redaction: on/);
    assert.match(shown.stdout, /rule codename: \/falcon-\[0-9\]\+\//);
    assert.match(shown.stdout, /Vision fallback: up\/m/);
    assert.match(shown.stdout, /search-1 tavily \(key stored\)/);
    const off = await hh(directory, ["gateway", "redaction", "off", ...daemon]);
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /Redaction: off/);
    assert.equal(await call(`admin ${admin}`), 200);
    assert.ok(upstream.bodies.at(-1)!.includes(admin), "opted out");
    const removed = await hh(directory, [
      "gateway",
      "search",
      "remove",
      "search-1",
      ...daemon,
    ]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /Web search: off/);
    const visionOff = await hh(directory, [
      "gateway",
      "vision",
      "off",
      ...daemon,
    ]);
    assert.equal(visionOff.code, 0, visionOff.stderr);
    assert.equal((await client.gatewayFeatures.get()).vision, undefined);
  },
);
