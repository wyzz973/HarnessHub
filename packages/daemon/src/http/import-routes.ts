// SPDX-License-Identifier: MIT
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import {
  ImportLinkError,
  parseImportLink,
  slugify,
  type ImportApp,
  type ImportItem,
  type ImportLink,
  type ImportPreview,
} from "@harnesshub/core/import-links";
import {
  isProviderId,
  type ProviderConfig,
  type WireProtocol,
} from "@harnesshub/core/model-plane";
import {
  choosePreset,
  PresetChoiceError,
  type ProviderPreset,
} from "@harnesshub/core/provider-presets";
import { ApiProblem, type PresetCatalog } from "./api-v1.js";
import {
  importApplySchema,
  importAppliedSchema,
  importPreviewRequestSchema,
  importPreviewSchema,
  responses,
} from "./api-v1-schemas.js";
import type { WiringHome } from "../agents-wiring.js";
import { readAppConfiguration, type AppUpstream } from "../provider-imports.js";

/** The body of `POST /providers`, which an import produces. */
export type ProviderBody = Record<string, unknown> & {
  preset?: string;
  region?: string;
  plan?: string;
  id?: string;
  name?: string;
  endpoints?: Partial<Record<WireProtocol, string>>;
  headers?: Record<string, string>;
  credential?: {
    id?: string;
    name?: string;
    value?: string;
    ref?: SecretReference;
    protocols?: WireProtocol[];
    enabled?: boolean;
  };
};

interface Pending {
  expires: number;
  entries: Array<{ item: ImportItem; body?: ProviderBody }>;
}

/** A preview is applied once, within this time. */
const PREVIEW_LIFETIME_MS = 10 * 60 * 1000;
/** Previews kept at once; the oldest goes first. */
const MAX_PREVIEWS = 32;
/** Keys this long or longer show their last four characters. */
const LAST4_MIN_LENGTH = 16;

function hostsOf(endpoints: ProviderConfig["endpoints"]): string[] {
  return [...new Set(Object.values(endpoints).map((url) => new URL(url).host))];
}

function keyView(credential: ProviderBody["credential"]): ImportItem["key"] {
  if (credential?.value !== undefined)
    return credential.value.length >= LAST4_MIN_LENGTH
      ? { kind: "value", last4: credential.value.slice(-4) }
      : { kind: "value" };
  if (credential?.ref?.kind === "env")
    return { kind: "env", variable: credential.ref.value };
  return { kind: "none" };
}

/** A problem of the request, with the link parameter it is about. */
function linkProblem(error: ImportLinkError): ApiProblem {
  return new ApiProblem("IMPORT_LINK_INVALID", error.message, 400, {
    errors: [
      {
        pointer: "/link",
        detail: error.parameter
          ? `parameter ${error.parameter}`
          : "is not a valid import link",
      },
    ],
  });
}

/**
 * Import routes under `/api/v1` (06 section 8): `POST /import/preview` reads
 * an import link or another app's configuration and keeps the providers it
 * describes in memory under a one-time `previewId` (10 minutes); `POST
 * /import/apply` creates the `new` ones through the same path as `POST
 * /providers`. Nothing is written before apply, keys reach only the secret
 * store and responses show at most a key's last four characters.
 */
