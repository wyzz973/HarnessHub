import {
  DiscoveryInputError,
  type ExecutableLocator,
  type ExecutableOverride,
  type HarnessObservation,
  type HarnessRecipe,
  validateRecipes,
} from "../domain/discovery.js";

/** One inventory application service; future entry points can reuse the same filesystem port. */
export class DiscoverHarnesses {
  constructor(
    private readonly locator: ExecutableLocator,
    private readonly now: () => Date,
  ) {}

  async execute(
    recipes: readonly HarnessRecipe[],
    overrides: ReadonlyMap<string, ExecutableOverride> = new Map(),
  ): Promise<{
    readonly schemaVersion: 1;
    readonly observedAt: string;
    readonly protocolProbesRun: 0;
    readonly harnesses: readonly HarnessObservation[];
  }> {
    validateRecipes(recipes);
    for (const [id, override] of overrides) {
      const recipe = recipes.find((item) => item.id === id);
      if (!recipe) throw new DiscoveryInputError("override names an unknown Harness: " + id);
      if (override.adapter !== undefined && recipe.adapterBinary === undefined)
        throw new DiscoveryInputError("this Harness has no external adapter: " + id);
      if (override.binary !== undefined) this.locator.validateOverride(override.binary);
      if (override.adapter !== undefined) this.locator.validateOverride(override.adapter);
    }
    const harnesses = await Promise.all(
      recipes.map(async (recipe): Promise<HarnessObservation> => {
        const override = overrides.get(recipe.id);
        const installation = await this.locator.lookup(recipe.binary, override?.binary);
        if (installation.status !== "found" && recipe.nativeRequired !== false)
          return {
            id: recipe.id,
            name: recipe.name,
            installation,
            control: {
              protocol: recipe.protocol,
              state: "harness_missing",
              command: null,
              adapter: null,
              probe: "not_run",
            },
          };
        const adapter = recipe.adapterBinary
          ? await this.locator.lookup(recipe.adapterBinary, override?.adapter)
          : null;
        const executable =
          adapter?.status === "found"
            ? adapter.path
            : installation.status === "found"
              ? installation.path
              : undefined;
        return {
          id: recipe.id,
          name: recipe.name,
          installation,
          control: {
            protocol: recipe.protocol,
            state:
              adapter !== null && adapter.status !== "found"
                ? installation.status === "found" ? "adapter_missing" : "harness_missing"
                : "candidate",
            command:
              executable === undefined || (adapter !== null && adapter.status !== "found")
                ? null
                : { executable, args: [...recipe.args] },
            adapter,
            probe: "not_run",
          },
        };
      }),
    );
    return { schemaVersion: 1, observedAt: this.now().toISOString(), protocolProbesRun: 0, harnesses };
  }
}
