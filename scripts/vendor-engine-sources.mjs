#!/usr/bin/env node
/**
 * Verify vendored upstream source snapshots without network or dependencies.
 * --fetch may clone the locked tags and recreate missing archives; it never runs
 * upstream hooks, dependency installers or builds. Existing bytes are preserved.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, lstat, readdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const execute = promisify(execFile);
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const limit = 95 * 1024 * 1024;
const partLimit = 90 * 1024 * 1024;
const archiveLimit = 512 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safePath = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.\-/]+$/.test(value) && !value.startsWith('/') && !value.split('/').some((part) => part === '..' || part === '.' || part === '');

/** Read a named source file from a bounded Git ZIP, never extracting paths. */
export function inspectGitArchive(bytes, expectedCommit, member) {
  if (bytes.length >= archiveLimit || bytes.length < 62) fail('Archive size is invalid');
  const eocd = bytes.length - 62;
  if (bytes.readUInt32LE(eocd) !== 0x06054b50 || bytes.readUInt16LE(eocd + 20) !== 40 || bytes.subarray(eocd + 22).toString('ascii') !== expectedCommit) fail('Archive commit does not match source lock');
  let cursor = bytes.readUInt32LE(eocd + 16);
  const count = bytes.readUInt16LE(eocd + 10);
  if (count === 65535) fail('ZIP64 source snapshots are not supported');
  let found;
  const names = new Set();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid archive directory');
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (names.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) fail('Unsafe or duplicate archive member');
    names.add(name);
    if (name === member) {
      const local = bytes.readUInt32LE(cursor + 42);
      if (local + 30 > cursor || bytes.readUInt32LE(local) !== 0x04034b50) fail('Invalid archive local header');
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.readUInt32LE(cursor + 20);
      const length = bytes.readUInt32LE(cursor + 24);
      if (length > 2 * 1024 * 1024 || start + compressed > cursor) fail('Source version member exceeds bounds');
      const method = bytes.readUInt16LE(cursor + 10);
      const payload = bytes.subarray(start, start + compressed);
      found = method === 0 ? payload : method === 8 ? inflateRawSync(payload, { maxOutputLength: 2 * 1024 * 1024 }) : fail('Unsupported compression');
      if (found.length !== length) fail('Source version member length mismatch');
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== eocd || found === undefined) fail('Source version member is missing');
  return { file: found, entries: count };
}

async function regularFile(root, relative) {
  if (!safePath(relative)) fail('Invalid local source path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail('Source paths cannot contain links');
  }
  const info = await lstat(current);
  if (!info.isFile() || info.size >= limit) fail('Expected a regular source file below 95 MiB');
  return readFile(current);
}

function validateSource(source) {
  if (!object(source) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.id) || !['engine', 'adapter', 'runtime'].includes(source.kind) || typeof source.version !== 'string' || source.version.length === 0 || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) || !/^[0-9a-f]{40}$/.test(source.commit) || typeof source.tag !== 'string' || source.tag.startsWith('-') || !/^[A-Za-z0-9_./-]+$/.test(source.tag) || !['MIT', 'Apache-2.0'].includes(source.license)) fail('Invalid source identity');
  if (source.archive !== `vendor/engine-sources/${source.id}.zip` || !/^[0-9a-f]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes <= 0 || source.bytes >= archiveLimit || !object(source.sourceVersion) || !safePath(source.sourceVersion.file) || !['json', 'toml'].includes(source.sourceVersion.format)) fail(`${source.id}: invalid archive lock`);
  if (source.parts !== undefined) {
    if (!Array.isArray(source.parts) || source.parts.length < 2 || source.parts.reduce((sum, part) => sum + part.bytes, 0) !== source.bytes) fail(`${source.id}: invalid archive parts`);
    for (const [index, part] of source.parts.entries()) {
      if (!object(part) || part.file !== `${source.archive}.part${String(index + 1).padStart(3, '0')}` || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > partLimit || !/^[0-9a-f]{64}$/.test(part.sha256)) fail(`${source.id}: invalid archive part order or identity`);
    }
  } else if (source.bytes >= limit) fail(`${source.id}: oversized archive must be split`);
  if (!Array.isArray(source.notices) || !source.notices.length) fail(`${source.id}: license is missing`);
  for (const notice of source.notices) {
    if (!object(notice) || !safePath(notice.source) || !safePath(notice.file) || notice.file.includes('/') || !/^[0-9a-f]{64}$/.test(notice.sha256)) fail(`${source.id}: invalid notice`);
  }
}

