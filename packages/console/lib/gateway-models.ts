// SPDX-License-Identifier: MIT
/**
 * The models the gateway offers, for pickers: each provider's exposed models
 * with their window and price, then route groups and the automatic groups
 * that are not hidden. Built from `/api/v1` lists; nothing is estimated.
 */
import type {
  AutoGroup,
  ProviderConfig,
  ProviderPreset,
  RouteGroup,
  SubscriptionBackend,
} from "@harnesshub/sdk/client";
import { formatUsd, t } from "./i18n";
import { modelPlane } from "./model-plane";

/** Marks of subscription providers, which have no preset (lib/brand-icons.ts). */
export const subscriptionIcons: Readonly<Record<SubscriptionBackend, string>> =
  { siwc: "openai", copilot: "githubcopilot" };

/** A provider's mark: its preset's, or its subscription backend's. */
export function providerIcon(
  provider: ProviderConfig,
  presetIcons: ReadonlyMap<string, string | undefined>,
): string | undefined {
  if (provider.preset) return presetIcons.get(provider.preset);
  return provider.subscription
    ? subscriptionIcons[provider.subscription.backend]
    : undefined;
}

export interface ModelOption {
  /** Model Ref: `provider/model` or `group/<id>`. */
  ref: string;
  /** The model's name within its provider, or the group's id. */
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** USD per million tokens. */
  price?: { input?: number; output?: number };
  /** Group members, for route and automatic groups. */
  members?: string[];
}

export interface ModelSection {
  /** Provider id, `group` or `auto-group`. */
  id: string;
  title: string;
  /** Lobehub slug of the provider's preset or subscription. */
  icon?: string;
  options: ModelOption[];
}

export interface GatewayModels {
  sections: ModelSection[];
  /** Every option by Model Ref. */
  byRef: ReadonlyMap<string, ModelOption>;
}

/** Group the gateway's models by provider, then route groups and automatic groups. */
export function gatewayModels(
  providers: readonly ProviderConfig[],
  presets: readonly ProviderPreset[],
  groups: readonly RouteGroup[],
  autoGroups: readonly AutoGroup[],
): GatewayModels {
  const icons = new Map(presets.map((preset) => [preset.id, preset.icon]));
  const sections: ModelSection[] = providers.map((provider) => {
    const icon = providerIcon(provider, icons);
    return {
      id: provider.id,
      title: provider.name,
      ...(icon ? { icon } : {}),
      options: provider.models.list
        .filter(
          (model) =>
            provider.models.expose === "all" ||
            provider.models.expose.includes(model.id),
        )
        .map((model) => ({
          ref: `${provider.id}/${model.id}`,
          label: model.id,
          ...(model.contextWindow !== undefined
            ? { contextWindow: model.contextWindow }
            : {}),
          ...(model.maxOutputTokens !== undefined
            ? { maxOutputTokens: model.maxOutputTokens }
            : {}),
          ...(model.price ? { price: model.price } : {}),
        })),
    };
  });
  if (groups.length)
    sections.push({
      id: "group",
      title: t("agents.picker.groups"),
      options: groups.map((group) => ({
        ref: `group/${group.id}`,
        label: `group/${group.id}`,
        members: group.members,
      })),
    });
  const visible = autoGroups.filter((group) => !group.hidden);
  if (visible.length)
    sections.push({
      id: "auto-group",
      title: t("agents.picker.autoGroups"),
      options: visible.map((group) => ({
        ref: `group/${group.id}`,
        label: `group/${group.id}`,
        members: group.members,
      })),
    });
  const filled = sections.filter((section) => section.options.length);
  return {
    sections: filled,
    byRef: new Map(
      filled.flatMap((section) =>
        section.options.map((option) => [option.ref, option] as const),
      ),
    ),
  };
}

/** Read the four lists the model pickers need. */
export async function loadGatewayModels(): Promise<GatewayModels> {
  const client = modelPlane();
  const [providers, presets, groups, autoGroups] = await Promise.all([
    client.providers.list(),
    client.presets.list(),
    client.routeGroups.list(),
    client.autoGroups.list(),
  ]);
  return gatewayModels(
    providers.items,
    presets.items,
    groups.items,
    autoGroups.items,
  );
}

/** 128000 → "128K", 1048576 → "1M", 2000000 → "2M"; undefined → "—". */
export function tokenCount(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** "$0.27 / $1.10" per million input and output tokens; unknown parts are "?". */
export function priceText(price: ModelOption["price"]): string {
  if (!price || (price.input === undefined && price.output === undefined))
    return t("agents.picker.priceUnknown");
  const part = (value: number | undefined) =>
    value === undefined ? "?" : formatUsd(value);
  return `${part(price.input)} / ${part(price.output)}`;
}
