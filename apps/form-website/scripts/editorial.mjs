import { open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readLocalJson, validateSites, validateArticle, generateDraft, importOutrank, reviewArticle, approveArticle, publicationStatus, previewArticle } from '../src/editorial.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Local editorial CLI (no network or provider access)
  draft <site-id> <slug> <title> <author> <YYYY-MM-DD>
  import <site-id> <local-export.json> <YYYY-MM-DD>
  review <slug> <reviewer> <YYYY-MM-DD> <scope>
  approve <slug> <reviewer> <YYYY-MM-DD> <scope>
  status <slug>
  preview <slug> (HTML to stdout; no files or receipts written)
Scopes: source-author-editorial | independent-editorial | clinical
Publication rights must be confirmed by editing the draft before review.
Import schema and lifecycle instructions: docs/website-acquisition/editorial-guide.md`;
function slugPath(slug) {
  if (typeof slug !== 'string' || slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Invalid slug');
  return join(root, 'content', 'articles', `${slug}.json`);
}
async function create(article) {
  const handle = await open(slugPath(article.slug), 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(article,null,2)}\n`); } finally { await handle.close(); }
}
async function replace(path, prior, article) {
  const temporary = join(dirname(path), `.editorial-${randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(article,null,2)}\n`, {flag:'wx',mode:0o600});
    if (await readFile(path,'utf8') !== prior) throw new Error('Article changed during operation; retry after inspection');
    await rename(temporary,path);
  } finally { await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;}); }
}
export async function main(args) {
  const [command,...values] = args;
  if (!command || command === 'help' || command === '--help') { console.log(usage); return; }
  if (command === 'preview') {
    if (values.length !== 1) throw new Error(usage);
    console.log(await previewArticle({root, slug: values[0]})); return;
  }
  if (command === 'draft' || command === 'import') {
    if (values.length !== (command === 'draft' ? 5 : 3)) throw new Error(usage);
    const sites = validateSites(await readLocalJson(join(root,'content','editorial-sites.json')));
    const site = sites.find(site => site.id === values[0]);
    if (!site) throw new Error('Unknown editorial site');
    const article = command === 'draft' ? generateDraft(site,{slug:values[1],title:values[2],author:values[3],created:values[4]}) : importOutrank(await readLocalJson(resolve(values[1])),{siteId:site.id,created:values[2]});
    await create(article); console.log(`Draft created: ${article.slug}.json`); return;
  }
  if (!['review','approve','status'].includes(command) || values.length !== (command === 'status' ? 1 : 4)) throw new Error(usage);
  const path = slugPath(values[0]);
  const article = validateArticle(await readLocalJson(path));
  const prior = await readFile(path,'utf8');
  if (JSON.stringify(JSON.parse(prior)) !== JSON.stringify(article)) throw new Error('Article changed during read');
  if (command === 'status') { console.log(JSON.stringify(publicationStatus(article))); return; }
  const metadata = {reviewer:values[1],date:values[2],scope:values[3]};
  const updated = command === 'review' ? reviewArticle(article,metadata) : approveArticle(article,metadata);
  await replace(path,prior,updated); console.log(`${updated.slug}: ${updated.lifecycle.state}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
