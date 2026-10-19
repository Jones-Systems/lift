import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, readdir, rm, symlink, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inventoryQueue, importQueue, MAX_BATCH_FILES, MAX_QUEUE_FILES } from '../src/editorial-queue.mjs';
import { MAX_JSON_BYTES, reviewArticle, approveArticle, publicationStatus } from '../src/editorial.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const day = '2026-10-09';
const siteId = 'everyday-longevity';
const input = slug => ({ schemaVersion: 1, slug, title: 'Synthetic queue guide', summary: 'Synthetic context.', author: 'Synthetic author',
  sections: [{ heading: 'Context', paragraphs: ['Plain original fixture words.'] }],
  sources: [{ title: 'Synthetic source', url: 'https://example.com/source', publisher: 'Fixture', accessed: day, supports: 'Synthetic context only.' }],
  origin: 'https://www.outrank.so/', rightsStatement: 'Unverified fixture rights.' });

async function sandbox(t) {
  const directory = await mkdtemp(join(root, 'tests', '.editorial-queue-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await assert.rejects(readFile(join(directory, 'content', 'editorial-sites.json')), { code: 'ENOENT' });
  });
  await mkdir(join(directory, 'content', 'articles'), { recursive: true });
  await copyFile(join(root, 'content', 'editorial-sites.json'), join(directory, 'content', 'editorial-sites.json'));
  return directory;
}
async function exportFile(directory, slug, value = input(slug)) {
  const path = join(directory, `${slug}-export.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}
const run = (root, files, overrides = {}) => importQueue({ root, files, siteId, created: day, ...overrides });

test('serial batch creates only rights-pending drafts and refuses repeat writes', async t => {
  const directory = await sandbox(t);
  const files = [await exportFile(directory, 'alpha'), await exportFile(directory, 'beta')];
  const result = await run(directory, files);
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(result.items.map(item => item.status), ['imported', 'imported']);
  for (const slug of ['alpha', 'beta']) {
    const article = JSON.parse(await readFile(join(directory, 'content', 'articles', `${slug}.json`)));
    assert.deepEqual(article.lifecycle, { state: 'draft' });
    assert.equal(article.rights.status, 'pending');
    assert.equal(publicationStatus(article).publishable, false);
    assert.throws(() => reviewArticle(article, { reviewer: 'Fixture', date: day, scope: 'independent-editorial' }), /rights/);
  }
  const prior = await readFile(join(directory, 'content', 'articles', 'alpha.json'));
  assert.deepEqual((await run(directory, files)).items.map(item => item.status), ['conflict', 'conflict']);
  assert.deepEqual(await readFile(join(directory, 'content', 'articles', 'alpha.json')), prior);
});

test('duplicate batch slugs are all refused while independent input succeeds', async t => {
  const directory = await sandbox(t);
  const a = await exportFile(directory, 'same');
  const b = await exportFile(directory, 'different-path', input('same'));
  const good = await exportFile(directory, 'unique');
  const result = await run(directory, [a, b, good]);
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.items.map(item => item.status), ['conflict', 'conflict', 'imported']);
  assert.deepEqual(await readdir(join(directory, 'content', 'articles')), ['unique.json']);
});

test('malformed, oversized, linked, non-file and unsafe exports remain explicit rejections', async t => {
  const directory = await sandbox(t);
  const malformed = join(directory, 'malformed.json'); await writeFile(malformed, '{');
  const oversized = join(directory, 'oversized.json'); await writeFile(oversized, ' '.repeat(MAX_JSON_BYTES + 1));
  const valid = await exportFile(directory, 'valid');
  const linked = join(directory, 'linked.json'); await symlink(valid, linked);
  const unsafe = await exportFile(directory, 'unsafe', { ...input('unsafe'), lifecycle: { state: 'approved' } });
  const future = await exportFile(directory, 'future', { ...input('future'), sources: [{ ...input('future').sources[0], accessed: '9999-01-01' }] });
  const result = await run(directory, [malformed, oversized, linked, directory, unsafe, future, valid]);
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.items.map(item => item.status), [...Array(6).fill('rejected'), 'imported']);
  assert.deepEqual(await readdir(join(directory, 'content', 'articles')), ['valid.json']);
});

test('inventory preserves bytes and exposes draft, stale approval, malformed and identity mismatches', async t => {
  const directory = await sandbox(t);
  await run(directory, [await exportFile(directory, 'draft'), await exportFile(directory, 'stale')]);
  const articles = join(directory, 'content', 'articles');
  const stalePath = join(articles, 'stale.json');
  const draft = JSON.parse(await readFile(stalePath));
  draft.rights = { status: 'original', statement: 'Synthetic original words.' };
  const metadata = { reviewer: 'Fixture', date: day, scope: 'independent-editorial' };
  const approved = approveArticle(reviewArticle(draft, metadata), metadata);
  const published = { ...approved }; await writeFile(stalePath, JSON.stringify(published));
  assert.equal((await inventoryQueue({ root: directory })).items.find(item => item.slug === 'stale').publication.publishable, true);
  approved.title += ' edited'; await writeFile(stalePath, JSON.stringify(approved));
  await writeFile(join(articles, 'mismatch.json'), JSON.stringify(draft));
  await writeFile(join(articles, 'unknown.json'), JSON.stringify({ ...draft, slug: 'unknown', siteId: 'unknown-site' }));
  await writeFile(join(articles, 'broken.json'), '{');
  await writeFile(join(articles, 'note.txt'), 'Ancillary file');
  const names = (await readdir(articles)).sort();
  const before = await Promise.all(names.map(name => readFile(join(articles, name))));
  const result = await inventoryQueue({ root: directory });
  assert.equal(result.ok, false);
  assert.equal(result.items.find(item => item.slug === 'draft').publication.reason, 'draft');
  assert.equal(result.items.find(item => item.slug === 'stale').publication.reason, 'changed since review');
  for (const filename of ['mismatch.json', 'unknown.json', 'broken.json']) assert.equal(result.items.find(item => item.filename === filename).status, 'invalid');
  assert.equal(result.items.find(item => item.filename === 'note.txt').status, 'ignored');
  assert.deepEqual(result.items.map(item => item.filename), names);
  assert.deepEqual(await Promise.all(names.map(name => readFile(join(articles, name)))), before);
});

test('count, destination capacity and unknown site limits refuse writes', async t => {
  const directory = await sandbox(t);
  const file = await exportFile(directory, 'limited');
  await assert.rejects(run(directory, Array(MAX_BATCH_FILES + 1).fill(file)), /1–20/);
  await assert.rejects(run(directory, [file], { siteId: 'missing' }), /Unknown/);
  await assert.rejects(run(directory, []), /1–20/);
  assert.equal((await run(directory, [file], { created: '9999-01-01' })).items[0].status, 'rejected');
  for (let i = 0; i < MAX_QUEUE_FILES; i++) await writeFile(join(directory, 'content', 'articles', `${i}.txt`), '');
  assert.equal((await run(directory, [file])).items[0].reason, 'Queue entry limit reached');
  await writeFile(join(directory, 'content', 'articles', 'excess.txt'), '');
  await assert.rejects(inventoryQueue({ root: directory }), /exceeds/);
  await assert.rejects(run(directory, [file]), /exceeds/);
});

test('symlink queue directory cannot redirect a batch outside its root', async t => {
  const directory = await sandbox(t);
  const outside = join(directory, 'other-articles'); await mkdir(outside);
  await rm(join(directory, 'content', 'articles'), { recursive: true });
  await symlink(outside, join(directory, 'content', 'articles'));
  await assert.rejects(run(directory, [await exportFile(directory, 'redirect')]), /without symlinks/);
  assert.deepEqual(await readdir(outside), []);
});

test('partial write remains visible, stops subsequent writes and preserves prior successes', async t => {
  const directory = await sandbox(t);
  const files = [];
  for (const slug of ['first', 'partial', 'later']) files.push(await exportFile(directory, slug));
  const probe = await open(join(directory, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.writeFile;
  await probe.close();
  let calls = 0;
  const mocked = t.mock.method(prototype, 'writeFile', async function (...args) {
    if (++calls === 2) {
      await this.write('{');
      throw new Error('Synthetic mid-write failure');
    }
    return original.apply(this, args);
  });
  let result;
  try { result = await run(directory, files); } finally { mocked.mock.restore(); }
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.imported, 1);
  assert.deepEqual(result.items.map(item => item.status), ['imported', 'unknown-write', 'not-attempted']);
  assert.equal(await readFile(join(directory, 'content', 'articles', 'partial.json'), 'utf8'), '{');
  assert.deepEqual((await readdir(join(directory, 'content', 'articles'))).sort(), ['first.json', 'partial.json']);
});

test('CLI binds output to its script root, emits JSON and exits nonzero for partial batches', async t => {
  const directory = await sandbox(t);
  for (const folder of ['src', 'scripts', 'elsewhere']) await mkdir(join(directory, folder));
  for (const file of ['src/editorial.mjs', 'src/shell.mjs', 'src/editorial-queue.mjs', 'scripts/editorial-queue.mjs']) await copyFile(join(root, file), join(directory, file));
  const invoke = (...args) => spawnSync(process.execPath, [join(directory, 'scripts', 'editorial-queue.mjs'), ...args], { cwd: join(directory, 'elsewhere'), encoding: 'utf8' });
  const good = await exportFile(directory, 'cli');
  const response = invoke('import', siteId, day, good, join(directory, 'absent.json'));
  assert.equal(response.status, 1, response.stderr);
  assert.equal(JSON.parse(response.stdout).outcome, 'partial');
  const inventory = invoke('inventory');
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.equal(JSON.parse(inventory.stdout).items[0].slug, 'cli');
  assert.deepEqual(await readdir(join(directory, 'elsewhere')), []);
  const invalid = invoke('inventory', '--root', root);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).outcome, 'no-writes');
});
