// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { HubError } from "@harnesshub/core/errors";
import {
  CONFIG_FILE,
  editConfigFile,
  looksLikeSecret,
  readConfigFile,
  resolveConfig,
  runtimeSettings,
  shownValue,
  startOptions,
  type ConfigDocument,
} from "../src/config-file.js";
import { GATEWAY_FEATURES_FILE } from "../src/gateway-features.js";
import { GATEWAY_SHARING_FILE } from "../src/lan-share.js";

async function configDir(t: TestContext, text?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hh-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "config");
  if (text !== undefined) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, CONFIG_FILE), text);
  }
  return directory;
}

function code(expected: string, part?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof HubError, String(error));
    assert.equal(error.code, expected, error.message);
    if (part) assert.match(error.message, part);
    return true;
  };
}

const document = (value: Record<string, unknown>): ConfigDocument => ({
  file: "/c/config.jsonc",
  text: JSON.stringify(value),
  document: value,
});

void test("a flag wins over the environment, which wins over the file, which wins over the default, and each value says where it came from", () => {
  const config = resolveConfig({
    config: document({
      server: { port: 4000, host: "0.0.0.0" },
      engines: { default: "codex" },
      catalog: { autoRefresh: true, url: "https://catalog.example/api.json" },
      wiring: { autoSync: false },
    }),
    env: { AGENT_ENGINE: "claude", HH_OFFLINE: "1" },
    flags: { "--port": "4100", "--data-dir": "data" },
    cwd: "/work",
  });
  const entry = (key: string) =>
    config.entries.find((item) => item.path === key)!;
  assert.deepEqual(
    [
      "server.port",
      "server.host",
      "engines.default",
      "dataDir",
      "catalog.autoRefresh",
      "catalog.url",
      "wiring.autoSync",
      "secrets.backend",
    ].map((key) => [key, entry(key).value, entry(key).source]),
    [
      ["server.port", 4100, { kind: "flag", name: "--port" }],
      ["server.host", "0.0.0.0", { kind: "file" }],
      ["engines.default", "claude", { kind: "env", name: "AGENT_ENGINE" }],
      [
        "dataDir",
        path.resolve("/work", "data"),
        { kind: "flag", name: "--data-dir" },
      ],
      ["catalog.autoRefresh", false, { kind: "env", name: "HH_OFFLINE" }],
      ["catalog.url", "https://catalog.example/api.json", { kind: "file" }],
      ["wiring.autoSync", false, { kind: "file" }],
      ["secrets.backend", "auto", { kind: "default" }],
    ],
  );
  const options = startOptions(config);
  assert.equal(options.port, 4100);
  assert.equal(options.defaultEngine, "claude");
  // HH_OFFLINE stays the catalog resolver's own switch.
  assert.deepEqual(options.catalog, {
    url: "https://catalog.example/api.json",
  });
  assert.deepEqual(options.wiring, { autoSync: false });
  // Runtime settings stay in their own files under the data root.
  assert.deepEqual(runtimeSettings(config), [
    {
      name: "LAN sharing",
      file: path.join(path.resolve("/work", "data"), GATEWAY_SHARING_FILE),
      command: "hh gateway share",
    },
    {
      name: "Redaction, vision and search",
      file: path.join(path.resolve("/work", "data"), GATEWAY_FEATURES_FILE),
      command: "hh gateway features",
    },
  ]);
  assert.throws(
    () =>
      resolveConfig({
        config: document({}),
        env: {},
        flags: { "--port": "eighty" },
      }),
    code("CONFIG_INVALID", /^--port must be an integer/),
  );
});

void test("unknown keys, invalid values and an unparseable file fail with the key path", async (t) => {
  const cases: Array<[string, string, RegExp]> = [
    [
      '{"server": {"prot": 1}}',
      "CONFIG_UNKNOWN_KEY",
      /server\.prot is not a setting/,
    ],
    ['{"servr": {}}', "CONFIG_UNKNOWN_KEY", /servr is not a setting/],
    [
      '{"server": {"port": 70000}}',
      "CONFIG_INVALID",
      /server\.port must be an integer/,
    ],
    [
      '{"dataDir": "relative/data"}',
      "CONFIG_INVALID",
      /dataDir must be an absolute path/,
    ],
    [
      '{"secrets": {"backend": "vault"}}',
      "CONFIG_INVALID",
      /secrets\.backend must be one of/,
    ],
    [
      '{"catalog": {"url": "http://example.com"}}',
      "CONFIG_INVALID",
      /catalog\.url must be an HTTPS URL/,
    ],
    [
      '{"gateway": {"limits": {"bogus": 1}}}',
      "CONFIG_INVALID",
      /gateway\.limits Unknown gateway limit bogus/,
    ],
    ['{"otlp": {"protocol": "grpc"}}', "CONFIG_INVALID", /otlp/],
    [
      '{"wiring": {"autoSync": "yes"}}',
      "CONFIG_INVALID",
      /wiring\.autoSync must be true or false/,
    ],
    ["{ server: }", "CONFIG_UNPARSEABLE", /Invalid JSON/],
    ["[]", "CONFIG_UNPARSEABLE", /not an object/],
  ];
  for (const [text, expected, message] of cases)
    await assert.rejects(
      readConfigFile(await configDir(t, text)),
      code(expected, message),
      text,
    );
  // A missing file is an empty configuration.
  assert.deepEqual((await readConfigFile(await configDir(t))).document, {});
});

