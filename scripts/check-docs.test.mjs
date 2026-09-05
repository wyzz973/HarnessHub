import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkDocs } from './check-docs.mjs';

const script = fileURLToPath(new URL('./check-docs.mjs', import.meta.url));

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnesshub-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return root;
}

test('valid documents, nested paths, fragments, remote URLs and generated exclusions', async (t) => {
  const root = await fixture(t, {
    'README.md': '# Project\n\n[Design](docs/design.md#not-validated) [Web](https://example.test/missing) [Mail](mailto:a@example.test) [Local](#anchor)\n',
    'docs/design.md': '# Design\n\n[Root](../README.md)\n',
    'node_modules/broken.md': '\uFEFF[bad](absent.md)',
    'data/output.md': '[bad](absent.md)',
    'artifacts/result.md': '[bad](absent.md)',
  });
  assert.deepEqual(await checkDocs(root), { checkedFiles: 2, diagnostics: [] });
});

test('missing links report their document and exact line; CLI exits nonzero', async (t) => {
  const root = await fixture(t, { 'README.md': '# Project\n\n[Missing](gone.md)\n' });
  const result = await checkDocs(root);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], /^README\.md:3: local link target unavailable \(ENOENT\): gone\.md$/);
  const cli = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /README\.md:3:/);
});

test('generated temp and runtime data are excluded; the same invalid document elsewhere fails', async (t) => {
  const invalid = '[Missing](absent.md)\n';
  const root = await fixture(t, {
    'README.md': '# Project\n',
    '.tmp/generated.md': invalid,
    'runtime-data/run/output.md': invalid,
  });
  assert.deepEqual(await checkDocs(root), { checkedFiles: 1, diagnostics: [] });
  await writeFile(path.join(root, 'regular.md'), invalid);
  const result = await checkDocs(root);
  assert.equal(result.checkedFiles, 2);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], /^regular\.md:1: local link target unavailable/);
});

test('local links must be relative even when an absolute target exists within root', async (t) => {
  const root = await fixture(t, {
    'README.md': '# Project\n\n[Valid](./target.md)\n',
    'target.md': '# Target\n',
  });
  assert.deepEqual((await checkDocs(root)).diagnostics, []);
  const absolute = path.join(root, 'target.md').split(path.sep).join('/');
  await writeFile(path.join(root, 'README.md'), `# Project\n\n[Absolute](<${absolute}>)\n[Encoded](${encodeURIComponent(absolute)})\n`);
  const { diagnostics } = await checkDocs(root);
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((value) => /absolute (?:local )?links are unsupported/.test(value)));
  assert.match(diagnostics[0], /^README\.md:3:/);
  assert.match(diagnostics[1], /^README\.md:4:/);
});

test('an unreadable project root rejects and the CLI exits nonzero', async (t) => {
  const parent = await fixture(t, {});
  const root = path.join(parent, 'missing');
  await assert.rejects(checkDocs(root), { code: 'ENOENT' });
  const cli = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /document check could not complete: ENOENT/);
});

test('spaces, Unicode, URL encoding, escaped parentheses, images and titles', async (t) => {
  const root = await fixture(t, {
    'README.md': '# Links\n\n[空格](<docs/中文 file.md>) [Encoded](docs/%E4%B8%AD%E6%96%87%20file.md?view=1#section) [Title](<docs/中文 file.md> "label")\n![Image](assets/a%20b.png) [Nested](docs/a(b).md) [Escaped](docs/a\\(b\\).md)\n',
    'docs/中文 file.md': '# 中文\n',
    'docs/a(b).md': '# Parentheses\n',
    'assets/a b.png': Buffer.from([0]),
  });
  assert.deepEqual((await checkDocs(root)).diagnostics, []);
});

test('fenced and inline code examples do not create missing-link errors', async (t) => {
  const root = await fixture(t, {
    'README.md': '# Examples\n\n```md\n[Fake](missing.md)\n```\n~~~~markdown\n[Fake](missing-too.md)\n~~~\n~~~~\n`[Fake](inline.md)` and `` `[Fake](nested.md)` ``.\n`Multi-line\n[Fake](multiline.md)`\n\\[Escaped](escaped.md)\n\n    [Example](indented.md)\n\t[Example](tab-indented.md)\n\n[Real](README.md)\n',
  });
  assert.deepEqual((await checkDocs(root)).diagnostics, []);
});

test('CRLF, BOM, missing and extra final newlines are errors', async (t) => {
  const root = await fixture(t, {
    'bom.md': '\uFEFF# BOM\n',
    'crlf.md': '# CRLF\r\n',
    'missing.md': '# Missing',
    'extra.md': '# Extra\n\n',
  });
  const { diagnostics } = await checkDocs(root);
  assert.equal(diagnostics.length, 4);
  assert.ok(diagnostics.some((value) => /^bom\.md:1:.*BOM/.test(value)));
  assert.ok(diagnostics.some((value) => /^crlf\.md:1:.*CRLF/.test(value)));
  assert.ok(diagnostics.some((value) => /^missing\.md:1:.*final LF/.test(value)));
  assert.ok(diagnostics.some((value) => /^extra\.md:3:.*final LF/.test(value)));
});

test('invalid UTF-8 is rejected instead of silently replacing bytes', async (t) => {
  const root = await fixture(t, { 'bad.md': Buffer.from([0xC3, 0x28, 0x0A]) });
  assert.deepEqual((await checkDocs(root)).diagnostics, ['bad.md:1: invalid UTF-8']);
});

test('unclosed fences identify the opening line and ignore their example links', async (t) => {
  const root = await fixture(t, { 'README.md': '# Fence\n\n````md\n[Example](absent.md)\n```\n' });
  assert.deepEqual((await checkDocs(root)).diagnostics, ['README.md:3: unclosed fenced code block']);
});

test('empty Markdown inventory fails, including when only excluded files exist', async (t) => {
  const root = await fixture(t, { 'node_modules/README.md': '# Dependency\n' });
  const result = await checkDocs(root);
  assert.equal(result.checkedFiles, 0);
  assert.match(result.diagnostics[0], /no Markdown files found/);
  const cli = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
});

test('path traversal and malformed percent encoding fail', async (t) => {
  const root = await fixture(t, { 'README.md': '# Bad links\n\n[Escape](../elsewhere.md) [Encoded](%2e%2e/outside.md) [Bad](bad%XX.md)\n' });
  const { diagnostics } = await checkDocs(root);
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics.filter((value) => value.includes('escapes project root')).length, 2);
  assert.ok(diagnostics.some((value) => value.includes('invalid URL encoding')));
});

test('a link through a symlink cannot escape the project root', async (t) => {
  const outside = await fixture(t, { 'outside.txt': 'outside' });
  const root = await fixture(t, { 'README.md': '# Links\n\n[Escape](escape.txt)\n' });
  try {
    await symlink(path.join(outside, 'outside.txt'), path.join(root, 'escape.txt'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
      t.skip('creating symlinks is not permitted on this host');
      return;
    }
    throw error;
  }
  assert.match((await checkDocs(root)).diagnostics[0], /^README\.md:3: local link symlink escapes/);
});

test('CLI passes for valid documents and rejects unsupported arguments', async (t) => {
  const root = await fixture(t, { 'README.md': '# Valid\n' });
  const valid = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /passed: 1 Markdown files/);
  const invalid = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Usage:/);
});