async function runtimeVersions(root) {
  const read = async (file) => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const [npm, main, binaries, extra, preset] = await Promise.all([read('distribution/npm/package.json'), read('package.json'), read('distribution/binary-sources.json'), read('distribution/extra-engine-sources.json'), read('distribution/deepseek.json')]);
  return { npm: { ...npm.dependencies, acpx: main.dependencies.acpx }, engines: { ...Object.fromEntries(binaries.map((entry) => [entry.id, entry.version])), hermes: extra.hermes.version }, supported: Object.keys(preset.engines).sort() };
}

async function git(args) {
  return (await execute('git', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 300000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
}

async function fetchSource(root, source) {
  const directory = path.join(root, '.tools/source-repositories', source.id);
  await mkdir(path.dirname(directory), { recursive: true });
  try { await lstat(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await git(['-c', 'core.hooksPath=', '-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', 'clone', '--depth', '1', '--single-branch', '--branch', source.tag, '--no-checkout', `${source.repository}.git`, directory]);
    await git(['-C', directory, '-c', 'core.hooksPath=', '-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', 'checkout', '--detach', source.commit]);
  }
  if ((await lstat(directory)).isSymbolicLink()) fail('Clone directory cannot be a link');
  if (await git(['-C', directory, 'rev-parse', 'HEAD']) !== source.commit || await git(['-C', directory, 'remote', 'get-url', 'origin']) !== `${source.repository}.git`) fail(`${source.id}: existing clone identity differs; it was preserved`);
  const expectedFiles = source.parts?.map((part) => part.file) ?? [source.archive];
  let missing = false;
  for (const file of expectedFiles) {
    try { await lstat(path.join(root, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; }
  }
  if (!missing) return;
  const scratchRoot = path.join(root, '.tmp/source-vendoring');
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, 'rebuild-'));
  const archive = path.join(scratch, `${source.id}.zip`);
  await git(['-C', directory, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=zip', `--prefix=${source.id}/`, `--output=${archive}`, source.commit]);
  const bytes = await readFile(archive);
  if (bytes.length !== source.bytes || hash(bytes) !== source.sha256) fail(`${source.id}: regenerated archive differs; preserved in ${scratch}`);
  let offset = 0;
  for (const part of source.parts ?? [{ file: source.archive, bytes: source.bytes }]) {
    const target = path.join(root, part.file);
    await mkdir(path.dirname(target), { recursive: true });
    try { await writeFile(target, bytes.subarray(offset, offset + part.bytes), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    offset += part.bytes;
  }
}

async function archiveBytes(root, source) {
  if (source.parts === undefined) return regularFile(root, source.archive);
  const parts = [];
  for (const part of source.parts) {
    const bytes = await regularFile(root, part.file);
    if (bytes.length !== part.bytes || hash(bytes) !== part.sha256) fail(`${source.id}: archive part hash or size mismatch`);
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

/** Reassemble one verified snapshot into a new file; never overwrite user work. */
export async function reassembleEngineSource(root, id, output) {
  await verifyEngineSources(root);
  const manifest = JSON.parse(await readFile(path.join(root, 'distribution/source-repositories.json'), 'utf8'));
  const source = manifest.sources.find((entry) => entry.id === id);
  if (source === undefined) fail('Unknown source id');
  await writeFile(path.resolve(output), await archiveBytes(root, source), { flag: 'wx' });
  return { id, output: path.resolve(output), bytes: source.bytes, sha256: source.sha256 };
}

/** Verify source identity, version, ZIP and retained license bytes; --check is offline. */
export async function verifyEngineSources(root = defaultRoot, { fetch = false } = {}) {
  const manifest = JSON.parse(await readFile(path.join(root, 'distribution/source-repositories.json'), 'utf8'));
  if (!object(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources) || manifest.sources.length === 0 || !Array.isArray(manifest.unavailable)) fail('Invalid source repositories manifest');
  const versions = await runtimeVersions(root);
  for (const entry of manifest.unavailable) {
    if (!object(entry) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || typeof entry.reason !== 'string' || entry.reason.length === 0 || typeof entry.version !== 'string') fail('Invalid unavailable engine record');
  }
  const accounted = [...manifest.sources.filter((source) => source.kind === 'engine').map((source) => source.id), ...manifest.unavailable.map((entry) => entry.id)].sort();
  if (JSON.stringify(accounted) !== JSON.stringify(versions.supported)) fail('Source matrix does not account for every supported engine exactly once');
  const ids = new Set();
  const results = [];
  for (const source of manifest.sources) {
    validateSource(source);
    if (ids.has(source.id)) fail('Duplicate source id');
    ids.add(source.id);
    const current = source.npmPackage ? versions.npm[source.npmPackage] : versions.engines[source.id];
    if (current !== source.version) fail(`${source.id}: runtime version differs from source lock`);
    if (fetch) await fetchSource(root, source);
    const bytes = await archiveBytes(root, source);
    if (bytes.length !== source.bytes || hash(bytes) !== source.sha256) fail(`${source.id}: archive hash or size mismatch`);
    const inspection = inspectGitArchive(bytes, source.commit, `${source.id}/${source.sourceVersion.file}`);
    const text = inspection.file.toString('utf8');
    const sourceVersion = source.sourceVersion.format === 'json' ? JSON.parse(text).version : text.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (sourceVersion !== source.version) fail(`${source.id}: archived source version differs from source lock`);
    const provenance = JSON.parse(await regularFile(root, `vendor/engine-sources/${source.id}/provenance.json`));
    if (JSON.stringify(provenance) !== JSON.stringify(source)) fail(`${source.id}: provenance differs from source lock`);
    for (const notice of source.notices) {
      const retained = await regularFile(root, `vendor/engine-sources/${source.id}/${notice.file}`);
      if (hash(retained) !== notice.sha256) fail(`${source.id}: retained notice hash mismatch`);
      const archived = inspectGitArchive(bytes, source.commit, `${source.id}/${notice.source}`).file;
      if (!archived.equals(retained)) fail(`${source.id}: notice differs from upstream archive`);
    }
    results.push({ id: source.id, version: source.version, commit: source.commit, bytes: bytes.length, entries: inspection.entries });
  }
  const expected = new Set(manifest.sources.flatMap((source) => [source.id, ...(source.parts?.map((part) => path.basename(part.file)) ?? [path.basename(source.archive)])]));
  for (const file of await readdir(path.join(root, 'vendor/engine-sources'))) {
    if (!expected.has(file)) fail(`Unexpected source snapshot file: ${file}`);
  }
  return { schemaVersion: 1, networkAllowed: fetch, sources: results, unavailable: manifest.unavailable.length, totalBytes: results.reduce((total, source) => total + source.bytes, 0) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let root = defaultRoot;
    let fetch = false;
    let reassemble;
    let output;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--check') continue;
      if (args[index] === '--fetch') { fetch = true; continue; }
      if (args[index] === '--root' && args[index + 1]) { root = path.resolve(args[++index]); continue; }
      if (args[index] === '--reassemble' && args[index + 1]) { reassemble = args[++index]; continue; }
      if (args[index] === '--output' && args[index + 1]) { output = args[++index]; continue; }
      fail('Usage: node scripts/vendor-engine-sources.mjs [--check|--fetch|--reassemble id --output new.zip] [--root directory]');
    }
    if ((reassemble === undefined) !== (output === undefined) || (fetch && reassemble !== undefined)) fail('Reassembly requires id and output and cannot fetch');
    console.log(JSON.stringify(reassemble ? await reassembleEngineSource(root, reassemble, output) : await verifyEngineSources(root, { fetch }), null, 2));
  } catch (error) {
    console.error(`Engine source verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
