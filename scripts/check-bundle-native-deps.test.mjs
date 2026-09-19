import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanLayout, summarize } from "./check-bundle-native-deps.mjs";
import {
  isApiSet,
  isRedistributableRuntime,
  PeFormatError,
  readPeImports,
} from "./lib/pe-imports.mjs";

/**
 * Minimal PE image with one section at RVA 0x1000 (file offset 0x200) that holds an import
 * table and a delay-load table. `old` delay entries store virtual addresses (attributes 0).
 */
function peImage({ plus = true, imports = [], delay = [], old = [] } = {}) {
  const imageBase = plus ? 0x140000000n : 0x400000n;
  const optionalSize = plus ? 240 : 224;
  const file = Buffer.alloc(0x200 + 0x800);
  file.writeUInt16LE(0x5a4d, 0);
  file.writeUInt32LE(0x40, 0x3c);
  file.writeUInt32LE(0x00004550, 0x40);
  file.writeUInt16LE(plus ? 0x8664 : 0x014c, 0x44);
  file.writeUInt16LE(1, 0x46);
  file.writeUInt16LE(optionalSize, 0x54);
  const optional = 0x58;
  file.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  if (plus) file.writeBigUInt64LE(imageBase, optional + 24);
  else file.writeUInt32LE(Number(imageBase), optional + 28);
  const directories = optional + (plus ? 112 : 96);
  file.writeUInt32LE(16, directories - 4);
  const section = optional + optionalSize;
  file.writeUInt32LE(0x800, section + 8);
  file.writeUInt32LE(0x1000, section + 12);
  file.writeUInt32LE(0x800, section + 16);
  file.writeUInt32LE(0x200, section + 20);
  const at = (rva) => rva - 0x1000 + 0x200;
  let strings = 0x1400;
  const name = (text) => {
    const rva = strings;
    file.write(`${text}\0`, at(rva), "latin1");
    strings += text.length + 1;
    return rva;
  };
  if (imports.length) {
    file.writeUInt32LE(0x1000, directories + 8);
    file.writeUInt32LE((imports.length + 1) * 20, directories + 12);
    imports.forEach((dll, index) => {
      const entry = at(0x1000) + index * 20;
      file.writeUInt32LE(0x1800, entry);
      file.writeUInt32LE(name(dll), entry + 12);
      file.writeUInt32LE(0x1800, entry + 16);
    });
  }
  const delayed = [
    ...delay.map((dll) => [dll, true]),
    ...old.map((dll) => [dll, false]),
  ];
  if (delayed.length) {
    file.writeUInt32LE(0x1200, directories + 13 * 8);
    file.writeUInt32LE((delayed.length + 1) * 32, directories + 13 * 8 + 4);
    delayed.forEach(([dll, modern], index) => {
      const entry = at(0x1200) + index * 32;
      const rva = name(dll);
      file.writeUInt32LE(modern ? 1 : 0, entry);
      file.writeUInt32LE(
        modern ? rva : Number((imageBase + BigInt(rva)) & 0xffffffffn),
        entry + 4,
      );
    });
  }
  return file;
}

async function layout(t) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh-native-deps-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (relative, bytes) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  };
  return { root, put };
}

test("PE reader lists ordinary and delay-load imports of PE32+ and PE32 images and ignores other files", async (t) => {
  const { root, put } = await layout(t);
  await put(
    "x64.exe",
    peImage({
      imports: ["VCRUNTIME140.dll", "KERNEL32.dll"],
      delay: ["MSVCP140.dll"],
    }),
  );
  await put(
    "x86.dll",
    peImage({ plus: false, imports: ["USER32.dll"], old: ["legacy.dll"] }),
  );
  await put(
    "script.exe",
    Buffer.from("#!/bin/sh\necho not a PE image\n".padEnd(128)),
  );
  await put("tiny.dll", Buffer.from("MZ"));
  assert.deepEqual(await readPeImports(path.join(root, "x64.exe")), {
    machine: "x64",
    imports: ["VCRUNTIME140.dll", "KERNEL32.dll"],
    delayImports: ["MSVCP140.dll"],
  });
  assert.deepEqual(await readPeImports(path.join(root, "x86.dll")), {
    machine: "x86",
    imports: ["USER32.dll"],
    delayImports: ["legacy.dll"],
  });
  assert.equal(await readPeImports(path.join(root, "script.exe")), undefined);
  assert.equal(await readPeImports(path.join(root, "tiny.dll")), undefined);

  // A damaged image fails explicitly instead of looking dependency-free.
  const damaged = peImage({ imports: ["a.dll"] });
  damaged.writeUInt16LE(0xffff, 0x54);
  await put("damaged.exe", damaged);
  await assert.rejects(
    readPeImports(path.join(root, "damaged.exe")),
    PeFormatError,
  );
});

