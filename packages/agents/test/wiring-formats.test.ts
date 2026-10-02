// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { editors } from "../src/wiring/formats/index.js";
import type {
  ConfigFormat,
  ConfigValue,
  KeyPath,
} from "../src/wiring/formats/index.js";
import {
  clone,
  deepEqual,
  deletePath,
  getPath,
} from "../src/wiring/formats/values.js";
import { WiringError } from "../src/wiring/errors.js";

const json = editors.json;
const toml = editors.toml;
const yaml = editors.yaml;
const dotenv = editors.dotenv;

/** TOML parsers return null-prototype objects; compare plain copies. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function rejects(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof WiringError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

void test("JSON edits keep comments, inline objects, trailing commas and indentation", () => {
  const original = `{
  // leading
  "theme": "dark", // trailing
  "security": {
    "folderTrust": { "enabled": true }
  },
  "list": [1, 2],
  "loose": {
    "x": 1,
  },
}
`;
  let text = json.set(
    original,
    ["security", "auth", "selectedType"],
    "gemini-api-key",
  );
  text = json.set(text, ["loose", "y"], 2);
  text = json.set(text, ["security", "folderTrust", "extra"], "z");
  text = json.set(text, ["model"], "m");
  assert.equal(
    text,
    `{
  // leading
  "theme": "dark", // trailing
  "security": {
    "folderTrust": { "enabled": true, "extra": "z" },
    "auth": {
      "selectedType": "gemini-api-key"
    }
  },
  "list": [1, 2],
  "loose": {
    "x": 1,
    "y": 2,
  },
  "model": "m",
}
`,
  );
  let back = json.remove(text, ["model"]);
  back = json.remove(back, ["security", "folderTrust", "extra"]);
  back = json.remove(back, ["loose", "y"]);
  back = json.remove(back, ["security", "auth"]);
  assert.equal(back, original);
});

void test("JSON keeps a comment on the line of the previous last property", () => {
  const original = '{\n  "a": 1 // about a\n}\n';
  const text = json.set(original, ["b"], true);
  assert.equal(text, '{\n  "a": 1, // about a\n  "b": true\n}\n');
  assert.equal(json.remove(text, ["b"]), original);
});

void test("JSON replaces values in place, creates documents and keeps tabs and CRLF", () => {
  assert.equal(
    json.set("", ["env", "A"], "x"),
    '{\n  "env": {\n    "A": "x"\n  }\n}\n',
  );
  assert.equal(json.set("{}", ["a"], 1), '{\n  "a": 1\n}');
  const tabs = '{\r\n\t"a": {\r\n\t\t"b": 1\r\n\t}\r\n}\r\n';
  const edited = json.set(tabs, ["a", "c"], { d: [1] });
  assert.equal(
    edited,
    '{\r\n\t"a": {\r\n\t\t"b": 1,\r\n\t\t"c": {\r\n\t\t\t"d": [\r\n\t\t\t\t1\r\n\t\t\t]\r\n\t\t}\r\n\t}\r\n}\r\n',
  );
  assert.equal(json.remove(edited, ["a", "c"]), tabs);
  assert.equal(
    json.set('{"a": "old", "b": 2}', ["a"], "new"),
    '{"a": "new", "b": 2}',
  );
  assert.equal(json.remove('{"a": 1, "b": 2}', ["a"]), '{"b": 2}');
  assert.equal(json.remove('{"a": 1, "b": 2}', ["b"]), '{"a": 1}');
  assert.equal(json.remove('{"a": 1}', ["missing"]), '{"a": 1}');
});

void test("JSON refuses invalid documents, duplicate keys on the path and a non-object root", () => {
  rejects(() => json.parse('{ "a": '), "WIRING_CONFIG_UNPARSEABLE");
  rejects(
    () => json.set('{ "secret": "sk-do-not-print" ', ["a"], 1),
    "WIRING_CONFIG_UNPARSEABLE",
  );
  try {
    json.parse('{ "secret": "sk-do-not-print" ');
  } catch (error) {
    assert.ok(error instanceof WiringError);
    assert.doesNotMatch(error.message, /sk-do-not-print/);
    assert.match(error.message, /line 1, column \d+/);
  }
  rejects(
    () => json.set('{"env": {}, "env": {}}', ["env", "A"], 1),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  assert.equal(
    json.set('{"x": 1, "x": 2, "env": {}}', ["env", "A"], 1).includes('"A": 1'),
    true,
  );
  rejects(() => json.parse("[1]"), "WIRING_UNSUPPORTED_STRUCTURE");
  rejects(
    () => json.set('{"env": "text"}', ["env", "A"], 1),
    "WIRING_PATH_CONFLICT",
  );
});

void test("TOML edits values, tables and dotted keys in place", () => {
  const original = `# Codex
model = "o3" # mine
approval_policy = "never"

[projects."/Users/me/x"]
  trust_level = "trusted"

[mcp_servers.fs]
command = "npx"
args = [
  "-y", # comment ] inside
  "server",
]
`;
  let text = toml.set(original, ["model"], "openai/gpt-5");
  text = toml.set(text, ["model_provider"], "harnesshub");
  text = toml.set(text, ["projects", "/Users/me/x", "extra"], 1);
  text = toml.set(text, ["model_providers", "harnesshub"], {
    name: "HarnessHub",
    base_url: "http://127.0.0.1:3180/v1",
  });
  assert.equal(
    text,
    `# Codex
model = "openai/gpt-5" # mine
approval_policy = "never"
model_provider = "harnesshub"

[projects."/Users/me/x"]
  trust_level = "trusted"
  extra = 1

[mcp_servers.fs]
command = "npx"
args = [
  "-y", # comment ] inside
  "server",
]

[model_providers.harnesshub]
name = "HarnessHub"
base_url = "http://127.0.0.1:3180/v1"
`,
  );
  let back = toml.remove(text, ["model_providers", "harnesshub"]);
  back = toml.remove(back, ["projects", "/Users/me/x", "extra"]);
  back = toml.remove(back, ["model_provider"]);
  back = toml.set(back, ["model"], "o3");
  assert.equal(back, original);
  const dotted = toml.set("a.b.c = 1\n", ["a", "b", "d"], "x");
  assert.equal(dotted, 'a.b.c = 1\na.b.d = "x"\n');
  assert.deepEqual(plain(toml.parse(dotted)), { a: { b: { c: 1, d: "x" } } });
  assert.equal(toml.remove(dotted, ["a", "b", "d"]), "a.b.c = 1\n");
  // A root key goes above the comment block attached to the first table.
  assert.equal(
    toml.set("# file\n\n# about t\n[t]\nk = 1\n", ["root"], true),
    "# file\n\nroot = true\n# about t\n[t]\nk = 1\n",
  );
});

void test("TOML replaces a subtree exactly and handles multi-line strings, escapes and CRLF", () => {
  const original = '[p.h]\nname = "x"\nold = 1\n\n[p.h.headers]\nX = "1"\n';
  const replaced = toml.set(original, ["p", "h"], {
    name: "y",
    fresh: [1, 2.5, "s"],
  });
  assert.deepEqual(plain(toml.parse(replaced)), {
    p: { h: { name: "y", fresh: [1, 2.5, "s"] } },
  });
  assert.equal(replaced, '[p.h]\nname = "y"\nfresh = [1, 2.5, "s"]\n');
  const strings = 's = """\nnot = "a key" # nor a comment\n"""\n[t]\nk = 1\n';
  const edited = toml.set(strings, ["t", "j"], 'tab\t"quote"\u0001');
  assert.equal(
    edited,
    's = """\nnot = "a key" # nor a comment\n"""\n[t]\nk = 1\nj = "tab\\t\\"quote\\"\\u0001"\n',
  );
  assert.equal(
    toml.parse(edited).t && (toml.parse(edited).t as Record<string, unknown>).j,
    'tab\t"quote"\u0001',
  );
  const crlf = "a = 1\r\n[t]\r\nk = 2\r\n";
  const added = toml.set(crlf, ["t", "n"], 3);
  assert.equal(added, "a = 1\r\n[t]\r\nk = 2\r\nn = 3\r\n");
  assert.equal(toml.remove(added, ["t", "n"]), crlf);
  const quoted = toml.set(
    "",
    ["models", "openai/gpt-5", "max_context_size"],
    1,
  );
  assert.equal(quoted, '[models."openai/gpt-5"]\nmax_context_size = 1\n');
});

void test("TOML table removal keeps comments that follow the table", () => {
  const wired = "[a]\nx = 1\n\n[t]\nk = 1\n\n# the user's note\n";
  assert.equal(toml.remove(wired, ["t"]), "[a]\nx = 1\n\n# the user's note\n");
  const middle = "[t]\nk = 1\n# kept\n[b]\ny = 2\n";
  assert.equal(toml.remove(middle, ["t"]), "# kept\n[b]\ny = 2\n");
});

void test("TOML refuses inline tables, arrays of tables and invalid documents", () => {
  rejects(
    () => toml.set("p = { a = 1 }\n", ["p", "b"], 2),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(
    () => toml.remove("p = { a = 1 }\n", ["p", "a"]),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(
    () => toml.set("[[a]]\nx = 1\n", ["a", "y"], 2),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(
    () => toml.set("", ["a"], [{ b: 1 }]),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(
    () => toml.set("", ["a"], Number.NaN),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(() => toml.parse('key = "sk-secret'), "WIRING_CONFIG_UNPARSEABLE");
  try {
    toml.parse('key = "sk-secret');
  } catch (error) {
    assert.ok(error instanceof WiringError);
    assert.doesNotMatch(error.message, /sk-secret/);
  }
  rejects(() => toml.parse("a = 1\na = 2\n"), "WIRING_CONFIG_UNPARSEABLE");
});

void test("dotenv edits one variable, keeps export prefixes and refuses ambiguity", () => {
  const original =
    "# keys\nexport A=1 # note\nB=\"two words\"\nC='multi\nline'\n";
  assert.deepEqual(dotenv.parse(original), {
    A: "1",
    B: "two words",
    C: "multi\nline",
  });
  let text = dotenv.set(original, ["A"], "hhk_x");
  text = dotenv.set(text, ["D"], "http://127.0.0.1:3180/v1");
  text = dotenv.set(text, ["E"], "has space");
  assert.equal(
    text,
    "# keys\nexport A=hhk_x # note\nB=\"two words\"\nC='multi\nline'\nD=http://127.0.0.1:3180/v1\nE='has space'\n",
  );
  let back = dotenv.remove(text, ["E"]);
  back = dotenv.remove(back, ["D"]);
  back = dotenv.set(back, ["A"], 1);
  assert.equal(back, original);
  assert.equal(dotenv.set("A=1", ["B"], "2"), "A=1\nB=2\n");
  assert.equal(dotenv.set("A=1\r\n", ["B"], "2"), "A=1\r\nB=2\r\n");
  rejects(
    () => dotenv.set("A=1\nA=2\n", ["A"], "3"),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(() => dotenv.parse('A="open\n'), "WIRING_CONFIG_UNPARSEABLE");
  rejects(() => dotenv.set("", ["A"], "it's"), "WIRING_UNSUPPORTED_STRUCTURE");
  rejects(
    () => dotenv.set("", ["A", "B"], "x"),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(
    () => dotenv.set("", ["A"], { b: "x" }),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
});

void test("YAML edits by key path keep comments and refuse aliases and multiple documents", () => {
  const original =
    "# top\nmodel:\n  provider: openai # inline\n  default: gpt\nlist:\n  - a\n";
  const text = yaml.set(original, ["model", "base_url"], "http://x/v1");
  assert.equal(
    text,
    "# top\nmodel:\n  provider: openai # inline\n  default: gpt\n  base_url: http://x/v1\nlist:\n  - a\n",
  );
  assert.equal(yaml.remove(text, ["model", "base_url"]), original);
  rejects(
    () => yaml.set("base: &b\n  x: 1\nother: *b\n", ["other", "y"], 1),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(
    () => yaml.set("base: &b\n  x: 1\n", ["base", "y"], 1),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(
    () => yaml.parse("a: 1\n---\nb: 2\n"),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
  rejects(() => yaml.parse("a: [1\n"), "WIRING_CONFIG_UNPARSEABLE");
  rejects(() => yaml.parse("- a\n"), "WIRING_UNSUPPORTED_STRUCTURE");
  assert.deepEqual(yaml.parse("# nothing\n"), {});
});

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

interface Sample {
  format: ConfigFormat;
  text: string;
  /** Paths that do not exist in the sample. */
  paths: KeyPath[];
  values: ConfigValue[];
  comments: string[];
  /** Whether removing every added entry must give back the original bytes. */
  exact: boolean;
}

