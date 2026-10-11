import { DiscoveryInputError } from "../domain/discovery.js";
import { validateDefinitions } from "../domain/catalog-parser.js";
import type {
  CatalogManifest, ConfigurationLocator, ControlObservation, HarnessDefinition,
  HarnessInventory, InstallationEnumerator, InventoryReport, LocalPackageResolver,
  ResolvedCommand,
} from "../domain/catalog.js";

/** Inventory observes entries and dependencies; it does not initialize or launch a Harness. */
export class DiscoverInventory {
  constructor(
    private readonly installations: InstallationEnumerator,
    private readonly packages: LocalPackageResolver,
    private readonly configurations: ConfigurationLocator,
    private readonly now: () => Date,
  ) {}

  async execute(
    definitions: readonly HarnessDefinition[],
    overrides: CatalogManifest["overrides"] = new Map(),
    installationOverrides: CatalogManifest["installationOverrides"] = new Map(),
  ): Promise<InventoryReport> {
    validateDefinitions(definitions);
    const knownControls = new Set(definitions.flatMap((item) => item.controls.map((control) => control.id)));
    for (const [id, override] of overrides) {
      if (!knownControls.has(id)) throw new DiscoveryInputError("unknown control override: " + id);
      this.installations.validateOverride(override.executable);
    }
    for (const [id, path] of installationOverrides) {
      if (!definitions.some((item) => item.id === id)) throw new DiscoveryInputError("unknown installation override: " + id);
      this.installations.validateOverride(path);
    }
    const harnesses: HarnessInventory[] = [];
    // Batches bound concurrent filesystem work while preserving catalog ordering.
    for (let offset = 0; offset < definitions.length; offset += 8) {
      const pending = definitions.slice(offset, offset + 8).map(async (definition): Promise<HarnessInventory> => {
        const installation = await this.installations.enumerate(definition.binaryNames, installationOverrides.get(definition.id));
        const configuration = await this.configurations.observe(definition.configHints);
        const controls: ControlObservation[] = [];
        for (const recipe of definition.controls) {
          const explicit = overrides.get(recipe.id);
          const entry = await this.installations.enumerate(recipe.executableNames, explicit?.executable);
          const diagnostics = [...entry.diagnostics];
          // The installed package behind a found entry reports its own version from metadata; nothing is run.
          if (entry.selected !== null && recipe.package !== null) diagnostics.push(...await this.packages.observe(recipe.package, entry.selected.resolvedPath));
          let command: ResolvedCommand | null = entry.selected === null ? null : {
            executable: entry.selected.path, args: [...recipe.args], env: { ...recipe.env },
          };
          if (command === null && entry.defaultResolution !== "blocked" && explicit === undefined && recipe.package !== null) {
            const local = await this.packages.resolve(recipe.package);
            diagnostics.push(...local.diagnostics);
            if (local.command !== null) command = {
              executable: local.command.executable,
              args: [...local.command.args, ...recipe.args],
              env: { ...local.command.env, ...recipe.env },
            };
          }
          const missingDependencies: string[] = [];
          let blocked = entry.defaultResolution === "blocked";
          for (const required of recipe.requiredExecutables) {
            const dependency = await this.installations.enumerate(
              [required], definition.binaryNames.includes(required) ? installationOverrides.get(definition.id) : undefined,
            );
            if (dependency.selected === null) missingDependencies.push(required);
            if (dependency.defaultResolution === "blocked") blocked = true;
          }
          if (command === null) missingDependencies.push(recipe.package?.name ?? recipe.executableNames[0] ?? recipe.id);
          if (blocked || missingDependencies.length > 0) command = null;
          controls.push({
            id: recipe.id, protocol: recipe.protocol, source: recipe.source,
            state: blocked ? "blocked" : command === null ? "missing_dependency" : "candidate",
            command, installation: entry, missingDependencies, diagnostics, probe: "not_run",
          });
        }
        return { id: definition.id, name: definition.name, aliases: definition.aliases, installation, configuration, controls };
      });
      const completed = await Promise.allSettled(pending);
      for (const result of completed) {
        if (result.status === "rejected") throw result.reason;
        harnesses.push(result.value);
      }
    }
    return { schemaVersion: 2, observedAt: this.now().toISOString(), protocolProbesRun: 0, harnesses };
  }
}
