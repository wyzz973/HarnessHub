import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyEngineSources, reassembleEngineSource } from './vendor-engine-sources.mjs';

const execute = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const script = fileURLToPath(new URL('./vendor-engine-sources.mjs', import.meta.url));

async function fixture(t, split = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnesshub-source-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('harnesshub-source-test-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const put = async (file, bytes) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), bytes); };
  const json = (file, value) => put(file, `${JSON.stringify(value, null, 2)}\n`);
  const upstream = path.join(root, 'upstream');
  await mkdir(upstream);
  const git = async (args) => (await execute('git', ['-C', upstream, ...args], { windowsHide: true })).stdout.trim();
  await git(['init', '--quiet']);
  await json('upstream/package.json', { name: 'fixture-engine', version: '1.2.3' });
  const license = Buffer.from('MIT License\nCopyright Test Fixture\n');
  await put('upstream/LICENSE', license);
  await git(['add', '.']);
  await git(['-c', 'core.hooksPath=', '-c', 'user.name=Source Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'source fixture']);
  const commit = await git(['rev-parse', 'HEAD']);
  const archive = 'vendor/engine-sources/fixture.zip';
  await mkdir(path.join(root, 'vendor/engine-sources'), { recursive: true });
  await git(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=zip', '--prefix=fixture/', `--output=${path.join(root, archive)}`, commit]);
  const bytes = await readFile(path.join(root, archive));
  const source = { id: 'fixture', repository: 'https://github.com/test/fixture', version: '1.2.3', tag: 'v1.2.3', commit, license: 'MIT', kind: 'engine', npmPackage: 'fixture-engine', sourceVersion: { file: 'package.json', format: 'json' }, archive, bytes: bytes.length, sha256: sha(bytes), notices: [{ source: 'LICENSE', file: 'LICENSE', sha256: sha(license) }] };
  if (split) {
    const half = Math.floor(bytes.length / 2);
    source.parts = [];
    for (const [index, part] of [bytes.subarray(0, half), bytes.subarray(half)].entries()) {
      const file = `${archive}.part${String(index + 1).padStart(3, '0')}`;
      await put(file, part);
      source.parts.push({ file, bytes: part.length, sha256: sha(part) });
    }
    await rm(path.join(root, archive));
  }
  const manifest = { schemaVersion: 1, sources: [source], unavailable: [] };
  const save = async () => { await json('distribution/source-repositories.json', manifest); await json('vendor/engine-sources/fixture/provenance.json', source); };
  await save();
  await put('vendor/engine-sources/fixture/LICENSE', license);
  await json('distribution/npm/package.json', { dependencies: { 'fixture-engine': '1.2.3' } });
  await json('package.json', { dependencies: { acpx: '0.13.2' } });
  await json('distribution/binary-sources.json', []);
  await json('distribution/extra-engine-sources.json', { hermes: { version: '0.19.0' } });
  await json('distribution/deepseek.json', { engines: { fixture: {} } });
  return { root, put, json, source, bytes, save };
}

test('source check works offline without Git on PATH', async (t) => {
  const f = await fixture(t);
  const result = await execute(process.execPath, [script, '--check', '--root', f.root], { env: { ...process.env, PATH: path.join(f.root, 'no-programs') }, windowsHide: true });
  const report = JSON.parse(result.stdout);
  assert.equal(report.networkAllowed, false);
  assert.equal(report.sources[0].version, '1.2.3');
});

test('split source reassembly preserves exact bytes and refuses overwrite', async (t) => {
  const f = await fixture(t, true);
  const output = path.join(f.root, 'assembled.zip');
  await reassembleEngineSource(f.root, 'fixture', output);
  assert.deepEqual(await readFile(output), f.bytes);
  await assert.rejects(reassembleEngineSource(f.root, 'fixture', output), { code: 'EEXIST' });
  assert.deepEqual(await readFile(output), f.bytes);
});

test('source check rejects corrupted archive and exits nonzero', async (t) => {
  const f = await fixture(t);
  const broken = Buffer.from(f.bytes);
  broken[100] ^= 1;
  await f.put(f.source.archive, broken);
  await assert.rejects(execute(process.execPath, [script, '--check', '--root', f.root], { windowsHide: true }), (error) => error.code === 1 && /hash or size mismatch/.test(error.stderr));
});

test('source check rejects runtime version drift', async (t) => {
  const f = await fixture(t);
  await f.json('distribution/npm/package.json', { dependencies: { 'fixture-engine': '2.0.0' } });
  await assert.rejects(verifyEngineSources(f.root), /runtime version differs/);
});

test('source check rejects an archived version that differs from the claimed lock', async (t) => {
  const f = await fixture(t);
  f.source.version = '2.0.0';
  await f.save();
  await f.json('distribution/npm/package.json', { dependencies: { 'fixture-engine': '2.0.0' } });
  await assert.rejects(verifyEngineSources(f.root), /archived source version differs/);
});

test('source check rejects a wrong commit despite unchanged archive hash', async (t) => {
  const f = await fixture(t);
  f.source.commit = '0'.repeat(40);
  await f.save();
  await assert.rejects(verifyEngineSources(f.root), /Archive commit does not match/);
});

test('source check rejects missing, extra, damaged and reordered parts', async (t) => {
  const f = await fixture(t, true);
  const first = f.source.parts[0];
  const bytes = await readFile(path.join(f.root, first.file));
  await rm(path.join(f.root, first.file));
  await assert.rejects(verifyEngineSources(f.root), { code: 'ENOENT' });
  await f.put(first.file, bytes);
  await f.put(`${f.source.archive}.part003`, bytes);
  await assert.rejects(verifyEngineSources(f.root), /Unexpected source snapshot file/);
  await rm(path.join(f.root, `${f.source.archive}.part003`));
  const damaged = Buffer.from(bytes);
  damaged[10] ^= 1;
  await f.put(first.file, damaged);
  await assert.rejects(verifyEngineSources(f.root), /archive part hash or size mismatch/);
  await f.put(first.file, bytes);
  f.source.parts.reverse();
  await f.save();
  await assert.rejects(verifyEngineSources(f.root), /archive part order or identity/);
});

test('source check rejects changed license bytes', async (t) => {
  const f = await fixture(t);
  await f.put('vendor/engine-sources/fixture/LICENSE', 'different license');
  await assert.rejects(verifyEngineSources(f.root), /retained notice hash mismatch/);
});

test('source check rejects an incomplete engine source matrix', async (t) => {
  const f = await fixture(t);
  await f.json('distribution/deepseek.json', { engines: { fixture: {}, missing: {} } });
  await assert.rejects(verifyEngineSources(f.root), /every supported engine exactly once/);
});
