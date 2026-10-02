// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseLabels, syncLabels } from "./check-labels.mjs";

test("the repository's label definitions are valid", async () => {
  const { labels, diagnostics } = parseLabels(await readFile(new URL("../.github/labels.yml", import.meta.url), "utf8"));
  assert.deepEqual(diagnostics, []);
  assert.ok(labels.length > 0);
});

test("rejects malformed, duplicate and incomplete definitions", () => {
  const { diagnostics } = parseLabels(`
- name: kind/bug
  color: "d73a4a"
  description: Something is broken.
- name: Kind/Bug
  color: "#d73a4a"
  description: Duplicate that differs only in case.
- name: " padded"
  color: d73a4
  description: ""
- name: area/x
  color: "00ff00"
  description: ${"x".repeat(101)}
  owner: someone
- just a string
`);
  assert.deepEqual(diagnostics, [
    "label 2: duplicate name Kind/Bug",
    'label 2: color must be 6 lowercase hex digits in quotes, without "#"',
    "label 3: name must be a non-empty string without surrounding spaces",
    'label 3: color must be 6 lowercase hex digits in quotes, without "#"',
    "label 3: description is required",
    "label 4: unknown fields owner",
    "label 4: description longer than 100 characters",
    "label 5: expected a mapping",
  ]);
  assert.deepEqual(parseLabels("[]").diagnostics, ["expected a non-empty list of labels"]);
  assert.match(parseLabels("- name: [").diagnostics[0], /^invalid YAML/);
});

function fakeGitHub(initial) {
  const labels = initial.map((label) => ({ ...label }));
  const requests = [];
  const fetch = async (url, { method, body }) => {
    const route = new URL(url).pathname.replace("/repos/o/r", "");
    requests.push(`${method} ${route}`);
    const json = (status, value) => ({ ok: status < 300, status, json: async () => value, text: async () => "" });
    if (method === "GET") {
      const page = Number(new URL(url).searchParams.get("page"));
      return json(200, labels.slice((page - 1) * 100, page * 100));
    }
    const payload = JSON.parse(body);
    if (method === "POST") {
      labels.push(payload);
      return json(201, payload);
    }
    if (route === "/labels/broken") return json(422, {});
    const target = labels.find((label) => label.name === decodeURIComponent(route.slice("/labels/".length)));
    Object.assign(target, { name: payload.new_name, color: payload.color, description: payload.description });
    return json(200, target);
  };
  return { labels, requests, fetch };
}

test("creates and updates labels, never deletes, and converges on a rerun", async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ name: `old/${i}`, color: "ededed", description: null }));
  const github = fakeGitHub([...filler, { name: "Kind/Bug", color: "D73A4A", description: "Old." }]);
  const desired = [
    { name: "kind/bug", color: "d73a4a", description: "Something is broken." },
    { name: "kind/docs", color: "0075ca", description: "Documentation." },
  ];
  const first = await syncLabels({ labels: desired, repository: "o/r", token: "t", fetch: github.fetch });
  assert.deepEqual(first.created, ["kind/docs"]);
  assert.deepEqual(first.updated, ["kind/bug"]);
  assert.equal(first.unmanaged.length, 100);
  assert.equal(github.requests.filter((request) => request === "GET /labels").length, 2);
  assert.equal(github.labels.length, 102);

  const second = await syncLabels({ labels: desired, repository: "o/r", token: "t", fetch: github.fetch });
  assert.deepEqual([second.created, second.updated], [[], []]);
});

test("a failed request rejects instead of reporting success", async () => {
  const github = fakeGitHub([{ name: "broken", color: "000000", description: "x" }]);
  await assert.rejects(
    syncLabels({
      labels: [{ name: "broken", color: "ffffff", description: "y" }],
      repository: "o/r",
      token: "t",
      fetch: github.fetch,
    }),
    /PATCH \/labels\/broken failed: 422/,
  );
});
