import brand_agoragentic_acp from "../assets/agoragentic-acp.svg";
import brand_autohand from "../assets/autohand.svg";
import brand_cortex_code from "../assets/cortex-code.svg";
import brand_corust_agent from "../assets/corust-agent.svg";
import brand_crow_cli from "../assets/crow-cli.svg";
import brand_deepagents from "../assets/deepagents.svg";
import brand_dimcode from "../assets/dimcode.svg";
import brand_fast_agent from "../assets/fast-agent.svg";
import brand_harn from "../assets/harn.svg";
import brand_kimchi from "../assets/kimchi.svg";
import brand_minion_code from "../assets/minion-code.svg";
import brand_sigit from "../assets/sigit.svg";
import brand_vtcode from "../assets/vtcode.svg";
import amp from "@lobehub/icons-static-svg/icons/amp-color.svg";
import antigravity from "@lobehub/icons-static-svg/icons/antigravity-color.svg";
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg";
import claudeCode from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import claude from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import cline from "@lobehub/icons-static-svg/icons/cline.svg";
import codebuddy from "@lobehub/icons-static-svg/icons/codebuddy-color.svg";
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg";
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import devin from "@lobehub/icons-static-svg/icons/devin.svg";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import copilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg";
import glm from "@lobehub/icons-static-svg/icons/chatglm-color.svg";
import goose from "@lobehub/icons-static-svg/icons/goose.svg";
import grok from "@lobehub/icons-static-svg/icons/grok.svg";
import hermes from "@lobehub/icons-static-svg/icons/hermesagent.svg";
import junie from "@lobehub/icons-static-svg/icons/junie-color.svg";
import kilo from "@lobehub/icons-static-svg/icons/kilocode.svg";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import openclaw from "@lobehub/icons-static-svg/icons/openclaw-color.svg";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import pi from "@lobehub/icons-static-svg/icons/pi.svg";
import poolside from "@lobehub/icons-static-svg/icons/poolside-color.svg";
import qoder from "@lobehub/icons-static-svg/icons/qoder-color.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import factory from "../assets/factory.svg";
import auggie from "../assets/auggie.svg";
import dirac from "../assets/dirac.svg";
import nova from "../assets/nova.svg";
import stakpak from "../assets/stakpak.svg";
import dshApp from "../assets/dsh-app.png";
import workbuddyApp from "../assets/workbuddy-app.png";
import { cn } from "../lib/cn.js";

/** Pinned local images identify known products. Initials are explicitly generic for brands without reviewed assets. */
const assets: Readonly<Record<string, string>> = {
  "agoragentic-acp": brand_agoragentic_acp,
  "autohand": brand_autohand,
  "cortex-code": brand_cortex_code,
  "corust-agent": brand_corust_agent,
  "crow-cli": brand_crow_cli,
  "deepagents": brand_deepagents,
  "dimcode": brand_dimcode,
  "fast-agent": brand_fast_agent,
  "harn": brand_harn,
  "kimchi": brand_kimchi,
  "minion-code": brand_minion_code,
  "sigit": brand_sigit,
  "vtcode": brand_vtcode,

  "amp-acp": amp, "antigravity-acp": antigravity, anthropic, auggie, claude, cline, "codebuddy-code": codebuddy, codex, cursor,
  "claude-acp": claudeCode, "claude-code": claudeCode, "pi-acp": pi, deepseek, dsh: dshApp, devin, hermes, "factory-droid": factory, gemini, "github-copilot": copilot, "github-copilot-cli": copilot, "glm-acp-agent": glm, goose, "grok-build": grok,
  dirac, junie, kilo, kimi, "minimax-code": minimax, "mistral-vibe": mistral, nova, openai, openclaw, opencode, openrouter, pi, poolside, qoder, qwen, "qwen-code": qwen, stakpak,
  workbuddy: workbuddyApp,
};
/**
 * How a mark sits in its tile (Icons board): "app" is a Mac application icon that fills the tile; "tile" is a mark drawn
 * as its own tile (Codex) and also fills it; "mono" is a single-color mark, drawn black and inverted in the dark; every
 * other official mark is "mark", two thirds of a white rounded tile (dark grey in the dark).
 */
type Kind = "app" | "tile" | "mono" | "mark";
const APP = new Set(["dsh", "workbuddy"]);
const TILE = new Set(["codex"]);
/** Single-color marks: the Lobe icons drawn in currentColor and every local SVG, which an <img> renders black. */
const MONOCHROME = new Set(["anthropic", "cline", "cursor", "devin", "github-copilot", "github-copilot-cli", "goose", "grok-build", "hermes", "kilo", "openai", "opencode", "pi", "pi-acp",
  "agoragentic-acp", "autohand", "cortex-code", "corust-agent", "crow-cli", "deepagents", "dimcode", "fast-agent", "harn", "kimchi", "minion-code", "sigit", "vtcode",
  "factory-droid", "auggie", "dirac", "nova", "stakpak"]);
function kindOf(brand: string): Kind { return APP.has(brand) ? "app" : TILE.has(brand) ? "tile" : MONOCHROME.has(brand) ? "mono" : "mark"; }

/**
 * An Agent's or Provider's identity: its official mark in a uniform rounded tile, or its Mac application icon. Never
 * smaller than 16 px. Products without a reviewed asset show their initials in the same tile, marked as generic.
 * Decorative: the name always appears next to it or names the control it sits in.
 */
export function BrandIcon({ brand, name, size = 24, className }: { readonly brand: string; readonly name: string; readonly size?: number; readonly className?: string }) {
  const source = assets[brand], side = Math.max(16, Math.round(size)), radius = Math.round(side * .28), kind = kindOf(brand);
  if (!source) {
    const characters = Array.from(name.trim());
    const initials = /^[\x20-\x7e]$/u.test(characters[0] ?? "") ? characters.slice(0, 2).join("").toLocaleUpperCase() : characters[0] ?? "?";
    return <span className={cn("brand-tile brand-icon brand-fallback select-none", className)} data-kind="mark" data-brand={brand} style={{ width: side, height: side, borderRadius: radius, fontSize: Math.max(8, Math.round(side * .4)) }}
      aria-hidden="true" title={`${name}：通用标识`}>{initials}</span>;
  }
  const inner = kind === "app" || kind === "tile" ? side : Math.round(side * .66);
  return <span className={cn("brand-tile", className)} data-kind={kind} data-brand={brand} style={{ width: side, height: side, borderRadius: radius }} aria-hidden="true">
    <img className={cn("brand-icon select-none", kind === "mono" && "brand-mono")} src={source} alt="" width={inner} height={inner} draggable={false}/>
  </span>;
}
export function providerBrand(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    if (host === "api.openai.com") return "openai";
    if (host === "api.anthropic.com") return "anthropic";
    if (host === "generativelanguage.googleapis.com") return "gemini";
    if (host === "api.deepseek.com") return "deepseek";
    if (host === "openrouter.ai") return "openrouter";
    if (host === "api.moonshot.ai" || host === "api.moonshot.cn") return "kimi";
  } catch { /* A validated Provider normally has an absolute URL; a generic identity remains accurate. */ }
  return "custom";
}
