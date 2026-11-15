import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";

/**
 * HarnessHub's own paired OpenClaw device (docs/gateway/protocol/auth.md): an Ed25519 key of the Hub's and the device token each Gateway issued
 * it, in one private file beside the relay key (`~/Library/Application Support/HarnessHub/openclaw-device.json`, 0600). Nothing of it is ever
 * written into OpenClaw's configuration. `HARNESSHUB_OPENCLAW_DEVICE` names another file (tests).
 */
export interface DeviceIdentity { readonly deviceId: string; readonly publicKeyPem: string; readonly privateKeyPem: string }
interface DeviceFile extends DeviceIdentity { readonly version: 1; readonly tokens: Record<string, { readonly token: string; readonly scopes: readonly string[] }> }

export function devicePath(env: Readonly<Record<string, string>>): string {
  return env.HARNESSHUB_OPENCLAW_DEVICE ?? join(env.HOME ?? homedir(), "Library", "Application Support", "HarnessHub", "openclaw-device.json");
}
const raw = (publicKeyPem: string): Buffer => createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }).subarray(12);
export function signPayload(privateKeyPem: string, payload: string): string { return sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString("base64url"); }
export function publicKeyRaw(publicKeyPem: string): string { return raw(publicKeyPem).toString("base64url"); }

export class DeviceStore {
  private writing: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string, private file: DeviceFile) {}
  /** The device of this path, made on first use: a new Ed25519 key whose id is the SHA-256 of its raw public key (OpenClaw's deriveDeviceIdFromPublicKey). */
  static async open(path: string): Promise<DeviceStore> {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 256 * 1024) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "the HarnessHub OpenClaw device file is invalid");
      const file = JSON.parse(await readFile(path, "utf8")) as DeviceFile;
      if (file.version !== 1 || typeof file.privateKeyPem !== "string" || typeof file.publicKeyPem !== "string" || createHash("sha256").update(raw(file.publicKeyPem)).digest("hex") !== file.deviceId)
        throw new ControlError("NATIVE_CONFIGURATION_INVALID", "the HarnessHub OpenClaw device file is invalid");
      return new DeviceStore(path, { ...file, tokens: file.tokens !== null && typeof file.tokens === "object" ? file.tokens : {} });
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error instanceof ControlError ? error : new ControlError("NATIVE_CONFIGURATION_INVALID", "the HarnessHub OpenClaw device file cannot be read");
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const store = new DeviceStore(path, { version: 1, deviceId: createHash("sha256").update(raw(publicKeyPem)).digest("hex"), publicKeyPem, privateKeyPem, tokens: {} });
    await store.save();
    return store;
  }
  get identity(): DeviceIdentity { return { deviceId: this.file.deviceId, publicKeyPem: this.file.publicKeyPem, privateKeyPem: this.file.privateKeyPem }; }
  token(url: string, role: string): { readonly token: string; readonly scopes: string[] } | null {
    const entry = this.file.tokens[url + "|" + role];
    return entry === undefined ? null : { token: entry.token, scopes: [...entry.scopes] };
  }
  store(url: string, role: string, token: string, scopes: readonly string[]): Promise<void> { this.file = { ...this.file, tokens: { ...this.file.tokens, [url + "|" + role]: { token, scopes: [...scopes] } } }; return this.save(); }
  clear(url: string, role: string): Promise<void> { const tokens = { ...this.file.tokens }; delete tokens[url + "|" + role]; this.file = { ...this.file, tokens }; return this.save(); }
  private save(): Promise<void> {
    const body = JSON.stringify(this.file, null, 2), path = this.path;
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = path + ".tmp-" + process.pid;
      await writeFile(temporary, body, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, path);
    });
    return this.writing;
  }
}

/** The local Gateway as its CLI finds it: `OPENCLAW_GATEWAY_PORT`, else `gateway.port` in the configuration, else 18789, on loopback; `HARNESSHUB_OPENCLAW_URL` for tests. */
export interface GatewayTarget { readonly url: string; sharedToken(): Promise<string | undefined> }
function configPath(env: Readonly<Record<string, string>>): string {
  return env.OPENCLAW_CONFIG_PATH ?? join(env.OPENCLAW_STATE_DIR ?? join(env.HOME ?? homedir(), ".openclaw"), "openclaw.json");
}
async function readConfig(env: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
  try {
    const path = configPath(env), info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return {};
    const value: unknown = JSON5.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
const field = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((at, key) => at !== null && typeof at === "object" && !Array.isArray(at) ? (at as Record<string, unknown>)[key] : undefined, value);
export async function gatewayTarget(env: Readonly<Record<string, string>>): Promise<GatewayTarget> {
  if (env.HARNESSHUB_OPENCLAW_URL) return { url: env.HARNESSHUB_OPENCLAW_URL, sharedToken: async () => env.OPENCLAW_GATEWAY_TOKEN || undefined };
  const config = await readConfig(env), port = Number(env.OPENCLAW_GATEWAY_PORT ?? field(config, "gateway", "port") ?? 18789);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "the OpenClaw Gateway port is invalid");
  // The shared Gateway token is read only for the first pairing of HarnessHub's device, held in memory for that connection, never logged.
  return { url: "ws://127.0.0.1:" + port, sharedToken: async () => { const token = env.OPENCLAW_GATEWAY_TOKEN || field(await readConfig(env), "gateway", "auth", "token"); return typeof token === "string" && token ? token : undefined; } };
}
