import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SecretReference } from "../../domain/engine-configuration.js";
import { HubError } from "../../domain/errors.js";
function failure(): HubError {
  return new HubError(
    "SECRET_UNAVAILABLE",
    "The credential reference is missing, locked or unreadable",
    400,
  );
}
async function keychain(
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
  const executable = fileURLToPath(
    new URL(
      process.platform === "win32"
        ? "../../../native/harnesshub-secrets.exe"
        : "../../../native/harnesshub-keychain",
      import.meta.url,
    ),
  );
  const child = spawn(executable, [], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let output = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 5000);
  try {
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", () => reject(failure()));
      child.once("close", resolve);
      child.stdout.on("data", (data: string) => {
        output += data;
        if (Buffer.byteLength(output) > 32768) child.kill("SIGKILL");
      });
      child.stdin.on("error", () => {
        /* exit/error settles the operation */
      });
    });
    child.stdin.end(
      JSON.stringify({
        operation,
        id,
        ...(value === undefined ? {} : { value }),
      }),
    );
    if ((await completion) !== 0) {
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
      error.cause = { operation, stage: timedOut ? "timeout" : stage };
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
  } finally {
    clearTimeout(timeout);
  }
}
/** Store an immutable macOS Keychain / Windows user-scoped DPAPI item. Only references are persisted. */
export async function createSecret(value: string): Promise<SecretReference> {
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
  await keychain("create", id, value);
  return { kind: "keychain", value: id };
}
/** Remove only an explicitly owned HarnessHub item, used by fixture cleanup. */
export async function deleteSecret(ref: SecretReference): Promise<void> {
  if (ref.kind !== "keychain") throw failure();
  await keychain("delete", ref.value);
}
/** Resolve at execution/test time; callers own the in-memory value and must not log it. */
export async function resolveSecret(
  ref: SecretReference,
  environment: Readonly<NodeJS.ProcessEnv>,
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
  } else if (ref.kind === "keychain") value = await keychain("read", ref.value);
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
          ? (await keychain("read-file", ref.value))?.trim()
          : (await readFile(ref.value, "utf8")).trim();
    } catch (error) {
      if (error instanceof HubError && error.code === "SECRET_UNAVAILABLE")
        throw error;
      throw failure();
    }
  }
  if (!value || Buffer.byteLength(value) > 8192 || /[\r\n\0]/.test(value))
    throw failure();
  return value;
}
