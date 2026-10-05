// SPDX-License-Identifier: MIT
/**
 * A provider's credentials as Magpie orders them for a model: those whose
 * own list lacks it are left out (`Model.Keys`, Magpie `Serves`), unless
 * none lists it; the rest in `keyFit` order, those limited to other
 * protocols than the best after the others.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  CredentialId,
  ProviderConfig,
  WireProtocol,
} from "@harnesshub/core/model-plane";
import { modelCandidates, planGroup } from "../src/routing.js";
import { group, provider } from "./shared-support.js";

/** Provider `p` with credentials cred-0…, each limited as `limits` says (undefined: not). */
function limited(
  endpoints: Partial<Record<WireProtocol, string>>,
  limits: (WireProtocol[] | undefined)[],
): ProviderConfig {
  const config = provider("p", endpoints, {
    secrets: limits.map((_, index) => `key-${index}`),
  });
  config.credentials.forEach((credential, index) => {
    const protocols = limits[index];
    if (protocols) credential.protocols = protocols;
  });
  return config;
}

const order = (config: ProviderConfig, model: string, inbound: WireProtocol) =>
  modelCandidates(config, model, inbound).candidates.map((candidate) => [
    candidate.credential.id,
    candidate.upstream,
    candidate.aside === true,
  ]);

void test("a credential whose own list lacks the model is left out, unless none lists it", () => {
  const config = provider(
    "p",
    { chat: "https://p.example/v1" },
    { secrets: ["key-a", "key-b", "key-c"] },
  );
  const [first, second, third] = config.credentials.map(
    (credential) => credential.id,
  );
  // Read with the first two; the third was added since.
  config.models.listedFor = [first!, second!];
  config.models.list = [
    { id: "model-a" },
    { id: "model-b", credentials: [second!] },
    { id: "model-c", credentials: [] },
  ];
  const ids = (model: string) => {
    const result = modelCandidates(config, model, "chat");
    return [
      result.candidates.map((candidate) => candidate.credential.id),
      result.unlisted,
      result.unlistedTried,
    ];
  };
  assert.deepEqual(ids("model-a"), [[first, second, third], 0, false]);
  assert.deepEqual(ids("model-b"), [[second, third], 1, false]);
  // A model not in the list is not known either way.
  assert.deepEqual(ids("model-z"), [[first, second, third], 0, false]);
  // Nobody known to list it, the unknown third aside: all of them.
  config.credentials.pop();
  assert.deepEqual(ids("model-c"), [[first, second], 0, true]);
});

void test("Claude's models go first to a credential that takes Anthropic's protocol, GPT's to one that does not", () => {
  const both = limited(
    {
      chat: "https://p.example/v1",
      anthropic: "https://p.example/anthropic",
    },
    [["chat"], ["anthropic"]],
  );
  assert.deepEqual(order(both, "claude-sonnet-5", "chat"), [
    ["cred-1", "anthropic", false],
    ["cred-0", "chat", true],
  ]);
  assert.deepEqual(order(both, "vendor/claude-opus-5", "anthropic"), [
    ["cred-1", "anthropic", false],
    ["cred-0", "chat", true],
  ]);
  for (const model of ["gpt-5.5", "gpt-5.5-codex", "o4-mini"])
    assert.deepEqual(
      order(both, model, "anthropic"),
      [
        ["cred-0", "chat", false],
        ["cred-1", "anthropic", true],
      ],
      model,
    );
  // A model of neither family: the one that takes the request as it is.
  assert.deepEqual(order(both, "deepseek-v4", "anthropic"), [
    ["cred-1", "anthropic", false],
    ["cred-0", "chat", true],
  ]);
  assert.deepEqual(order(both, "deepseek-v4", "chat"), [
    ["cred-0", "chat", false],
    ["cred-1", "anthropic", true],
  ]);
  // Credentials not limited all fit; the order is the configuration's.
  const open = limited(
    {
      chat: "https://p.example/v1",
      anthropic: "https://p.example/anthropic",
    },
    [undefined, undefined],
  );
  assert.deepEqual(order(open, "claude-sonnet-5", "chat"), [
    ["cred-0", "chat", false],
    ["cred-1", "chat", false],
  ]);
});

void test("in a weighed group, a credential limited to another protocol than its model's best comes after the weighed ones", async () => {
  const both = limited(
    {
      chat: "https://p.example/v1",
      anthropic: "https://p.example/anthropic",
    },
    [["chat"], ["anthropic"], ["anthropic"]],
  );
  const planned = await planGroup(
    group("g", ["p/claude-x"], { strategy: "least-used" }),
    "chat",
    {
      provider: async () => both,
      group: async () => undefined,
      order: (current) => current.members,
      // Weighs the chat credential first, were it among the weighed.
      weigh: async (_, list) =>
        [...list].sort((a, b) =>
          a.credential.id === ("cred-0" as CredentialId)
            ? -1
            : b.credential.id === ("cred-0" as CredentialId)
              ? 1
              : b.credential.id.localeCompare(a.credential.id),
        ),
      blocked: () => false,
    },
  );
  assert.deepEqual(
    planned.candidates.map((candidate) => candidate.credential.id),
    ["cred-2", "cred-1", "cred-0"],
  );
});
