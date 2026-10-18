import type { CapabilityEdge, CapabilityMechanism, CapabilityStatus, CapabilityWarning } from "../../../contracts/capabilities.js";

/**
 * The role a skills directory plays for one Harness (ADR-045): the shared `~/.agents/skills`, the Harness's own
 * directory, another product's directory it also reads, a directory its configuration adds, its workspace, the skills
 * the program installed with itself, or those it syncs from the user's account.
 */
export type SkillRootRole = "shared" | "own" | "compat" | "external" | "workspace" | "bundled" | "synced";
/**
 * How a Harness treats several skills of one name, by its documented or verified behavior:
 * - `dedupe-realpath`: one skill reached through several paths loads once; different skills of one name follow precedence (Claude Code).
 * - `all-visible`: every copy is listed (Codex: "both can appear").
 * - `last-wins-unordered`: one copy is kept, which one depends on load order (OpenCode 1.18.35 loads them concurrently).
 * - `precedence`: the copy in the higher-precedence root wins (Gemini, OpenClaw, Pi, Hermes).
 * - `unknown`: the Harness does not say (Cursor); every copy is shown as a duplicate with that said.
 */
export type DuplicateRule = "dedupe-realpath" | "all-visible" | "last-wins-unordered" | "precedence" | "unknown";

/** One entry of a skills directory, as read from disk. */
export interface ScannedSkill {
  readonly dirName: string;
  /** The entry's path, with ~ for the home directory. */
  readonly shown: string;
  /** The link's resolved target; null for a link to nothing. Absent for a real directory. */
  readonly link?: { readonly target: string | null };
  readonly realPath: string | null;
  readonly skillFile: boolean;
  /** The frontmatter's name and description; null when absent. `frontmatter` is false when it could not be parsed. */
  readonly name: string | null;
  readonly description: string | null;
  readonly frontmatter: boolean;
}
/** One skills directory of one Harness, scanned. A higher `precedence` wins. */
export interface ScannedRoot {
  readonly role: SkillRootRole;
  readonly shown: string;
  readonly realPath: string | null;
  readonly precedence: number;
  /** The Harness skips an entry whose real path leaves this root (OpenClaw). */
  readonly containment: boolean;
  readonly entries: readonly ScannedSkill[];
}
export interface SkillRules {
  readonly duplicates: DuplicateRule;
  readonly requiresDescription: boolean;
  readonly nameMustMatchDirectory: boolean;
  /**
   * Roles whose skills are not weighed against the others by name: the Harness loads both, and which one a bare name
   * calls is not documented (Claude Code's synced skills). A shared name is still warned about.
   */
  readonly separate?: readonly SkillRootRole[];
  /** Why the Harness has this skill turned off in its own configuration; null when it does not. */
  readonly disabled: (name: string, realPath: string | null) => string | null;
}
/** One skill as one Harness sees it. */
export interface SkillEdge extends CapabilityEdge { readonly name: string; readonly realPath: string | null }

function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + "/"); }
function mechanismOf(role: SkillRootRole, entry: ScannedSkill): CapabilityMechanism {
  switch (role) {
    case "shared": return "native-shared";
    case "own": case "workspace": return entry.link ? "linked" : "own-copy";
    case "compat": return "compat-root";
    case "external": return "external-dir";
    case "bundled": return "bundled";
    case "synced": return "synced";
  }
}

/**
 * Every skill one Harness sees, with its mechanism and status, by that Harness's rules (ADR-045): entries it cannot use
 * first (a link to nothing, no SKILL.md, frontmatter it rejects, a real path leaving a contained root), then several
 * skills of one name by its duplicate rule, then its own disabled list. Warnings say what the user should know:
 * duplicates, and links the Harness skips because it already reads their target.
 */
