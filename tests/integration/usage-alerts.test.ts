// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-alerts-upstream-0001";

/**
 * An OpenAI-compatible upstream whose answers carry rate-limit headers:
 * `remaining` of 100 requests left in a window that resets in 6 minutes.
 */
async function upstream(t: TestContext, state: { remaining: number }) {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": String(state.remaining),
        "x-ratelimit-reset-requests": "6m0s",
      });
      response.end(
        JSON.stringify({
          id: "chatcmpl-alerts",
          object: "chat.completion",
          model: "chat-1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

void test(
  "a window past the usage alert is logged and listed once per run, across restarts, backups and a corrupt file",
  { timeout: 120_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(t, "hh-alerts-");
    const dataDir = path.join(directory, "data");
    const configDir = path.join(directory, "config");
    const state = { remaining: 50 };
    const base = await upstream(t, state);
    const start = async () => {
      const hub = await startHub({
        dataDir,
        configDir,
        secretsBackend: "file",
        demo: true,
        cwd: directory,
        port: 0,
        host: "127.0.0.1",
      });
      let open = true;
      defer(() => (open ? hub.server.close() : undefined));
      const client = await connectLocal({ dataDir, url: hub.url });
      return {
        hub,
        client,
        stop: async () => {
          open = false;
          await hub.server.close();
        },
      };
    };
    let { hub, client, stop } = await start();
    await client.providers.create({
      id: "alpha",
      endpoints: { chat: base },
      models: { source: "manual", list: [{ id: "chat-1" }], expose: "all" },
      credential: { name: "work", value: UPSTREAM_KEY },
    });
    const { key } = await client.gatewayKeys.create({
      name: "alerts",
      modelAllow: ["alpha/*"],
    });
    const call = async () => {
      const gateway = (await client.system.info()).gateway!;
      const response = await fetch(
        `${gateway.openaiBaseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: "alpha/chat-1",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      assert.equal(response.status, 200, await response.text());
    };
    const listed = () => client.usage.alerts();

    // Half used, no alert set: nothing.
    await call();
    assert.deepEqual(await listed(), { usagePercent: null, items: [] });
    // Setting the alert looks at once: 50% is under 80%.
    assert.deepEqual((await client.gatewayFeatures.setAlerts(80)).alerts, {
      usagePercent: 80,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual((await listed()).items, []);

    // 95% used: said once, in the log and the list.
    state.remaining = 5;
    await call();
    await client.gatewayFeatures.setAlerts(85);
    const first = await until(listed, (value) => value.items.length > 0);
    assert.equal(first.usagePercent, 85);
    assert.equal(first.items.length, 1);
    const [alert] = first.items;
    assert.deepEqual(
      {
        provider: alert!.provider,
        credentialName: alert!.credentialName,
        window: alert!.window,
        usedPercent: alert!.usedPercent,
      },
      {
        provider: "alpha",
        credentialName: "work",
        window: "requests",
        usedPercent: 95,
      },
    );
    assert.ok(Date.parse(alert!.resetsAt!) > Date.now());
    const logged = (await readFile(hub.logFile, "utf8"))
      .split("\n")
      .filter((line) => line.includes('"usage.alert"'));
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /"usedPercent":95/);
    assert.equal(logged[0]!.includes(UPSTREAM_KEY), false);

    // The same run read again: nothing new.
    await call();
    await client.gatewayFeatures.setAlerts(90);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await listed()).items.length, 1);

    // hh shows the setting and the alert.
    const hh = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        execFile(
          process.execPath,
          [
            fileURLToPath(HH_ENTRY),
            ...args,
            "--url",
            hub.url,
            "--data-dir",
            dataDir,
          ],
          { cwd: directory },
          (error, stdout, stderr) =>
            resolve({
              code: error ? Number(error.code ?? 1) : 0,
              stdout,
              stderr,
            }),
        ),
      );
    const shown = await hh(["gateway", "alert"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^Usage alert: at 90% of an allowance window/);
    assert.match(shown.stdout, /alpha\s+work\s+requests\s+95%/);
    assert.equal((await hh(["gateway", "alert", "150"])).code, 2);
    const turnedOff = await hh(["gateway", "alert", "off"]);
    assert.equal(turnedOff.code, 0, turnedOff.stderr);
    assert.match(turnedOff.stdout, /Usage alert: off/);
    const set = await hh(["gateway", "alert", "80"]);
    assert.match(
      set.stdout,
      /Usage alert: when an allowance window reaches 80% used/,
    );

    // A backup carries the setting; a restore brings it back.
    const backup = await client.backup.create({
      passphrase: "synthetic pass",
      keys: false,
    });
    await client.gatewayFeatures.clearAlerts();
    const restored = await client.backup.restore({
      backup,
      passphrase: "synthetic pass",
      agents: false,
    });
    assert.deepEqual(restored.gatewayFeatures?.alerts, {
      usagePercent: 80,
      changed: true,
    });
    assert.equal((await client.gatewayFeatures.get()).alerts?.usagePercent, 80);

    // After a restart the marks are still there: the same run is not said again.
    await stop();
    ({ hub, client, stop } = await start());
    assert.equal((await listed()).items.length, 1);
    await call();
    await client.gatewayFeatures.setAlerts(81);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await listed()).items.length, 1);

    // A corrupt file never stops the start; it is logged and taken as empty.
    await stop();
    await writeFile(path.join(dataDir, "usage-alerts.json"), "{ not json");
    ({ hub, client, stop } = await start());
    assert.match(await readFile(hub.logFile, "utf8"), /"usage.alerts_invalid"/);
    assert.deepEqual((await listed()).items, []);
    await call();
    await client.gatewayFeatures.setAlerts(82);
    assert.equal(
      (await until(listed, (value) => value.items.length > 0)).items.length,
      1,
    );
    // The file is written again, whole, after the alert is listed.
    const saved = await until(
      () => readFile(path.join(dataDir, "usage-alerts.json"), "utf8"),
      (text) => text.startsWith("{\n"),
    );
    assert.equal((JSON.parse(saved) as { alerts: unknown[] }).alerts.length, 1);
    await stop();
  },
);
