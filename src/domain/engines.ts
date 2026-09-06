import type { EngineConfiguration } from "./engine-configuration.js";
import type { EngineProfile } from "./types.js";

/** Local executable registration. Commands are argv, never a shell expression. */
export interface EngineRegistration {
  id: string;
  driver: "acp" | "cli";
  command: string[];
  enabled?: boolean;
  model?: string;
  credentialEnv?: string[];
  configuration?: EngineConfiguration;
  maxConcurrency?: number;
  cli?: { inputMode?: "stdin" | "argv"; maxOutputBytes?: number };
  acp?: { sessionMode?: "resume"; initializeTimeoutMs?: number };
}

/** Discovery reports installation evidence only, never model authentication or task success. */
export interface EngineCandidate {
  id: string;
  name: string;
  executable: string;
  source: "path" | "known-location" | "manifest";
  status: "ready" | "adapter-required";
  registration?: EngineRegistration;
  notes: string[];
}

/** Runtime reads immutable revisions; replacing/removing a current engine preserves old revisions. */
export interface EngineCatalog {
  list(): EngineProfile[];
  resolve(id: string, revision?: string): EngineProfile;
  defaultId(): string;
}

/** Gateway owns management and persistence; discovery does not register or execute candidates. */
export interface EngineManagement extends EngineCatalog {
  register(input: unknown): Promise<EngineProfile>;
  remove(id: string): Promise<void>;
  setDefault(id: string): Promise<void>;
  discover(): Promise<EngineCandidate[]>;
  reload(): Promise<{ engines: number; defaultEngine: string }>;
  status(): {
    watching: boolean;
    lastReloadAt: number | null;
    lastError: string | null;
  };
  close(): Promise<void>;
}

/** Durable catalog snapshot shares the Gateway SQLite transaction owner. */
export interface EngineCatalogPersistence {
  readEngineCatalog(): unknown;
  writeEngineCatalog(value: unknown): void;
}
