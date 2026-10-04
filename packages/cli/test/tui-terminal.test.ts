// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeKeys,
  fit,
  pad,
  shorten,
  styles,
  width,
} from "../src/tui/terminal.js";

void test("decodeKeys reads arrows, control keys and pasted text from one chunk", () => {
  assert.deepEqual(decodeKeys("\x1b[A\x1bOB\x1b[C\x1b[D\x1b[5~\x1b[6~\x1b[Z"), [
    { name: "up" },
    { name: "down" },
    { name: "right" },
    { name: "left" },
    { name: "pageup" },
    { name: "pagedown" },
    { name: "backtab" },
  ]);
  assert.deepEqual(decodeKeys("ab\r\n\x7f\t\x03\x15"), [
    { name: "char", text: "a" },
    { name: "char", text: "b" },
    { name: "enter" },
    { name: "backspace" },
    { name: "tab" },
    { name: "interrupt" },
    { name: "clear" },
  ]);
  // A lone escape, and escape before another key.
  assert.deepEqual(decodeKeys("\x1b"), [{ name: "escape" }]);
  assert.deepEqual(decodeKeys("\x1bq"), [
    { name: "escape" },
    { name: "char", text: "q" },
  ]);
  // Text beyond the BMP stays one key.
  assert.deepEqual(decodeKeys("模😀"), [
    { name: "char", text: "模" },
    { name: "char", text: "😀" },
  ]);
});

void test("decodeKeys drops sequences and control bytes the screen does not use", () => {
  // Delete, F5, a mouse report, a cut-off sequence and NUL.
  assert.deepEqual(decodeKeys("\x1b[3~\x1b[15~\x1b[<0;3;4M\x00x\x1b["), [
    { name: "char", text: "x" },
  ]);
});

void test("width counts columns, wide text as two and escape sequences as none", () => {
  assert.equal(width("abc"), 3);
  assert.equal(width("模型"), 4);
  assert.equal(width("\x1b[1;36mab\x1b[22;39m"), 2);
  assert.equal(width("é"), 1);
  assert.equal(pad("\x1b[1mab\x1b[22m", 4), "\x1b[1mab\x1b[22m  ");
});

void test("fit cuts to the width with an ellipsis and closes cut styles", () => {
  assert.equal(fit("abcdef", 6), "abcdef");
  assert.equal(fit("abcdef", 4), "abc…");
  assert.equal(fit("模型模型", 5), "模型…");
  assert.equal(fit("\x1b[31mabcdef\x1b[39m", 4), "\x1b[31mabc…\x1b[0m");
  assert.equal(width(fit("\x1b[31mabcdef\x1b[39m", 4)), 4);
});

void test("shorten keeps the end of a long path", () => {
  const file = "/a/very/long/directory/name/home/.codex/config.toml";
  const short = shorten(file, 30);
  assert.equal(width(short), 30);
  assert.ok(short.endsWith(".codex/config.toml"), short);
  assert.ok(short.startsWith("/a/very"), short);
  assert.equal(shorten("short", 24), "short");
});

void test("styles write SGR unless NO_COLOR is set to a value", () => {
  const color = styles({});
  assert.equal(color.color, true);
  assert.match(color.ok("x"), /\x1b\[32mx\x1b\[39m/);
  assert.equal(styles({ NO_COLOR: "" }).color, true);
  const plain = styles({ NO_COLOR: "1" });
  assert.equal(plain.color, false);
  const all = [
    plain.bold("a"),
    plain.muted("a"),
    plain.faint("a"),
    plain.accent("a"),
    plain.ok("a"),
    plain.bad("a"),
    plain.added("a"),
    plain.removed("a"),
    plain.pill("a"),
    plain.caret(),
  ].join("");
  assert.doesNotMatch(all, /\x1b/);
  assert.equal(plain.pill("model"), "[model]");
});
