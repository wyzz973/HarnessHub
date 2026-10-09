import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError, parseProviderTarget } from "../../src/contracts/provider.js";
import { MAX_CREDENTIAL_BYTES, MAX_MODELS, assertProviderCompatibility, parseProviderWrite, supportedProviderProtocols } from "../../src/contexts/provider/domain/provider.js";

const id = "provider-6fda5d0f-dc7c-4a58-83c9-a4fa7571db03";
const input = { name: "Local", protocol: "openai-responses", baseUrl: "http://127.0.0.1:1234/v1", models: ["m1"], defaultModel: "m1", enabled: true };
function invalid(value: unknown): void { assert.throws(() => parseProviderWrite(value), error => error instanceof ProviderError && error.code === "INVALID_INPUT"); }
test("Provider input strictly preserves explicit protocol, model and normalized endpoint", () => {
  assert.deepEqual(parseProviderWrite({ ...input, baseUrl: input.baseUrl + "/" }), input);
  for (const protocol of ["openai-responses", "openai-chat-completions", "anthropic-messages", "gemini"])
    assert.equal(parseProviderWrite({ ...input, protocol }).protocol, protocol);
  assert.equal(parseProviderWrite({ ...input, apiKey: "synthetic-key" }).apiKey, "synthetic-key");
});
test("Provider parser rejects missing and unknown fields, invalid types, duplicate or unlisted models", () => {
  for (const value of [null, [], "provider", 1, {}, { ...input, extra: true }, { ...input, apiKey: "" }, { ...input, apiKey: null },
    { ...input, name: "\n" }, { ...input, enabled: 1 }, { ...input, protocol: "chat" }, { ...input, models: [] },
    { ...input, models: ["m1", "m1"] }, { ...input, models: [1] }, { ...input, models: ["m\n1"] }, { ...input, defaultModel: "m2" },
    { ...input, name: "x".repeat(129) }, { ...input, models: ["x".repeat(257)], defaultModel: "x".repeat(257) },
    { ...input, apiKey: "x".repeat(MAX_CREDENTIAL_BYTES + 1) }, Object.create(input)]) invalid(value);
});
test("Provider model and credential byte boundaries are enforced", () => {
  const models = Array.from({ length: MAX_MODELS }, (_, index) => "m" + index);
  assert.equal(parseProviderWrite({ ...input, models, defaultModel: models[0], apiKey: "x".repeat(MAX_CREDENTIAL_BYTES) }).models.length, MAX_MODELS);
  invalid({ ...input, models: [...models, "another"], defaultModel: models[0] });
  invalid({ ...input, models: ["中".repeat(86)], defaultModel: "中".repeat(86) });
});
test("Provider URL preserves explicit self-hosted HTTP and rejects embedded credential, query, fragment and unsupported schemes", () => {
  for (const baseUrl of ["ftp://example.com", "https://key@example.com/v1", "https://example.com/v1?key=x", "https://example.com/v1#key", "invalid", "https://example.com/\n"]) invalid({ ...input, baseUrl });
  for (const baseUrl of ["http://localhost:1234/v1", "http://[::1]:1234/v1", "http://192.168.1.42:1234/v1", "http://provider.example/v1", "https://provider.example/v1"])
    assert.equal(parseProviderWrite({ ...input, baseUrl }).baseUrl, baseUrl);
});
test("Provider target is a strict immutable revision and explicit bounded model", () => {
  assert.deepEqual(parseProviderTarget({ providerId: id, revision: 1, model: "m1" }), { providerId: id, revision: 1, model: "m1" });
  for (const value of [null, [], { providerId: "codex", revision: 1, model: "m1" }, { providerId: id, revision: 0, model: "m1" },
    { providerId: id, revision: 1.5, model: "m1" }, { providerId: id, revision: Number.MAX_SAFE_INTEGER + 1, model: "m1" },
    { providerId: id, revision: 1, model: "" }, { providerId: id, revision: 1, model: "m\n1" }, { providerId: id, revision: 1, model: "中".repeat(86) },
    { providerId: id, revision: 1, model: "m1", extra: true }, Object.create({ providerId: id, revision: 1, model: "m1" })])
    assert.throws(() => parseProviderTarget(value), error => error instanceof ProviderError && error.code === "INVALID_INPUT");
});
test("Provider support is product-specific and does not infer execution compatibility from ACP", () => {
  assert.equal(assertProviderCompatibility("openai-responses", "codex"), "codex");
  assert.equal(assertProviderCompatibility("gemini", "gemini"), "gemini");
  assert.deepEqual(supportedProviderProtocols("codex"), ["openai-responses"]);
  assert.deepEqual(supportedProviderProtocols("gemini"), ["gemini"]);
  for (const harness of ["opencode", "claude", "custom-codex", "cursor", "qwen"]) assert.deepEqual(supportedProviderProtocols(harness), []);
  for (const [protocol, harness] of [["openai-chat-completions", "codex"], ["gemini", "codex"], ["openai-responses", "opencode"], ["anthropic-messages", "claude"]] as const)
    assert.throws(() => assertProviderCompatibility(protocol, harness), error => error instanceof ProviderError && error.code === "UNSUPPORTED_PROVIDER");
});
