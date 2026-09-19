#!/usr/bin/env node
/**
 * Publish files to a GitHub Release with the `gh` CLI (GH_TOKEN from the workflow) so the
 * public download names are replaced as late as possible:
 *
 * 1. every asset must be a regular file smaller than 2 GiB (GitHub's asset limit);
 * 2. the release is created as a prerelease when missing (notes/title/target apply only then,
 *    unless --notes-file is given, which also updates an existing release);
 * 3. all files are uploaded under `<name>.staging-<run>` names first;
 * 4. only then each old `<name>` asset is deleted and the staged one renamed to `<name>`;
 * 5. leftover `*.staging-*` assets and assets matching --prune (for example split volumes
 *    that the new upload no longer has) are deleted.
 * A cancelled run therefore leaves the previous public assets intact unless it is stopped
 * inside the short swap in step 4; the next run removes its staged leftovers.
 *
 * Usage: node scripts/publish-release-assets.mjs --tag TAG --asset FILE [--asset FILE ...]
 *   [--repo OWNER/NAME] [--title TEXT] [--notes-file FILE] [--target SHA] [--prune REGEX]
 *   [--run-id ID]
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, link, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const GITHUB_ASSET_LIMIT = 2 * 1024 ** 3;
const stagingPattern = /\.staging-[A-Za-z0-9_-]+$/;

/** Run `gh` and return stdout; rejects with stderr on a non-zero exit. */
export function runGh(args, { timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) =>
    execFile(
      "gh",
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `gh ${args.slice(0, 3).join(" ")} failed: ${String(
                stderr || error.message,
              )
                .trim()
                .slice(0, 1000)}`,
            ),
          );
        else resolve(stdout);
      },
    ),
  );
}

async function releaseAssets(gh, repo, tag) {
  const release = JSON.parse(
    await gh(["api", `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]),
  );
  return (release.assets ?? []).map((asset) => ({
    id: asset.id,
    name: asset.name,
  }));
}

/**
 * Publish `assets` to `tag`. `gh` is injectable for tests.
 *
 * @returns {Promise<{tag: string, published: string[], deleted: string[], created: boolean}>}
 */
export async function publishReleaseAssets(options) {
  const gh = options.gh ?? runGh;
  const { tag, repo } = options;
  if (!tag || !repo)
    throw new Error("--tag and --repo (or GITHUB_REPOSITORY) are required");
  if (!options.assets?.length)
    throw new Error("At least one --asset is required");
  const names = options.assets.map((file) => path.basename(file));
  if (new Set(names).size !== names.length)
    throw new Error("Asset file names must be unique");
  const limit = options.limit ?? GITHUB_ASSET_LIMIT;
  for (const file of options.assets) {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`Asset is not a regular file: ${file}`);
    if (info.size >= limit)
      throw new Error(
        `Asset ${path.basename(file)} is ${info.size} bytes; GitHub Release assets must be smaller than ${limit} bytes (2 GiB)`,
      );
  }
  const prune = options.prune ? new RegExp(options.prune) : undefined;
  let created = false;
  try {
    await gh(["release", "view", tag, "--repo", repo, "--json", "tagName"]);
  } catch {
    await gh([
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--prerelease",
      "--title",
      options.title ?? tag,
      ...(options.notesFile
        ? ["--notes-file", options.notesFile]
        : ["--notes", ""]),
      ...(options.target ? ["--target", options.target] : []),
    ]);
    created = true;
  }
  const run = options.runId ?? randomBytes(6).toString("hex");
  const suffix = `.staging-${run}`;
  const stageDirectory = path.join(
    path.dirname(path.resolve(options.assets[0])),
    `.release-staging-${run}`,
  );
  await mkdir(stageDirectory, { recursive: true });
  const deleted = [];
  try {
    const staged = [];
    for (const file of options.assets) {
      const target = path.join(
        stageDirectory,
        `${path.basename(file)}${suffix}`,
      );
      try {
        await link(path.resolve(file), target);
      } catch {
        await copyFile(path.resolve(file), target);
      }
      staged.push(target);
    }
    await gh([
      "release",
      "upload",
      tag,
      ...staged,
      "--repo",
      repo,
      "--clobber",
    ]);
    let assets = await releaseAssets(gh, repo, tag);
    for (const name of names) {
      const fresh = assets.find((asset) => asset.name === `${name}${suffix}`);
      if (!fresh)
        throw new Error(
          `Uploaded asset ${name}${suffix} is not listed on the release`,
        );
      const old = assets.find((asset) => asset.name === name);
      if (old) {
        await gh([
          "api",
          "-X",
          "DELETE",
          `repos/${repo}/releases/assets/${old.id}`,
        ]);
        deleted.push(name);
      }
      await gh([
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/releases/assets/${fresh.id}`,
        "-f",
        `name=${name}`,
      ]);
    }
    assets = await releaseAssets(gh, repo, tag);
    for (const asset of assets) {
      const stale =
        !names.includes(asset.name) &&
        (stagingPattern.test(asset.name) ||
          (prune !== undefined && prune.test(asset.name)));
      if (!stale) continue;
      await gh([
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/releases/assets/${asset.id}`,
      ]);
      deleted.push(asset.name);
    }
    if (options.notesFile && !created)
      await gh([
        "release",
        "edit",
        tag,
        "--repo",
        repo,
        "--notes-file",
        options.notesFile,
        ...(options.title ? ["--title", options.title] : []),
      ]);
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }
  return { tag, published: names, deleted, created };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        tag: { type: "string" },
        asset: { type: "string", multiple: true },
        repo: { type: "string" },
        title: { type: "string" },
        "notes-file": { type: "string" },
        target: { type: "string" },
        prune: { type: "string" },
        "run-id": { type: "string" },
      },
      strict: true,
    });
    const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
    const result = await publishReleaseAssets({
      tag: values.tag,
      repo,
      assets: values.asset ?? [],
      ...(values.title ? { title: values.title } : {}),
      ...(values["notes-file"] ? { notesFile: values["notes-file"] } : {}),
      ...(values.target ? { target: values.target } : {}),
      ...(values.prune ? { prune: values.prune } : {}),
      runId:
        values["run-id"] ??
        process.env.GITHUB_RUN_ID ??
        randomBytes(6).toString("hex"),
    });
    for (const name of result.published)
      console.log(
        `https://github.com/${repo}/releases/download/${encodeURIComponent(result.tag)}/${name}`,
      );
    console.log(JSON.stringify({ event: "release.published", ...result }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
