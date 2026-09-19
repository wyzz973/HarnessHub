import type { EngineRegistration } from "../domain/engines.js";

/** Competition-only break-glass switch. Ordinary Gateway runs remain unchanged. */
export function fullAccessEnabled(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  return environment.HARNESSHUB_FULL_ACCESS === "1";
}

function boundary(command: string[]): number {
  const at = command.indexOf("--");
  if (at < 0)
    throw new Error("Bundled engine command is missing its launcher boundary");
  return at;
}

function setLauncherEnvironment(
  command: string[],
  name: string,
  value: string,
): void {
  let stop = boundary(command);
  const prefix = `${name}=`;
  const at = command.findIndex(
    (argument, index) => index < stop && argument.startsWith(prefix),
  );
  if (at >= 0) command[at] = `${prefix}${value}`;
  else {
    command.splice(stop, 0, `${prefix}${value}`);
    stop++;
  }
}

function appendEngineOption(
  command: string[],
  flag: string,
  value?: string,
): void {
  const stop = boundary(command);
  if (
    command
      .slice(stop + 1)
      .some((argument) => argument === flag || argument.startsWith(`${flag}=`))
  )
    return;
  command.push(flag);
  if (value !== undefined) command.push(value);
}

/**
 * Translate the one Competition full-access switch into native harness options.
 * ACP-level permission approval is handled separately by AcpDriver; this function
 * only removes harness-specific read-only/approval modes that would otherwise be
 * stricter than the ACP client. It never touches model, Provider or credential
 * settings, so the unified model registration (ADR 0013) is unaffected.
 */
export function applyFullAccessToRegistration(
  input: EngineRegistration,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): EngineRegistration {
  if (!fullAccessEnabled(environment)) return input;
  const command = [...input.command];
  const adapter = input.configuration?.adapter ?? "generic";
  switch (adapter) {
    case "codex":
      setLauncherEnvironment(
        command,
        "INITIAL_AGENT_MODE",
        "agent-full-access",
      );
      break;
    // OpenCode relies on ACP approve-all only. Injecting OPENCODE_PERMISSION="allow"
    // made fixed OpenCode fail Runs with driver_error (A/B: Safe 204, Full
    // driver_error, Full without the injection 204).
    case "gemini":
      setLauncherEnvironment(command, "GEMINI_CLI_TRUST_WORKSPACE", "true");
      appendEngineOption(command, "--approval-mode", "yolo");
      break;
    case "qwen":
      appendEngineOption(command, "--approval-mode", "yolo");
      break;
    // MiMo is not changed: `mimo acp` (fixed 0.1.14) rejects `--yolo` and exits
    // before ACP initialize, so it relies on ACP approve-all like OpenCode.
    case "hermes":
      setLauncherEnvironment(command, "HERMES_YOLO_MODE", "1");
      break;
    // OpenCode, MiMo, DSH, Pi and OpenClaw receive ACP approve-all. OpenClaw's
    // private exec policy is additionally widened by launch-openclaw-bundled.mjs.
    default:
      break;
  }
  return { ...input, command };
}
