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

/** Pinned local SVGs identify known products. Initials are explicitly generic for brands without reviewed assets. */
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
  "claude-acp": claudeCode, "claude-code": claudeCode, "pi-acp": pi, deepseek, devin, "factory-droid": factory, gemini, "github-copilot": copilot, "github-copilot-cli": copilot, "glm-acp-agent": glm, goose, "grok-build": grok,
  dirac, junie, kilo, kimi, "minimax-code": minimax, "mistral-vibe": mistral, nova, openai, openclaw, opencode, openrouter, pi, poolside, qoder, qwen, "qwen-code": qwen, stakpak,
};
export function BrandIcon({ brand, name, size = 24 }: { brand: string; name: string; size?: number }) {
  const source = assets[brand];
  const characters = Array.from(name.trim());
  const initials = /^[\x20-\x7e]$/u.test(characters[0] ?? "") ? characters.slice(0, 2).join("").toLocaleUpperCase() : characters[0] ?? "?";
  return source ? <img className="brand-icon" src={source} alt="" width={size} height={size} aria-hidden="true"/>
    : <span className="brand-icon brand-fallback" style={{ width: size, height: size, fontSize: Math.max(12, Math.round(size * .37)) }} aria-hidden="true" title={`${name}：通用标识`}>{initials}</span>;
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
