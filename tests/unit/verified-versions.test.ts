import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VERIFIED_VERSIONS, versionVerification } from "../../src/infrastructure/management/verified-versions.js";

test("a version is verified only where HarnessHub ran it for real; unknown versions and Harnesses claim nothing", () => {
  assert.deepEqual(versionVerification("claude", "2.1.296", "0.89.1"), { state: "verified", program: "2.1.296", adapter: "0.89.1" });
  assert.equal(versionVerification("claude", "2.1.300", "0.89.1")?.state, "unverified", "a newer product");
  assert.equal(versionVerification("claude", "2.1.296", "0.90.0")?.state, "unverified", "a newer adapter in front of a verified product");
  assert.equal(versionVerification("claude", "2.1.296", "2.1.296")?.state, "verified", "an entry without its own version");
  assert.deepEqual(versionVerification("codex", "0.162.1", "0.162.1"), { state: "verified", program: "0.162.1" });
  assert.equal(versionVerification("codex", "0.163.0", "0.163.0")?.state, "unverified");
  assert.equal(versionVerification("codex", "0.162.1-alpha.2", "0.162.1-alpha.2")?.state, "unverified", "a prerelease of the verified version");
  assert.equal(versionVerification("cursor", "2026.10.01-e373342", null)?.state, "verified", "a version that is not semver matches exactly");
  assert.equal(versionVerification("cursor", "2026.10.02-a1b2c3d", null)?.state, "unverified");
  assert.equal(versionVerification("dsh", "0.2.1-alpha.1", null)?.state, "verified");
  assert.equal(versionVerification("dsh", "0.2.1", null)?.state, "unverified", "the release after the verified prerelease");
  assert.equal(versionVerification("gemini", null, "0.62.0"), null, "no product version, no claim");
  assert.equal(versionVerification("autohand", "1.0.0", "1.0.0"), null, "a Harness never verified");
  assert.equal(versionVerification("constructor", "1.0.0", null), null, "no inherited key counts as a Harness");
});

test("the verified versions are the installations the capability matrix records for its real checks", () => {
  const matrix = JSON.parse(readFileSync(fileURLToPath(new URL("../../../plan/native-capabilities.json", import.meta.url)), "utf8")) as { harnesses: { id: string; installation: string }[] };
  const installations = new Map(matrix.harnesses.map(harness => [harness.id, harness.installation]));
  assert.deepEqual([...Object.keys(VERIFIED_VERSIONS)].sort(), [...installations.keys()].sort(), "every Harness of the matrix, and no other");
  for (const [id, verified] of Object.entries(VERIFIED_VERSIONS)) {
    const installation = installations.get(id)!;
    assert.ok(installation.includes(verified.program[1]), `${id}: the matrix was checked on ${verified.program[1]}: ${installation}`);
    if (verified.adapter) assert.ok(installation.includes(verified.adapter[1]), `${id}: the matrix names adapter ${verified.adapter[1]}`);
  }
});
