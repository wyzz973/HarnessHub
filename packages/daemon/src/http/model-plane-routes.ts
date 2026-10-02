// SPDX-License-Identifier: MIT
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import {
  issueGatewayKey,
  parseModelRef,
  wireProtocols,
  type CredentialId,
  type GatewayKeyId,
  type GatewayKeyQuota,
  type GatewayKeyRecord,
  type GatewayKeyView,
  type ModelCallEntry,
  type ModelPlaneStore,
  type ModelRef,
  type ProviderConfig,
  type ProviderCredential,
  type ProviderId,
  type ProviderModel,
  type RetryPolicy,
  type RouteGroup,
  type RouteGroupId,
  type UsageFilter,
  type UsageGroupBy,
  type WireProtocol,
} from "@harnesshub/core/model-plane";
import {
  endpointProblem,
  isProviderConfig,
  isRouteGroup,
} from "@harnesshub/core/model-plane-records";
import {
  isOverrideRef,
  type ModelOverride,
  type ModelProvenance,
  type OverrideValues,
} from "@harnesshub/core/model-metadata";
import type { SessionId } from "@harnesshub/core/types";
import { ApiProblem, type ApiV1Options, type ProblemItem } from "./api-v1.js";
import { createModelEnrichment, type LiveModels } from "./model-enrichment.js";
import {
  fetchModelList,
  listingProtocol,
  ModelListError,
} from "./model-list.js";
import { providerFromPreset } from "@harnesshub/core/provider-presets";
import {
  catalogStatusSchema,
  credentialCreateSchema,
  credentialParams,
  credentialSchema,
  credentialSecretSchema,
  emptyBodySchema,
  gatewayKeyCreatedSchema,
  gatewayKeyCreateSchema,
  gatewayKeySchema,
  idParams,
  listOf,
  modelCallPageSchema,
  modelCallsQuerySchema,
  modelMetadataSchema,
  modelOverrideBodySchema,
  modelOverrideSchema,
  modelRefParams,
  noContent,
  presetSchema,
  providerCreateSchema,
  providerPatchSchema,
  providerSchema,
  responses,
  routeGroupCreateSchema,
  routeGroupPatchSchema,
  routeGroupSchema,
  usageQuerySchema,
  usageSchema,
} from "./api-v1-schemas.js";

/** Client keys expire after 90 days unless the request says otherwise (03 section 2). */
const CLIENT_KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

type Json = Record<string, unknown>;

