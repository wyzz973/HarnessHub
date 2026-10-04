// SPDX-License-Identifier: MIT
/**
 * Array elements HarnessHub owns inside lists of the user's: the editors'
 * element operations, and wire, re-wire and unwire around the user's own
 * additions and removals, as seeded random sequences.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyWiring,
  detectDrift,
  unwire,
  WiringError,
  type WiringModel,
  type WiringTarget,
} from "../src/wiring/index.js";
import {
  editors,
  type ConfigValue,
  type FormatEditor,
  type KeyPath,
} from "../src/wiring/formats/index.js";
import { getPath } from "../src/wiring/formats/values.js";
import { KEY, NEW_KEY, sandbox, writeFiles } from "./wiring-support.js";

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)]!;
}

type Element = { id: string; [key: string]: ConfigValue };

const ours = (id: string): KeyPath => ["list", { match: { id } }];

function list(editor: FormatEditor, text: string): Element[] {
  return (getPath(editor.parse(text), ["list"]) ?? []) as Element[];
}

/** A user's own edit of the list: the file rewritten as a tool would, with the element at `index` inserted or removed. */
function rewrite(
  editor: FormatEditor,
  text: string,
  change: (items: Element[]) => void,
): string {
  const document = editor.parse(text);
  const items = [...list(editor, text)];
  change(items);
  const next = { ...document, list: items };
  return editor.format === "json"
    ? `${JSON.stringify(next, null, 2)}\n`
    : editors.yaml.set("", ["list"], items as ConfigValue).replace(
        /^/,
        Object.entries(next)
          .filter(([key]) => key !== "list")
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
          .join(""),
      );
}

const SAMPLES: ReadonlyArray<{
  editor: FormatEditor;
  text: string;
  exact: boolean;
}> = [
  {
    editor: editors.json,
    exact: true,
    text: `{
  // My list
  "theme": "dark",
  "list": [
    { "id": "u1", "name": "first" }, // mine
    {
      "id": "u2",
      "name": "second"
    }
  ],
  "after": true
}
`,
  },
  {
    editor: editors.json,
    exact: true,
    text: `{"list": [{"id": "u1"}, {"id": "u2"}], "other": 1}\n`,
  },
  {
    editor: editors.json,
    exact: true,
    text: `{\r\n\t"list": [\r\n\t\t{"id": "u1"},\r\n\t],\r\n}\r\n`,
  },
  {
    editor: editors.json,
    exact: true,
    text: `{\n  "list": []\n}\n`,
  },
  {
    editor: editors.yaml,
    exact: false,
    text: `# mine
theme: dark
list:
  - id: u1 # first
    name: first
  - id: u2
    name: second
after: true
`,
  },
];

void test("editors set, replace and remove selected elements and keep every other element, comment and its order", () => {
  for (const [index, sample] of SAMPLES.entries())
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed * 100 + index);
      const { editor } = sample;
      const label = `sample ${index} seed ${seed}`;
      const others = (text: string) => {
        const document = editor.parse(text);
        delete document.list;
        return document;
      };
      const unrelated = others(sample.text);
      let text = sample.text;
      // The list as it should be, HarnessHub's and the user's elements in order.
      let expected = list(editor, text);
      let counter = 0;
      for (let step = 0; step < 25; step++) {
        const roll = next();
        if (roll < 0.4) {
          const id = pick(next, ["h0", "h1", "h2", "h3"]);
          const value: Element = { id, rev: step, owner: "hh" };
          text = editor.set(text, ours(id), value);
          const at = expected.findIndex((item) => item.id === id);
          if (at >= 0) expected[at] = value;
          else expected.push(value);
        } else if (roll < 0.65) {
          const id = pick(next, ["h0", "h1", "h2", "h3"]);
          text = editor.remove(text, ours(id));
          expected = expected.filter((item) => item.id !== id);
        } else if (roll < 0.85) {
          const value: Element = { id: `u-new-${counter++}` };
          const at = Math.floor(next() * (expected.length + 1));
          text = rewrite(editor, text, (items) => items.splice(at, 0, value));
          expected.splice(at, 0, value);
        } else {
          const users = expected.filter((item) => !item.id.startsWith("h"));
          if (!users.length) continue;
          const gone = pick(next, users).id;
          text = rewrite(editor, text, (items) =>
            items.splice(
              items.findIndex((item) => item.id === gone),
              1,
            ),
          );
          expected = expected.filter((item) => item.id !== gone);
        }
        assert.deepEqual(list(editor, text), expected, `${label} step ${step}`);
        assert.deepEqual(others(text), unrelated, `${label} step ${step}`);
      }
    }
});

