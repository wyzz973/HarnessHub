// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import { MAX_SEALED_BYTES } from "../backup-envelope.js";
import type { BackupService } from "../backup.js";
import type { SyncService } from "../sync.js";
import { emptyBodySchema, quotaSchema, responses } from "./api-v1-schemas.js";

const text = (maxLength: number) =>
  ({ type: "string", minLength: 1, maxLength }) as const;
const strings = { type: "array", items: { type: "string" } } as const;
const passphrase = {
  ...text(1024),
  description:
    "Seals and opens the backup; it is never stored by a backup or a restore",
} as const;

/** The sealed file: a JSON envelope (docs/backup-sync.md). */
const envelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["format", "version", "kdf", "iterations", "salt", "nonce", "data"],
  properties: {
    format: { type: "string", enum: ["harnesshub-backup"] },
    version: { type: "integer" },
    kdf: { type: "string" },
    iterations: { type: "integer" },
    salt: { type: "string", description: "base64" },
    nonce: { type: "string", description: "base64" },
    data: {
      type: "string",
      description: "base64 of the AES-256-GCM ciphertext and its 16-byte tag",
    },
  },
} as const;

const backupBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["passphrase"],
  properties: {
    passphrase,
    keys: {
      type: "boolean",
      default: true,
      description: "Include the values of stored credentials",
    },
  },
} as const;

const restoreBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["backup", "passphrase"],
  properties: {
    backup: {
      type: "object",
      description: "The sealed file as parsed JSON; checked when opened",
    },
    passphrase,
    agents: {
      type: "boolean",
      default: true,
      description: "Re-wire the agents installed here",
    },
    library: {
      type: "boolean",
      default: true,
      description:
        "Bring the Library's items in (agents' files are synced separately, through /library/sync)",
    },
    references: {
      type: "boolean",
      default: false,
      description:
        "Confirms restoring the credentials listed in providers.references, whose keys are read from outside HarnessHub's store; without it such a restore is refused with 409 BACKUP_REFERENCES",
    },
    dryRun: {
      type: "boolean",
      default: false,
      description: "Only show what the restore would do",
    },
  },
} as const;

const referenceKind = {
  type: "string",
  enum: ["env", "file", "keychain"],
} as const;

const shareSettings = {
  type: "object",
  additionalProperties: false,
  required: ["lan"],
  properties: {
    lan: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "names"],
      properties: {
        enabled: { type: "boolean" },
        host: { type: "string" },
        port: { type: "integer" },
        names: strings,
      },
    },
    publicBaseUrl: { type: "string" },
  },
} as const;
const catalogSettings = {
  type: "object",
  additionalProperties: false,
  required: ["autoRefresh", "url"],
  properties: { autoRefresh: { type: "boolean" }, url: { type: "string" } },
} as const;

const changes = {
  type: "object",
  additionalProperties: false,
  required: ["added", "replaced", "removed"],
  properties: { added: strings, replaced: strings, removed: strings },
} as const;

const restoreSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "createdAt",
    "app",
    "keys",
    "providers",
    "groups",
    "overrides",
    "profiles",
    "library",
    "gatewayFeatures",
    "gatewayShare",
    "catalog",
    "agents",
    "clientKeys",
  ],
  properties: {
    createdAt: { type: "string" },
    app: { type: "string" },
    keys: { type: "boolean" },
    providers: {
      type: "object",
      additionalProperties: false,
      required: [
        "added",
        "replaced",
        "needKey",
        "signInAgain",
        "signedInHere",
        "references",
        "refused",
      ],
      properties: {
        added: strings,
        replaced: strings,
        needKey: strings,
        signInAgain: strings,
        signedInHere: strings,
        references: {
          type: "array",
          description:
            "Credentials whose key would be read from an environment variable, a file or a keychain item and sent to the provider's hosts; those read the same way here already are not listed",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "credential", "kind", "name", "hosts"],
            properties: {
              provider: { type: "string" },
              credential: { type: "string" },
              kind: referenceKind,
              name: { type: "string" },
              hosts: strings,
            },
          },
        },
        refused: {
          type: "array",
          description:
            "Credentials naming HarnessHub's own variables or files: never restored",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "credential", "kind", "name", "reason"],
            properties: {
              provider: { type: "string" },
              credential: { type: "string" },
              kind: referenceKind,
              name: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
    },
    groups: {
      type: "object",
      additionalProperties: false,
      required: ["added", "replaced", "skipped"],
      properties: { added: strings, replaced: strings, skipped: strings },
    },
    overrides: { type: "integer" },
    profiles: {
      type: "object",
      additionalProperties: false,
      required: ["added", "replaced"],
      properties: { added: strings, replaced: strings },
    },
    library: {
      type: "object",
      nullable: true,
      description:
        "The Library's items brought in; null when the backup has none or library is false",
      additionalProperties: false,
      required: ["instructions", "mcp", "skills", "refused"],
      properties: {
        instructions: changes,
        mcp: {
          type: "object",
          additionalProperties: false,
          required: ["added", "replaced", "removed", "needSecret"],
          properties: {
            ...changes.properties,
            needSecret: {
              ...strings,
              description:
                "server: NAME of stored secrets with no value in the backup or here; left out",
            },
          },
        },
        skills: {
          type: "object",
          additionalProperties: false,
          required: ["added", "replaced", "removed", "incomplete"],
          properties: {
            ...changes.properties,
            incomplete: {
              ...strings,
              description:
                "Skills brought in without files left out of the backup (over 2 MiB)",
            },
          },
        },
        refused: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "name", "reason"],
            properties: {
              kind: { type: "string", enum: ["instructions", "mcp", "skills"] },
              name: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
    },
    gatewayFeatures: {
      type: "object",
      nullable: true,
      description:
        "Redaction, the vision model, the search backends and the usage alert brought in; null when the backup has none (an older HarnessHub)",
      additionalProperties: false,
      required: ["redaction", "rules", "vision", "search", "alerts"],
      properties: {
        redaction: {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "turnsOff", "turnsOn"],
          properties: {
            enabled: {
              type: "boolean",
              description: "Outbound redaction after the restore",
            },
            turnsOff: {
              type: "boolean",
              description:
                "Redaction is on here and the backup turns it off: a security change to show",
            },
            turnsOn: { type: "boolean" },
          },
        },
        rules: { ...changes, description: "Redaction rules by name" },
        vision: {
          type: "object",
          nullable: true,
          additionalProperties: false,
          required: ["model", "changed"],
          properties: {
            model: { type: "string" },
            changed: { type: "boolean" },
            unresolved: {
              type: "string",
              description:
                "Why the model or group is not here after the restore; it is set all the same",
            },
          },
        },
        search: {
          type: "object",
          additionalProperties: false,
          required: ["added", "replaced", "removed", "needKey", "refused"],
          properties: {
            ...changes.properties,
            needKey: {
              ...strings,
              description:
                "Backends whose stored key the backup has no value for and this machine lacks: not brought in",
            },
            refused: {
              ...strings,
              description:
                "Backends whose key the backup names as a reference to a secret outside HarnessHub's store, with what it names: not brought in",
            },
          },
        },
        alerts: {
          type: "object",
          additionalProperties: false,
          required: ["usagePercent", "changed"],
          properties: {
            usagePercent: {
              type: "integer",
              nullable: true,
              description:
                "The usage alert's threshold after the restore; null: off",
            },
            changed: { type: "boolean" },
          },
        },
      },
    },
    gatewayShare: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["apply", "unchanged", "absent", "unavailable"],
        },
        settings: shareSettings,
        error: { type: "string" },
      },
    },
    catalog: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["backup", "current", "differs"],
      properties: {
        backup: catalogSettings,
        current: catalogSettings,
        differs: { type: "boolean" },
      },
    },
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["agent", "models", "action"],
        properties: {
          agent: { type: "string" },
          model: {
            type: "string",
            description: "Absent for an agent that signs in by itself",
          },
          models: { ...strings, description: "The models it may list" },
          deny: { ...strings, description: "The models hidden from it" },
          tiers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          effort: { type: "string" },
          options: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          action: {
            type: "string",
            enum: [
              "wire",
              "unchanged",
              "skip-disabled",
              "skip-not-installed",
              "skip-unknown",
              "skip-unavailable",
            ],
          },
          outcome: { type: "string", enum: ["wired", "failed"] },
          error: { type: "string" },
        },
      },
    },
    clientKeys: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "modelAllow", "allowLan"],
        properties: {
          name: { type: "string" },
          modelAllow: strings,
          allowLan: { type: "boolean" },
          quota: quotaSchema,
          expiresAt: { type: "string" },
        },
      },
    },
  },
} as const;

