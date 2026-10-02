// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { HubError } from "@harnesshub/core/errors";
import type { ProcessLauncher } from "@harnesshub/core/process-launcher";
import { secretHelperPath } from "./native-helper.js";

/** Longest wait for the platform secret helper (cold .NET start on Windows). */
const HELPER_TIMEOUT_MS = 20_000;

function failure(): HubError {
  return new HubError(
    "SECRET_UNAVAILABLE",
    "The credential reference is missing, locked or unreadable",
    400,
  );
}
/** The helper is started through an injected launcher; refuse without one. */
function helperLauncher(
  launcher: ProcessLauncher | undefined,
): ProcessLauncher {
  if (!launcher)
    throw new HubError(
      "PROCESS_LAUNCHER_NOT_INJECTED",
      "The secret helper needs a process launcher from the composition root",
      500,
    );
  return launcher;
}
async function keychain(
  launcher: ProcessLauncher | undefined,
  operation: string,
  id: string,
  value?: string,
): Promise<string | undefined> {
  if (process.platform !== "darwin" && process.platform !== "win32")
    throw new HubError(
      "KEYCHAIN_UNSUPPORTED",
      "Use an environment or file reference on this platform",
      400,
    );
  const executable = secretHelperPath(process.platform);
  // The Windows helper is a .NET Framework program: its first start on a cold machine
  // (JIT plus antivirus scanning) took over 5 s on CI runners, which failed saving the
  // model key from the console. The operation itself takes a few milliseconds.
  const run = await helperLauncher(launcher).run({
    file: executable,
    args: [],
    env: "inherit",
    input: JSON.stringify({
      operation,
      id,
      ...(value === undefined ? {} : { value }),
    }),
    timeoutMs: HELPER_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 32768,
  });
  if (run.error) throw failure();
  const output = run.stdout.toString("utf8");
  if (run.code !== 0) {
    const error = failure();
    let stage = "unavailable";
    try {
      const response: unknown = JSON.parse(output);
      if (
        response &&
        typeof response === "object" &&
        "stage" in response &&
        typeof response.stage === "string" &&
        [
          "request",
          "path",
          "owner",
          "acl",
          "open",
          "identity",
          "read",
          "profile",
          "encrypt",
          "create",
          "decrypt",
          "delete",
        ].includes(response.stage)
      )
        stage = response.stage;
    } catch {
      // Native failures may produce no JSON. Raw output must never become diagnostic data.
    }
    error.cause = { operation, stage: run.timedOut ? "timeout" : stage };
    throw error;
  }
  let result: unknown;
  try {
    result = JSON.parse(output) as unknown;
  } catch {
    throw failure();
  }
  if (!result || typeof result !== "object") throw failure();
  if ("value" in result && typeof result.value === "string")
    return result.value;
  if (operation === "read") throw failure();
  if (!("ok" in result) || result.ok !== true) throw failure();
  return undefined;
}
/**
 * Store an immutable macOS Keychain / Windows user-scoped DPAPI item. Only
 * references are persisted. The platform helper is started with `launcher`.
 */
export async function createSecret(
  value: string,
  launcher: ProcessLauncher,
): Promise<SecretReference> {
  if (
    !value.trim() ||
    Buffer.byteLength(value) > 8192 ||
    /[\r\n\0]/.test(value)
  )
    throw new HubError(
      "INVALID_SECRET",
      "Credential must be a non-empty single-line value up to 8 KiB",
    );
  const id = randomUUID();
  await keychain(launcher, "create", id, value);
  return { kind: "keychain", value: id };
}
/** Remove only an explicitly owned HarnessHub item, used by fixture cleanup. */
export async function deleteSecret(
  ref: SecretReference,
  launcher: ProcessLauncher,
): Promise<void> {
  if (ref.kind !== "keychain") throw failure();
  await keychain(launcher, "delete", ref.value);
}
/**
 * Resolve at execution/test time; callers own the in-memory value and must not
 * log it. Keychain references, and file references on Windows, are read by the
 * platform helper, which needs `launcher`; without one they fail with
 * PROCESS_LAUNCHER_NOT_INJECTED (500), a composition defect. Environment
 * references, and file references elsewhere, start no process.
 */
export async function resolveSecret(
  ref: SecretReference,
  environment: Readonly<NodeJS.ProcessEnv>,
  launcher?: ProcessLauncher,
): Promise<string> {
  let value: string | undefined;
  if (ref.kind === "env") {
    const names = Object.keys(environment).filter((name) =>
      process.platform === "win32"
        ? name.toUpperCase() === ref.value.toUpperCase()
        : name === ref.value,
    );
    const values = new Set(names.map((name) => environment[name]));
    if (values.size > 1) throw failure();
    value = environment[names[0] ?? ref.value];
  } else if (ref.kind === "keychain")
    value = await keychain(launcher, "read", ref.value);
  else {
    try {
      const info = await lstat(ref.value);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 8192 ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        throw failure();
      value =
        process.platform === "win32"
          ? (await keychain(launcher, "read-file", ref.value))?.trim()
          : (await readFile(ref.value, "utf8")).trim();
    } catch (error) {
      if (
        error instanceof HubError &&
        ["SECRET_UNAVAILABLE", "PROCESS_LAUNCHER_NOT_INJECTED"].includes(
          error.code,
        )
      )
        throw error;
      throw failure();
    }
  }
  if (!value || Buffer.byteLength(value) > 8192 || /[\r\n\0]/.test(value))
    throw failure();
  return value;
}
