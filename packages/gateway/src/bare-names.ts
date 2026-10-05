// SPDX-License-Identifier: MIT
/**
 * A model asked for by a bare name, without `provider/` or `group/` (an IDE
 * plugin, a script that says "gpt-5"), resolved as Magpie resolves one
 * (`provider.GroupFor` and `provider.Resolve`, yetone/magpie@2e340f7): the
 * route group of that ID, then the group of the name as vendors spell it,
 * then the automatic group of that name, then the one model of that ID that
 * providers expose, then the one model of that ID a provider lists. Where
 * Magpie takes the first of several providers' models, HarnessHub refuses
 * and names them. Only what the caller's Gateway Key may use counts: a name
 * of something else resolves as an unknown name does, so that its answer
 * says nothing about what is configured (security review L6).
 */
import { autoGroups, sameModel, slug } from "@harnesshub/core/auto-groups";
import {
  providerEnabled,
  type ModelPlaneStore,
  type ProviderConfig,
  type RouteGroupId,
} from "@harnesshub/core/model-plane";

/** What a bare name names here. */
export type BareName =
  /** One route group (`group/<id>`) or one model (`provider/model`). */
  | { kind: "resolved"; ref: string; via: "group" | "auto-group" | "model" }
  /** Several providers' models of that ID, as Model Refs; none is picked. */
  | { kind: "ambiguous"; refs: string[] }
  | { kind: "none" };

const GROUP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

function exposed(provider: ProviderConfig): string[] {
  const { list, expose } = provider.models;
  return list
    .map((model) => model.id)
    .filter((id) => expose === "all" || expose.includes(id));
}

/**
 * Resolves `name`, a model name that is not a Model Ref or `group/<id>`,
 * to what `usable` admits (the key's allowlist). The automatic groups are
 * those `/v1/models` lists: a hidden one, or one whose ID a user group
 * took, is not a candidate.
 */
export async function resolveBareName(
  name: string,
  store: Pick<
    ModelPlaneStore,
    "listProviders" | "listRouteGroups" | "listHiddenAutoGroups"
  >,
  usable: (ref: string) => Promise<boolean>,
): Promise<BareName> {
  const text = name.trim();
  if (!text || text.includes("/")) return { kind: "none" };
  const spelt = sameModel(text);
  const [providers, groups, hidden] = await Promise.all([
    store.listProviders(),
    store.listRouteGroups(),
    store.listHiddenAutoGroups(),
  ]);
  const found = autoGroups(providers, {
    hidden,
    taken: groups.map((group) => group.id),
  }).filter((group) => !group.hidden);
  // The group of that ID, then of the name as vendors spell it: a user
  // group, or an automatic one of exactly that ID.
  for (const id of new Set([text.toLowerCase(), slug(spelt)])) {
    if (!GROUP_ID.test(id) || !(await usable(`group/${id}`))) continue;
    if (groups.some((group) => group.id === id))
      return { kind: "resolved", ref: `group/${id}`, via: "group" };
    if (found.some((group) => group.id === id))
      return { kind: "resolved", ref: `group/${id}`, via: "auto-group" };
  }
  // The automatic group of that model.
  const auto = found.find((group) => group.model === spelt);
  if (auto && (await usable(`group/${auto.id}`)))
    return {
      kind: "resolved",
      ref: `group/${auto.id as RouteGroupId}`,
      via: "auto-group",
    };
  // The one model of that ID the providers expose, else list.
  for (const models of [
    exposed,
    (provider: ProviderConfig) => provider.models.list.map((model) => model.id),
  ]) {
    const refs: string[] = [];
    for (const provider of providers)
      if (
        providerEnabled(provider) &&
        models(provider).includes(text) &&
        (await usable(`${provider.id}/${text}`))
      )
        refs.push(`${provider.id}/${text}`);
    if (refs.length === 1)
      return { kind: "resolved", ref: refs[0]!, via: "model" };
    if (refs.length > 1) return { kind: "ambiguous", refs: refs.sort() };
  }
  return { kind: "none" };
}
