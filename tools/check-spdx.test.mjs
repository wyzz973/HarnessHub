// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSpdx } from "./check-spdx.mjs";

async function project(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-spdx-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
}

test("accepts MIT headers, shebang files and listed third-party licenses", async (t) => {
  const root = await project(t, {
    "tests/a.ts": "// SPDX-License-Identifier: MIT\nexport {};\n",
    "apps/hh/bin/hh.mjs": "#!/usr/bin/env node\n// SPDX-License-Identifier: MIT\n",
    "tools/check.mjs": "#!/usr/bin/env node\n// SPDX-License-Identifier: MIT\n",
    "packages/core/src/types.ts": "// SPDX-License-Identifier: MIT\nexport {};\n",
    "packages/core/node_modules/ajv/index.js": "dependency without a header\n",
    "packages/core/dist/src/types.js": "compiled output\n",
    "packages/console/components/ai-elements/x.tsx": "// SPDX-License-Identifier: Apache-2.0\n\"use client\";\n",
    "packages/console/next-env.d.ts": '/// <reference types="next" />\n',
    "packages/agents/src/configuration/codex-default-instructions.ts": "// SPDX-License-Identifier: Apache-2.0\n",
    "tests/node_modules/ignored.ts": "no header\n",
    "examples/tool-packages/demo/cli/run.mjs": "pinned payload bytes\n",
  });
  const result = await checkSpdx(root);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.checkedFiles, 6);
});

test("rejects missing headers, wrong identifiers and an empty inventory", async (t) => {
  const root = await project(t, {
    "packages/core/src/missing.ts": "export {};\n",
    "packages/core/src/late.ts": "export {};\n// SPDX-License-Identifier: MIT\n",
    "tests/apache.ts": "// SPDX-License-Identifier: Apache-2.0\n",
    "tools/lib/missing.mjs": "export {};\n",
    "apps/hh/src/main.ts": "export {};\n",
    "packages/console/components/ai-elements/mit.tsx": "// SPDX-License-Identifier: MIT\n",
  });
  const { diagnostics } = await checkSpdx(root);
  assert.equal(diagnostics.length, 6);
  assert.match(diagnostics.join("\n"), /src\/missing\.ts: missing/);
  assert.match(diagnostics.join("\n"), /src\/late\.ts: missing/);
  assert.match(diagnostics.join("\n"), /tests\/apache\.ts: expected MIT, found Apache-2\.0/);
  assert.match(diagnostics.join("\n"), /tools\/lib\/missing\.mjs: missing/);
  assert.match(diagnostics.join("\n"), /apps\/hh\/src\/main\.ts: missing/);
  assert.match(diagnostics.join("\n"), /ai-elements\/mit\.tsx: expected Apache-2\.0, found MIT/);

  const empty = await project(t, { "README.md": "# x\n" });
  assert.deepEqual((await checkSpdx(empty)).diagnostics, ["no source files found"]);
});

test("package native directories hold helper sources only, never compiled helpers", async (t) => {
  const sources = await project(t, {
    "packages/store/native/windows-acl.cs": "// SPDX-License-Identifier: MIT\nclass Acl {}\n",
    "packages/store/native/build-windows-acl.mjs": "// SPDX-License-Identifier: MIT\n",
    "packages/secrets/native/keychain.swift": "// SPDX-License-Identifier: MIT\nimport Foundation\n",
    "packages/store/dist/native/harnesshub-acl.exe": "MZ\0\0 built output, not committed",
  });
  assert.deepEqual((await checkSpdx(sources)).diagnostics, []);

  const binaries = await project(t, {
    "packages/core/src/a.ts": "// SPDX-License-Identifier: MIT\n",
    "packages/store/native/harnesshub-acl.exe": "MZ\0\0 compiled helper",
    "packages/secrets/native/bin/harnesshub-keychain": "Ïúíþ\0\0",
    "packages/secrets/native/keychain.swift": "// SPDX-License-Identifier: MIT\n\0\0",
  });
  const { diagnostics } = await checkSpdx(binaries);
  assert.equal(diagnostics.length, 3, diagnostics.join("\n"));
  for (const file of [
    "packages/store/native/harnesshub-acl.exe",
    "packages/secrets/native/bin/harnesshub-keychain",
    "packages/secrets/native/keychain.swift",
  ])
    assert.ok(
      diagnostics.some((line) => line.startsWith(`${file}: native/ holds helper sources`)),
      file,
    );
});