void test("secrets are refused in the file, secret references are not", async (t) => {
  for (const [name, value] of [
    ["url", "sk-live-0123456789abcdef"],
    [
      "anything",
      "hhk_c_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
    ],
    ["authorization", "Bearer abcdefghijklmnop"],
    ["x-api-key", "plain-but-under-a-key-name"],
    ["value", "AbCdEf0123456789AbCdEf0123456789xyz"],
    ["token", "ghp_0123456789abcdefghij"],
  ] as const)
    assert.equal(looksLikeSecret(name, value), true, `${name}: ${value}`);
  for (const [name, value] of [
    ["url", "https://models.dev/api.json"],
    ["dataDir", "/Users/someone/Library/Application Support/HarnessHub/data/x"],
    ["host", "127.0.0.1"],
    ["backend", "keychain"],
  ] as const)
    assert.equal(looksLikeSecret(name, value), false, `${name}: ${value}`);
  await assert.rejects(
    readConfigFile(
      await configDir(
        t,
        '{"otlp": {"endpoint": "https://otel.example/v1/traces", "headers": {"authorization": "Bearer abcdefghijklmnop"}}}',
      ),
    ),
    code(
      "CONFIG_SECRET",
      /otlp\.headers\.authorization looks like a secret.*hh credential/,
    ),
  );
  const references = await readConfigFile(
    await configDir(
      t,
      '{"otlp": {"endpoint": "https://otel.example/v1/traces", "headers": {"authorization": {"kind": "env", "value": "OTEL_TOKEN"}}}}',
    ),
  );
  assert.ok(references.document.otlp);
});

