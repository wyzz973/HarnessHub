import type { ControlObservation } from "../contexts/catalog/domain/catalog.js";
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