const scalarValues: ConfigValue[] = [
  "v1",
  "with space",
  'quo"te',
  42,
  3.5,
  true,
  false,
];
const samples: Sample[] = [
  {
    format: "json",
    text: `{
  // leading comment
  "name": "sample", // trailing
  "env": {
    "KEEP": "1"
  },
  "inline": { "a": 1 },
  "list": [1, 2, 3],
  "loose": {
    "x": true,
  },
}
`,
    paths: [
      ["hh_a"],
      ["env", "HH_B"],
      ["inline", "hh_c"],
      ["loose", "hh_d"],
      ["hh_obj", "x", "y"],
    ],
    values: [...scalarValues, ["x", 1], { k: "v", n: { m: [true] } }],
    comments: ["// leading comment", "// trailing"],
    exact: true,
  },
  {
    format: "toml",
    text: `# top comment
title = "sample" # trailing

[env]
KEEP = "1" # keep

[server.http]
port = 8080
hosts = [
  "a", # first
  "b",
]

[[plugins]]
name = "p"
`,
    paths: [
      ["hh_a"],
      ["env", "HH_B"],
      ["server", "http", "hh_c"],
      ["hh_obj", "x", "y"],
    ],
    values: [...scalarValues, ["x", 1], { k: "v", n: { m: [true] } }],
    comments: ["# top comment", "# trailing", "# keep", "# first"],
    exact: true,
  },
  {
    format: "dotenv",
    text: '# comment\nexport KEEP=1\nQUOTED="a b" # c\nMULTI="line1\nline2"\n',
    paths: [["HH_A"], ["HH_B"], ["HH_C"]],
    values: scalarValues,
    comments: ["# comment", "# c"],
    exact: true,
  },
  {
    format: "yaml",
    text: '# top\nname: sample # trailing\nenv:\n  KEEP: "1"\nlist:\n  - a\n  - b\n',
    paths: [["hh_a"], ["env", "HH_B"], ["hh_obj", "x"]],
    values: [...scalarValues, ["x", 1], { k: "v", n: { m: [true] } }],
    comments: ["# top", "# trailing"],
    exact: false,
  },
];

