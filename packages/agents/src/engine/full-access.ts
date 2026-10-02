// SPDX-License-Identifier: MIT
/**
 * Break-glass switch for unattended Runs. When `HARNESSHUB_FULL_ACCESS=1`, ACP
 * permission requests are approved by the client instead of waiting for a person.
 * It never changes model, Provider or credential settings.
 */
export function fullAccessEnabled(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  return environment.HARNESSHUB_FULL_ACCESS === "1";
}
