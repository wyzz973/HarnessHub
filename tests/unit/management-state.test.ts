import assert from "node:assert/strict";
import test from "node:test";
import { ManagementError } from "../../src/contracts/management.js";
import { parseManagementInput } from "../../src/contexts/management/domain/input.js";
import { parseManagementJob, parseManagementLog, parseManagementUpdate, parseInstallationRecord } from "../../src/contexts/management/domain/state.js";
import { builtinManagementRecipes } from "../../src/adapters/management/recipes.js";

const job = { id: "management-876453de-07ea-47b5-8e29-c0271c9faabb", harnessId: "codex", controlId: "codex-native", action: "install",
  status: "queued", phase: "queued", cancelRequested: false, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", resolvedVersion: null, installationId: null, error: null, logCursor: 0 };
test("management input does not accept shell, URLs, package overrides, unknown actions or invalid CAS", () => {
  assert.deepEqual(parseManagementInput({ harnessId: "codex", action: "install", commandId: "request-1", expectedDefaultRevision: 0 }), { harnessId: "codex", action: "install", commandId: "request-1", expectedDefaultRevision: 0 });
  for (const input of [null, [], {}, { harnessId: "codex", action: "remove", commandId: "k" }, { harnessId: "../codex", action: "install", commandId: "k" },
    { harnessId: "codex", action: "install", commandId: "k", shell: "echo yes" }, { harnessId: "codex", action: "install", commandId: "k", expectedDefaultRevision: -1 },
    { harnessId: "codex", action: "install", commandId: "" }, Object.create({ harnessId: "codex", action: "install", commandId: "k" })])
    assert.throws(() => parseManagementInput(input), error => error instanceof ManagementError && error.code === "INVALID_INPUT");
});
test("persisted management facts reject unknown schema, statuses and incoherent completed/admission fields", () => {
  assert.deepEqual(parseManagementJob(job), job);
  for (const value of [{ ...job, schemaVersion: 99 }, { ...job, status: "done" }, { ...job, phase: "installing" }, { ...job, cancelRequested: 1 },
    { ...job, createdAt: "not-a-date" }, { ...job, logCursor: -1 }, { ...job, status: "completed", phase: "completed" }, { ...job, resolvedVersion: "1.0.0" }])
    assert.throws(() => parseManagementJob(value));
});
test("management log/update/installation formats preserve bounded explicit fields", () => {
  assert.equal(parseManagementLog({ seq: 1, time: job.createdAt, stream: "stdout", text: "line\nline" }).text, "line\nline");
  assert.throws(() => parseManagementLog({ seq: 0, time: job.createdAt, stream: "stdout", text: "x" }));
  assert.throws(() => parseManagementUpdate({ latestVersion: "1", updateStatus: "success", checkedAt: job.createdAt, error: null }));
  assert.throws(() => parseInstallationRecord({ command: { executable: "/tmp/x", args: [1], env: {} } }));
});
test("builtin management recipes cover reviewed native package identities and multi-bin boundaries", () => {
  const recipes = builtinManagementRecipes();
  assert.equal(recipes.find(recipe => recipe.controlId === "codex-native")?.packageName, "@openai/codex");
  assert.equal(recipes.find(recipe => recipe.controlId === "openclaw-native")?.packageName, "openclaw");
  assert.deepEqual(recipes.find(recipe => recipe.harnessId === "pi")?.dependencies, [{ packageName: "@earendil-works/pi-coding-agent", binName: "pi" }]);
  for (const [harness, bin] of [["codebuddy-code", "codebuddy"], ["dimcode", "dimcode"], ["nova", "nova"], ["minion-code", "minion-code"]]) assert.equal(recipes.find(recipe => recipe.harnessId === harness)?.binName, bin);
  assert.equal(recipes.filter(recipe => recipe.kind === "binary").length, 19);
});
