// 原型，仅用于测量，不是实现。测量 6（可选）：用 Node 内置 node:sqlite 在临时库里测“run.ended 事务中追加派生行”的提交耗时增量。
// 临时库建在 RELAY_SPIKE_TMP（缺省 os.tmpdir()）下的新目录里，测完整个目录删除。不碰任何 data/ 目录或 4317 服务。
// 表结构：sessions 与 events 照 src/infrastructure/session/sqlite-store.ts:463–465；relay_digests 照 v1 §14.1；PRAGMA 照 sqlite-store.ts:247。
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { now, summary } from "./common.ts";
import { bigFixture } from "./bench-render.ts";
import { text } from "./gen.ts";

function walBytes(path: string): number { try { return statSync(path + "-wal").size; } catch { return 0; } }

export function run(): Record<string, unknown> {
  const base = process.env.RELAY_SPIKE_TMP ?? os.tmpdir();
  const dir = mkdtempSync(join(base, "relay-spike-sqlite-"));
  try {
    const f = bigFixture();
    const digests = f.dg.json, shas = f.dg.sha;
    const results: Record<string, unknown> = { digestRowBytes: summary(digests.map(d => Buffer.byteLength(d)), 0) };
    const db0 = new DatabaseSync(":memory:");
    results.sqliteVersion = (db0.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v; db0.close();
    for (const mib of [1, 8]) {
      const path = join(dir, "bench-" + mib + ".sqlite");
      const db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
      db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>=1),last_seq INTEGER NOT NULL CHECK(last_seq>=0),snapshot TEXT NOT NULL CHECK(json_valid(snapshot))) STRICT;
        CREATE TABLE events(session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL CHECK(seq>=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),event_json TEXT NOT NULL CHECK(json_valid(event_json)),PRIMARY KEY(session_id,seq)) STRICT;
        CREATE TABLE relay_digests(session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL, run_index INTEGER NOT NULL, policy_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN('current','behind','failed')),
          digest_json TEXT NOT NULL CHECK(json_valid(digest_json) AND length(CAST(digest_json AS BLOB))<=65536), sha256 TEXT NOT NULL,
          PRIMARY KEY(session_id, run_id), UNIQUE(session_id, run_index)) STRICT;`);
      // 快照正文：合成文本，序列化后约 mib MiB（每次提交改 version，整份重写，同现状 sqlite-store.ts:359）。
      const body = text(mib * 1024 * 1024 - 4096, mib);
      const snap = (v: number): string => JSON.stringify({ v, body });
      db.prepare("INSERT INTO sessions VALUES('s',1,0,?)").run(snap(1));
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const update = db.prepare("UPDATE sessions SET version=?,last_seq=?,snapshot=? WHERE id='s' AND version=?");
      const event = db.prepare("INSERT INTO events(session_id,seq,owner_generation,event_json) VALUES('s',?,1,?)");
      const digest = db.prepare("INSERT INTO relay_digests VALUES('s',?,?,'relay/1','current',?,?)");
      let version = 1, seq = 0, runIndex = 0;
      const ended = JSON.stringify({ type: "run.ended", data: { runId: "run-x", status: "completed", delivery: { outcome: "recorded", evidence: "E3" }, digest: { status: "current" } } });
      const txn = (withDigest: boolean): number => {
        const t = now();
        db.exec("BEGIN IMMEDIATE");
        update.run(version + 1, seq + 1, snap(version + 1), version); version++; seq++;
        event.run(seq, ended);
        if (withDigest) { const k = runIndex % digests.length; digest.run("run-" + runIndex, runIndex, digests[k]!, shas[k]!); runIndex++; }
        db.exec("COMMIT");
        return now() - t;
      };
      for (let i = 0; i < 4; i++) { txn(false); txn(true); }
      const base: number[] = [], withD: number[] = [], diff: number[] = [];
      const pairs = mib === 8 ? 40 : 80;
      for (let i = 0; i < pairs; i++) {
        // ABBA 交替，抵消漂移
        let a: number, b: number;
        if (i % 2 === 0) { a = txn(false); b = txn(true); } else { b = txn(true); a = txn(false); }
        base.push(a); withD.push(b); diff.push(b - a);
      }
      // 只追加派生行（无快照重写）的提交：与 R6 的“账本式追加”同口径。
      const appendOnly: number[] = [], walGrowth: number[] = [];
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");   // 让 WAL 从 0 开始增长，才能按文件大小看每次追加写了多少
      for (let i = 0; i < 200; i++) {
        const w0 = walBytes(path), t = now();
        db.exec("BEGIN IMMEDIATE");
        const k = runIndex % digests.length; digest.run("run-" + runIndex, runIndex, digests[k]!, shas[k]!); runIndex++;
        db.exec("COMMIT");
        appendOnly.push(now() - t); walGrowth.push(walBytes(path) - w0);
      }
      // 交接时读 256 行摘要并解析（渲染路径若从库里读）
      const read = db.prepare("SELECT digest_json FROM relay_digests WHERE session_id='s' AND run_index BETWEEN ? AND ? ORDER BY run_index");
      const readXs: number[] = [];
      for (let i = 0; i < 50; i++) { const t = now(); const rows = read.all(0, 255) as { digest_json: string }[]; for (const r of rows) JSON.parse(r.digest_json); readXs.push(now() - t); }
      results["snapshot" + mib + "MiB"] = { commitWithoutDigestMs: summary(base, 3), commitWithDigestMs: summary(withD, 3), pairedIncrementMs: summary(diff, 3), appendOnlyCommitMs: summary(appendOnly, 3), appendOnlyWalBytes: walGrowth.some(x => x > 0) ? summary(walGrowth.filter(x => x > 0), 0) : null, read256DigestsAndParseMs: summary(readXs, 3) };
      db.close();
    }
    return results;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.main) console.log(JSON.stringify(run(), null, 2));
