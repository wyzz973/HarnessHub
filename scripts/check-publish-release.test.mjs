import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishReleaseAssets } from "./publish-release-assets.mjs";

/** In-memory stand-in for the parts of `gh` the publisher uses. */
function fakeGh(initial) {
  let release = initial
    ? { assets: initial.map((name, index) => ({ id: index + 1, name })) }
    : undefined;
  let nextId = 100;
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const [command, sub] = args;
    if (command === "release" && sub === "view") {
      if (!release) throw new Error("release not found");
      return "{}";
    }
    if (command === "release" && sub === "create") {
      release = { assets: [] };
      return "";
    }
    if (command === "release" && sub === "edit") return "";
    if (command === "release" && sub === "upload") {
      const files = args.slice(3, args.indexOf("--repo"));
      for (const file of files) {
        const name = path.basename(file);
        release.assets = release.assets.filter((asset) => asset.name !== name);
        release.assets.push({ id: nextId++, name });
      }
      return "";
    }
    if (command === "api" && args[1] === "-X" && args[2] === "DELETE") {
      const id = Number(args[3].split("/").at(-1));
      release.assets = release.assets.filter((asset) => asset.id !== id);
      return "";
    }
    if (command === "api" && args[1] === "-X" && args[2] === "PATCH") {
      const id = Number(args[3].split("/").at(-1));
      const name = args[5].slice("name=".length);
      assert.equal(
        release.assets.some((asset) => asset.name === name),
        false,
        `rename target ${name} still exists`,
      );
      release.assets.find((asset) => asset.id === id).name = name;
      return "";
    }
    if (command === "api") return JSON.stringify({ assets: release.assets });
    throw new Error(`unexpected gh call ${args.join(" ")}`);
  };
  return {
    gh,
    calls,
    names: () => release.assets.map((asset) => asset.name).sort(),
    release: () => release,
  };
}

async function files(t, names) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = [];
  for (const name of names) {
    const file = path.join(directory, name);
    await writeFile(file, `content of ${name}\n`);
    result.push(file);
  }
  return result;
}

test("publisher uploads staged names, swaps them in and prunes stale volumes and staging leftovers only", async (t) => {
  const fake = fakeGh([
    "kit.7z.001",
    "kit.7z.002",
    "kit.7z.003",
    "parts.sha256",
    "kit.7z.001.staging-oldrun",
    "unrelated-notes.txt",
  ]);
  const assets = await files(t, ["kit.7z.001", "kit.7z.002", "parts.sha256"]);
  const result = await publishReleaseAssets({
    gh: fake.gh,
    tag: "offline-dev-latest",
    repo: "owner/repo",
    assets,
    prune: "^kit\\.7z\\.\\d{3}$",
    runId: "42",
  });
  assert.deepEqual(fake.names(), [
    "kit.7z.001",
    "kit.7z.002",
    "parts.sha256",
    "unrelated-notes.txt",
  ]);
  assert.ok(
    fake
      .release()
      .assets.every(
        (asset) => asset.name === "unrelated-notes.txt" || asset.id >= 100,
      ),
  );
  assert.deepEqual(result.published, [
    "kit.7z.001",
    "kit.7z.002",
    "parts.sha256",
  ]);
  assert.ok(result.deleted.includes("kit.7z.003"));
  assert.ok(result.deleted.includes("kit.7z.001.staging-oldrun"));
  const upload = fake.calls.find(
    (args) => args[0] === "release" && args[1] === "upload",
  );
  assert.ok(upload.slice(3, -3).every((file) => file.endsWith(".staging-42")));
  const firstDelete = fake.calls.findIndex((args) => args[2] === "DELETE");
  assert.ok(
    fake.calls.indexOf(upload) < firstDelete,
    "old assets are deleted only after every upload finished",
  );
});

test("publisher creates a missing prerelease and refuses oversized or duplicate assets before calling gh", async (t) => {
  const fake = fakeGh(undefined);
  const [zip] = await files(t, ["bundle.zip"]);
  const result = await publishReleaseAssets({
    gh: fake.gh,
    tag: "competition-test",
    repo: "o/r",
    assets: [zip],
    target: "abc",
    runId: "7",
  });
  assert.equal(result.created, true);
  const create = fake.calls.find((args) => args[1] === "create");
  assert.ok(create.includes("--prerelease"));
  assert.deepEqual(
    create.slice(create.indexOf("--target"), create.indexOf("--target") + 2),
    ["--target", "abc"],
  );
  assert.deepEqual(fake.names(), ["bundle.zip"]);
  const strict = fakeGh([]);
  await assert.rejects(
    publishReleaseAssets({
      gh: strict.gh,
      tag: "t",
      repo: "o/r",
      assets: [zip],
      limit: 4,
    }),
    /must be smaller than 4 bytes/,
  );
  await assert.rejects(
    publishReleaseAssets({
      gh: strict.gh,
      tag: "t",
      repo: "o/r",
      assets: [zip, zip],
    }),
    /unique/,
  );
  await assert.rejects(
    publishReleaseAssets({ gh: strict.gh, tag: "t", repo: "o/r", assets: [] }),
    /At least one/,
  );
  assert.equal(strict.calls.length, 0);
});
