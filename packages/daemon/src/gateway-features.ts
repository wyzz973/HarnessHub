// SPDX-License-Identifier: MIT
/**
 * The shared gateway's features as the user sets them (redaction, the
 * vision model, web search backends, usage alerts), kept in
 * `<dataDir>/gateway-features.json` (mode 0600, replaced atomically). The
 * gateway reads the current value for every request; changes apply to the
 * next request. Search API keys go to the secret store; the file holds
 * their references only.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HubError } from "@harnesshub/core/errors";
import {
  DEFAULT_GATEWAY_FEATURES,
  gatewayFeaturesProblems,
  redactionRuleProblem,
  searchBackendProblem,
  usagePercent as isUsagePercent,
  type GatewayFeatures,
  type RedactionRule,
  type SearchBackend,
  type SearchBackendKind,
} from "@harnesshub/core/gateway-features";
import { parseModelRef } from "@harnesshub/core/model-plane";
import type { ManagedSecrets } from "./http/api-v1.js";
import { ApiProblem } from "./http/api-v1.js";
import type {
  GatewayFeaturesControl,
  GatewayFeaturesView,
} from "./http/gateway-features-routes.js";

/** The settings file in the data root. */
export const GATEWAY_FEATURES_FILE = "gateway-features.json";

/**
 * Loads, changes and saves the gateway features. Changes are serialized;
 * a change that cannot be saved leaves the previous value in force.
 */
export class GatewayFeaturesFile implements GatewayFeaturesControl {
  #current: GatewayFeatures = structuredClone(DEFAULT_GATEWAY_FEATURES);
  #writes: Promise<unknown> = Promise.resolve();
  /** Called after a change is saved and in force; must not throw. */
  changed: () => void = () => undefined;

  constructor(
    private readonly options: {
      dataDir: string;
      secrets: ManagedSecrets;
      /** Stamps `updatedAt` on each change; the system clock by default. */
      clock?: () => Date;
    },
  ) {}

