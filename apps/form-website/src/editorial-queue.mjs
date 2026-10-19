import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_JSON_BYTES, readLocalJson, validateSites, validateArticle, importOutrank, publicationStatus } from './editorial.mjs';

export const MAX_QUEUE_FILES = 100;
export const MAX_BATCH_FILES = 20;

async function queueContext(root) {
  const base = await realpath(resolve(root));
  for (const path of [base, join(base, 'content'), join(base, 'content', 'articles')]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected local queue directories without symlinks');
  }
  const sites = validateSites(await readLocalJson(join(base, 'content', 'editorial-sites.json')));
  return { directory: join(base, 'content', 'articles'), sites };
}

async function queueNames(directory) {
  const names = [];
  for await (const entry of await opendir(directory)) {
    if (names.length === MAX_QUEUE_FILES) throw new Error(`Queue exceeds ${MAX_QUEUE_FILES} directory entries`);
    names.push(entry.name);
  }
  return names.sort();
}

export async function inventoryQueue({ root }) {
  const { directory, sites } = await queueContext(root);
  const items = [];
  for (const filename of await queueNames(directory)) {
    if (!filename.endsWith('.json')) {
      items.push({ filename, status: 'ignored', reason: 'Not a JSON article' });
      continue;
    }
    try {
      const article = validateArticle(await readLocalJson(join(directory, filename)));
      if (filename !== `${article.slug}.json` || !sites.some(site => site.id === article.siteId)) throw new Error('Article filename or site mismatch');
      items.push({ filename, status: 'valid', slug: article.slug, siteId: article.siteId,
        state: article.lifecycle.state, rights: article.rights.status, publication: publicationStatus(article) });
    } catch (error) {
      items.push({ filename, status: 'invalid', reason: error.message });
    }
  }
  return { schemaVersion: 1, operation: 'inventory', ok: items.every(item => item.status !== 'invalid'), items };
}

export async function importQueue({ root, siteId, created, files }) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_BATCH_FILES || files.some(file => typeof file !== 'string' || !file || file.length > 4096)) {
    throw new Error(`Expected 1–${MAX_BATCH_FILES} local export paths`);
  }
  const { directory, sites } = await queueContext(root);
  if (!sites.some(site => site.id === siteId)) throw new Error('Unknown editorial site');
  const names = new Set(await queueNames(directory));
  const prepared = [];
  for (const file of files) {
    try {
      const article = importOutrank(await readLocalJson(resolve(file)), { siteId, created });
      const bytes = `${JSON.stringify(article)}\n`;
      if (Buffer.byteLength(bytes) > MAX_JSON_BYTES) throw new Error('Serialized article exceeds size limit');
      prepared.push({ file, article, bytes });
    } catch (error) {
      prepared.push({ file, status: 'rejected', reason: error.message });
    }
  }
  const counts = new Map();
  for (const { article } of prepared) if (article) counts.set(article.slug, (counts.get(article.slug) || 0) + 1);
  const items = [];
  let stopped = false;
  for (const item of prepared) {
    const { file, article, bytes } = item;
    if (!article) { items.push(item); continue; }
    const slug = article.slug;
    const filename = `${slug}.json`;
    if (counts.get(slug) > 1 || names.has(filename)) {
      items.push({ file, slug, status: 'conflict', reason: counts.get(slug) > 1 ? 'Duplicate batch slug' : 'Destination already exists' });
      continue;
    }
    if (stopped) { items.push({ file, slug, status: 'not-attempted', reason: 'Earlier write has an unknown outcome; inspect before retry' }); continue; }
    if (names.size === MAX_QUEUE_FILES) { items.push({ file, slug, status: 'rejected', reason: 'Queue entry limit reached' }); continue; }
    let handle;
    let writeStarted = false;
    try {
      handle = await open(join(directory, filename), 'wx', 0o600);
      writeStarted = true;
      await handle.writeFile(bytes);
      await handle.close();
      handle = undefined;
      const saved = await readLocalJson(join(directory, filename));
      if (JSON.stringify(saved) !== JSON.stringify(article)) throw new Error('Destination differs after write');
      names.add(filename);
      items.push({ file, slug, status: 'imported', state: 'draft', rights: 'pending' });
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (!writeStarted && error.code === 'EEXIST') {
        names.add(filename);
        items.push({ file, slug, status: 'conflict', reason: 'Destination already exists' });
      } else {
        // Preserve a possibly created file and stop: cleanup or retry could conceal a partial write.
        stopped = true;
        items.push({ file, slug, status: 'unknown-write', reason: error.message });
      }
    }
  }
  const imported = items.filter(item => item.status === 'imported').length;
  return { schemaVersion: 1, operation: 'import', ok: imported === items.length,
    outcome: stopped ? 'unknown' : imported === items.length ? 'complete' : imported ? 'partial' : 'no-imports', imported, items };
}
