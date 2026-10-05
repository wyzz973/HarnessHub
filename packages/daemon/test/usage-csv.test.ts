// SPDX-License-Identifier: MIT
/** CSV fields as Go's encoding/csv writes them, the formula guard, and Magpie's swapped-model rule. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  csvField,
  csvRecord,
  localRfc3339,
  swappedModel,
} from "../src/usage-csv.js";

void test("fields are quoted where encoding/csv quotes them", () => {
  assert.equal(csvField(""), "");
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  assert.equal(csvField("cr\rhere"), '"cr\rhere"');
  assert.equal(csvField(" leading space"), '" leading space"');
  assert.equal(
    csvField("\u3000ideographic space"),
    '"\u3000ideographic space"',
  );
  assert.equal(csvField("\\."), '"\\."');
  assert.equal(csvField("trailing "), "trailing ");
  assert.equal(csvRecord(["a", "b,c", ""]), 'a,"b,c",\n');
});

void test("a field a spreadsheet would read as a formula is prefixed; a plain number is not", () => {
  for (const value of ["=1+1", "+cmd", "-cmd", "@SUM(A1)", "\tx", "\rx"])
    assert.equal(
      csvField(value).replace(/^"|"$/g, "").startsWith("'"),
      true,
      value,
    );
  assert.equal(csvField("=a,b"), `"'=a,b"`);
  assert.equal(csvField("\tx"), "'\tx");
  for (const value of ["-5", "+3", "-0.25", "12"])
    assert.equal(csvField(value), value);
  assert.equal(csvField("-5e3"), "'-5e3");
  assert.equal(csvField("a=b"), "a=b");
  // After leading whitespace, which a spreadsheet may trim on import.
  for (const value of [
    ' =HYPERLINK("http://x","y")',
    "  +cmd",
    "\u00a0=1+1",
    "\u3000@SUM(A1)",
    "\ufeff-cmd",
  ])
    assert.equal(
      csvField(value).replace(/^"|"$/g, "").startsWith("'"),
      true,
      JSON.stringify(value),
    );
  assert.equal(csvField(" =1"), "' =1");
  assert.equal(csvField(" 12"), '" 12"');
});

void test("times are RFC 3339 to the second with the local offset", () => {
  const text = localRfc3339("2026-10-05T08:09:10.987Z");
  assert.match(text, /^2026-10-0[45]T\d{2}:\d{2}:10(Z|[+-]\d{2}:\d{2})$/);
  assert.equal(Date.parse(text), Date.parse("2026-10-05T08:09:10Z"));
  assert.equal(localRfc3339("not a time"), "not a time");
});

void test("a dated, pinned or prefixed name of the model sent is no swap", () => {
  assert.equal(swappedModel("gpt-5", "gpt-5-2025-08-07"), false);
  assert.equal(
    swappedModel("claude-sonnet-4-5", "claude-sonnet-4-5-20250929"),
    false,
  );
  assert.equal(
    swappedModel("gemini-2.5-pro", "models/gemini-2.5-pro-001"),
    false,
  );
  assert.equal(
    swappedModel("claude-opus-5[1m]", "us.anthropic.claude-opus-5-v1:0"),
    false,
  );
  assert.equal(swappedModel("auto", "gpt-5"), false);
  assert.equal(swappedModel("deepseek-v3", "deepseek-v2"), true);
  assert.equal(swappedModel("gpt-5", "gpt-5-mini"), true);
  assert.equal(swappedModel("", "gpt-5"), false);
});
