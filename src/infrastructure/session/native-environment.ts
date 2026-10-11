import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFile, stat } from "node:fs/promises";

/** Captured host profile. Values remain private and never enter Web/Session DTOs. */
export interface NativeEnvironment { readonly home: string; readonly values: Readonly<Record<string, string>> }
const piCredentialVariables = new Set(["COPILOT_GITHUB_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANT_LING_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "NVIDIA_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "RADIUS_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY", "HF_TOKEN", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "BASETEN_API_KEY", "OPENCODE_API_KEY", "KIMI_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"]);
export function captureNativeEnvironment(values: NodeJS.ProcessEnv = process.env): NativeEnvironment {
  const snapshot = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const home = snapshot.HOME ?? homedir();
  if (!isAbsolute(home) || home.includes("\0")) throw new Error("native HOME must be an absolute path");
  return { home, values: Object.freeze(snapshot) };
}
/** Explicit private profiles retain system transport/runtime variables, not another profile's credentials. */
export function nativeBaseValues(source: NativeEnvironment, explicitHome: string | null, harness = ""): Readonly<Record<string, string>> {
  const allowed = /^(PATH|LANG|LC_[A-Z_]+|SHELL|USER|LOGNAME|TERM|TMPDIR|TMP|TEMP|SystemRoot|SYSTEMROOT|COMSPEC|PATHEXT|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/u;
  const prefixes = harness === "codex" ? ["CODEX_", "OPENAI_", "AWS_", "BEDROCK_"] : harness === "gemini" ? ["GEMINI_", "GOOGLE_", "GCLOUD_", "VERTEX_"]
    : harness.startsWith("claude") ? ["CLAUDE_", "ANTHROPIC_"]
    : [harness.toUpperCase().replaceAll("-", "_") + "_"];
  return Object.fromEntries(Object.entries(source.values).filter(([name]) => allowed.test(name) || explicitHome === null &&
    (name === "HOME" || name.startsWith("XDG_") || prefixes.some(prefix => name.startsWith(prefix)) || harness === "pi" && piCredentialVariables.has(name))));
}
/** Native config may explicitly reference custom credential environment names; only those names are added. */
export async function referencedNativeValues(source: NativeEnvironment, explicitHome: string | null, harness: string, workspace: string): Promise<Readonly<Record<string, string>>> {
  const result = { ...nativeBaseValues(source, explicitHome, harness) };
  if (explicitHome !== null) return result;
  const configRoot = source.values.XDG_CONFIG_HOME ?? join(source.home, ".config");
  const files = harness === "codex" ? [join(source.values.CODEX_HOME ?? join(source.home, ".codex"), "config.toml"), join(workspace, ".codex", "config.toml")]
    : harness === "opencode" ? [join(source.values.OPENCODE_CONFIG_DIR ?? join(configRoot, "opencode"), "opencode.json"), join(source.values.OPENCODE_CONFIG_DIR ?? join(configRoot, "opencode"), "opencode.jsonc"), join(workspace, "opencode.json"), join(workspace, "opencode.jsonc")]
    : harness === "pi" ? [join(source.values.PI_CODING_AGENT_DIR ?? join(source.home, ".pi", "agent"), "models.json"), join(source.values.PI_CODING_AGENT_DIR ?? join(source.home, ".pi", "agent"), "auth.json")]
    : harness === "openclaw" ? [source.values.OPENCLAW_CONFIG_PATH ?? join(source.values.OPENCLAW_STATE_DIR ?? join(source.home, ".openclaw"), "openclaw.json")]
    : [];
  for (const file of files) {
    let input: string;
    try {
      const info = await stat(file); if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("native config is not a bounded regular file");
      input = await readFile(file, "utf8"); if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error("native config grew beyond its budget");
    } catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
    const patterns = [/\benv_key\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gu, /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, harness === "pi" ? /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu : /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, ...(harness === "pi" ? [/(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)/gu] : [])];
    for (const pattern of patterns) for (const match of input.matchAll(pattern)) {
      const name = match[1]; if (name && source.values[name] !== undefined) result[name] = source.values[name];
    }
  }
  return result;
}
/** Explicit fixture/profile roots replace home-shaped variables; native defaults use the host as-is. */
export function nativeValues(source: NativeEnvironment, explicitHome: string | null): Record<string, string> {
  if (explicitHome === null) return { HOME: source.home,
    XDG_CONFIG_HOME: source.values.XDG_CONFIG_HOME ?? join(source.home, ".config"), XDG_DATA_HOME: source.values.XDG_DATA_HOME ?? join(source.home, ".local", "share"),
    XDG_STATE_HOME: source.values.XDG_STATE_HOME ?? join(source.home, ".local", "state"), XDG_CACHE_HOME: source.values.XDG_CACHE_HOME ?? join(source.home, ".cache"),
    CODEX_HOME: source.values.CODEX_HOME ?? join(source.home, ".codex"), ...(source.values.CLAUDE_CONFIG_DIR === undefined ? {} : { CLAUDE_CONFIG_DIR: source.values.CLAUDE_CONFIG_DIR }),
    OPENCODE_CONFIG_DIR: source.values.OPENCODE_CONFIG_DIR ?? join(source.values.XDG_CONFIG_HOME ?? join(source.home, ".config"), "opencode"),
    OPENCLAW_CONFIG_PATH: source.values.OPENCLAW_CONFIG_PATH ?? join(source.values.OPENCLAW_STATE_DIR ?? join(source.home, ".openclaw"), "openclaw.json") };
  return { HOME: explicitHome, XDG_CONFIG_HOME: join(explicitHome, "config"), XDG_DATA_HOME: join(explicitHome, "data"),
    XDG_STATE_HOME: join(explicitHome, "state"), XDG_CACHE_HOME: join(explicitHome, "cache"), CODEX_HOME: join(explicitHome, "codex"),
    CLAUDE_CONFIG_DIR: join(explicitHome, "claude"), OPENCODE_CONFIG_DIR: join(explicitHome, "opencode"),
    OPENCLAW_CONFIG_PATH: join(explicitHome, ".openclaw", "openclaw.json") };
}
/** Profile-location variables a native program resolves for itself when they are unset. */
const PROFILE_VARIABLES = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "OPENCLAW_CONFIG_PATH"] as const;
/**
 * Child-process profile variables. Native mode passes exactly what the user's environment sets: a synthesized default
 * is not equivalent for every program (Cursor resolves $XDG_CONFIG_HOME/cursor before ~/.cursor; Claude keeps
 * .claude.json outside an overridden config directory). Explicit private profiles keep their isolated layout.
 * Hub-side path lookups use nativeValues(), which may resolve defaults without exporting them.
 */
export function nativeLaunchValues(source: NativeEnvironment, explicitHome: string | null): Record<string, string> {
  if (explicitHome !== null) return nativeValues(source, explicitHome);
  return { HOME: source.home, ...Object.fromEntries(PROFILE_VARIABLES.flatMap(name => { const value = source.values[name]; return value === undefined ? [] : [[name, value] as const]; })) };
}
/** A catalog descriptor cannot redirect the user's native profile: unset profile variables stay unset. */
export function nativeDescriptorValues(source: NativeEnvironment, explicitHome: string | null, descriptor: Readonly<Record<string, string>>): Record<string, string> {
  const values = { ...descriptor, ...nativeLaunchValues(source, explicitHome) };
  if (explicitHome === null) for (const name of PROFILE_VARIABLES) if (source.values[name] === undefined) delete values[name];
  return values;
}
