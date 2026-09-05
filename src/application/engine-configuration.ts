import type { ConfigurationManagement } from "../domain/engine-configuration.js";
/** Configuration operations use injected platform/adapter functions, separate from business execution. */
export class EngineConfigurationService implements ConfigurationManagement {
  constructor(private readonly operations: ConfigurationManagement) {}
  templates() {
    return this.operations.templates();
  }
  inspect(input: unknown) {
    return this.operations.inspect(input);
  }
  test(id: string) {
    return this.operations.test(id);
  }
  createSecret(value: string) {
    return this.operations.createSecret(value);
  }
  adapters() {
    return this.operations.adapters();
  }
}
