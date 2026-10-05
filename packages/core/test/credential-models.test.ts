// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialUnlisted,
  type CredentialId,
  type ProviderModels,
} from "../src/model-plane.js";

const a = "cred-a" as CredentialId;
const b = "cred-b" as CredentialId;
const c = "cred-c" as CredentialId;

void test("a credential is known not to list a model only when its own list was read and lacks it", () => {
  const models: ProviderModels = {
    source: "live",
    expose: "all",
    listedFor: [a, b],
    list: [{ id: "both" }, { id: "only-b", credentials: [b] }],
  };
  const unlisted = (credential: CredentialId, model: string) =>
    credentialUnlisted({ models }, credential, model);
  assert.equal(unlisted(a, "only-b"), true);
  assert.equal(unlisted(b, "only-b"), false);
  assert.equal(unlisted(a, "both"), false);
  assert.equal(unlisted(c, "only-b"), false, "its list was never read");
  assert.equal(unlisted(a, "not-listed"), false, "not known either way");
  const { listedFor: _listedFor, ...single } = models;
  assert.equal(
    credentialUnlisted({ models: single }, a, "only-b"),
    false,
    "one list for the provider",
  );
});
