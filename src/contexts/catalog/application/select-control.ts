import { DiscoveryInputError } from "../domain/discovery.js";
import type { ControlObservation } from "../domain/catalog.js";

export function chooseControl(controls: readonly ControlObservation[], id?: string): ControlObservation {
  if (id !== undefined) {
    const explicit = controls.find((item) => item.id === id);
    if (explicit === undefined) throw new DiscoveryInputError("unknown control for this Harness: " + id);
    if (explicit.state !== "candidate" || explicit.command === null)
      throw new DiscoveryInputError("selected control is unavailable: " + id + " (" + explicit.state + ")");
    return explicit;
  }
  const available = controls.filter((item) => item.state === "candidate");
  if (available.length !== 1) throw new DiscoveryInputError(available.length === 0
    ? "no available control; use discover to inspect missing dependencies"
    : "multiple available controls; specify --control explicitly");
  return available[0]!;
}
