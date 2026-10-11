import type { ControlObservation, InstallationEnumeration, ResolvedCommand } from "../contexts/catalog/domain/catalog.js";
import type { HarnessView } from "../contracts/web.js";

/**
 * Where a control entry was found, in the terms comparable products use: on PATH, in a standard installation directory,
 * as the user's explicit custom entry from the discovery manifest, in an explicit package root, or as a HarnessHub-managed
 * installation. Only the kind of source leaves the Gateway; the path stays private like every other command detail.
 * Returns null when no usable entry was found.
 */
export function harnessEntry(control: ControlObservation, managed: boolean): HarnessView["controls"][number]["entry"] {
  if (managed) return { source: "managed" };
  const selected = control.installation.selected;
  if (selected) {
    switch (selected.source) {
      case "override": return { source: "custom-entry" };
      case "path": return { source: "path" };
      case "managed": return { source: "managed" };
      case "local-package": return { source: "package-root" };
      case "configured-directory": case "known-directory": case "manager-directory": return { source: "standard-directory" };
    }
  }
  // A package found in an explicit package root runs through Node from the package's own bin.
  return control.command !== null ? { source: "package-root" } : null;
}

/**
 * The product's own command when the control entry is a different program in front of it: Claude Code's `claude` behind
 * the claude-agent-acp adapter. `product` is the product's first binary name; the installation is the enumeration of the
 * product's binaries. Returns null when the entry is the product itself or the product command was not found; the
 * product's version is then the entry's version.
 */
export function productCommand(product: string | undefined, installation: InstallationEnumeration, control: ControlObservation): ResolvedCommand | null {
  if (product === undefined || control.command === null) return null;
  const candidate = installation.candidates.find(item => item.entries.some(entry => entry.name === product));
  if (candidate === undefined) return null;
  const entry = control.installation.selected;
  if (entry !== null && (entry.resolvedPath === candidate.resolvedPath || entry.path === candidate.path)) return null;
  if (control.command.args.includes(candidate.resolvedPath)) return null;
  return { executable: candidate.path, args: [], env: { ...control.command.env } };
}