void test("the proxy comes from --proxy, then HTTPS_PROXY and the like, then the file; a password only from the environment or a secret", async (t) => {
  const entry = (config: ReturnType<typeof resolveConfig>, key: string) =>
    config.entries.find((item) => item.path === key)!;
  const file = document({
    network: {
      proxy: "http://alice@proxy.corp:3128",
      proxyPassword: { kind: "env", value: "PROXY_PASSWORD" },
      noProxy: [".corp.example", "10.0.0.0/8"],
    },
  });
  const fromFile = resolveConfig({ config: file, env: {} });
  assert.deepEqual(startOptions(fromFile).network, {
    proxy: "http://alice@proxy.corp:3128",
    proxyPassword: { kind: "env", value: "PROXY_PASSWORD" },
    noProxy: [".corp.example", "10.0.0.0/8"],
  });
  // curl's order: lower case first, and an HTTP proxy serves HTTPS too.
  for (const [env, name] of [
    [
      { HTTPS_PROXY: "http://u:p@a:1", https_proxy: "http://b:2" },
      "https_proxy",
    ],
    [
      { HTTPS_PROXY: "http://u:p@a:1", HTTP_PROXY: "http://c:3" },
      "HTTPS_PROXY",
    ],
    [{ HTTP_PROXY: "http://c:3" }, "HTTP_PROXY"],
  ] as const) {
    const config = resolveConfig({ config: file, env });
    assert.deepEqual(entry(config, "network.proxy").source, {
      kind: "env",
      name,
    });
  }
  const environment = resolveConfig({
    config: file,
    env: { HTTPS_PROXY: "http://u:p%40ss@a:1", NO_PROXY: "a.com, .b.com" },
  });
  assert.equal(
    entry(environment, "network.proxy").value,
    "http://u:p%40ss@a:1",
  );
  // hh config shows it masked.
  assert.equal(
    shownValue(entry(environment, "network.proxy")),
    "http://u:***@a:1",
  );
  assert.deepEqual(entry(environment, "network.noProxy").value, [
    "a.com",
    ".b.com",
  ]);
  assert.deepEqual(entry(environment, "network.noProxy").source, {
    kind: "env",
    name: "NO_PROXY",
  });
  // A flag wins over the environment; direct turns the proxy off.
  const flagged = resolveConfig({
    config: file,
    env: { HTTPS_PROXY: "http://a:1" },
    flags: { "--proxy": "direct" },
  });
  assert.equal(entry(flagged, "network.proxy").value, "direct");
  assert.deepEqual(entry(flagged, "network.proxy").source, {
    kind: "flag",
    name: "--proxy",
  });
  assert.throws(
    () =>
      resolveConfig({
        config: document({}),
        env: {},
        flags: { "--proxy": "http://u:pw@a:1" },
      }),
    code("CONFIG_SECRET", /^--proxy holds a password/),
  );
  assert.throws(
    () =>
      resolveConfig({
        config: document({}),
        env: { HTTPS_PROXY: "ftp://a:1" },
      }),
    code(
      "CONFIG_INVALID",
      /^HTTPS_PROXY must use http, https, socks5 or socks5h/,
    ),
  );
  for (const [text, expected, message] of [
    [
      '{"network": {"proxy": "http://alice:pw@proxy:1"}}',
      "CONFIG_SECRET",
      /network\.proxy holds a password.*network\.proxyPassword/,
    ],
    [
      '{"network": {"proxy": "proxy:8080/x"}}',
      "CONFIG_INVALID",
      /network\.proxy must be the proxy's address alone/,
    ],
    [
      '{"network": {"proxyPassword": "short"}}',
      "CONFIG_INVALID",
      /network\.proxyPassword must be a secret reference/,
    ],
    [
      '{"network": {"proxyPassword": "a-long-plain-password"}}',
      "CONFIG_SECRET",
      /network\.proxyPassword looks like a secret/,
    ],
    [
      '{"network": {"noProxy": ["bad host"]}}',
      "CONFIG_INVALID",
      /network\.noProxy bad host is not a host/,
    ],
    [
      '{"network": {"noProxy": ".corp.example"}}',
      "CONFIG_INVALID",
      /network\.noProxy must be a list of hosts/,
    ],
    [
      '{"network": {"proxie": "http://a:1"}}',
      "CONFIG_UNKNOWN_KEY",
      /network\.proxie is not a setting/,
    ],
  ] as const)
    await assert.rejects(
      readConfigFile(await configDir(t, text)),
      code(expected, message),
      text,
    );
  const valid = await readConfigFile(
    await configDir(
      t,
      '{"network": {"proxy": "socks5://127.0.0.1:1080", "noProxy": ["*"]}}',
    ),
  );
  assert.deepEqual(valid.document.network, {
    proxy: "socks5://127.0.0.1:1080",
    noProxy: ["*"],
  });
});

void test("set and unset edit the file in place, keep its comments, and write nothing that does not validate", async (t) => {
  const original = `// My settings
{
  // where it listens
  "server": { "port": 4000 },
  "catalog": {
    "autoRefresh": false // offline laptop
  }
}
`;
  const directory = await configDir(t, original);
  const file = path.join(directory, CONFIG_FILE);
  await editConfigFile(directory, "wiring.autoSync", false);
  let text = await readFile(file, "utf8");
  assert.ok(text.startsWith("// My settings\n{\n  // where it listens\n"));
  assert.match(text, /"autoRefresh": false \/\/ offline laptop/);
  assert.deepEqual((await readConfigFile(directory)).document.wiring, {
    autoSync: false,
  });
  for (const [key, value, expected] of [
    ["server.port", "high", "CONFIG_INVALID"],
    ["server.colour", 1, "CONFIG_UNKNOWN_KEY"],
    ["otlp.headers.x-api-key", "abcdefghijklmnop", "CONFIG_SECRET"],
  ] as const)
    await assert.rejects(
      editConfigFile(directory, key, value),
      code(expected),
      key,
    );
  assert.equal(await readFile(file, "utf8"), text);
  await editConfigFile(directory, "gateway.limits.idleTimeoutMs", 60_000);
  await editConfigFile(directory, "gateway.limits.idleTimeoutMs", undefined);
  await editConfigFile(directory, "wiring.autoSync", undefined);
  text = await readFile(file, "utf8");
  assert.equal(text, original);
  // A new file is created private, with a comment saying what it is.
  const fresh = await configDir(t);
  await editConfigFile(fresh, "server.port", 3200);
  const created = path.join(fresh, CONFIG_FILE);
  assert.match(
    await readFile(created, "utf8"),
    /^\/\/ HarnessHub configuration/,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(created)).mode & 0o777, 0o600);
    assert.equal((await stat(fresh)).mode & 0o777, 0o700);
  }
});