test("runtime classification separates redistributable runtimes from Windows DLLs and API sets", () => {
  for (const name of [
    "VCRUNTIME140.dll",
    "vcruntime140_1.dll",
    "MSVCP140.dll",
    "msvcp140_atomic_wait.dll",
    "MSVCR120.dll",
    "vcomp140.dll",
    "concrt140.dll",
    "mfc140u.dll",
  ])
    assert.equal(isRedistributableRuntime(name), true, name);
  for (const name of [
    "ucrtbase.dll",
    "KERNEL32.dll",
    "msvcrt.dll",
    "python312.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll",
  ])
    assert.equal(isRedistributableRuntime(name), false, name);
  assert.equal(isApiSet("api-ms-win-crt-runtime-l1-1-0.dll"), true);
  assert.equal(isApiSet("EXT-MS-WIN-foo-l1-1-0.dll"), true);
  assert.equal(isApiSet("kernel32.dll"), false);
});

test("layout scan accepts application-local and host-directory runtimes and reports a runtime that only an installed redistributable would provide", async (t) => {
  const { root, put } = await layout(t);
  const needsRuntime = peImage({
    imports: [
      "VCRUNTIME140.dll",
      "KERNEL32.dll",
      "api-ms-win-crt-heap-l1-1-0.dll",
    ],
  });
  // Python keeps the runtime next to python.exe; extension modules live below it.
  await put("engines/py/python.exe", needsRuntime);
  await put(
    "engines/py/vcruntime140.dll",
    peImage({ imports: ["KERNEL32.dll"] }),
  );
  await put("engines/py/DLLs/_ssl.pyd", needsRuntime);
  // Node addons are loaded by runtime/node.exe.
  await put("runtime/node.exe", peImage({ imports: ["KERNEL32.dll"] }));
  await put("runtime/vcruntime140.dll", peImage({ imports: ["KERNEL32.dll"] }));
  await put("engines/npm/node_modules/addon/build/addon.node", needsRuntime);
  // A Windows component that the clean system lacks, and a DLL that exists nowhere.
  await put(
    "engines/tool/tool.exe",
    peImage({ imports: ["KERNEL32.dll", "dwrite.dll", "nowhere.dll"] }),
  );
  // Runtime data is not part of the shipped layout.
  await put("state/cache/ignored.exe", peImage({ imports: ["MSVCP140.dll"] }));

  const system = new Set(["kernel32.dll", "ucrtbase.dll"]);
  const reference = new Set(["kernel32.dll", "dwrite.dll"]);
  const healthy = await scanLayout({
    root,
    system,
    reference,
    ignore: ["state"],
  });
  assert.equal(healthy.status, "OK", JSON.stringify(healthy.runtime));
  assert.equal(healthy.peFiles, 7);
  assert.deepEqual(healthy.runtime["vcruntime140.dll"].resolutions, {
    "app-local": 1,
    "host-directory": 1,
    "node-runtime-directory": 1,
  });
  assert.equal(
    healthy.missing["dwrite.dll"].classification,
    "windows-component-absent-on-the-clean-system",
  );
  assert.equal(healthy.missing["nowhere.dll"].classification, "found-nowhere");
  assert.equal(healthy.missing["msvcp140.dll"], undefined, "state/ is ignored");

  // The same image in a directory without the runtime only works where a
  // redistributable is installed: another copy elsewhere in the layout does not count.
  await put("engines/rust/agent.exe", needsRuntime);
  const risky = await scanLayout({
    root,
    system,
    reference,
    ignore: ["state"],
  });
  assert.equal(risky.status, "RISK");
  assert.deepEqual(risky.runtimeAtRisk, ["vcruntime140.dll"]);
  assert.equal(risky.runtime["vcruntime140.dll"].resolutions.elsewhere, 1);
  assert.match(summarize(risky), /\*\*RISK\*\*/);
  assert.match(summarize(risky), /vcruntime140\.dll \| 4 \|/);

  // A machine that has the redistributable installed hides the problem - which is
  // exactly why the clean list matters.
  const installed = await scanLayout({
    root,
    system: new Set([...system, "vcruntime140.dll"]),
    ignore: ["state"],
  });
  assert.equal(installed.status, "OK");
});
