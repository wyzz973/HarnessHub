// SPDX-License-Identifier: MIT
/**
 * Allowlisted environments for development tools that must not see the
 * developer's shell (tests, the console build). Names compare case-insensitively,
 * as on Windows; values keep the parent's spelling of the name.
 */

/** System variables a child tool may inherit: locale, terminal, and what Windows needs to start programs. */
export const SYSTEM_VARIABLES = Object.freeze([
  // Shared
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "USER",
  "LOGNAME",
  "SHELL",
  // Windows
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "SYSTEMDRIVE",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "PSMODULEPATH",
]);

/**
 * Copy the allowed variables from a parent environment.
 *
 * @param {Record<string, string | undefined>} parent
 * @param {{names?: readonly string[], patterns?: readonly RegExp[]}} [allow] Extra
 *   names and name patterns allowed besides SYSTEM_VARIABLES.
 * @returns {{env: Record<string, string>, dropped: Record<string, string>}} The
 *   allowed variables, and the rest, which callers may scan for in their output.
 */
export function pickEnvironment(parent, { names = [], patterns = [] } = {}) {
  const allowed = new Set([...SYSTEM_VARIABLES, ...names].map((name) => name.toUpperCase()));
  const env = {};
  const dropped = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (allowed.has(name.toUpperCase()) || patterns.some((pattern) => pattern.test(name))) env[name] = value;
    else dropped[name] = value;
  }
  return { env, dropped };
}

/**
 * Set variables, replacing any existing spelling of the same name.
 *
 * @param {Record<string, string>} env Modified in place.
 * @param {Record<string, string>} values
 */
export function assignEnvironment(env, values) {
  for (const [name, value] of Object.entries(values)) {
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
    env[name] = value;
  }
  return env;
}
