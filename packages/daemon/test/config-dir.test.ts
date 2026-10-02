// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { defaultConfigDir } from "../src/main.js";

void test("the default config root follows each platform's convention", () => {
  assert.equal(
    defaultConfigDir({}, "darwin", "/Users/u"),
    path.join(
      "/Users/u",
      "Library",
      "Application Support",
      "HarnessHub",
      "config",
    ),
  );
  assert.equal(
    defaultConfigDir(
      { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      "win32",
      "C:\\Users\\u",
    ),
    "C:\\Users\\u\\AppData\\Local\\HarnessHub\\config",
  );
  assert.equal(
    defaultConfigDir({}, "win32", "C:\\Users\\u"),
    "C:\\Users\\u\\AppData\\Local\\HarnessHub\\config",
  );
  assert.equal(
    defaultConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/u"),
    path.join("/xdg", "harnesshub"),
  );
  // A relative or empty XDG value is ignored, as the XDG specification requires.
  for (const value of ["relative/dir", ""])
    assert.equal(
      defaultConfigDir({ XDG_CONFIG_HOME: value }, "linux", "/home/u"),
      path.join("/home/u", ".config", "harnesshub"),
    );
});
