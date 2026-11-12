import assert from "node:assert/strict";
import test from "node:test";
import { bodySha, findBlock, instructionBody, instructionTextProblem, withBlock, withoutBlock } from "../../src/infrastructure/capabilities/instruction-blocks.js";

const BODY = "Answer in Chinese.\n\n- Keep commits small.";
const block = (body: string, eol = "\n") => "<!-- harnesshub:begin id=instructions sha=" + bodySha(body) + " -->" + eol + body.split("\n").join(eol) + eol + "<!-- harnesshub:end id=instructions -->" + eol;

test("G064-I1 HarnessHub's instructions block is added after an empty line, replaced in place and removed back to the old bytes, the rest of the file never changed", () => {
  // Added at the end after one empty line, whatever the file ended with; removal gives the same bytes back.
  for (const [before, separator] of [["", ""], ["﻿", ""], ["# Mine\n", "\n"], ["# Mine", "\n\n"], ["# Mine\n\n", ""], ["# Mine\n\n\n", ""]] as const) {
    const written = withBlock(before, BODY);
    assert.equal(written.separator, separator, JSON.stringify(before));
    assert.equal(written.after, before + separator + block(BODY));
    const found = findBlock(written.after);
    assert.ok(found.kind === "block" && found.intact && found.body === BODY && found.terminated, JSON.stringify(before));
    assert.equal(withoutBlock(written.after, written.separator), before, "removal gives the old bytes back: " + JSON.stringify(before));
  }
  // Replaced in place: what the user wrote before and after the block stays byte for byte.
  const first = withBlock("# Mine\n", "one").after + "\nLater, mine too.\n", replaced = withBlock(first, BODY);
  assert.equal(replaced.separator, "");
  assert.equal(replaced.after, "# Mine\n\n" + block(BODY) + "\nLater, mine too.\n");
  assert.equal(withoutBlock(replaced.after, "\n"), "# Mine\n\n\nLater, mine too.\n", "with text after the block, the separator stays");
  // A CRLF file gets CRLF lines; a block at the very end without a final line break is replaced without adding one.
  const crlf = withBlock("# Mine\r\n", BODY);
  assert.equal(crlf.after, "# Mine\r\n\r\n" + block(BODY, "\r\n"));
  assert.ok(findBlock(crlf.after).kind === "block" && (findBlock(crlf.after) as { body: string }).body === BODY);
  assert.equal(withoutBlock(crlf.after, crlf.separator), "# Mine\r\n");
  const unterminated = "# Mine\n\n" + block("one").slice(0, -1);
  assert.equal(withBlock(unterminated, BODY).after, "# Mine\n\n" + block(BODY).slice(0, -1));
  assert.equal(withoutBlock(unterminated, "\n"), "# Mine\n");
  // A file of mixed line breaks gets CRLF lines; a byte order mark before CRLF lines stays; the rest is byte for byte as before.
  const mixed = "one\r\ntwo\nthree\r\n", mixedWritten = withBlock(mixed, BODY);
  assert.equal(mixedWritten.after, mixed + "\r\n" + block(BODY, "\r\n"));
  assert.equal(withoutBlock(mixedWritten.after, mixedWritten.separator), mixed);
  const bomCrlf = "\uFEFF# Mine\r\n", bomWritten = withBlock(bomCrlf, BODY);
  assert.equal(bomWritten.after, bomCrlf + "\r\n" + block(BODY, "\r\n"));
  assert.equal(withoutBlock(withBlock(bomWritten.after, "two").after, bomWritten.separator), bomCrlf);
  // An edit inside the block shows: the text no longer matches the begin line's sha.
  const edited = withBlock("", BODY).after.replace("small", "tiny"), found = findBlock(edited);
  assert.ok(found.kind === "block" && !found.intact && found.body.endsWith("tiny."));
});

test("G064-I1 markers HarnessHub cannot use stop it from writing, and the texts it would write are checked first", () => {
  const good = block(BODY);
  for (const [text, reason] of [
    ["<!-- harnesshub:begin id=shared sha=0 -->\nshared\n<!-- harnesshub:end -->\n", /无法识别/u],
    [good + good, /不止一个/u],
    [good.split("\n").slice(0, -2).join("\n") + "\n", /只有开始标记/u],
    ["<!-- harnesshub:end id=instructions -->\n", /结束标记在开始标记之前|只有结束标记/u],
    ["  <!-- harnesshub:begin id=instructions sha=000000000000 -->\nx\n<!-- harnesshub:end id=instructions -->\n", /无法识别/u],
    ["<!-- harnesshub:begin id=other sha=" + bodySha("x") + " -->\nx\n<!-- harnesshub:end id=other -->\n", /无法识别/u],
    ["<!-- harnesshub:begin id=instructions sha=ABCDEF012345 -->\nx\n<!-- harnesshub:end id=instructions -->\n", /无法识别/u],
  ] as const) {
    const found = findBlock(text);
    assert.ok(found.kind === "broken" && reason.test(found.reason), JSON.stringify(text) + " → " + JSON.stringify(found));
    assert.throws(() => withBlock(text, BODY), reason);
  }
  assert.deepEqual(findBlock("# Mine mentions <!-- harnesshub:begin in passing\n").kind, "none", "only a line that starts with the marker is a marker");
  assert.throws(() => withoutBlock("# Mine\n", "\n"), /没有 HarnessHub 区块/u);
  // One Harness's text: the shared text, then its own addition after an empty line; empty parts and stray space dropped.
  assert.equal(instructionBody("\n\nShared.\r\nLine two.  \n\n", "  Own.\n"), "Shared.\nLine two.\n\n  Own.");
  assert.equal(instructionBody("Shared.", " \n"), "Shared.");
  assert.equal(instructionBody("  \n", ""), "");
  // What a text may not hold: too much, a NUL, HarnessHub's marker, the home written out.
  const homes = ["/Users/someone", "/private/var/someone"];
  assert.equal(instructionTextProblem("Reply in Chinese. See ~/notes/rules.md.", homes), null);
  assert.equal(instructionTextProblem("x".repeat(16 * 1024), homes), null);
  assert.match(instructionTextProblem("中".repeat(2796203), homes) ?? "", /8 MiB/u, "the guard counts UTF-8 bytes");
  assert.match(instructionTextProblem("a\0b", homes) ?? "", /NUL/u);
  for (const text of ["a\rb", "bell\u0007", "esc\u001b[0m", "next\u0085line", "del\u007f"]) assert.match(instructionTextProblem(text, homes) ?? "", /控制字符/u, JSON.stringify(text));
  assert.equal(instructionTextProblem("tab\tand\nnewline, 中文与 emoji 😀", homes), null, "tabs, line breaks and whole characters are fine");
  for (const text of ["half \uD83D pair", "\uDE00 low half"]) assert.match(instructionTextProblem(text, homes) ?? "", /孤立的代理项/u, JSON.stringify(text));
  assert.match(instructionTextProblem("keep <!-- harnesshub:begin out", homes) ?? "", /区块标记/u);
  for (const text of ["Projects live in /Users/someone/projects.", "My home is /Users/someone", "(/private/var/someone)"]) assert.match(instructionTextProblem(text, homes) ?? "", /写成 ~/u, text);
  assert.equal(instructionTextProblem("/Users/someone-else/x and /Users/someones", homes), null, "another user's home is not this one");
});
