// SPDX-License-Identifier: MIT
/**
 * Brand marks of providers and agents, bundled with the console: the page
 * loads nothing from other origins (its CSP forbids it). The SVGs come from
 * `@lobehub/icons-static-svg` (MIT, github.com/lobehub/lobe-icons), named by
 * their lobehub slug as presets name them (`ProviderPreset.icon`); the marks
 * belong to their owners. Small files are inlined as data URIs by Vite; a
 * slug without a file fails the build.
 */
import ai302Color from "@lobehub/icons-static-svg/icons/ai302-color.svg?url";
import aihubmixColor from "@lobehub/icons-static-svg/icons/aihubmix-color.svg?url";
import azureColor from "@lobehub/icons-static-svg/icons/azure-color.svg?url";
import baiducloudColor from "@lobehub/icons-static-svg/icons/baiducloud-color.svg?url";
import bedrockColor from "@lobehub/icons-static-svg/icons/bedrock-color.svg?url";
import claudeColor from "@lobehub/icons-static-svg/icons/claude-color.svg?url";
import claudecodeColor from "@lobehub/icons-static-svg/icons/claudecode-color.svg?url";
import cline from "@lobehub/icons-static-svg/icons/cline.svg?url";
import codexColor from "@lobehub/icons-static-svg/icons/codex-color.svg?url";
import commandcode from "@lobehub/icons-static-svg/icons/commandcode.svg?url";
import deepseekColor from "@lobehub/icons-static-svg/icons/deepseek-color.svg?url";
import fireworksColor from "@lobehub/icons-static-svg/icons/fireworks-color.svg?url";
import geminiColor from "@lobehub/icons-static-svg/icons/gemini-color.svg?url";
import githubcopilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg?url";
import grok from "@lobehub/icons-static-svg/icons/grok.svg?url";
import groq from "@lobehub/icons-static-svg/icons/groq.svg?url";
import huaweicloudColor from "@lobehub/icons-static-svg/icons/huaweicloud-color.svg?url";
import kilocode from "@lobehub/icons-static-svg/icons/kilocode.svg?url";
import kimi from "@lobehub/icons-static-svg/icons/kimi.svg?url";
import lmstudio from "@lobehub/icons-static-svg/icons/lmstudio.svg?url";
import minimaxColor from "@lobehub/icons-static-svg/icons/minimax-color.svg?url";
import mistralColor from "@lobehub/icons-static-svg/icons/mistral-color.svg?url";
import modelscopeColor from "@lobehub/icons-static-svg/icons/modelscope-color.svg?url";
import nousresearch from "@lobehub/icons-static-svg/icons/nousresearch.svg?url";
import nvidiaColor from "@lobehub/icons-static-svg/icons/nvidia-color.svg?url";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg?url";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?url";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?url";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg?url";
import qoderColor from "@lobehub/icons-static-svg/icons/qoder-color.svg?url";
import qwenColor from "@lobehub/icons-static-svg/icons/qwen-color.svg?url";
import siliconcloudColor from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg?url";
import stepfunColor from "@lobehub/icons-static-svg/icons/stepfun-color.svg?url";
import tencentcloudColor from "@lobehub/icons-static-svg/icons/tencentcloud-color.svg?url";
import togetherColor from "@lobehub/icons-static-svg/icons/together-color.svg?url";
import vllm from "@lobehub/icons-static-svg/icons/vllm.svg?url";
import volcengineColor from "@lobehub/icons-static-svg/icons/volcengine-color.svg?url";
import xai from "@lobehub/icons-static-svg/icons/xai.svg?url";
import xiaomimimo from "@lobehub/icons-static-svg/icons/xiaomimimo.svg?url";
import zai from "@lobehub/icons-static-svg/icons/zai.svg?url";
import zhipuColor from "@lobehub/icons-static-svg/icons/zhipu-color.svg?url";

/** Bundled icons by lobehub slug. A slug missing here is shown as initials. */
const icons: Readonly<Record<string, string>> = {
  "ai302-color": ai302Color,
  "aihubmix-color": aihubmixColor,
  "azure-color": azureColor,
  "baiducloud-color": baiducloudColor,
  "bedrock-color": bedrockColor,
  "claude-color": claudeColor,
  "claudecode-color": claudecodeColor,
  cline: cline,
  "codex-color": codexColor,
  commandcode: commandcode,
  "deepseek-color": deepseekColor,
  "fireworks-color": fireworksColor,
  "gemini-color": geminiColor,
  githubcopilot: githubcopilot,
  grok: grok,
  groq: groq,
  "huaweicloud-color": huaweicloudColor,
  kilocode: kilocode,
  kimi: kimi,
  lmstudio: lmstudio,
  "minimax-color": minimaxColor,
  "mistral-color": mistralColor,
  "modelscope-color": modelscopeColor,
  nousresearch: nousresearch,
  "nvidia-color": nvidiaColor,
  ollama: ollama,
  openai: openai,
  opencode: opencode,
  openrouter: openrouter,
  "qoder-color": qoderColor,
  "qwen-color": qwenColor,
  "siliconcloud-color": siliconcloudColor,
  "stepfun-color": stepfunColor,
  "tencentcloud-color": tencentcloudColor,
  "together-color": togetherColor,
  vllm: vllm,
  "volcengine-color": volcengineColor,
  xai: xai,
  xiaomimimo: xiaomimimo,
  zai: zai,
  "zhipu-color": zhipuColor,
};

/** Slugs presets use that the icon package names differently. */
const aliases: Readonly<Record<string, string>> = {
  kilo: "kilocode",
  mimocode: "xiaomimimo",
};

/** The icon of each agent adapter, by adapter id; others show initials. */
const agentSlugs: Readonly<Record<string, string>> = {
  claude: "claudecode-color",
  codex: "codex-color",
  gemini: "gemini-color",
  qwen: "qwen-color",
  opencode: "opencode",
  kimi: "kimi",
  grok: "grok",
  qoder: "qoder-color",
  "qoder-cn": "qoder-color",
  cline: "cline",
  mimocode: "xiaomimimo",
  hermes: "nousresearch",
  "minimax-code": "minimax-color",
};

/**
 * The bundled icon for a lobehub slug: its URL and whether it is a
 * single-color mark drawn in black, which dark mode inverts.
 */
export function brandIcon(
  slug: string | undefined,
): { url: string; mono: boolean } | undefined {
  if (!slug) return undefined;
  const name = aliases[slug] ?? slug;
  const url = icons[name];
  return url ? { url, mono: !name.endsWith("-color") } : undefined;
}

/** The lobehub slug of an agent adapter, if one is bundled. */
export function agentIconSlug(adapterId: string): string | undefined {
  return agentSlugs[adapterId];
}