export function registerImportRoutes(
  api: FastifyInstance,
  options: {
    presets: PresetCatalog;
    /** Where other apps' configuration is read; absent, app imports are refused. */
    home: WiringHome | undefined;
    /** The local gateway, so that an app wired to HarnessHub is not imported back. */
    gatewayOrigin: () => string | undefined;
    build: (body: ProviderBody, now: string) => ProviderConfig;
    exists: (id: string) => Promise<boolean>;
    create: (body: ProviderBody) => Promise<ProviderConfig>;
  },
): void {
  const pending = new Map<string, Pending>();
  const sweep = (now: number) => {
    for (const [id, entry] of pending)
      if (entry.expires <= now) pending.delete(id);
  };

  /** The item for a body: built and checked like `POST /providers`, and whether its ID is taken. */
  const itemFor = async (
    ref: string,
    body: ProviderBody,
    links: { website?: string; keysUrl?: string } = {},
    strict = false,
  ): Promise<ImportItem> => {
    let built: ProviderConfig;
    try {
      built = options.build(body, new Date().toISOString());
    } catch (error) {
      // A link describes one provider, so its problem is the request's;
      // one bad entry of an app's file does not hide the others.
      if (strict || !(error instanceof ApiProblem) || error.statusCode !== 400)
        throw error;
      const first = error.extensions.errors?.[0];
      const where =
        first === undefined
          ? ""
          : ` (${"pointer" in first ? first.pointer : first.parameter} ${first.detail})`;
      return {
        ref,
        status: "skipped",
        reason: `${error.message}${where}`,
        hosts: [],
        key: keyView(body.credential),
      };
    }
    const exists = await options.exists(built.id);
    return {
      ref,
      status: exists ? "exists" : "new",
      ...(exists
        ? {
            reason: `A provider with the ID ${built.id} exists; it is left as it is`,
          }
        : {}),
      provider: {
        id: built.id,
        name: built.name,
        kind: built.kind,
        ...(built.preset !== undefined ? { preset: built.preset } : {}),
        ...(built.region !== undefined ? { region: built.region } : {}),
        ...(built.plan !== undefined ? { plan: built.plan } : {}),
        ...(built.catalog !== undefined ? { catalog: built.catalog } : {}),
        endpoints: built.endpoints,
        apiKeyHeader: built.auth.apiKeyHeader,
        models: built.models.list.map((model) => model.id),
        headers: Object.keys(built.headers ?? {}),
      },
      hosts: hostsOf(built.endpoints),
      key: keyView(body.credential),
      ...(links.website !== undefined ? { website: links.website } : {}),
      ...(links.keysUrl !== undefined ? { keysUrl: links.keysUrl } : {}),
    };
  };

  /** The `POST /providers` body of a link, and its preset when it names one. */
  const linkBody = (
    link: ImportLink,
  ): { body: ProviderBody; preset?: ProviderPreset } => {
    let preset: ProviderPreset | undefined;
    let region = link.region;
    let plan = link.plan;
    if (link.preset !== undefined) {
      if (link.flavor === "magpie") {
        const resolved = options.presets.magpie(link.preset, link.region);
        if (!resolved)
          throw new ApiProblem(
            "PRESET_NOT_FOUND",
            `HarnessHub has no preset for Magpie's ${link.preset}`,
            400,
            { errors: [{ pointer: "/link", detail: "parameter preset" }] },
          );
        ({ preset, region, plan } = resolved);
      } else {
        preset = options.presets.get(link.preset);
        if (!preset)
          throw new ApiProblem(
            "PRESET_NOT_FOUND",
            `There is no preset ${link.preset}`,
            400,
            { errors: [{ pointer: "/link", detail: "parameter preset" }] },
          );
      }
    }
    const credential = link.key !== undefined ? { value: link.key } : undefined;
    const models = (source: ProviderConfig["models"]["source"]) =>
      link.models.length
        ? {
            models: {
              source,
              list: link.models.map((id) => ({ id })),
              expose: "all",
            },
          }
        : {};
    if (preset) {
      let chosen: ProviderPreset;
      try {
        chosen = choosePreset(preset, { region, plan }).preset;
      } catch (error) {
        if (!(error instanceof PresetChoiceError)) throw error;
        throw new ApiProblem(error.code, error.message, 400, {
          errors: [
            { pointer: "/link", detail: `parameter ${error.pointer.slice(1)}` },
          ],
        });
      }
      return {
        // The preset as the chosen region and plan see it.
        preset: chosen,
        body: {
          preset: preset.id,
          ...(region !== undefined ? { region } : {}),
          ...(plan !== undefined ? { plan } : {}),
          ...(link.id !== undefined ? { id: link.id } : {}),
          ...(link.name !== undefined ? { name: link.name } : {}),
          ...(Object.keys(link.endpoints).length
            ? { endpoints: link.endpoints }
            : {}),
          ...(link.catalog !== undefined ? { catalog: link.catalog } : {}),
          ...models(chosen.models.source),
          ...(credential ? { credential } : {}),
        },
      };
    }
    return {
      body: {
        id: link.id!,
        name: link.name!,
        endpoints: link.endpoints,
        ...(link.catalog !== undefined ? { catalog: link.catalog } : {}),
        ...models("manual"),
        ...(credential ? { credential } : {}),
      },
    };
  };

  /** The preset whose endpoints (in some region and plan) include `url`. */
  const presetAt = (
    protocol: WireProtocol,
    url: string,
  ): { preset: ProviderPreset; region?: string; plan?: string } | undefined => {
    for (const preset of options.presets.list()) {
      if (preset.kind === "local" || preset.userEndpoint) continue;
      for (const region of preset.regions ?? [undefined])
        for (const plan of preset.plans ?? [undefined]) {
          const chosen = choosePreset(preset, {
            region: region?.id,
            plan: plan?.id,
          }).preset;
          if (chosen.endpoints[protocol] === url)
            return {
              preset,
              ...(region ? { region: region.id } : {}),
              ...(plan ? { plan: plan.id } : {}),
            };
        }
    }
    return undefined;
  };

  /** The body of an app's upstream, or why it is not imported. */
  const appBody = (
    upstream: AppUpstream,
  ): { body: ProviderBody } | { reason: string } => {
    const gateway = options.gatewayOrigin();
    const urls = Object.entries(upstream.endpoints) as Array<
      [WireProtocol, string]
    >;
    if (
      upstream.ref === "harnesshub" ||
      (upstream.key &&
        "value" in upstream.key &&
        upstream.key.value.startsWith("hhk_")) ||
      urls.some(
        ([, url]) =>
          URL.canParse(url) &&
          gateway !== undefined &&
          new URL(url).origin === gateway,
      )
    )
      return { reason: "It points at HarnessHub itself" };
    if (!upstream.key) return { reason: "It has no API key" };
    // The rule of credential references (`checkCredentialBody`).
    if ("env" in upstream.key && !/^[A-Z][A-Z0-9_]*$/.test(upstream.key.env))
      return {
        reason:
          "Its key variable is not an environment variable name (A-Z, 0-9, _)",
      };
    const credential =
      "value" in upstream.key
        ? { value: upstream.key.value }
        : { ref: { kind: "env" as const, value: upstream.key.env } };
    const models = upstream.models.length
      ? {
          models: {
            source: "manual",
            list: upstream.models.map((id) => ({ id })),
            expose: "all",
          },
        }
      : {};
    const [protocol, url] = urls[0]!;
    // An upstream at a preset's own endpoint becomes that preset.
    const known = urls.length === 1 ? presetAt(protocol, url) : undefined;
    if (known)
      return {
        body: {
          preset: known.preset.id,
          ...(known.region !== undefined ? { region: known.region } : {}),
          ...(known.plan !== undefined ? { plan: known.plan } : {}),
          ...(upstream.headers ? { headers: upstream.headers } : {}),
          ...(upstream.models.length
            ? {
                models: {
                  source: choosePreset(known.preset, known).preset.models
                    .source,
                  list: upstream.models.map((id) => ({ id })),
                  expose: "all",
                },
              }
            : {}),
          credential,
        },
      };
    const id = slugify(
      upstream.ref === "settings" ? upstream.name : upstream.ref,
    );
    if (!id || !isProviderId(id))
      return { reason: "Its name gives no provider ID" };
    return {
      body: {
        id,
        name: upstream.name.slice(0, 200),
        endpoints: upstream.endpoints,
        auth: { apiKeyHeader: upstream.apiKeyHeader },
        ...(upstream.headers ? { headers: upstream.headers } : {}),
        ...models,
        credential,
      },
    };
  };

  api.post<{ Body: { link?: string; app?: ImportApp } }>(
    "/import/preview",
    {
      schema: {
        body: importPreviewRequestSchema,
        response: responses(importPreviewSchema),
      },
    },
    async (request): Promise<ImportPreview> => {
      const now = Date.now();
      sweep(now);
      const entries: Pending["entries"] = [];
      const warnings: string[] = [];
      let file: string | undefined;
      const { link: text, app } = request.body;
      if ((text === undefined) === (app === undefined))
        throw new ApiProblem(
          "INVALID_REQUEST",
          "Give either an import link or an app",
          400,
          {
            errors: [
              { pointer: "/link", detail: "exactly one of link and app" },
            ],
          },
        );
      if (text !== undefined) {
        let link: ImportLink;
        try {
          link = parseImportLink(text);
        } catch (error) {
          if (error instanceof ImportLinkError) throw linkProblem(error);
          throw error;
        }
        warnings.push(...link.warnings);
        const { body, preset } = linkBody(link);
        const keysUrl = link.keysUrl ?? preset?.keysUrl;
        const website = link.website ?? preset?.website;
        entries.push({
          item: await itemFor(
            "link",
            body,
            {
              ...(website !== undefined ? { website } : {}),
              ...(keysUrl !== undefined ? { keysUrl } : {}),
            },
            true,
          ),
          body,
        });
      } else {
        if (!options.home)
          throw new ApiProblem(
            "IMPORT_SOURCE_UNAVAILABLE",
            "This daemon was started without a wiring home, so other apps' configuration is not read; hh serve sets it to your home directory",
            409,
          );
        const configuration = await readAppConfiguration(app!, options.home);
        file = configuration.file;
        if (!file)
          warnings.push(
            `No ${app === "claude-code" ? "Claude Code settings.json" : "Codex config.toml"} was found`,
          );
        const ids = new Map<string, string>();
        for (const upstream of configuration.upstreams) {
          const result = appBody(upstream);
          if ("reason" in result) {
            entries.push({
              item: {
                ref: upstream.ref,
                status: "skipped",
                reason: result.reason,
                hosts: [],
                key: { kind: "none" },
              },
            });
            continue;
          }
          const item = await itemFor(upstream.ref, result.body);
          const id = item.provider?.id;
          const earlier = id === undefined ? undefined : ids.get(id);
          if (
            id !== undefined &&
            earlier !== undefined &&
            item.status === "new"
          ) {
            item.status = "skipped";
            item.reason = `It would take the ID ${id}, as ${earlier} does`;
          } else if (id !== undefined) ids.set(id, upstream.ref);
          entries.push({ item, body: result.body });
        }
      }
      while (pending.size >= MAX_PREVIEWS)
        pending.delete(pending.keys().next().value!);
      const previewId = randomBytes(16).toString("base64url");
      const expires = now + PREVIEW_LIFETIME_MS;
      pending.set(previewId, { expires, entries });
      return {
        previewId,
        expiresAt: new Date(expires).toISOString(),
        source: text !== undefined ? "link" : app!,
        ...(file !== undefined ? { file } : {}),
        items: entries.map((entry) => entry.item),
        warnings,
      };
    },
  );

  api.post<{ Body: { previewId: string; refs?: string[] } }>(
    "/import/apply",
    {
      schema: {
        body: importApplySchema,
        response: responses(importAppliedSchema),
      },
    },
    async (request) => {
      sweep(Date.now());
      const found = pending.get(request.body.previewId);
      // A preview is used once, whatever the outcome.
      pending.delete(request.body.previewId);
      if (!found)
        throw new ApiProblem(
          "IMPORT_PREVIEW_NOT_FOUND",
          "No preview has this ID: it was applied already, expired after 10 minutes or the daemon restarted",
          404,
        );
      const wanted = request.body.refs;
      const unknown = wanted?.filter(
        (ref) => !found.entries.some((entry) => entry.item.ref === ref),
      );
      if (unknown?.length)
        throw new ApiProblem(
          "INVALID_REQUEST",
          "The preview has no such item",
          400,
          {
            errors: unknown.map((ref) => ({
              pointer: "/refs",
              detail: `${ref.slice(0, 80)} is not an item of the preview`,
            })),
          },
        );
      const items = [];
      for (const { item, body } of found.entries) {
        if (wanted && !wanted.includes(item.ref)) continue;
        if (item.status !== "new" || !body) {
          items.push({
            ref: item.ref,
            status: "skipped" as const,
            reason: item.reason ?? "It is not new",
          });
          continue;
        }
        try {
          const created = await options.create(body);
          items.push({
            ref: item.ref,
            status: "created" as const,
            provider: created,
          });
        } catch (error) {
          if (!(error instanceof ApiProblem) || error.statusCode >= 500)
            throw error;
          items.push({
            ref: item.ref,
            status: "failed" as const,
            code: error.code,
            reason: error.message,
          });
        }
      }
      return { items };
    },
  );
}