void test("removing the elements set restores the original bytes (JSON) or document (YAML)", () => {
  for (const [index, sample] of SAMPLES.entries())
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed * 1000 + index);
      const { editor } = sample;
      let text = sample.text;
      const ids = ["h0", "h1", "h2"].filter(() => next() < 0.7);
      for (const id of ids)
        text = editor.set(text, ours(id), { id, nested: { deep: [1, 2] } });
      for (const id of ids)
        if (next() < 0.5)
          text = editor.set(text, ours(id), { id, replaced: true });
      for (const id of [...ids].sort(() => next() - 0.5))
        text = editor.remove(text, ours(id));
      if (sample.exact)
        assert.equal(text, sample.text, `sample ${index} seed ${seed}`);
      else
        assert.deepEqual(
          editor.parse(text),
          editor.parse(sample.text),
          `sample ${index} seed ${seed}`,
        );
    }
});

void test("selectors match on several fields or a scalar, lead into an existing element, and refuse what they cannot edit", () => {
  const json = editors.json;
  let text = `{"rules": [{"p": "a", "m": "x"}, {"p": "b", "m": "x"}], "names": ["one"]}\n`;
  text = json.set(text, ["rules", { match: { p: "b", m: "x" } }], {
    p: "b",
    m: "x",
    v: 2,
  });
  text = json.set(text, ["names", { equals: "two" }], "two");
  assert.deepEqual(json.parse(text), {
    rules: [
      { p: "a", m: "x" },
      { p: "b", m: "x", v: 2 },
    ],
    names: ["one", "two"],
  });
  // A field inside an element that is there.
  text = json.set(text, ["rules", { match: { p: "a", m: "x" } }, "v"], 1);
  assert.deepEqual(
    getPath(json.parse(text), ["rules", { match: { p: "a", m: "x" } }]),
    {
      p: "a",
      m: "x",
      v: 1,
    },
  );
  const refuses = (action: () => unknown, code: string) =>
    assert.throws(
      action,
      (error: unknown) => error instanceof WiringError && error.code === code,
    );
  refuses(
    () => json.set(text, ["rules", { match: { m: "x" } }], { m: "x" }),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  refuses(
    () => json.set(text, ["rules", { match: { p: "c" } }, "v"], 1),
    "WIRING_PATH_CONFLICT",
  );
  refuses(
    () => json.set(`{"rules": {}}`, ["rules", { equals: "x" }], "x"),
    "WIRING_PATH_CONFLICT",
  );
  refuses(
    () => editors.toml.set("a = 1\n", ["list", { equals: "x" }], "x"),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  refuses(
    () => editors.dotenv.set("A=1\n", [{ equals: "x" }], "x"),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  // A missing list is created with the element; removing it again is a no-op elsewhere.
  assert.deepEqual(
    json.parse(json.set("{}\n", ["a", "list", { equals: "x" }], "x")),
    { a: { list: ["x"] } },
  );
  assert.equal(json.remove(text, ["rules", { match: { p: "z" } }]), text);
  const yaml = editors.yaml;
  assert.deepEqual(
    yaml.parse(
      yaml.set("a: 1\n", ["list", { match: { id: "x" } }], { id: "x" }),
    ),
    { a: 1, list: [{ id: "x" }] },
  );
  assert.equal(
    yaml.remove("list:\n  - id: y\n", ["list", { match: { id: "x" } }, "f"]),
    "list:\n  - id: y\n",
  );
});

void test("a JSON document whose root is a list takes a selector first, only through parseRoot", () => {
  const json = editors.json;
  const text = `[
  // mine
  {"id": "a"},
  {"id": "b"}
]
`;
  assert.throws(
    () => json.parse(text),
    (error: unknown) =>
      error instanceof WiringError &&
      error.code === "WIRING_UNSUPPORTED_STRUCTURE",
  );
  const added = json.set(text, [{ match: { id: "h" } }], { id: "h", v: 1 });
  assert.deepEqual(json.parseRoot!(added), [
    { id: "a" },
    { id: "b" },
    { id: "h", v: 1 },
  ]);
  const changed = json.set(added, [{ match: { id: "h" } }, "v"], 2);
  assert.deepEqual(
    getPath(json.parseRoot!(changed), [{ match: { id: "h" } }]),
    {
      id: "h",
      v: 2,
    },
  );
  assert.equal(json.remove(changed, [{ match: { id: "h" } }]), text);
  for (const [document, segment] of [
    [text, "key"],
    ["", { equals: "x" }],
  ] as const)
    assert.throws(
      () => json.set(document, [segment], "x"),
      (error: unknown) =>
        error instanceof WiringError && error.code === "WIRING_PATH_CONFLICT",
    );
});

const POOL: WiringModel[] = [
  { ref: "alpha/one", contextWindow: 100_000, nativeProtocols: ["chat"] },
  { ref: "beta/two", nativeProtocols: ["responses"] },
  {
    ref: "gamma/three",
    contextWindow: 200_000,
    nativeProtocols: ["anthropic"],
  },
  { ref: "group/fast" },
];

function droidTarget(next: () => number, key: typeof KEY = KEY): WiringTarget {
  const models = POOL.filter(() => next() < 0.6);
  const chosen = models.length ? models : [POOL[0]!];
  return {
    baseUrl: "http://127.0.0.1:3180",
    ...key,
    model: chosen[0]!.ref,
    models: chosen,
  };
}

type Custom = { id: string; [key: string]: unknown };

void test("droid: wire, re-wire and unwire keep the user's custom models and their order through random edits of theirs", async (t) => {
  for (let seed = 1; seed <= 25; seed++) {
    const next = random(seed);
    const context = await sandbox(t);
    const file = path.join(context.home, ".factory", "settings.json");
    const own = Array.from({ length: Math.floor(next() * 4) }, (_, index) => ({
      model: `mine-${index}`,
      id: `custom:mine-${index}`,
      displayName: `Mine ${index}`,
    }));
    const original = `${JSON.stringify(
      {
        theme: "dark",
        ...(own.length || next() < 0.5 ? { customModels: own } : {}),
        ...(next() < 0.5
          ? { sessionDefaultSettings: { model: "custom:mine-0" } }
          : {}),
      },
      null,
      2,
    )}\n`;
    await writeFiles(context.home, { ".factory/settings.json": original });
    const read = async () =>
      JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const customs = async () => ((await read()).customModels ?? []) as Custom[];
    const users = async () =>
      (await customs()).filter(
        (item) => !item.id.startsWith("custom:harnesshub/"),
      );
    const harnesshub = async () =>
      (await customs())
        .filter((item) => item.id.startsWith("custom:harnesshub/"))
        .map((item) => item.model as string);
    let edited = false;
    /** A user's edit: one custom model of theirs added at any place, or one removed. */
    const userEdit = async () => {
      edited = true;
      const document = await read();
      const items = [...((document.customModels ?? []) as Custom[])];
      const theirs = items.filter(
        (item) => !item.id.startsWith("custom:harnesshub/"),
      );
      if (next() < 0.6 || !theirs.length)
        items.splice(Math.floor(next() * (items.length + 1)), 0, {
          id: `custom:added-${seed}-${Math.floor(next() * 1e6)}`,
          model: "added",
        });
      else items.splice(items.indexOf(pick(next, theirs)), 1);
      await writeFile(
        file,
        `${JSON.stringify({ ...document, customModels: items }, null, 2)}\n`,
      );
    };
    const label = `seed ${seed}`;

    const first = droidTarget(next);
    let { record } = await applyWiring("droid", first, context);
    assert.deepEqual(await users(), own, label);
    assert.deepEqual(
      await harnesshub(),
      first.models.map((model) => model.ref),
      label,
    );
    for (let round = 0; round < 3; round++) {
      for (let edits = Math.floor(next() * 3); edits > 0; edits--)
        await userEdit();
      const theirs = await users();
      const before = await harnesshub();
      const target = droidTarget(next, next() < 0.5 ? KEY : NEW_KEY);
      ({ record } = await applyWiring("droid", target, context, {
        previous: record,
      }));
      assert.deepEqual(await users(), theirs, `${label} round ${round}`);
      const refs = target.models.map((model) => model.ref);
      // Ours that stay keep their places; new ones come after them.
      assert.deepEqual(
        await harnesshub(),
        [
          ...before.filter((ref) => refs.includes(ref)),
          ...refs.filter((ref) => !before.includes(ref)),
        ],
        `${label} round ${round}`,
      );
      assert.equal(
        ((await read()).sessionDefaultSettings as Record<string, unknown>)
          .model,
        `custom:harnesshub/${target.model}`,
      );
      assert.equal((await detectDrift(record, context)).drifted, false, label);
    }
    if (next() < 0.5) await userEdit();
    const theirs = await users();
    await unwire(record, context);
    const after = await read();
    assert.deepEqual(await users(), theirs, label);
    assert.deepEqual(await harnesshub(), [], label);
    const originalDocument = JSON.parse(original) as Record<string, unknown>;
    assert.deepEqual(
      after.sessionDefaultSettings,
      originalDocument.sessionDefaultSettings,
      label,
    );
    if (!edited) assert.equal(await readFile(file, "utf8"), original, label);
  }
});

void test("droid: an element of HarnessHub's that the user removes or changes is drift", async (t) => {
  const context = await sandbox(t);
  const file = path.join(context.home, ".factory", "settings.json");
  const target: WiringTarget = {
    baseUrl: "http://127.0.0.1:3180",
    ...KEY,
    model: "alpha/one",
    models: POOL.slice(0, 2),
  };
  const { record } = await applyWiring("droid", target, context);
  const document = JSON.parse(await readFile(file, "utf8")) as {
    customModels: Custom[];
  };
  await writeFile(
    file,
    JSON.stringify({
      ...document,
      customModels: [
        { ...document.customModels[0]!, displayName: "Renamed" },
        document.customModels[1]!,
      ],
    }),
  );
  let report = await detectDrift(record, context);
  assert.deepEqual(report.kinds, ["replaced"]);
  assert.deepEqual(report.findings[0]?.keyPath, [
    "customModels",
    '[id="custom:harnesshub/alpha/one"]',
    "displayName",
  ]);
  await writeFile(
    file,
    JSON.stringify({ ...document, customModels: [document.customModels[1]!] }),
  );
  report = await detectDrift(record, context);
  // The selected model's own entry, with the gateway URL and the key, is gone.
  assert.deepEqual(report.kinds, ["replaced", "unwired"]);
  assert.ok(
    report.findings.some(
      (finding) =>
        finding.kind === "unwired" &&
        finding.keyPath.at(-1) === "baseUrl" &&
        finding.reason === "missing",
    ),
  );
});
