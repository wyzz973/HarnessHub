import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  parseCommandConfiguration,
  SESSION_WORKSPACE_PLACEHOLDER,
} from "../../src/drivers/tool-command/config.js";
import {
  isWindowsBatch,
  quoteBatchArgument,
  windowsBatchCommandLine,
  windowsBatchLaunch,
} from "../../src/drivers/tool-command/windows-batch.js";
import { SESSION_WORKSPACE_PLACEHOLDER as PACKAGE_PLACEHOLDER } from "../../src/tool-packages/index.js";

void test("batch arguments are quoted so cmd.exe metacharacters stay literal and trailing backslashes survive argv parsing", () => {
  assert.equal(quoteBatchArgument("plain"), '"plain"');
  assert.equal(quoteBatchArgument(""), '""');
  assert.equal(quoteBatchArgument("two words"), '"two words"');
  for (const value of [
    "a&b",
    "a|b",
    "<in>",
    "(group)",
    "caret^",
    "bang!",
    "semi;colon,comma=eq",
    "中文 路径",
  ])
    assert.equal(quoteBatchArgument(value), `"${value}"`, value);
  assert.equal(quoteBatchArgument("C:\\dir\\"), '"C:\\dir\\\\"');
  assert.equal(quoteBatchArgument("C:\\dir\\\\"), '"C:\\dir\\\\\\\\"');
  assert.equal(
    quoteBatchArgument("mid\\dle\\path"),
    '"mid\\dle\\path"',
    "backslashes not before the closing quote are literal",
  );
});

void test("batch arguments that cmd.exe would expand or re-split are rejected instead of rewritten", () => {
  for (const value of [
    'say "hi"',
    "%PATH%",
    "100%",
    "line\nbreak",
    "carriage\rreturn",
    "nul\0byte",
  ])
    assert.throws(
      () => quoteBatchArgument(value),
      /cannot contain/,
      JSON.stringify(value),
    );
});

void test("a batch launch uses an absolute cmd.exe with /d /s /v:off /c and one verbatim quoted line", () => {
  assert.equal(isWindowsBatch("C:\\pack\\tool.CMD"), true);
  assert.equal(isWindowsBatch("C:\\pack\\tool.bat"), true);
  assert.equal(isWindowsBatch("C:\\pack\\tool.exe"), false);
  assert.equal(
    windowsBatchCommandLine("C:\\Program Files (x86)\\pack\\tool.cmd", [
      "a b",
      "x&y",
    ]),
    '"C:\\Program Files (x86)\\pack\\tool.cmd" "a b" "x&y"',
  );
  assert.deepEqual(
    windowsBatchLaunch("C:\\pack\\tool.cmd", ["--flag", "value with space"], {
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      SystemRoot: "D:\\Other",
    }),
    {
      file: "C:\\Windows\\system32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        '""C:\\pack\\tool.cmd" "--flag" "value with space""',
      ],
    },
  );
  assert.equal(
    windowsBatchLaunch("C:\\pack\\tool.bat", [], {
      SYSTEMROOT: "C:\\Windows",
      COMSPEC: "powershell.exe",
    }).file,
    path.win32.join("C:\\Windows", "System32", "cmd.exe"),
    "a non-cmd or relative ComSpec is ignored; SystemRoot lookup is case-insensitive",
  );
  assert.throws(
    () => windowsBatchLaunch("C:\\pack\\tool.cmd", [], {}),
    /Cannot locate cmd\.exe/,
  );
  assert.throws(
    () => windowsBatchLaunch("tool.cmd", [], { SystemRoot: "C:\\Windows" }),
    /absolute \.cmd\/\.bat/,
  );
  assert.throws(
    () =>
      windowsBatchLaunch("C:\\pack\\tool.cmd", ["%USERPROFILE%"], {
        SystemRoot: "C:\\Windows",
      }),
    /cannot contain/,
  );
});

void test("command MCP resolves the Session workspace from its argument, keeps legacy env bindings and refuses an unsubstituted placeholder", () => {
  assert.equal(SESSION_WORKSPACE_PLACEHOLDER, PACKAGE_PLACEHOLDER);
  const workspace = path.resolve("/session/workspace");
  const tools = JSON.stringify([
    {
      name: "echo",
      command: path.resolve("/pack/node"),
      prefixArgs: ["/pack/echo.mjs", { anchor: "workspace" }, "--fixed"],
    },
  ]);
  const parsed = parseCommandConfiguration(["--workspace", workspace], {
    HHCAP_CLI_TOOLS_JSON: tools,
  });
  assert.equal(parsed.workspace, workspace);
  assert.deepEqual(parsed.tools[0]!.prefixArgs, [
    "/pack/echo.mjs",
    workspace,
    "--fixed",
  ]);
  assert.equal(
    parseCommandConfiguration([], {
      HHCAP_CLI_WORKSPACE: workspace,
      HHCAP_CLI_TOOLS_JSON: tools,
    }).workspace,
    workspace,
    "revisions bound before ADR 0013 carry an absolute env workspace",
  );
  for (const [argv, environment, pattern] of [
    [
      ["--workspace", SESSION_WORKSPACE_PLACEHOLDER],
      { HHCAP_CLI_TOOLS_JSON: tools },
      /not substituted/,
    ],
    [
      [],
      {
        HHCAP_CLI_WORKSPACE: SESSION_WORKSPACE_PLACEHOLDER,
        HHCAP_CLI_TOOLS_JSON: tools,
      },
      /not substituted/,
    ],
    [["--workspace", "relative"], { HHCAP_CLI_TOOLS_JSON: tools }, /absolute/],
    [[], { HHCAP_CLI_TOOLS_JSON: tools }, /absolute/],
    [
      ["--workspace", workspace, "--extra"],
      { HHCAP_CLI_TOOLS_JSON: tools },
      /only --workspace/,
    ],
    [["--workspace", workspace], {}, /missing/],
    [
      ["--workspace", workspace],
      {
        HHCAP_CLI_TOOLS_JSON: JSON.stringify([
          {
            name: "echo",
            command: "/pack/node",
            prefixArgs: [{ anchor: "package" }],
          },
        ]),
      },
      /Invalid managed CLI tool declaration/,
    ],
    [
      ["--workspace", workspace],
      {
        HHCAP_CLI_TOOLS_JSON: JSON.stringify([
          { name: "echo", command: "relative/node", prefixArgs: [] },
        ]),
      },
      /Invalid managed CLI tool declaration/,
    ],
  ] as const)
    assert.throws(
      () => parseCommandConfiguration(argv, environment),
      pattern,
      JSON.stringify(argv),
    );
});