  get #file(): string {
    return path.join(this.options.dataDir, GATEWAY_FEATURES_FILE);
  }

  /**
   * Read the file; a missing file is the defaults.
   *
   * @throws HubError `GATEWAY_FEATURES_INVALID` (500) for a file that is
   *   not valid settings, so a hand-edited mistake does not silently turn
   *   redaction off.
   */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    const problems = gatewayFeaturesProblems(value);
    if (problems.length)
      throw new HubError(
        "GATEWAY_FEATURES_INVALID",
        `${this.#file} is not valid: ${problems
          .slice(0, 3)
          .map((item) => `${item.pointer || "/"} ${item.detail}`)
          .join("; ")}`,
        500,
      );
    this.#current = value as GatewayFeatures;
  }

  /** The settings in force; the gateway reads this for each request. */
  current(): GatewayFeatures {
    return this.#current;
  }

  view(): GatewayFeaturesView {
    const { search, updatedAt: _updatedAt, ...rest } = this.#current;
    return {
      ...rest,
      ...(search
        ? {
            search: {
              backends: search.backends.map(({ credential, ...backend }) => ({
                ...backend,
                hasKey: credential !== undefined,
              })),
            },
          }
        : {}),
    };
  }

  /**
   * Replace the settings as a whole (restore and sync), `updatedAt`
   * included as given. Search keys are the caller's: their references must
   * already be in the secret store, and keys the old settings referred to
   * are not removed here.
   *
   * @throws ApiProblem `GATEWAY_FEATURES_INVALID` for invalid settings,
   *   which leave the current ones in force.
   */
  async replace(next: GatewayFeatures): Promise<void> {
    await this.#change(
      (draft) => {
        for (const key of Object.keys(draft) as (keyof GatewayFeatures)[])
          delete draft[key];
        Object.assign(draft, structuredClone(next));
      },
      { stamp: false },
    );
  }

  /** Apply `change` to a copy, validate, save, then make it current. */
  #change(
    change: (draft: GatewayFeatures) => void | Promise<void>,
    options: { stamp: boolean } = { stamp: true },
  ): Promise<GatewayFeaturesView> {
    const run = async () => {
      const draft = structuredClone(this.#current);
      await change(draft);
      if (options.stamp)
        draft.updatedAt = (this.options.clock?.() ?? new Date()).toISOString();
      const problems = gatewayFeaturesProblems(draft);
      if (problems.length)
        throw new ApiProblem(
          "GATEWAY_FEATURES_INVALID",
          "The gateway features are invalid",
          400,
          { errors: problems },
        );
      await mkdir(this.options.dataDir, { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, this.#file);
      this.#current = draft;
      this.changed();
      return this.view();
    };
    const result = this.#writes.then(run, run);
    this.#writes = result.catch(() => undefined);
    return result;
  }

  setRedaction(input: {
    enabled?: boolean;
    rules?: RedactionRule[];
  }): Promise<GatewayFeaturesView> {
    return this.#change((draft) => {
      if (input.enabled !== undefined) draft.redaction.enabled = input.enabled;
      if (input.rules !== undefined) {
        input.rules.forEach((rule, index) => {
          const problem = redactionRuleProblem(rule);
          if (problem)
            throw new ApiProblem(
              "GATEWAY_FEATURES_INVALID",
              "A redaction rule is invalid",
              400,
              { errors: [{ pointer: `/rules/${index}`, detail: problem }] },
            );
        });
        draft.redaction.rules = input.rules;
      }
    });
  }

  setVision(model: string | null): Promise<GatewayFeaturesView> {
    return this.#change((draft) => {
      if (model === null) delete draft.vision;
      else {
        if (!parseModelRef(model))
          throw new ApiProblem(
            "GATEWAY_FEATURES_INVALID",
            "The vision model must be a Model Ref or group/<id>",
            400,
            {
              errors: [
                {
                  pointer: "/model",
                  detail: "must be a Model Ref or group/<id>",
                },
              ],
            },
          );
        draft.vision = { model };
      }
    });
  }

  setAlerts(usagePercent: number | null): Promise<GatewayFeaturesView> {
    return this.#change((draft) => {
      if (usagePercent === null) delete draft.alerts;
      else {
        if (!isUsagePercent(usagePercent))
          throw new ApiProblem(
            "GATEWAY_FEATURES_INVALID",
            "A usage alert is at a whole percent from 1 to 100",
            400,
            {
              errors: [
                {
                  pointer: "/usagePercent",
                  detail: "must be a whole percent from 1 to 100",
                },
              ],
            },
          );
        draft.alerts = { usagePercent };
      }
    });
  }

  addSearch(input: {
    kind: SearchBackendKind;
    key?: string;
    baseUrl?: string;
  }): Promise<GatewayFeaturesView> {
    let created: SearchBackend["credential"];
    const result = this.#change(async (draft) => {
      const backends = draft.search?.backends ?? [];
      let index = backends.length + 1;
      while (backends.some((item) => item.id === `search-${index}`)) index++;
      const backend: SearchBackend = {
        id: `search-${index}`,
        kind: input.kind,
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      };
      // Checked before the key is stored, so a refused backend stores nothing.
      const problem = searchBackendProblem({
        ...backend,
        ...(input.key !== undefined
          ? { credential: { kind: "store", value: "unchecked" } }
          : {}),
      });
      if (problem)
        throw new ApiProblem(
          "GATEWAY_FEATURES_INVALID",
          "The search backend is invalid",
          400,
          { errors: [{ pointer: "", detail: problem }] },
        );
      if (input.key !== undefined)
        backend.credential = created = await this.options.secrets.create(
          input.key,
        );
      draft.search = { backends: [...backends, backend] };
    });
    return result.catch(async (error: unknown) => {
      if (created)
        await this.options.secrets.delete(created).catch(() => false);
      throw error;
    });
  }

  removeSearch(id: string): Promise<GatewayFeaturesView> {
    let removed: SearchBackend | undefined;
    return this.#change((draft) => {
      const backends = draft.search?.backends ?? [];
      removed = backends.find((item) => item.id === id);
      if (!removed)
        throw new HubError(
          "SEARCH_BACKEND_NOT_FOUND",
          `No search backend ${JSON.stringify(id).slice(0, 80)}`,
          404,
        );
      const rest = backends.filter((item) => item !== removed);
      if (rest.length) draft.search = { backends: rest };
      else delete draft.search;
    }).then(async (view) => {
      // The setting is gone first; a key left behind is only unused.
      if (removed?.credential?.kind === "store")
        await this.options.secrets
          .delete(removed.credential)
          .catch(() => false);
      return view;
    });
  }
}
