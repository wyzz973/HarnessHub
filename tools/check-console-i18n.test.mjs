// SPDX-License-Identifier: MIT
/**
 * The console's message catalogs (packages/console/lib/messages): both
 * languages have the same keys and placeholders, no key belongs to two
 * areas, English has no Chinese, and no component or library module
 * writes Chinese text outside the catalogs.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { consoleModule } from "./console-module.mjs";

const CONSOLE = fileURLToPath(new URL("../packages/console/", import.meta.url));
const CJK = /[　-〿㐀-鿿＀-￯]/;

/** Placeholder names of a message: `{name}` and `{name, plural, …}`. */
function placeholders(text) {
  const names = new Set();
  let depth = 0;
  let start = -1;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "{") {
      if (depth === 0) start = at + 1;
      depth++;
    } else if (text[at] === "}" && --depth === 0)
      names.add(text.slice(start, at).split(",")[0].trim());
  }
  return [...names].sort();
}

/** What is wrong with one area's catalogs; empty when nothing is. */
export function catalogProblems(area, catalogs) {
  const problems = [];
  const zh = Object.keys(catalogs.zh);
  const en = Object.keys(catalogs.en);
  for (const key of zh)
    if (!(key in catalogs.en)) problems.push(`${area}: en lacks ${key}`);
  for (const key of en)
    if (!(key in catalogs.zh)) problems.push(`${area}: zh-CN lacks ${key}`);
  for (const key of zh) {
    if (!key.startsWith(`${area}.`))
      problems.push(`${area}: ${key} does not start with "${area}."`);
    const source = catalogs.zh[key];
    const english = catalogs.en[key];
    if (typeof source !== "string" || !source.trim())
      problems.push(`${area}: zh-CN ${key} is empty`);
    if (typeof english !== "string" || !english.trim()) {
      problems.push(`${area}: en ${key} is empty`);
      continue;
    }
    if (CJK.test(english)) problems.push(`${area}: en ${key} has Chinese text`);
    if (/\{[^}]*,\s*plural/.test(source))
      problems.push(`${area}: zh-CN ${key} uses a plural form`);
    const want = placeholders(source).join(",");
    const got = placeholders(english).join(",");
    if (want !== got)
      problems.push(`${area}: ${key} has placeholders {${got}} in en, {${want}} in zh-CN`);
  }
  return problems;
}

/**
 * Chinese text that a console source writes outside the catalogs, by
 * line. Comments are skipped; `allowed` holds the lines that must stay.
 */
export function literalProblems(file, source, allowed = []) {
  const problems = [];
  const lines = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .split("\n");
  lines.forEach((line, index) => {
    const code = line.replace(/(^|[^:"'`])\/\/.*$/, "$1");
    if (CJK.test(code) && !allowed.some((pattern) => pattern.test(code)))
      problems.push(`${file}:${index + 1}: ${code.trim()}`);
  });
  return problems;
}

/** Lines that keep Chinese text on purpose, each with its reason. */
const ALLOWED = {
  // A language's own name is shown in that language in the switch.
  "lib/i18n.ts": [/"zh-CN": "中文"/],
  // Lists typed by people may be separated by full-width commas.
  "components/settings-page.tsx": [/\[\\s,，\]/],
};

async function sources(directory) {
  const entries = await readdir(path.join(CONSOLE, directory), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) =>
      path.relative(CONSOLE, path.join(entry.parentPath, entry.name)),
    )
    .filter((file) => !file.startsWith(`lib${path.sep}messages${path.sep}`));
}

test("each area's catalogs have the same keys and placeholders in zh-CN and en", async () => {
  const { areas } = await consoleModule("lib/messages/index.ts");
  const problems = [];
  const owners = new Map();
  for (const [area, catalogs] of Object.entries(areas)) {
    problems.push(...catalogProblems(area, catalogs));
    for (const key of Object.keys(catalogs.zh)) {
      if (owners.has(key)) problems.push(`${key} is in ${owners.get(key)} and ${area}`);
      owners.set(key, area);
    }
  }
  assert.deepEqual(problems, []);
  // Rejection samples: a key missing in English, an extra one, other placeholders, Chinese in English.
  assert.deepEqual(
    catalogProblems("demo", {
      zh: { "demo.a": "第 {n} 个", "demo.b": "二", "demo.c": "{name} 已保存" },
      en: { "demo.a": "Item {count}", "demo.c": "已保存 {name}", "demo.d": "Extra" },
    }),
    [
      "demo: en lacks demo.b",
      "demo: zh-CN lacks demo.d",
      "demo: demo.a has placeholders {count} in en, {n} in zh-CN",
      "demo: en demo.b is empty",
      "demo: en demo.c has Chinese text",
    ],
  );
  assert.deepEqual(
    catalogProblems("demo", {
      zh: { "demo.n": "{n} 个模型" },
      en: { "demo.n": "{n, plural, one {# model} other {# models}}" },
    }),
    [],
    "an English plural form uses the same placeholder",
  );
});

test("no console source writes Chinese text outside the catalogs", async () => {
  const problems = [];
  for (const directory of ["components", "lib", "src"])
    for (const file of await sources(directory))
      problems.push(
        ...literalProblems(
          file,
          await readFile(path.join(CONSOLE, file), "utf8"),
          ALLOWED[file.split(path.sep).join("/")],
        ),
      );
  assert.deepEqual(problems, []);
  // Rejection samples: JSX text, a string literal and a template literal; a comment is fine.
  assert.deepEqual(
    literalProblems("demo.tsx", [
      "// 注释可以写中文",
      "/* 这里也可以 */",
      "export const Demo = () => <p>你好</p>;",
      'const label = "保存";',
      "const text = `已删除 ${name}`;",
    ].join("\n")),
    [
      "demo.tsx:3: export const Demo = () => <p>你好</p>;",
      'demo.tsx:4: const label = "保存";',
      "demo.tsx:5: const text = `已删除 ${name}`;",
    ],
  );
});

test("messages take their values, plural forms and the locale's number format", async () => {
  const i18n = await consoleModule("lib/i18n.ts");
  assert.equal(i18n.preferredLocale(["fr-FR", "zh-TW", "en-US"]), "zh-CN");
  assert.equal(i18n.preferredLocale(["en-GB", "zh-CN"]), "en");
  assert.equal(i18n.preferredLocale(["de-DE"]), "en", "other languages get English");
  const parts = (text, params, locale) => i18n.messageParts(text, params, locale).join("");
  assert.equal(parts("{n, plural, one {# model} other {# models}}", { n: 1 }, "en"), "1 model");
  assert.equal(parts("{n, plural, one {# model} other {# models}}", { n: 1200 }, "en"), "1,200 models");
  assert.equal(parts("已用 {n}%", { n: 25 }, "zh-CN"), "已用 25%");
  assert.equal(parts("Saved {name}", { name: "team" }, "en"), "Saved team");
  const node = { element: true };
  assert.deepEqual(i18n.messageParts("Open {link} now", { link: node }, "en"), ["Open ", node, " now"]);
  assert.equal(i18n.formatUsd("0.0021", "en"), "$0.0021");
  assert.equal(i18n.formatUsd(12.5, "en"), "$12.50");
});
