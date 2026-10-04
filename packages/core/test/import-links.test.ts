// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPORT_LINK_MAX_BYTES,
  ImportLinkError,
  parseImportLink,
  slugify,
} from "../src/import-links.js";

const KEY = "sk-synthetic-link-key-0123456789";

void test("HarnessHub and Magpie links in every accepted form", () => {
  assert.deepEqual(
    parseImportLink(
      `harnesshub://import?v=1&kind=provider&preset=moonshot&region=global&key=${KEY}`,
    ),
    {
      flavor: "harnesshub",
      preset: "moonshot",
      region: "global",
      key: KEY,
      endpoints: {},
      models: [],
      warnings: [],
    },
  );
  for (const form of [
    "harnesshub:import?preset=deepseek",
    "harnesshub:///import?preset=deepseek",
    "  HARNESSHUB://import?preset=DeepSeek  ",
    "https://harnesshub.dev/import#preset=deepseek",
    "https://www.harnesshub.dev/import/#preset=deepseek",
  ])
    assert.deepEqual(
      [parseImportLink(form).flavor, parseImportLink(form).preset],
      ["harnesshub", "deepseek"],
      form,
    );
  for (const form of [
    "magpie://import?preset=moonshot-cn",
    "magpie:import?preset=moonshot-cn",
    "https://usemagpie.ai/import#preset=moonshot-cn",
  ])
    assert.equal(parseImportLink(form).flavor, "magpie", form);

  // A custom provider: the ID comes from the name, endpoints lose a trailing
  // slash, models are deduplicated, a local plain-HTTP endpoint warns.
  const custom = parseImportLink(
    "harnesshub://import?name=My%20Relay%E2%80%94Team&chat=https://relay.example.test/v1/&anthropic=http://192.168.1.20:4000" +
      "&gemini=https://relay.example.test&models=a,%20b,a,,openrouter/x&catalog=deepseek&website=https://relay.example.test&keys=http://relay.example.test/keys" +
      "&icon=https://relay.example.test/logo.png&plan=coding&preset=zhipu",
  );
  assert.equal(custom.id, undefined); // a preset is given, so no derived ID
  const plain = parseImportLink(
    "magpie://import?name=My%20Relay!&chat=https://relay.example.test/v1/&anthropic=http://192.168.1.20:4000&models=a,%20b,a,,openrouter/x" +
      "&catalog=DeepSeek&website=https://relay.example.test&keys=http://relay.example.test/keys&icon=https://relay.example.test/logo.png",
  );
  assert.deepEqual(plain, {
    flavor: "magpie",
    id: "my-relay",
    name: "My Relay!",
    endpoints: {
      chat: "https://relay.example.test/v1",
      anthropic: "http://192.168.1.20:4000",
    },
    models: ["a", "b", "openrouter/x"],
    catalog: "deepseek",
    website: "https://relay.example.test",
    warnings: [
      "anthropic= uses plain HTTP to a local or private address: requests and the key travel unencrypted",
      "keys= is left out: it is not an https page",
      "icon= is not fetched: HarnessHub shows only the icons of its own presets",
    ],
  });
  assert.equal(
    parseImportLink(
      "harnesshub://import?name=x&id=Team%20One&chat=https://a.test/v1",
    ).id,
    "team-one",
  );
  assert.equal(slugify("  Ünïcode — Relay  "), "unicode-relay");
});

