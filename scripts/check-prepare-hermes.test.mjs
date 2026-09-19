import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HERMES_LOCAL_ENVIRONMENT,
  patchHermesLocalEnvironment,
  prepareHermes,
  verifyHermesPatch,
} from "./prepare-hermes.mjs";

// Excerpt shaped like hermes-agent 0.19.0 tools/environments/local.py around both probes.
const aslrProbe = [
  "        result = subprocess.run(",
  "            [",
  "                powershell,",
  '                "-NoProfile",',
  '                "-NonInteractive",',
  '                "-Command",',
  '                "(Get-ProcessMitigation -System).Aslr.ForceRelocateImages.ToString()",',
  "            ],",
  "            capture_output=True,",
  "            text=True,",
  "            timeout=10,",
  "            creationflags=windows_hide_flags(),",
  "        )",
  "",
].join("\n");
const bashProbe = [
  "        result = subprocess.run(",
  '            [bash, "--noprofile", "--norc", "-c", _BASH_EXTERNAL_PROGRAM_PROBE],',
  "            capture_output=True,",
  "            text=True,",
  "            timeout=15,",
  "            creationflags=windows_hide_flags() if _IS_WINDOWS else 0,",
  "        )",
  "",
].join("\n");
const commandSpawn = [
  "        proc = subprocess.Popen(",
  "            args,",
  "            stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,",
  "        )",
  "",
].join("\n");
const fixture = `# header — non-ASCII kept\n${aslrProbe}\n${bashProbe}\n${commandSpawn}`;

test("both Windows probes of Hermes get NUL stdin and nothing else changes", () => {
  const patched = patchHermesLocalEnvironment(fixture);
  const added = "            stdin=subprocess.DEVNULL,\n";
  assert.equal(patched.length, fixture.length + 2 * added.length);
  assert.equal(
    patched.split(`capture_output=True,\n${added}            text=True,`)
      .length - 1,
    2,
  );
  assert.equal(patched.replaceAll(added, ""), fixture);
  assert.ok(patched.includes(commandSpawn), "command execution is untouched");
});

test("another Hermes source shape or an already patched source is refused", () => {
  assert.throws(
    () => patchHermesLocalEnvironment(fixture.replace(bashProbe, "")),
    /Git Bash start probe does not match/,
  );
  assert.throws(
    () => patchHermesLocalEnvironment(`${fixture}\n${aslrProbe}`),
    /Mandatory ASLR probe does not match/,
  );
  assert.throws(
    () => patchHermesLocalEnvironment(patchHermesLocalEnvironment(fixture)),
    /already has an explicit stdin/,
  );
});

test("prepareHermes only accepts the pinned module and never rewrites a foreign file", async (t) => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), "hh-hermes-runtime-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const file = path.join(runtime, HERMES_LOCAL_ENVIRONMENT);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, fixture);
  await assert.rejects(
    prepareHermes(runtime),
    /expected hermes-agent 0\.19\.0/,
  );
  assert.equal(await readFile(file, "utf8"), fixture);
  await assert.rejects(
    verifyHermesPatch(runtime),
    /lacks the Git Bash stdin fix/,
  );
  await rm(file);
  await assert.rejects(prepareHermes(runtime), { code: "ENOENT" });
});
