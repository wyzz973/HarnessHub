// SPDX-License-Identifier: MIT
/**
 * Automatic route groups (Magpie's found groups, `internal/provider/group.go`):
 * a model that two or more ready providers serve under the same name, however
 * each vendor spells it, is also the route group `group/auto-<slug>`. They are
 * derived from the providers whenever they are needed and never stored; only
 * the IDs that the user hid are (`ModelPlaneStore.listHiddenAutoGroups`).
 */
import {
  parseModelRef,
  providerEnabled,
  type ModelRef,
  type ProviderConfig,
  type RouteGroup,
  type RouteGroupId,
} from "./model-plane.js";

/** Every automatic group's ID starts with this. */
export const AUTO_GROUP_PREFIX = "auto-";

function digit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

/** `YYYYMMDD` from 2000 on, or Volcengine Ark's `YYMMDD` of 2023 to 2039 with a valid month and day. */
function snapshotDate(text: string): boolean {
  if (!/^\d+$/.test(text)) return false;
  if (text.length === 8) return text.startsWith("20");
  if (text.length !== 6) return false;
  const [year, month, day] = [0, 2, 4].map((at) =>
    Number(text.slice(at, at + 2)),
  ) as [number, number, number];
  return (
    year >= 23 &&
    year <= 39 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31
  );
}

/**
 * A model's name as vendors agree on it: lowercase, `_` as `-`, only the part
 * after the last `/` (no vendor prefix), a version's `.` or `p` between digits
 * as `-` (`claude-opus-4.5` and `deepseek-v4p1`), and without a snapshot date
 * (`-YYYYMMDD`, Vertex's `@YYYYMMDD`, Ark's `-YYMMDD`). Variants such as
 * `:free`, `-thinking` or a four-digit release (`-2507`) stay.
 */
export function sameModel(id: string): string {
  let key = id.trim().toLowerCase().replaceAll("_", "-");
  key = key.slice(key.lastIndexOf("/") + 1);
  const chars = key.split("");
  for (let index = 1; index + 1 < chars.length; index++)
    if (
      (chars[index] === "." || chars[index] === "p") &&
      digit(chars[index - 1]) &&
      digit(chars[index + 1])
    )
      chars[index] = "-";
  key = chars.join("");
  const cut = Math.max(key.lastIndexOf("-"), key.lastIndexOf("@"));
  if (cut > 0 && snapshotDate(key.slice(cut + 1))) key = key.slice(0, cut);
  return key;
}

/** Lowercase letters and digits, every other run as one `-`, no `-` at either end. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One automatic group as derived from the providers. */
export interface AutoGroup {
  id: RouteGroupId;
  /** The name its members share ({@link sameModel}). */
  model: string;
  /** One Model Ref per provider, in the order the providers were added. */
  members: ModelRef[];
  hidden: boolean;
  /** When the last member's provider was added, the group's own creation. */
  createdAt: string;
}

function exposed(provider: ProviderConfig) {
  const expose = provider.models.expose;
  return expose === "all"
    ? provider.models.list
    : provider.models.list.filter((model) => expose.includes(model.id));
}

/** A provider can serve a call: it is switched on, and keyless or with an enabled credential. */
function ready(provider: ProviderConfig): boolean {
  return (
    providerEnabled(provider) &&
    (provider.credentials.length === 0 ||
      provider.credentials.some((credential) => credential.enabled))
  );
}

/**
 * The automatic groups of these providers. Each ready provider contributes
 * its first exposed model of each {@link sameModel} name; a name that two or
 * more providers contribute is the group `auto-<slug of the name>` (the slug
 * cut to fit a group ID). A user group of the same ID takes its place, so
 * `taken` IDs are left out; `hidden` IDs are listed with `hidden: true`.
 */
export function autoGroups(
  providers: readonly ProviderConfig[],
  options: { hidden?: Iterable<string>; taken?: Iterable<string> } = {},
): AutoGroup[] {
  const hidden = new Set(options.hidden ?? []);
  const taken = new Set(options.taken ?? []);
  const added = [...providers]
    .filter(ready)
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const byName = new Map<
    string,
    { ref: ModelRef; provider: ProviderConfig }[]
  >();
  for (const provider of added)
    for (const model of exposed(provider)) {
      const name = sameModel(model.id);
      const entries = byName.get(name) ?? [];
      if (entries.some((entry) => entry.provider.id === provider.id)) continue;
      entries.push({
        ref: `${provider.id}/${model.id}` as ModelRef,
        provider,
      });
      byName.set(name, entries);
    }
  const groups: AutoGroup[] = [];
  const seen = new Set<string>();
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    const tail = slug(name).slice(0, 63 - AUTO_GROUP_PREFIX.length);
    const id = `${AUTO_GROUP_PREFIX}${tail.replace(/-+$/, "")}`;
    if (
      id === AUTO_GROUP_PREFIX ||
      parseModelRef(`group/${id}`)?.kind !== "group" ||
      taken.has(id) ||
      seen.has(id)
    )
      continue;
    seen.add(id);
    groups.push({
      id: id as RouteGroupId,
      model: name,
      members: entries.map((entry) => entry.ref),
      hidden: hidden.has(id),
      createdAt: entries
        .map((entry) => entry.provider.createdAt)
        .reduce((latest, at) =>
          Date.parse(at) > Date.parse(latest) ? at : latest,
        ),
    });
  }
  return groups;
}

/** How an automatic group routes: its members in order, with `auto` stickiness. */
export function autoRouteGroup(group: AutoGroup): RouteGroup {
  return {
    id: group.id,
    strategy: "order",
    stickiness: "auto",
    members: group.members,
    createdAt: group.createdAt,
    updatedAt: group.createdAt,
  };
}
