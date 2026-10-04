// SPDX-License-Identifier: MIT
/**
 * Muse Code's model list (Magpie's `gw/muse.go`). Muse asks for it at
 * `/muse-code/models` on its endpoint's host, whatever path the endpoint
 * has, before every session, and starts none without it; a model it lists
 * is one whose `metadata["muse-code"]` says how Muse treats it (a row
 * without it is hidden, and a list of none is refused). The ids are the
 * gateway's, which Muse sends back as the model of its `/v1/responses`
 * calls.
 */
import type {
  ProviderModel,
  ReasoningEffort,
} from "@harnesshub/core/model-plane";

/** Where Muse asks for its models. */
export const MUSE_MODELS_PATH = "/muse-code/models";

/** What Muse is told of a model whose window or output limit is unknown (Magpie's). */
const MUSE_CONTEXT = 128_000;
const MUSE_OUTPUT = 32_000;

/** One of the gateway's models for a key, as the model list has it. */
export interface MuseListed {
  id: string;
  displayName?: string;
  owner: string;
  model?: ProviderModel;
  efforts?: readonly ReasoningEffort[];
}

/**
 * The list Muse reads. Every model gets a window and an output limit: Muse
 * hides a model whose limit lacks either and, without a limit, asks for
 * replies of 128K tokens.
 */
export function museModelList(listed: readonly MuseListed[]): unknown {
  return {
    object: "list",
    data: listed.map((entry) => {
      const name = entry.displayName ?? entry.id;
      const images = entry.model?.inputModalities?.includes("image") === true;
      const context = entry.model?.contextWindow ?? MUSE_CONTEXT;
      const output =
        entry.model?.maxOutputTokens ?? Math.min(MUSE_OUTPUT, context);
      return {
        id: entry.id,
        object: "model",
        created: 0,
        owned_by: entry.owner,
        metadata: {
          "muse-code": {
            name,
            family: entry.owner,
            is_hidden: false,
            attachment: images,
            reasoning: (entry.efforts?.length ?? 0) > 0,
            temperature: false,
            tool_call: true,
            modalities: {
              input: images ? ["text", "image"] : ["text"],
              output: ["text"],
            },
            options: { include: [] },
            variants: {},
            description: `${name} via HarnessHub`,
            limit: { context, output },
          },
        },
      };
    }),
  };
}
