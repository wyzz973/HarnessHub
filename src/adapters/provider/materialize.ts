import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ProviderError, type ProviderTarget, type ProviderView } from "../../contracts/provider.js";
import { assertProviderCompatibility } from "../../contexts/provider/domain/provider.js";

export const PROVIDER_KEY_ENV = "HARNESS_GATEWAY_PROVIDER_KEY";
async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new ProviderError("INVALID_CONFIGURATION", "managed Provider configuration must use a private directory");
}
/** The caller owns the fresh private home and its deletion. No key is written to configuration files. */
export async function materializeProvider(view: ProviderView, target: ProviderTarget, harnessId: string,
  home: string, secret: string | null): Promise<Readonly<Record<string, string>>> {
  const product = assertProviderCompatibility(view.protocol, harnessId);
  if (product === "gemini" && secret === null) throw new ProviderError("CREDENTIAL_REQUIRED", "Gemini managed Provider execution requires an API key");
  if (!isAbsolute(home) || home.length > 4096 || /[\0\r\n]/u.test(home)) throw new ProviderError("INVALID_CONFIGURATION", "managed Provider home must be absolute");
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || await realpath(home) !== home)
    throw new ProviderError("INVALID_CONFIGURATION", "managed Provider home must be a canonical private directory");
  switch (product) {
    case "codex": {
      const directory = join(home, "codex"); await ownedDirectory(directory);
      // JSON quoting is compatible with the deliberately bounded TOML basic string inputs.
      const config = ["model = " + JSON.stringify(target.model), 'model_provider = "harnessgateway"', 'web_search = "disabled"',
        '[features]', 'shell_tool = false', 'unified_exec = false', 'shell_snapshot = false', 'skill_mcp_dependency_install = false',
        '[model_providers.harnessgateway]', 'name = "HarnessGateway managed Provider"', "base_url = " + JSON.stringify(view.baseUrl),
        'wire_api = "responses"', ...(secret === null ? [] : ['env_key = "' + PROVIDER_KEY_ENV + '"']),
        'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0',
        'stream_idle_timeout_ms = 10000', ""].join("\n");
      await writeFile(join(directory, "config.toml"), config, { flag: "wx", mode: 0o600 });
      return { CODEX_HOME: directory, ...(secret === null ? {} : { [PROVIDER_KEY_ENV]: secret }) };
    }
    case "gemini": {
      const directory = join(home, "gemini"); await ownedDirectory(directory);
      const settings = join(directory, "settings.json"), defaults = join(directory, "system-defaults.json");
      await writeFile(settings, JSON.stringify({ security: { auth: { selectedType: "gemini-api-key", enforcedType: "gemini-api-key" } },
        model: { name: target.model }, telemetry: { enabled: false }, general: { enableAutoUpdate: false } }) + "\n", { flag: "wx", mode: 0o600 });
      await writeFile(defaults, "{}\n", { flag: "wx", mode: 0o600 });
      if (secret === null) throw new ProviderError("CREDENTIAL_REQUIRED", "Gemini managed Provider execution requires an API key");
      return { GEMINI_API_KEY: secret, GOOGLE_GEMINI_BASE_URL: view.baseUrl, GEMINI_MODEL: target.model,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults };
    }
  }
}