void test("links that are not import links, or not safe ones, are refused without echoing the key", () => {
  const refused: Array<[string, RegExp]> = [
    ["https://example.test/import#preset=deepseek", /Not an import link/],
    ["http://harnesshub.dev/import#preset=deepseek", /Not an import link/],
    ["https://harnesshub.dev/other#preset=deepseek", /Not an import link/],
    ["https://harnesshub.dev/import?preset=deepseek", /Not an import link/],
    [
      "harnesshub://export?preset=deepseek",
      /start with harnesshub:\/\/import\?/,
    ],
    ["harnesshub://import?preset=deepseek#x", /fragment/],
    ["harnesshub://import?preset=deepseek&preset=openai", /preset= twice/],
    [
      "harnesshub://import?preset=deepseek&color=red",
      /unknown parameter "color"/,
    ],
    // Magpie links take exactly Magpie's parameters.
    ["magpie://import?preset=deepseek&plan=coding", /unknown parameter "plan"/],
    ["magpie://import?preset=deepseek&v=1", /unknown parameter "v"/],
    ["harnesshub://import?v=2&preset=deepseek", /version 2.*update HarnessHub/],
    ["harnesshub://import?v=one&preset=deepseek", /not a version/],
    [
      "harnesshub://import?kind=mcp&preset=deepseek",
      /MCP server links are not supported/,
    ],
    [
      "harnesshub://import?kind=agent&preset=deepseek",
      /kind= must be provider/,
    ],
    ["harnesshub://import?preset=deep%20seek", /preset= is not an ID/],
    [
      "harnesshub://import?region=cn&name=x&chat=https://a.test/v1",
      /region= needs preset=/,
    ],
    ["harnesshub://import?key=x", /needs preset= or name=/],
    ["harnesshub://import?name=x", /no base URL/],
    [
      "harnesshub://import?name=%21%21&chat=https://a.test/v1",
      /no letters or digits/,
    ],
    ["harnesshub://import?name=x&id=group&chat=https://a.test/v1", /reserved/],
    ["harnesshub://import?name=HH&chat=https://a.test/v1", /reserved/],
    [
      `harnesshub://import?name=${"n".repeat(81)}&chat=https://a.test/v1`,
      /longer than 80/,
    ],
    [
      "harnesshub://import?name=x&chat=http://relay.example.test/v1",
      /chat= must use HTTPS/,
    ],
    [
      "harnesshub://import?name=x&chat=https://user:pw@relay.example.test/v1",
      /chat= must not contain credentials/,
    ],
    [
      "harnesshub://import?name=x&chat=https://relay.example.test/v1/chat/completions",
      /operation path/,
    ],
    [
      "harnesshub://import?name=x&anthropic=https://relay.example.test/v1",
      /API version/,
    ],
    [
      "harnesshub://import?name=x&chat=ftp://relay.example.test/v1",
      /chat= must use HTTPS/,
    ],
    [
      "harnesshub://import?name=x&chat=https://a.test/v1&models=a%20b",
      /invalid model ID/,
    ],
    [
      `harnesshub://import?name=x&chat=https://a.test/v1&models=${Array.from({ length: 201 }, (_, i) => `m${i}`).join(",")}`,
      /more than 200/,
    ],
    [
      "harnesshub://import?name=x&chat=https://a.test/v1&catalog=Not%20Slug",
      /catalog= is not an ID/,
    ],
    [
      "harnesshub://import?name=x&chat=https://a.test/v1&icon=http://a.test/i.png",
      /icon= must be an https picture/,
    ],
    [
      `harnesshub://import?preset=deepseek&key=${KEY}%0Amore`,
      /key= is not a key/,
    ],
    [
      `harnesshub://import?preset=deepseek&key=sk+${KEY}`,
      /key= is not a key \(a \+ in it must be written %2B\)/,
    ],
    [
      `harnesshub://import?preset=deepseek&key=${"k".repeat(4097)}`,
      /key= is not a key/,
    ],
    [
      `harnesshub://import?preset=deepseek&key=${KEY}&name=${"x".repeat(IMPORT_LINK_MAX_BYTES)}`,
      /longer than 8192 bytes/,
    ],
  ];
  for (const [link, reason] of refused)
    assert.throws(
      () => parseImportLink(link),
      (error: unknown) => {
        assert.ok(error instanceof ImportLinkError, link);
        assert.match(error.message, reason, link);
        assert.equal(error.message.includes(KEY), false, link);
        return true;
      },
    );
  // A + written %2B is kept.
  assert.equal(
    parseImportLink(`harnesshub://import?preset=deepseek&key=sk%2B${KEY}`).key,
    `sk+${KEY}`,
  );
});
