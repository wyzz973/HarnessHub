#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Validate .github/labels.yml and, with --sync, apply it to a GitHub repository.
 * Usage: node scripts/check-labels.mjs [--file <path>] [--sync]
 *
 * The file is the single source of truth for labels: a YAML list of
 * `{name, color, description}` with unique names (case-insensitive, as GitHub
 * compares them), 6-digit hex colors and descriptions of at most 100
 * characters. --sync reads GITHUB_REPOSITORY and GITHUB_TOKEN, creates missing
 * labels and updates differing ones. It never deletes a label: labels missing
 * from the file are only reported, so removing one stays a reviewed manual step.
 * Exits non-zero on an invalid file or any failed API request.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const DEFAULT_FILE = fileURLToPath(new URL("../.github/labels.yml", import.meta.url));
const MAX_DESCRIPTION = 100;
const API = "https://api.github.com";

/**
 * Parse and validate label definitions.
 *
 * @param {string} text YAML source.
 * @returns {{labels: {name: string, color: string, description: string}[], diagnostics: string[]}}
 *   Labels are only meaningful when diagnostics is empty; an empty list is a diagnostic.
 */
export function parseLabels(text) {
  const diagnostics = [];
  let raw;
  try {
    raw = parse(text);
  } catch (error) {
    return { labels: [], diagnostics: [`invalid YAML: ${error.message}`] };
  }
  if (!Array.isArray(raw) || raw.length === 0)
    return { labels: [], diagnostics: ["expected a non-empty list of labels"] };
  const labels = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    const where = `label ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push(`${where}: expected a mapping`);
      return;
    }
    const extra = Object.keys(entry).filter((key) => !["name", "color", "description"].includes(key));
    if (extra.length) diagnostics.push(`${where}: unknown fields ${extra.join(", ")}`);
    const { name, color, description } = entry;
    if (typeof name !== "string" || !name.trim() || name !== name.trim())
      diagnostics.push(`${where}: name must be a non-empty string without surrounding spaces`);
    else if (seen.has(name.toLowerCase())) diagnostics.push(`${where}: duplicate name ${name}`);
    else seen.add(name.toLowerCase());
    if (typeof color !== "string" || !/^[0-9a-f]{6}$/.test(color))
      diagnostics.push(`${where}: color must be 6 lowercase hex digits in quotes, without "#"`);
    if (typeof description !== "string" || !description.trim())
      diagnostics.push(`${where}: description is required`);
    else if (description.length > MAX_DESCRIPTION)
      diagnostics.push(`${where}: description longer than ${MAX_DESCRIPTION} characters`);
    labels.push({ name, color, description });
  });
  return { labels, diagnostics };
}

/**
 * Bring a repository's labels in line with the definitions.
 *
 * @param {object} options
 * @param {{name: string, color: string, description: string}[]} options.labels Validated definitions.
 * @param {string} options.repository `owner/name`.
 * @param {string} options.token Token with `issues: write`.
 * @param {typeof fetch} [options.fetch] Injected for tests.
 * @returns {Promise<{created: string[], updated: string[], unmanaged: string[]}>}
 *   Rejects on the first failed request; earlier changes stay applied and a rerun converges.
 */
export async function syncLabels({ labels, repository, token, fetch: request = fetch }) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  async function call(method, route, body) {
    const response = await request(`${API}/repos/${repository}${route}`, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${method} ${route} failed: ${response.status} ${await response.text()}`);
    return response.status === 204 ? undefined : response.json();
  }

  const existing = new Map();
  for (let page = 1; ; page += 1) {
    const batch = await call("GET", `/labels?per_page=100&page=${page}`);
    for (const label of batch) existing.set(label.name.toLowerCase(), label);
    if (batch.length < 100) break;
  }

  const created = [];
  const updated = [];
  for (const label of labels) {
    const current = existing.get(label.name.toLowerCase());
    existing.delete(label.name.toLowerCase());
    if (!current) {
      await call("POST", "/labels", label);
      created.push(label.name);
    } else if (
      current.name !== label.name ||
      current.color.toLowerCase() !== label.color ||
      (current.description ?? "") !== label.description
    ) {
      await call("PATCH", `/labels/${encodeURIComponent(current.name)}`, {
        new_name: label.name,
        color: label.color,
        description: label.description,
      });
      updated.push(label.name);
    }
  }
  return { created, updated, unmanaged: [...existing.values()].map((label) => label.name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fileIndex = process.argv.indexOf("--file");
  const file = fileIndex > 0 ? process.argv[fileIndex + 1] : DEFAULT_FILE;
  const { labels, diagnostics } = parseLabels(await readFile(file, "utf8"));
  for (const line of diagnostics) console.error(line);
  if (diagnostics.length) process.exit(1);
  if (!process.argv.includes("--sync")) {
    console.log(`${labels.length} label definitions are valid.`);
  } else {
    const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env;
    if (!repository || !token) {
      console.error("--sync requires GITHUB_REPOSITORY and GITHUB_TOKEN");
      process.exit(1);
    }
    const result = await syncLabels({ labels, repository, token });
    console.log(`Created ${result.created.length}: ${result.created.join(", ") || "-"}`);
    console.log(`Updated ${result.updated.length}: ${result.updated.join(", ") || "-"}`);
    if (result.unmanaged.length)
      console.log(`Not in labels.yml (left unchanged): ${result.unmanaged.join(", ")}`);
  }
}