function object(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON Merge Patch (RFC 7396): objects merge, `null` removes, anything else replaces. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!object(patch)) return patch;
  const result: Json = object(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function notFound(kind: string, id: string): ApiProblem {
  return new ApiProblem(
    `${kind.toUpperCase().replaceAll(" ", "_")}_NOT_FOUND`,
    `No ${kind} has the ID ${JSON.stringify(id).slice(0, 120)}`,
    404,
  );
}

function invalid(code: string, message: string, errors: ProblemItem[]) {
  return new ApiProblem(code, message, 400, { errors });
}

/** Explains why a provider candidate is invalid, endpoint by endpoint. */
function checkProvider(candidate: unknown): ProviderConfig {
  const errors: ProblemItem[] = [];
  if (object(candidate) && object(candidate.endpoints))
    for (const [name, url] of Object.entries(candidate.endpoints)) {
      const problem =
        typeof url === "string" &&
        (wireProtocols as readonly string[]).includes(name)
          ? endpointProblem(name as WireProtocol, url)
          : "is not a known protocol endpoint";
      if (problem)
        errors.push({ pointer: `/endpoints/${name}`, detail: problem });
    }
  if (object(candidate) && object(candidate.endpoints))
    if (Object.keys(candidate.endpoints).length === 0)
      errors.push({
        pointer: "/endpoints",
        detail: "must name at least one endpoint",
      });
  if (errors.length || !isProviderConfig(candidate))
    throw invalid(
      "PROVIDER_INVALID",
      "The provider configuration is invalid",
      errors.length
        ? errors
        : [{ pointer: "", detail: "does not form a valid provider" }],
    );
  return candidate;
}

function view(record: GatewayKeyRecord): GatewayKeyView {
  const { secretHash: _hash, ...rest } = record;
  return rest;
}

/** Decimal string for a USD amount (06 section 2.1), at most 10 decimals. */
function decimal(amount: number): string {
  const fixed = amount.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function callView(entry: ModelCallEntry) {
  return {
    ...entry,
    cost:
      entry.cost === null
        ? null
        : {
            amount: decimal(entry.cost.amountUsd),
            currency: "USD" as const,
            priceSource: entry.cost.priceSource,
          },
  };
}

interface CallQuery {
  from?: string;
  to?: string;
  keyId?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
}

function usageFilter(query: CallQuery): UsageFilter {
  return {
    ...(query.from !== undefined ? { from: query.from } : {}),
    ...(query.to !== undefined ? { to: query.to } : {}),
    ...(query.keyId !== undefined
      ? { keyId: query.keyId as GatewayKeyId }
      : {}),
    ...(query.provider !== undefined
      ? { provider: query.provider as ProviderId }
      : {}),
    ...(query.model !== undefined ? { modelRef: query.model as ModelRef } : {}),
    ...(query.sessionId !== undefined
      ? { sessionId: query.sessionId as SessionId }
      : {}),
  };
}

interface CredentialBody {
  id?: string;
  name: string;
  value?: string;
  ref?: SecretReference;
  protocols?: WireProtocol[];
  enabled?: boolean;
}

/** Exactly one of `value` and `ref`; a reference names an env variable or an absolute file. */
function checkCredentialBody(body: CredentialBody, at: string): void {
  if ((body.value === undefined) === (body.ref === undefined))
    throw invalid(
      "CREDENTIAL_INVALID",
      "Give either the secret value or a reference",
      [{ pointer: `${at}/value`, detail: "exactly one of value and ref" }],
    );
  if (
    body.ref !== undefined &&
    (body.ref.kind === "env"
      ? !/^[A-Z][A-Z0-9_]*$/.test(body.ref.value)
      : !path.isAbsolute(body.ref.value))
  )
    throw invalid("CREDENTIAL_INVALID", "The reference is invalid", [
      {
        pointer: `${at}/ref/value`,
        detail:
          body.ref.kind === "env"
            ? "must name an environment variable (A-Z, 0-9, _)"
            : "must be an absolute path",
      },
    ]);
}

/** The requested credential ID, or the first free `key-N`. */
function credentialId(
  existing: readonly ProviderCredential[],
  requested: string | undefined,
): CredentialId {
  const taken = new Set<string>(existing.map((item) => item.id));
  if (requested !== undefined) {
    if (taken.has(requested))
      throw new ApiProblem(
        "CREDENTIAL_EXISTS",
        "The provider has a credential with this ID",
        409,
      );
    return requested as CredentialId;
  }
  let index = existing.length + 1;
  while (taken.has(`key-${index}`)) index += 1;
  return `key-${index}` as CredentialId;
}

/** Whether an allowlist entry names a provider's models (`p/*` or `p/model`). */
function allowsProvider(entry: string, provider: string): boolean {
  const parsed = parseModelRef(entry);
  return parsed?.kind === "model" && parsed.provider === provider;
}

/** The model reference of a metadata route, which must name a model of a provider. */
function overrideRef(ref: string, wildcard: boolean) {
  const parsed = parseModelRef(ref);
  if (
    !isOverrideRef(ref) ||
    parsed?.kind !== "model" ||
    (!wildcard && parsed.model === "*")
  )
    throw invalid("MODEL_REF_INVALID", "The Model Ref is invalid", [
      {
        parameter: "ref",
        detail: wildcard
          ? "must be provider/model or provider/*"
          : "must be provider/model",
      },
    ]);
  return parsed;
}

/**
 * Model-plane routes under `/api/v1` (06 section 3, 03 sections 2, 4, 7 and
 * 8): providers and their credentials, model metadata and overrides, the
 * catalog snapshot, route groups, `client:` Gateway Keys, the `model.call`
 * ledger and usage. Writes are serialized within the daemon, so each
 * read-modify-write of a provider sees the previous one. Every write that
 * changes a provider's models or overrides resolves the models' metadata
 * into the provider (where the gateway reads prices and limits) and stores
 * its provenance in the same transaction. Secret values reach only
 * `secrets`; responses carry references, keys their text once.
 */
export function registerModelPlaneRoutes(
  api: FastifyInstance,
  options: Pick<
    ApiV1Options,
    "modelPlane" | "secrets" | "presets" | "catalog" | "environment"
  >,
): void {
  const store: ModelPlaneStore = options.modelPlane;
  const metadata = options.modelPlane;
  const secrets = options.secrets;
  const enrichment = createModelEnrichment({
    store: metadata,
    presets: options.presets,
    catalog: () => options.catalog.current(),
  });
  /** Resolve the metadata of every model of `config`, then write both. */
  const writeEnriched = async (
    config: ProviderConfig,
    live?: LiveModels,
  ): Promise<ProviderConfig> => {
    const { provider: enriched, provenance } = await enrichment.enrich(
      config,
      live ? { live } : {},
    );
    const checked = checkProvider(enriched);
    await metadata.putProviderMetadata(checked, provenance);
    return checked;
  };
  /**
   * Store the credential's value (when it has one), then write the provider
   * that `withCredential` builds (with `provenance`, when given); a secret
   * written for a failed provider write is removed again.
   */
  const writeWithCredential = async (
    body: CredentialBody,
    id: CredentialId,
    withCredential: (credential: ProviderCredential) => ProviderConfig,
    provenance?: ModelProvenance[],
  ): Promise<ProviderCredential> => {
    const ref =
      body.value !== undefined ? await secrets.create(body.value) : body.ref!;
    const credential: ProviderCredential = {
      id,
      name: body.name,
      ref,
      ...(body.protocols ? { protocols: body.protocols } : {}),
      enabled: body.enabled ?? true,
    };
    try {
      const written = checkProvider(withCredential(credential));
      if (provenance) await metadata.putProviderMetadata(written, provenance);
      else await store.putProvider(written);
    } catch (error) {
      if (ref.kind === "store") {
        try {
          await secrets.delete(ref);
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Credential write failed and its secret could not be removed",
          );
        }
      }
      throw error;
    }
    return credential;
  };
  let queue: Promise<unknown> = Promise.resolve();
  /** Run one mutation after the previous one settled. */
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const provider = async (id: string): Promise<ProviderConfig> => {
    const found = await store.getProvider(id as ProviderId);
    if (!found) throw notFound("provider", id);
    return found;
  };
  const credential = (config: ProviderConfig, id: string) => {
    const found = config.credentials.find((item) => item.id === id);
    if (!found) throw notFound("credential", id);
    return found;
  };
  const activeKeys = async () =>
    (await store.listGatewayKeys()).filter(
      (key) => key.revokedAt === undefined,
    );

  api.get(
    "/providers",
    { schema: { response: responses(listOf(providerSchema)) } },
    async () => ({ items: await store.listProviders(), nextCursor: null }),
  );
  api.get(
    "/presets",
    { schema: { response: responses(listOf(presetSchema)) } },
    async () => ({ items: options.presets.list(), nextCursor: null }),
  );
  api.post<{
    Body: Json & {
      preset?: string;
      id?: string;
      name?: string;
      endpoints?: Partial<Record<WireProtocol, string>>;
      credential?: Omit<CredentialBody, "name"> & { name?: string };
    };
  }>(
    "/providers",
    {
      schema: {
        body: providerCreateSchema,
        response: responses(providerSchema, 201),
      },
    },
    async (request, reply) =>
      serialized(async () => {
        const {
          preset: presetId,
          credential: credentialBody,
          ...fields
        } = request.body;
        const now = new Date().toISOString();
        let base: Json;
        if (presetId !== undefined) {
          const preset = options.presets.get(presetId);
          if (!preset)
            throw invalid("PRESET_NOT_FOUND", "There is no such preset", [
              { pointer: "/preset", detail: "is not a known preset ID" },
            ]);
          // Fields given with the preset override it, endpoints by protocol.
          const { id, name, endpoints, ...rest } = fields;
          const expanded = providerFromPreset(preset, {
            ...(id !== undefined ? { id } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(endpoints !== undefined ? { endpoints } : {}),
            now,
          });
          base = {
            ...expanded,
            models: {
              ...expanded.models,
              // The preset's values are resolved below with their source.
              list: expanded.models.list.map((model) => ({
                id: model.id,
                ...(model.wire !== undefined ? { wire: model.wire } : {}),
              })),
            },
            ...rest,
          };
        } else {
          const missing = (["id", "endpoints"] as const).filter(
            (field) => fields[field] === undefined,
          );
          if (missing.length)
            throw invalid(
              "PROVIDER_INVALID",
              "Give a preset, or an id and endpoints",
              missing.map((field) => ({
                pointer: `/${field}`,
                detail: "is required without a preset",
              })),
            );
          base = {
            schemaVersion: 1,
            name: fields.id,
            kind: "custom",
            auth: { apiKeyHeader: "authorization-bearer" },
            models: { source: "manual", list: [], expose: "all" },
            ...fields,
          };
        }
        const candidate = {
          ...base,
          credentials: [],
          createdAt: now,
          updatedAt: now,
        };
        const valid = checkProvider(candidate);
        if (await store.getProvider(valid.id))
          throw new ApiProblem(
            "PROVIDER_EXISTS",
            "A provider with this ID exists",
            409,
          );
        const { provider: enriched, provenance } =
          await enrichment.enrich(valid);
        const created = checkProvider(enriched);
        if (credentialBody === undefined) {
          await metadata.putProviderMetadata(created, provenance);
          return reply.code(201).send(created);
        }
        const named = {
          ...credentialBody,
          name: credentialBody.name ?? "default",
        };
        checkCredentialBody(named, "/credential");
        const credential = await writeWithCredential(
          named,
          credentialId([], credentialBody.id),
          (item) => ({ ...created, credentials: [item] }),
          provenance,
        );
        return reply.code(201).send({ ...created, credentials: [credential] });
      }),
  );
  api.get<{ Params: { id: string } }>(
    "/providers/:id",
    { schema: { params: idParams, response: responses(providerSchema) } },
    async (request) => provider(request.params.id),
  );
  api.patch<{ Params: { id: string }; Body: Json }>(
    "/providers/:id",
    {
      schema: {
        params: idParams,
        body: providerPatchSchema,
        response: responses(providerSchema),
      },
    },
    async (request) =>
      serialized(async () => {
        const current = await provider(request.params.id);
        const updated = checkProvider({
          ...(mergePatch(current, request.body) as Json),
          id: current.id,
          schemaVersion: 1,
          credentials: current.credentials,
          createdAt: current.createdAt,
          updatedAt: new Date().toISOString(),
        });
        return writeEnriched(updated);
      }),
  );
  api.delete<{ Params: { id: string } }>(
    "/providers/:id",
    { schema: { params: idParams, response: noContent } },
    async (request, reply) =>
      serialized(async () => {
        const current = await provider(request.params.id);
        const references = [
          ...(await store.listRouteGroups())
            .filter((group) =>
              group.members.some((member) =>
                allowsProvider(member, current.id),
              ),
            )
            .map((group) => ({ type: "route-group", id: group.id })),
          ...(await activeKeys())
            .filter((key) =>
              key.modelAllow.some((entry) => allowsProvider(entry, current.id)),
            )
            .map((key) => ({ type: "gateway-key", id: key.keyId })),
        ];
        if (references.length)
          throw new ApiProblem(
            "PROVIDER_IN_USE",
            "Route groups or Gateway Keys still refer to this provider",
            409,
            { references },
          );
        // Secrets first: a failure leaves the provider, and repeating the
        // delete finishes the job (an already deleted secret is skipped).
        for (const item of current.credentials)
          if (item.ref.kind === "store") await secrets.delete(item.ref);
        await store.deleteProvider(current.id);
        return reply.code(204).send();
      }),
  );

  api.post<{ Params: { id: string } }>(
    "/providers/:id/models/refresh",
    {
      schema: {
        params: idParams,
        body: emptyBodySchema,
        response: responses(providerSchema),
      },
    },
    async (request) => {
      // The upstream request runs outside the write queue; its result is
      // merged into the provider as it is when the request ends.
      const listed = await provider(request.params.id);
      const protocol = listingProtocol(listed);
      const credential = listed.credentials.find(
        (item) =>
          item.enabled &&
          (item.protocols === undefined ||
            (protocol !== undefined && item.protocols.includes(protocol))),
      );
      let models: ProviderModel[] | undefined;
      let failure: ApiProblem | undefined;
      let key: string | undefined;
      try {
        key = credential
          ? await secrets.resolve(credential.ref, options.environment)
          : undefined;
      } catch {
        failure = new ApiProblem(
          "CREDENTIAL_UNAVAILABLE",
          `The credential ${credential?.id ?? ""} could not be read`,
          409,
        );
      }
      if (!failure)
        try {
          models = await fetchModelList(listed, key);
        } catch (error) {
          if (!(error instanceof ModelListError)) throw error;
          failure = new ApiProblem(
            "MODELS_REFRESH_FAILED",
            `The model list could not be refreshed: ${error.message}`,
            502,
          );
        }
      return serialized(async () => {
        const current = await provider(request.params.id);
        const now = new Date().toISOString();
        if (!models) {
          // The previous list stays; it is marked stale.
          await store.putProvider(
            checkProvider({
              ...current,
              models: { ...current.models, stale: true },
              updatedAt: now,
            }),
          );
          throw failure!;
        }
        const previous = new Map(
          current.models.list.map((model) => [model.id, model]),
        );
        const { stale: _stale, ...rest } = current.models;
        // Values set by hand on a model stay; the list's own values replace
        // what an earlier list, the preset or the catalog supplied.
        return writeEnriched(
          checkProvider({
            ...current,
            models: {
              ...rest,
              source: "live",
              list: models.map(
                (model) => previous.get(model.id) ?? { id: model.id },
              ),
              refreshedAt: now,
            },
            updatedAt: now,
          }),
          {
            models: new Map(models.map((model) => [model.id, model])),
            at: now,
          },
        );
      });
    },
  );
  api.get<{ Params: { id: string } }>(
    "/providers/:id/models",
    {
      schema: {
        params: idParams,
        response: responses(listOf(modelMetadataSchema)),
      },
    },
    async (request) => {
      const config = await provider(request.params.id);
      return {
        items: await enrichment.resolve(
          config,
          config.models.list
            .map((model) => model.id)
            .filter((id) => isOverrideRef(`${config.id}/${id}`)),
        ),
        nextCursor: null,
      };
    },
  );
  api.get<{ Params: { ref: string } }>(
    "/models/:ref",
    {
      schema: {
        params: modelRefParams,
        response: responses(modelMetadataSchema),
      },
    },
    async (request) => {
      const parsed = overrideRef(request.params.ref, false);
      const [resolved] = await enrichment.resolve(
        await provider(parsed.provider),
        [parsed.model],
      );
      return resolved;
    },
  );
  /** Write or remove one override with the values it implies, in one transaction. */
  const changeOverride = async (
    ref: string,
    record: ModelOverride | null,
  ): Promise<void> => {
    const parsed = overrideRef(ref, true);
    const current = await provider(parsed.provider);
    if (record === null && !(await metadata.getModelOverride(parsed.ref)))
      throw notFound("model override", parsed.ref);
    const { provider: enriched, provenance } = await enrichment.enrich(
      { ...current, updatedAt: new Date().toISOString() },
      { override: { ref: parsed.ref, record } },
    );
    await metadata.putProviderMetadata(
      checkProvider(enriched),
      provenance,
      record ? { put: record } : { delete: parsed.ref },
    );
  };
  api.get<{ Params: { ref: string } }>(
    "/models/:ref/overrides",
    {
      schema: {
        params: modelRefParams,
        response: responses(modelOverrideSchema),
      },
    },
    async (request) => {
      const parsed = overrideRef(request.params.ref, true);
      await provider(parsed.provider);
      const found = await metadata.getModelOverride(parsed.ref);
      if (!found) throw notFound("model override", parsed.ref);
      return found;
    },
  );
  api.put<{ Params: { ref: string }; Body: OverrideValues }>(
    "/models/:ref/overrides",
    {
      schema: {
        params: modelRefParams,
        body: modelOverrideBodySchema,
        response: responses(modelOverrideSchema),
      },
    },
    async (request) =>
      serialized(async () => {
        const record: ModelOverride = {
          ref: request.params.ref,
          values: request.body,
          updatedAt: new Date().toISOString(),
        };
        await changeOverride(request.params.ref, record);
        return record;
      }),
  );
  api.delete<{ Params: { ref: string } }>(
    "/models/:ref/overrides",
    { schema: { params: modelRefParams, response: noContent } },
    async (request, reply) =>
      serialized(async () => {
        await changeOverride(request.params.ref, null);
        return reply.code(204).send();
      }),
  );
  // A refreshed catalog reaches the providers' stored metadata (and so the
  // gateway's prices) in the same write queue as every other provider write.
  options.catalog.subscribe(() =>
    serialized(async () => {
      const failures: unknown[] = [];
      for (const config of await store.listProviders())
        try {
          const { provider: enriched, provenance } =
            await enrichment.enrich(config);
          await metadata.putProviderMetadata(
            checkProvider(enriched),
            provenance,
          );
        } catch (error) {
          failures.push(error);
        }
      if (failures.length)
        throw new AggregateError(
          failures,
          `${failures.length} providers kept their previous model metadata`,
        );
    }),
  );
  api.get(
    "/catalog",
    { schema: { response: responses(catalogStatusSchema) } },
    async () => options.catalog.status(),
  );
  api.post(
    "/catalog/refresh",
    {
      schema: {
        body: emptyBodySchema,
        response: responses(catalogStatusSchema),
      },
    },
    // Not in the write queue: the provider updates of a changed catalog are.
    async () => options.catalog.refresh(),
  );
  api.get<{ Params: { id: string } }>(
    "/providers/:id/credentials",
    {
      schema: {
        params: idParams,
        response: responses(listOf(credentialSchema)),
      },
    },
    async (request) => ({
      items: (await provider(request.params.id)).credentials,
      nextCursor: null,
    }),
  );
  api.post<{ Params: { id: string }; Body: CredentialBody }>(
    "/providers/:id/credentials",
    {
      schema: {
        params: idParams,
        body: credentialCreateSchema,
        response: responses(credentialSchema, 201),
      },
    },
    async (request, reply) =>
      serialized(async () => {
        const body = request.body;
        checkCredentialBody(body, "");
        const current = await provider(request.params.id);
        const added = await writeWithCredential(
          body,
          credentialId(current.credentials, body.id),
          (credential) => ({
            ...current,
            credentials: [...current.credentials, credential],
            updatedAt: new Date().toISOString(),
          }),
        );
        return reply.code(201).send(added);
      }),
  );
  api.put<{
    Params: { id: string; credentialId: string };
    Body: { value: string };
  }>(
    "/providers/:id/credentials/:credentialId/secret",
    {
      schema: {
        params: credentialParams,
        body: credentialSecretSchema,
        response: responses(credentialSchema),
      },
    },
    async (request) =>
      serialized(async () => {
        const found = credential(
          await provider(request.params.id),
          request.params.credentialId,
        );
        if (found.ref.kind !== "store")
          throw new ApiProblem(
            "CREDENTIAL_NOT_MANAGED",
            "Only credentials stored by HarnessHub can be rotated here",
            409,
          );
        await secrets.rotate(found.ref, request.body.value);
        return found;
      }),
  );
  api.delete<{ Params: { id: string; credentialId: string } }>(
    "/providers/:id/credentials/:credentialId",
    { schema: { params: credentialParams, response: noContent } },
    async (request, reply) =>
      serialized(async () => {
        const current = await provider(request.params.id);
        const found = credential(current, request.params.credentialId);
        // Secret first, as for providers: a retry completes a partial delete.
        if (found.ref.kind === "store") await secrets.delete(found.ref);
        await store.putProvider(
          checkProvider({
            ...current,
            credentials: current.credentials.filter((item) => item !== found),
            updatedAt: new Date().toISOString(),
          }),
        );
        return reply.code(204).send();
      }),
  );

  const group = async (id: string): Promise<RouteGroup> => {
    const found = await store.getRouteGroup(id as RouteGroupId);
    if (!found) throw notFound("route group", id);
    return found;
  };
  /** Members must name models of existing providers. */
  const checkGroup = async (candidate: unknown): Promise<RouteGroup> => {
    if (!isRouteGroup(candidate))
      throw invalid("ROUTE_GROUP_INVALID", "The route group is invalid", [
        { pointer: "", detail: "does not form a valid route group" },
      ]);
    const providers = new Set(
      (await store.listProviders()).map((item) => item.id),
    );
    const errors = candidate.members.flatMap((member, index): ProblemItem[] => {
      const parsed = parseModelRef(member);
      return parsed?.kind === "model" && providers.has(parsed.provider)
        ? []
        : [
            {
              pointer: `/members/${index}`,
              detail: "must name a model of an existing provider",
            },
          ];
    });
    if (errors.length)
      throw invalid(
        "ROUTE_GROUP_INVALID",
        "The route group is invalid",
        errors,
      );
    return candidate;
  };
  api.get(
    "/route-groups",
    { schema: { response: responses(listOf(routeGroupSchema)) } },
    async () => ({ items: await store.listRouteGroups(), nextCursor: null }),
  );
  api.post<{
    Body: {
      id: string;
      members: string[];
      strategy?: RouteGroup["strategy"];
      stickiness?: RouteGroup["stickiness"];
      retry?: Partial<RetryPolicy>;
    };
  }>(
    "/route-groups",
    {
      schema: {
        body: routeGroupCreateSchema,
        response: responses(routeGroupSchema, 201),
      },
    },
    async (request, reply) =>
      serialized(async () => {
        const body = request.body;
        if (await store.getRouteGroup(body.id as RouteGroupId))
          throw new ApiProblem(
            "ROUTE_GROUP_EXISTS",
            "A route group with this ID exists",
            409,
          );
        const now = new Date().toISOString();
        const created = await checkGroup({
          strategy: "order",
          stickiness: "auto",
          ...body,
          createdAt: now,
          updatedAt: now,
        });
        await store.putRouteGroup(created);
        return reply.code(201).send(created);
      }),
  );
  api.get<{ Params: { id: string } }>(
    "/route-groups/:id",
    { schema: { params: idParams, response: responses(routeGroupSchema) } },
    async (request) => group(request.params.id),
  );
  api.patch<{ Params: { id: string }; Body: Json }>(
    "/route-groups/:id",
    {
      schema: {
        params: idParams,
        body: routeGroupPatchSchema,
        response: responses(routeGroupSchema),
      },
    },
    async (request) =>
      serialized(async () => {
        const current = await group(request.params.id);
        const updated = await checkGroup({
          ...(mergePatch(current, request.body) as Json),
          id: current.id,
          createdAt: current.createdAt,
          updatedAt: new Date().toISOString(),
        });
        await store.putRouteGroup(updated);
        return updated;
      }),
  );
  api.delete<{ Params: { id: string } }>(
    "/route-groups/:id",
    { schema: { params: idParams, response: noContent } },
    async (request, reply) =>
      serialized(async () => {
        const current = await group(request.params.id);
        const references = (await activeKeys())
          .filter((key) => key.modelAllow.includes(`group/${current.id}`))
          .map((key) => ({ type: "gateway-key", id: key.keyId }));
        if (references.length)
          throw new ApiProblem(
            "ROUTE_GROUP_IN_USE",
            "Gateway Keys still allow this route group",
            409,
            { references },
          );
        await store.deleteRouteGroup(current.id);
        return reply.code(204).send();
      }),
  );

  const gatewayKey = async (id: string): Promise<GatewayKeyRecord> => {
    const found = await store.getGatewayKey(id as GatewayKeyId);
    if (!found) throw notFound("gateway key", id);
    return found;
  };
  api.get(
    "/gateway-keys",
    { schema: { response: responses(listOf(gatewayKeySchema)) } },
    async () => ({
      items: (await store.listGatewayKeys()).map(view),
      nextCursor: null,
    }),
  );
  api.post<{
    Body: {
      name: string;
      modelAllow: string[];
      quota?: GatewayKeyQuota;
      expiresAt?: string | null;
    };
  }>(
    "/gateway-keys",
    {
      schema: {
        body: gatewayKeyCreateSchema,
        response: responses(gatewayKeyCreatedSchema, 201),
      },
    },
    async (request, reply) =>
      serialized(async () => {
        const body = request.body;
        const errors = body.modelAllow.flatMap((entry, index): ProblemItem[] =>
          parseModelRef(entry)
            ? []
            : [
                {
                  pointer: `/modelAllow/${index}`,
                  detail: "must be provider/model, provider/* or group/<id>",
                },
              ],
        );
        const now = Date.now();
        const expiresAt =
          body.expiresAt === undefined
            ? new Date(now + CLIENT_KEY_LIFETIME_MS).toISOString()
            : body.expiresAt;
        if (expiresAt !== null && Date.parse(expiresAt) <= now)
          errors.push({
            pointer: "/expiresAt",
            detail: "must be in the future",
          });
        if (errors.length)
          throw invalid(
            "GATEWAY_KEY_INVALID",
            "The Gateway Key is invalid",
            errors,
          );
        const scope = { kind: "client" as const, name: body.name };
        const issued = issueGatewayKey(scope);
        const record: GatewayKeyRecord = {
          keyId: issued.keyId,
          name: body.name,
          scope,
          modelAllow: body.modelAllow,
          ...(body.quota ? { quota: body.quota } : {}),
          secretHash: issued.secretHash,
          createdAt: new Date(now).toISOString(),
          ...(expiresAt !== null ? { expiresAt } : {}),
        };
        await store.createGatewayKey(record);
        return reply
          .code(201)
          .header("cache-control", "no-store")
          .send({ key: issued.text, gatewayKey: view(record) });
      }),
  );
  api.get<{ Params: { id: string } }>(
    "/gateway-keys/:id",
    { schema: { params: idParams, response: responses(gatewayKeySchema) } },
    async (request) => view(await gatewayKey(request.params.id)),
  );
  api.post<{ Params: { id: string } }>(
    "/gateway-keys/:id/revoke",
    {
      schema: {
        params: idParams,
        body: emptyBodySchema,
        response: responses(gatewayKeySchema),
      },
    },
    async (request) =>
      serialized(async () => {
        const id = (await gatewayKey(request.params.id)).keyId;
        await store.revokeGatewayKey(id, new Date().toISOString());
        return view(await gatewayKey(id));
      }),
  );

  api.get<{ Querystring: CallQuery & { limit: number; cursor?: string } }>(
    "/model-calls",
    {
      schema: {
        querystring: modelCallsQuerySchema,
        response: responses(modelCallPageSchema),
      },
    },
    async (request) => {
      const { limit, cursor } = request.query;
      const page = await store.listModelCalls(
        usageFilter(request.query),
        cursor === undefined ? { limit } : { limit, cursor },
      );
      return {
        items: page.items.map(callView),
        nextCursor: page.nextCursor ?? null,
      };
    },
  );
  api.get<{ Querystring: CallQuery & { groupBy: UsageGroupBy } }>(
    "/usage",
    {
      schema: {
        querystring: usageQuerySchema,
        response: responses(usageSchema),
      },
    },
    async (request) => ({
      groupBy: request.query.groupBy,
      items: (
        await store.aggregateUsage(
          usageFilter(request.query),
          request.query.groupBy,
        )
      ).map(({ costUsd, ...bucket }) => ({
        ...bucket,
        cost: { amount: decimal(costUsd), currency: "USD" as const },
      })),
    }),
  );
}
