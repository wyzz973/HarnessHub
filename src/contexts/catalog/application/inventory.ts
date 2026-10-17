import { DiscoveryInputError } from "../domain/discovery.js";
import { validateDefinitions } from "../domain/catalog-parser.js";
import type {
  CatalogManifest, ChannelRegistry, ClassifiedCandidate, ConfigurationLocator, ControlObservation, ControlRecipe, HarnessDefinition,
  HarnessInventory, InstallationCandidate, InstallationClassifier, InstallationEnumeration, InstallationEnumerator, InstallationPolicy,
  InventoryReport, LocalPackageResolver, ObservedInstallations, ResolvedCommand,
} from "../domain/catalog.js";
import type { OfficialChannels } from "../domain/channels.js";

/** How found programs are classified into official channels, and which of them count as installations (ADR-044). */
export interface ChannelPolicy {
  readonly classifier: InstallationClassifier;
  readonly registry: ChannelRegistry;
  readonly policy: InstallationPolicy;
}

/** Inventory observes entries and dependencies; it does not initialize or launch a Harness. */
export class DiscoverInventory {
  constructor(
    private readonly installations: InstallationEnumerator,
    private readonly packages: LocalPackageResolver,
    private readonly configurations: ConfigurationLocator,
    private readonly now: () => Date,
    private readonly channels: ChannelPolicy,
  ) {
    if (channels.policy !== "official" && channels.policy !== "any") throw new DiscoveryInputError("installation policy must be official or any");
  }

  /** The channel and role of one found program: the product's channels first, then the adapters' that name it. */
  private async classify(definition: HarnessDefinition, candidate: InstallationCandidate, adapters: readonly ControlRecipe[]): Promise<Pick<ClassifiedCandidate, "channel" | "version" | "role">> {
    const product = this.channels.registry.product(definition.id);
    const found = product === null ? null : await this.channels.classifier.classify(candidate, product);
    if (found !== null) return { ...found, role: "product" };
    const names = new Set(candidate.entries.map(entry => entry.name));
    const named = adapters.filter(control => control.executableNames.some(name => names.has(name)));
    for (const control of named) {
      const channels = this.channels.registry.adapter(definition.id, control);
      const adapter = channels === null ? null : await this.channels.classifier.classify(candidate, channels);
      if (adapter !== null) return { ...adapter, role: "adapter" };
    }
    return { channel: null, version: null, role: named.length > 0 && !names.has(definition.binaryNames[0] ?? "") ? "adapter" : "product" };
  }

  /**
   * Applies the policy to one enumeration. Under `official`, programs outside every channel are left out, and the first
   * official candidate in search order (PATH first) is selected when the PATH default is not official; a blocked default
   * still selects nothing. An explicit entry outside every channel is left out too: entries are a development choice.
   */
  private async observe(definition: HarnessDefinition, enumeration: InstallationEnumeration, adapters: readonly ControlRecipe[]): Promise<ObservedInstallations> {
    const classified: ClassifiedCandidate[] = await Promise.all(enumeration.candidates.map(async candidate => ({ ...candidate, ...await this.classify(definition, candidate, adapters) })));
    const admitted = (candidate: ClassifiedCandidate) => this.channels.policy === "any" || candidate.channel !== null;
    const candidates = classified.filter(admitted);
    const unofficial = enumeration.candidates.filter((_, index) => !admitted(classified[index]!));
    const prior = enumeration.selected === null ? undefined : candidates.find(candidate => candidate.resolvedPath === enumeration.selected!.resolvedPath);
    const selected = enumeration.defaultResolution === "blocked" ? null : prior ?? candidates[0] ?? null;
    const unofficialDefault = enumeration.defaultResolution === "located" ? unofficial.find(candidate => candidate.resolvedPath === enumeration.selected?.resolvedPath) ?? null : null;
    return { ...enumeration, candidates, selected, unofficial, unofficialDefault };
  }

  /** Whether a package resolved from an explicit package root counts under the policy. */
  private async admitsPackage(command: ResolvedCommand, channels: OfficialChannels | null): Promise<boolean> {
    if (this.channels.policy === "any") return true;
    if (channels === null) return false;
    const program = command.args[0] !== undefined && command.args[0].startsWith("/") ? command.args[0] : command.executable;
    return await this.channels.classifier.classify({ path: program, resolvedPath: program, source: "local-package", entries: [] }, channels) !== null;
  }

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
        // A control runs the product itself when it starts the product's first command; any other control is an adapter.
        const product = definition.binaryNames[0];
        const adapters = definition.controls.filter(control => product === undefined || !control.executableNames.includes(product));
        const installation = await this.observe(definition, await this.installations.enumerate(definition.binaryNames, installationOverrides.get(definition.id)), adapters);
        const configuration = await this.configurations.observe(definition.configHints);
        const controls: ControlObservation[] = [];
        for (const recipe of definition.controls) {
          const explicit = overrides.get(recipe.id);
          const isAdapter = adapters.includes(recipe);
          const entry = await this.observe(definition, await this.installations.enumerate(recipe.executableNames, explicit?.executable), isAdapter ? [recipe] : []);
          const diagnostics = [...entry.diagnostics];
          // The installed package behind a found entry reports its own version from metadata; nothing is run.
          if (entry.selected !== null && recipe.package !== null) diagnostics.push(...await this.packages.observe(recipe.package, entry.selected.resolvedPath));
          let command: ResolvedCommand | null = entry.selected === null ? null : {
            executable: entry.selected.path, args: [...recipe.args], env: { ...recipe.env },
          };
          if (command === null && entry.defaultResolution !== "blocked" && explicit === undefined && recipe.package !== null) {
            const local = await this.packages.resolve(recipe.package);
            diagnostics.push(...local.diagnostics);
            const channels = isAdapter ? this.channels.registry.adapter(definition.id, recipe) : this.channels.registry.product(definition.id);
            if (local.command !== null && await this.admitsPackage(local.command, channels)) command = {
              executable: local.command.executable,
              args: [...local.command.args, ...recipe.args],
              env: { ...local.command.env, ...recipe.env },
            };
          }
          const missingDependencies: string[] = [];
          let blocked = entry.defaultResolution === "blocked";
          for (const required of recipe.requiredExecutables) {
            const dependency = await this.observe(definition, await this.installations.enumerate(
              [required], definition.binaryNames.includes(required) ? installationOverrides.get(definition.id) : undefined,
            ), adapters);
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
