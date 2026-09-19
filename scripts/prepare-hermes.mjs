/**
 * Build-machine-only fix of the fixed Hermes 0.19.0 package (hermes-agent, MIT).
 *
 * On Windows Hermes checks that Git Bash can start by running it with `subprocess.run(...,
 * capture_output=True)` and no `stdin`, so bash inherits Hermes' own stdin. Under ACP that
 * handle is the engine's JSON-RPC pipe with a read pending, and the MSYS runtime's inspection
 * of an inherited synchronous pipe blocks until the next ACP message arrives. The probe then
 * times out, Hermes falls back to a `bin\bash.exe` launcher whose killed parent leaves the real
 * bash holding the output pipe, and the first terminal call hangs until the Run ends. Giving
 * both probes NUL as stdin removes the hang; command execution already uses NUL or its own pipe.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Patched module, relative to the Hermes runtime directory (`engines/hermes/runtime`). */
export const HERMES_LOCAL_ENVIRONMENT = path.join(
  "Lib",
  "site-packages",
  "tools",
  "environments",
  "local.py",
);
/** `tools/environments/local.py` of hermes_agent-0.19.0-py3-none-any.whl. */
export const HERMES_LOCAL_ORIGINAL_SHA256 =
  "92384375cea9f015bbdd9dc020e637c1498511e1a69d0b19104463b664d716ec";
/** The same file after {@link patchHermesLocalEnvironment}. */
export const HERMES_LOCAL_PATCHED_SHA256 =
  "8cd5e6d642ce9e95f63c3f56e31b12b9b19b03b868c52692c6da7af52017c698";

const PROBES = [
  {
    name: "Git Bash start probe",
    anchor:
      '            [bash, "--noprofile", "--norc", "-c", _BASH_EXTERNAL_PROGRAM_PROBE],\n            capture_output=True,\n',
  },
  {
    name: "Mandatory ASLR probe",
    anchor:
      '                "(Get-ProcessMitigation -System).Aslr.ForceRelocateImages.ToString()",\n            ],\n            capture_output=True,\n',
  },
];
const STDIN_LINE = "            stdin=subprocess.DEVNULL,\n";

const sha256 = (text) =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * Give Hermes' two Windows probes NUL as stdin. Each anchor must occur exactly once;
 * any other shape (another Hermes version, an already patched text) throws.
 */
export function patchHermesLocalEnvironment(text) {
  let result = text;
  for (const probe of PROBES) {
    const first = result.indexOf(probe.anchor);
    if (first < 0 || result.indexOf(probe.anchor, first + 1) >= 0)
      throw new Error(
        `Hermes ${probe.name} does not match the fixed 0.19.0 source exactly once`,
      );
    if (result.startsWith(STDIN_LINE, first + probe.anchor.length))
      throw new Error(`Hermes ${probe.name} already has an explicit stdin`);
    result =
      result.slice(0, first + probe.anchor.length) +
      STDIN_LINE +
      result.slice(first + probe.anchor.length);
  }
  return result;
}

/**
 * Patch `runtime` in place (atomic replace). Idempotent: an already patched file is left as
 * is. Fails for any file that is neither the fixed original nor its patched form.
 */
export async function prepareHermes(runtime) {
  const file = path.join(path.resolve(runtime), HERMES_LOCAL_ENVIRONMENT);
  const text = await readFile(file, "utf8");
  const digest = sha256(text);
  if (digest === HERMES_LOCAL_PATCHED_SHA256)
    return { id: "hermes", file, changed: false };
  if (digest !== HERMES_LOCAL_ORIGINAL_SHA256)
    throw new Error(
      `Unexpected Hermes ${HERMES_LOCAL_ENVIRONMENT} (sha256 ${digest}); expected hermes-agent 0.19.0`,
    );
  const patched = patchHermesLocalEnvironment(text);
  if (sha256(patched) !== HERMES_LOCAL_PATCHED_SHA256)
    throw new Error("Patched Hermes local.py does not have the expected digest");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, patched, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return { id: "hermes", file, changed: true };
}

/** Throw unless `runtime` carries the patched module (used by `prepare-contest --check`). */
export async function verifyHermesPatch(runtime) {
  const file = path.join(path.resolve(runtime), HERMES_LOCAL_ENVIRONMENT);
  if (sha256(await readFile(file, "utf8")) !== HERMES_LOCAL_PATCHED_SHA256)
    throw new Error(
      "Hermes runtime lacks the Git Bash stdin fix; prepare into a fresh root",
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({ options: { runtime: { type: "string" } } });
  if (!values.runtime) {
    console.error("Usage: node scripts/prepare-hermes.mjs --runtime ENGINES/hermes/runtime");
    process.exit(2);
  }
  console.log(JSON.stringify(await prepareHermes(values.runtime)));
}
