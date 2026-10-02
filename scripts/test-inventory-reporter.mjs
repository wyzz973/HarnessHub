// SPDX-License-Identifier: MIT
/**
 * node:test reporter that writes the test inventory: one JSON line per reported
 * test, `{"file", "test", "status"}`, where `file` is the basename of the test
 * file (null when the runner reports no file), `test` the names from the
 * outermost test or suite down to this one, and `status` one of "pass", "fail",
 * "skip" or "todo". A todo test is "todo" whatever its outcome; a test skipped
 * by an option or by `t.skip()` is "skip". A file that fails to load is
 * reported by the runner as one failed test named after the file.
 *
 * run-tests.mjs loads this file with `--test-reporter` and a file destination
 * next to the spec reporter, then adds the suite name to every line; see
 * `runSuite`'s `inventory` option. The runner reports the tests of each file in
 * definition order, each `test:start` before the results of its subtests, so a
 * stack of started names per file gives every result its full name path. A
 * result that does not match that stack throws, which fails the run instead of
 * writing a wrong inventory.
 */

import path from "node:path";

/** @param {{type: string, data: {skip?: unknown, todo?: unknown}}} event A test:pass or test:fail event. */
function status({ type, data }) {
  if (data.todo !== undefined) return "todo";
  if (data.skip !== undefined) return "skip";
  return type === "test:pass" ? "pass" : "fail";
}

/**
 * @param {AsyncIterable<{type: string, data: any}>} source Events of the test runner.
 * @returns {AsyncGenerator<string>} Inventory lines, each ending with "\n".
 */
export default async function* inventoryReporter(source) {
  /** Started test names by nesting level, per test file. */
  const started = new Map();
  for await (const event of source) {
    const { type, data } = event;
    if (type === "test:start") {
      const names = started.get(data.file) ?? [];
      if (data.nesting > names.length)
        throw new Error(`test inventory: "${data.name}" started at nesting ${data.nesting} without its parent`);
      names.length = data.nesting;
      names.push(data.name);
      started.set(data.file, names);
    } else if (type === "test:pass" || type === "test:fail") {
      const names = started.get(data.file) ?? [];
      if (names[data.nesting] !== data.name)
        throw new Error(`test inventory: result of "${data.name}" arrived out of definition order`);
      const entry = {
        file: data.file === undefined ? null : path.basename(data.file),
        test: names.slice(0, data.nesting + 1),
        status: status(event),
      };
      yield `${JSON.stringify(entry)}\n`;
    }
  }
}