const parts = {
  type: "array",
  items: { enum: ["providers", "agents", "profiles", "library", "features"] },
} as const;
const syncStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "intervalMs", "secretBackend"],
  properties: {
    enabled: { type: "boolean" },
    kind: { type: "string", enum: ["webdav", "s3"] },
    url: { type: "string" },
    user: { type: "string" },
    endpoint: { type: "string" },
    region: { type: "string" },
    pathStyle: { type: "boolean" },
    keys: { type: "boolean" },
    agents: { type: "boolean" },
    intervalMs: { type: "integer" },
    lastSyncAt: { type: "string" },
    lastError: { type: "string" },
    lastErrorCode: {
      type: "string",
      description:
        "The problem code of lastError, e.g. SYNC_ROLLBACK (then POST /sync/now with acceptOlder takes the older file)",
    },
    nextSyncAt: { type: "string" },
    notice: {
      type: "object",
      additionalProperties: false,
      required: ["at", "here", "there"],
      properties: {
        at: { type: "string" },
        here: parts,
        there: parts,
        saved: { type: "string" },
        kept: strings,
        redactionOff: {
          type: "boolean",
          enum: [true],
          description:
            "The server's gateway features turned outbound redaction off here",
        },
        redactionOffHeld: {
          type: "boolean",
          enum: [true],
          description:
            "The server's gateway features turn outbound redaction off, but this machine's are as new or newer: it stays on here until turned off by hand",
        },
        needKey: {
          ...strings,
          description:
            "Search backends the server carries without a key and this machine has none for: not brought in",
        },
        refused: {
          ...strings,
          description:
            "Provider credentials naming HarnessHub's own secrets and search keys that are references, left out",
        },
      },
    },
    secretBackend: { type: "string", enum: ["keychain", "dpapi", "file"] },
    warnings: strings,
  },
} as const;

const syncPutSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "url"],
  properties: {
    kind: { type: "string", enum: ["webdav", "s3"] },
    url: {
      ...text(2048),
      description:
        "https://… for WebDAV, s3://bucket or s3://bucket/prefix for S3",
    },
    user: {
      ...text(512),
      description: "The WebDAV user name, or the S3 access key ID",
    },
    secret: {
      ...text(8192),
      description:
        "The WebDAV password or the S3 secret access key; omitted, the stored one stays for the same target and user",
    },
    passphrase: {
      ...passphrase,
      description:
        "Seals the copy on the server; kept in the secret store, omitted keeps the stored one",
    },
    endpoint: text(2048),
    region: text(64),
    pathStyle: { type: "boolean" },
    keys: {
      type: "boolean",
      default: true,
      description: "Credential values go to the server (sealed)",
    },
    agents: {
      type: "boolean",
      default: true,
      description: "Agent wirings are synced",
    },
  },
} as const;

/**
 * `POST /api/v1/backup` and `/restore`, and `/api/v1/sync`
 * (docs/backup-sync.md). Registered inside the `/api/v1` plugin, so the admin
 * token and loopback rules apply; passphrases and secrets arrive in request
 * bodies, which are never logged.
 */
export function registerBackupRoutes(
  api: FastifyInstance,
  backups: BackupService,
  sync: SyncService,
): void {
  api.post<{ Body: { passphrase: string; keys: boolean } }>(
    "/backup",
    {
      schema: { body: backupBodySchema, response: responses(envelopeSchema) },
    },
    async (request) => backups.create(request.body),
  );
  api.post<{
    Body: {
      backup: unknown;
      passphrase: string;
      agents: boolean;
      library: boolean;
      references: boolean;
      dryRun: boolean;
    };
  }>(
    "/restore",
    {
      // A sealed file of up to MAX_SEALED_BYTES, as JSON within the body.
      bodyLimit: MAX_SEALED_BYTES + 64 * 1024,
      schema: {
        body: restoreBodySchema,
        response: responses(restoreSummarySchema),
      },
    },
    async (request) => backups.restore(request.body),
  );
  api.get(
    "/sync",
    { schema: { response: responses(syncStatusSchema) } },
    async () => sync.status(),
  );
  api.put<{ Body: unknown }>(
    "/sync",
    { schema: { body: syncPutSchema, response: responses(syncStatusSchema) } },
    async (request) => sync.configure(request.body),
  );
  api.delete(
    "/sync",
    { schema: { response: responses(syncStatusSchema) } },
    async () => sync.disable(),
  );
  api.post<{ Body: { acceptOlder?: boolean } }>(
    "/sync/now",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            acceptOlder: {
              type: "boolean",
              description:
                "Take a server file older than one this machine already synced (otherwise 409 SYNC_ROLLBACK)",
            },
          },
        },
        response: responses(syncStatusSchema),
      },
    },
    async (request) =>
      sync.now({ acceptOlder: request.body.acceptOlder === true }),
  );
}
