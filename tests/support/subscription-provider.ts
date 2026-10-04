// SPDX-License-Identifier: MIT
/**
 * A subscription provider as a sign-in leaves it, written straight into a
 * running daemon's model-plane store: tests of backup and sync need one
 * without going through the vendors' sign-in flows. Its account's secret
 * reference names nothing; backups and sync never read it.
 */
import path from "node:path";
import type {
  CredentialId,
  ProviderConfig,
  ProviderId,
} from "@harnesshub/core/model-plane";
import { isProviderConfig } from "@harnesshub/core/model-plane-records";
import { SqliteModelPlaneStore } from "@harnesshub/store/storage/model-plane-store";

/** Write a signed-in ChatGPT (`siwc`) or Copilot provider `id` into `dataDir`'s store. */
export async function seedSubscription(
  dataDir: string,
  id: string,
  backend: "siwc" | "copilot",
): Promise<ProviderConfig> {
  const now = new Date().toISOString();
  const provider = {
    schemaVersion: 1,
    id: id as ProviderId,
    name: backend === "siwc" ? "ChatGPT plan" : "GitHub Copilot",
    kind: "vendor",
    subscription: { backend },
    endpoints:
      backend === "siwc"
        ? { responses: "https://chatgpt.example.test/v1" }
        : {},
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [
      {
        id: "account-1" as CredentialId,
        name: "plan-user@example.com",
        ref: { kind: "store", value: "00000000-0000-4000-8000-000000000000" },
        enabled: true,
        account:
          backend === "siwc"
            ? {
                backend,
                subject: "synthetic-subject",
                email: "plan-user@example.com",
                clientId: "oaiapp_synthetic_client",
                consent: { notice: "synthetic-notice", acceptedAt: now },
              }
            : {
                backend,
                subject: "synthetic-login",
                auth: "login",
                host: "github.com",
                consent: { notice: "synthetic-notice", acceptedAt: now },
              },
      },
    ],
    models: { source: "manual", list: [{ id: "plan-model" }], expose: "all" },
    createdAt: now,
    updatedAt: now,
  } as unknown;
  if (!isProviderConfig(provider))
    throw new Error("The seeded subscription provider is invalid");
  const store = new SqliteModelPlaneStore(
    path.join(dataDir, "harnesshub.sqlite"),
  );
  try {
    await store.putProvider(provider);
  } finally {
    store.close();
  }
  return provider;
}