function masked(document: unknown, paths: readonly KeyPath[]): unknown {
  const copy = clone(document);
  for (const path of paths) deletePath(copy, path);
  for (const path of paths)
    for (let length = path.length - 1; length > 0; length--) {
      const parent = getPath(copy, path.slice(0, length));
      if (
        typeof parent !== "object" ||
        parent === null ||
        Object.keys(parent).length
      )
        break;
      deletePath(copy, path.slice(0, length));
    }
  return copy;
}

for (const sample of samples)
  void test(`${sample.format}: random set/remove sequences keep unrelated content`, () => {
    const editor = editors[sample.format];
    const original = editor.parse(sample.text);
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(next() * items.length)]!;
      let text = sample.text;
      const expected = new Map<string, ConfigValue | undefined>();
      for (let step = 0; step < 12; step++) {
        const path = pick(sample.paths);
        if (next() < 0.7) {
          const value = pick(sample.values);
          text = editor.set(text, path, value);
          // dotenv stores text.
          expected.set(
            JSON.stringify(path),
            sample.format === "dotenv" ? String(value) : value,
          );
        } else {
          text = editor.remove(text, path);
          expected.set(JSON.stringify(path), undefined);
        }
        const document = editor.parse(text);
        for (const [key, value] of expected)
          assert.ok(
            deepEqual(getPath(document, JSON.parse(key) as string[]), value),
            `seed ${seed} step ${step}: ${key}`,
          );
        assert.ok(
          deepEqual(
            masked(document, sample.paths),
            masked(original, sample.paths),
          ),
          `seed ${seed} step ${step}: unrelated entries changed\n${text}`,
        );
        for (const comment of sample.comments)
          assert.ok(text.includes(comment), `seed ${seed}: lost ${comment}`);
      }
      // Remove each added entry at its outermost new key.
      for (const path of sample.paths) {
        let length = 1;
        while (getPath(original, path.slice(0, length)) !== undefined) length++;
        text = editor.remove(text, path.slice(0, length));
      }
      if (sample.exact) assert.equal(text, sample.text, `seed ${seed}`);
      else assert.ok(deepEqual(editor.parse(text), original), `seed ${seed}`);
    }
  });