export function skillVisibility(harnessId: string, harnessName: string, roots: readonly ScannedRoot[], rules: SkillRules): { readonly edges: readonly SkillEdge[]; readonly warnings: readonly (CapabilityWarning & { readonly name: string })[] } {
  const edges: SkillEdge[] = [], warnings: (CapabilityWarning & { name: string })[] = [], usable: { edge: SkillEdge; precedence: number; separate: boolean }[] = [];
  const readRoots = roots.flatMap(root => root.realPath === null ? [] : [{ realPath: root.realPath, shown: root.shown }]);
  for (const root of roots) for (const entry of root.entries) {
    const name = entry.name ?? entry.dirName, mechanism = mechanismOf(root.role, entry);
    const edge = (status: CapabilityStatus, reason: string | null): SkillEdge => ({ harnessId, name, realPath: entry.realPath, mechanism, status, via: entry.shown, reason });
    if (entry.link && entry.link.target === null) { edges.push(edge("broken-link", "链接指向的位置已不存在")); continue; }
    if (!entry.skillFile) { edges.push(edge("invalid", "目录里没有 SKILL.md")); continue; }
    if (!entry.frontmatter) { edges.push(edge("invalid", "SKILL.md 的 frontmatter 无法解析")); continue; }
    if (rules.requiresDescription && (entry.description === null || entry.name === null)) { edges.push(edge("invalid", harnessName + " 要求 frontmatter 写明 name 和 description")); continue; }
    if (rules.nameMustMatchDirectory && entry.name !== null && entry.name !== entry.dirName) { edges.push(edge("invalid", harnessName + " 要求 name 与目录同名（这里是 " + entry.name + "）")); continue; }
    if (root.containment && root.realPath !== null && (entry.realPath === null || !inside(entry.realPath, root.realPath))) {
      const covering = entry.realPath === null ? undefined : readRoots.find(other => other.realPath !== root.realPath && inside(entry.realPath!, other.realPath));
      edges.push(edge("rejected", "真实路径在 " + root.shown + " 之外，" + harnessName + " 跳过它"));
      if (covering) warnings.push({ kind: "redundant", harnessId, name, text: harnessName + " 已从 " + covering.shown + " 读取 " + name + "，" + entry.shown + " 这个链接是多余的，会被跳过。" });
      continue;
    }
    usable.push({ edge: edge("active", null), precedence: root.precedence, separate: rules.separate?.includes(root.role) ?? false });
  }
  const byName = new Map<string, { edge: SkillEdge; precedence: number }[]>();
  for (const item of usable) { const key = (item.separate ? "\u0000" : "") + item.edge.name; byName.set(key, [...(byName.get(key) ?? []), item]); }
  for (const [key, group] of byName) {
    const name = group[0]!.edge.name;
    if (!key.startsWith("\u0000") && byName.has("\u0000" + name)) warnings.push({ kind: "duplicate", harnessId, name,
      text: harnessName + " 同时加载 " + [...group, ...byName.get("\u0000" + name)!].map(item => item.edge.via).join("、") + " 里的 " + name + "，用名字调用时用哪一份没有说明。" });
    let decided: SkillEdge[];
    const ranked = [...group].sort((left, right) => right.precedence - left.precedence);
    if (group.length === 1) decided = [group[0]!.edge];
    else switch (rules.duplicates) {
      case "all-visible":
        decided = group.map(item => item.edge);
        warnings.push({ kind: "duplicate", harnessId, name, text: harnessName + " 会同时列出 " + group.length + " 个名为 " + name + " 的技能：" + group.map(item => item.edge.via).join("、") + "。" });
        break;
      case "unknown":
        decided = group.map(item => ({ ...item.edge, status: "duplicate" as const, reason: harnessName + " 没有说明同名技能怎样处理" }));
        warnings.push({ kind: "duplicate", harnessId, name, text: harnessName + " 在 " + group.map(item => item.edge.via).join("、") + " 都找到 " + name + "，它没有说明会用哪一份。" });
        break;
      case "last-wins-unordered":
        decided = group.map(item => ({ ...item.edge, status: "duplicate" as const, reason: harnessName + " 只保留其中一份，保留哪一份取决于加载先后" }));
        warnings.push({ kind: "duplicate", harnessId, name, text: harnessName + " 在 " + group.map(item => item.edge.via).join("、") + " 都找到 " + name + "，只保留一份，哪一份不确定。" });
        break;
      case "dedupe-realpath": {
        const winner = ranked[0]!.edge, distinct = new Set(group.map(item => item.edge.realPath));
        decided = ranked.map((item, index) => index === 0 ? item.edge : item.edge.realPath !== null && item.edge.realPath === winner.realPath
          ? { ...item.edge, status: "duplicate" as const, reason: "与 " + winner.via + " 是同一份，只加载一次" }
          : { ...item.edge, status: "shadowed" as const, reason: "被 " + winner.via + " 覆盖" });
        if (distinct.size > 1) warnings.push({ kind: "shadow", harnessId, name, text: harnessName + " 有 " + distinct.size + " 个不同的 " + name + "，使用 " + winner.via + "。" });
        break;
      }
      case "precedence": {
        const winner = ranked[0]!.edge;
        decided = ranked.map((item, index) => index === 0 ? item.edge : { ...item.edge, status: "shadowed" as const, reason: "被 " + winner.via + " 覆盖" });
        if (new Set(group.map(item => item.edge.realPath)).size > 1) warnings.push({ kind: "shadow", harnessId, name, text: harnessName + " 有不止一个 " + name + "，使用优先级更高的 " + winner.via + "。" });
        break;
      }
    }
    edges.push(...decided.map(edge => { const off = edge.status === "active" || edge.status === "duplicate" ? rules.disabled(name, edge.realPath) : null; return off === null ? edge : { ...edge, status: "disabled" as const, reason: off }; }));
  }
  return { edges, warnings };
}
