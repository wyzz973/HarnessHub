// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_ITERATIONS,
  BackupError,
  formatEnvelope,
  open,
  parseEnvelope,
  seal,
  type BackupEnvelope,
} from "../src/backup-envelope.js";

const PLAIN = Buffer.from(
  JSON.stringify({ secret: "sk-synthetic-envelope-0001" }),
);
const PASSPHRASE = "synthetic passphrase";
/** The lowest count `open` accepts keeps the other cases fast. */
const FAST = 100_000;

function rejects(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BackupError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 400);
    return true;
  };
}

void test("a sealed backup opens with its passphrase and holds ciphertext only", async () => {
  const envelope = await seal(PLAIN, PASSPHRASE);
  assert.equal(envelope.format, "harnesshub-backup");
  assert.equal(envelope.version, 1);
  assert.equal(envelope.kdf, "pbkdf2-sha256");
  assert.equal(envelope.iterations, BACKUP_ITERATIONS);
  assert.equal(BACKUP_ITERATIONS, 600_000);
  assert.equal(Buffer.from(envelope.salt, "base64").length, 16);
  assert.equal(Buffer.from(envelope.nonce, "base64").length, 12);
  const text = formatEnvelope(envelope);
  assert.doesNotMatch(text, /sk-synthetic/);
  assert.deepEqual(await open(parseEnvelope(text), PASSPHRASE), PLAIN);
  // Salt and nonce are fresh each time.
  const again = await seal(PLAIN, PASSPHRASE, FAST);
  assert.notEqual(again.salt, envelope.salt);
  assert.notEqual(again.nonce, envelope.nonce);
});

void test("a wrong passphrase, a changed byte or a changed envelope field opens nothing", async () => {
  const envelope = await seal(PLAIN, PASSPHRASE, FAST);
  await assert.rejects(open(envelope, "wrong"), rejects("BACKUP_PASSPHRASE"));
  const flip = (field: "data" | "nonce" | "salt", index: number) => {
    const bytes = Buffer.from(envelope[field], "base64");
    bytes.writeUInt8(bytes.readUInt8(index) ^ 1, index);
    return { ...envelope, [field]: bytes.toString("base64") };
  };
  for (const changed of [
    flip("data", 0),
    flip("data", Buffer.from(envelope.data, "base64").length - 1),
    flip("nonce", 3),
    flip("salt", 7),
    { ...envelope, iterations: FAST + 1 },
  ])
    await assert.rejects(
      open(changed, PASSPHRASE),
      rejects("BACKUP_PASSPHRASE"),
    );
});

void test("what is not a sealed backup, or a newer one, is refused before decrypting", async () => {
  const envelope = await seal(PLAIN, PASSPHRASE, FAST);
  const cases: Array<[unknown, string]> = [
    [null, "BACKUP_INVALID"],
    [[], "BACKUP_INVALID"],
    [{ ...envelope, format: "magpie-backup" }, "BACKUP_INVALID"],
    [{ ...envelope, version: 2 }, "BACKUP_UNSUPPORTED"],
    [{ ...envelope, kdf: "argon2id" }, "BACKUP_UNSUPPORTED"],
    [{ ...envelope, iterations: 99_999 }, "BACKUP_INVALID"],
    [{ ...envelope, iterations: 10_000_001 }, "BACKUP_INVALID"],
    [{ ...envelope, iterations: "600000" }, "BACKUP_INVALID"],
    [
      { ...envelope, nonce: Buffer.alloc(16).toString("base64") },
      "BACKUP_INVALID",
    ],
    [
      { ...envelope, salt: Buffer.alloc(8).toString("base64") },
      "BACKUP_INVALID",
    ],
    [{ ...envelope, data: "not base64!" }, "BACKUP_INVALID"],
    [
      { ...envelope, data: Buffer.alloc(8).toString("base64") },
      "BACKUP_INVALID",
    ],
  ];
  for (const [value, code] of cases)
    await assert.rejects(open(value, PASSPHRASE), rejects(code));
  assert.throws(() => parseEnvelope("{not json"), rejects("BACKUP_INVALID"));
  await assert.rejects(seal(PLAIN, ""), rejects("BACKUP_INVALID"));
});

void test("an empty content round-trips and the envelope is plain JSON", async () => {
  const envelope: BackupEnvelope = await seal(Buffer.alloc(0), "p", FAST);
  const text = formatEnvelope(envelope);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(Object.keys(JSON.parse(text) as object), [
    "format",
    "version",
    "kdf",
    "iterations",
    "salt",
    "nonce",
    "data",
  ]);
  assert.equal((await open(JSON.parse(text), "p")).length, 0);
});
