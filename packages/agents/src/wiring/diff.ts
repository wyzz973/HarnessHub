// SPDX-License-Identifier: MIT

type Line = { kind: " " | "-" | "+"; text: string };

/**
 * A unified diff of two texts with `context` unchanged lines around each
 * change. Lines keep their own terminators for the comparison, so line-ending
 * and final-newline changes show up; a printed line without a final newline
 * is followed by the usual marker. Returns "" for equal texts.
 */
export function unifiedDiff(
  before: string | undefined,
  after: string | undefined,
  label: string,
  context: number,
): string {
  if (before === after) return "";
  const a = lines(before ?? "");
  const b = lines(after ?? "");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const script: Line[] = [
    ...a.slice(0, prefix).map((text): Line => ({ kind: " ", text })),
    ...middle(
      a.slice(prefix, a.length - suffix),
      b.slice(prefix, b.length - suffix),
    ),
    ...a.slice(a.length - suffix).map((text): Line => ({ kind: " ", text })),
  ];
  const header = [
    `--- ${before === undefined ? "/dev/null" : label}`,
    `+++ ${after === undefined ? "/dev/null" : label}`,
  ];
  return [...header, ...hunks(script, context)].join("\n") + "\n";
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** An edit script by longest common subsequence; large inputs degrade to replace-all. */
function middle(a: string[], b: string[]): Line[] {
  if (a.length * b.length > 1_000_000)
    return [
      ...a.map((text): Line => ({ kind: "-", text })),
      ...b.map((text): Line => ({ kind: "+", text })),
    ];
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const script: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      script.push({ kind: " ", text: a[i++]! });
      j++;
    } else if (
      i < a.length &&
      (j === b.length ||
        table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
    )
      script.push({ kind: "-", text: a[i++]! });
    else script.push({ kind: "+", text: b[j++]! });
  }
  return script;
}

function hunks(script: Line[], context: number): string[] {
  const output: string[] = [];
  const changes = script.flatMap((line, index) =>
    line.kind === " " ? [] : [index],
  );
  let index = 0;
  while (index < changes.length) {
    let last = index;
    while (
      last + 1 < changes.length &&
      changes[last + 1]! - changes[last]! <= 2 * context + 1
    )
      last++;
    const start = Math.max(0, changes[index]! - context);
    const end = Math.min(script.length, changes[last]! + context + 1);
    let oldLine = 1;
    let newLine = 1;
    for (const line of script.slice(0, start)) {
      if (line.kind !== "+") oldLine++;
      if (line.kind !== "-") newLine++;
    }
    const body = script.slice(start, end);
    const oldCount = body.filter((line) => line.kind !== "+").length;
    const newCount = body.filter((line) => line.kind !== "-").length;
    output.push(
      `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`,
    );
    for (const line of body) {
      output.push(`${line.kind}${line.text.replace(/\r?\n$/, "")}`);
      if (!line.text.endsWith("\n"))
        output.push("\\ No newline at end of file");
    }
    index = last + 1;
  }
  return output;
}
