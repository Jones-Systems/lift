import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, validateArticle, publicationStatus, reviewArticle, approveArticle, importOutrank, validateSites, generateDraft, sourceHref, readLocalJson, editorialPages, previewArticle, MAX_JSON_BYTES, evidenceDateBoundary } from '../src/editorial.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const day = '2026-10-09';
const metadata = {reviewer:'Synthetic editorial reviewer',date:day,scope:'independent-editorial'};
const fixture = () => ({schemaVersion:1,slug:'synthetic-guide',siteId:'everyday-longevity',title:'Synthetic title',summary:'Synthetic test summary',author:'Synthetic author',created:day,sections:[{heading:'A heading',paragraphs:['A paragraph'],checklist:['A question']}],sources:[{title:'CDC',url:'https://www.cdc.gov/physical-activity-basics/guidelines/adults.html',publisher:'CDC',accessed:day,supports:'General adult guidance'}],rights:{status:'original',statement:'Synthetic original test text'},provenance:{kind:'original',origin:'Test fixture',note:'Explicitly synthetic, no clinical evidence'},lifecycle:{state:'draft'}});
const approved = () => approveArticle(reviewArticle(fixture(),metadata),metadata);

test('draft requires review and a separate approval; reviewing never publishes', () => {
  const draft = fixture();
  assert.equal(publicationStatus(draft).publishable,false);
  assert.throws(() => approveArticle(draft,metadata),/reviewed/);
  const reviewed = reviewArticle(draft,metadata);
  assert.equal(reviewed.lifecycle.state,'reviewed');
  assert.equal(publicationStatus(reviewed).publishable,false);
  assert.equal(publicationStatus(approveArticle(reviewed,metadata)).publishable,true);
  assert.equal(draft.lifecycle.state,'draft');
});
test('changes to copy, sources, rights, authorship and provenance invalidate approval', () => {
  const mutations = [a => a.title += ' revised',a => a.summary += ' revised',a => a.author += ' revised',a => a.sections[0].paragraphs.push('New claim'),a => a.sections[0].checklist[0] = 'New question',a => a.sources[0].url = 'https://www.cdc.gov/another-page',a => a.sources[0].accessed = '2026-10-08',a => a.rights.statement += ' revised',a => a.provenance.note += ' revised',a => a.siteId = 'strength-beginners',a => a.created = '2026-10-08'];
  for (const mutate of mutations) {const article = approved(); mutate(article); assert.equal(publicationStatus(article).publishable,false);}
  const reviewed = reviewArticle(fixture(),metadata); reviewed.title += ' revised';
  assert.throws(() => approveArticle(reviewed,metadata),/current reviewed/);
});
test('review metadata edits invalidate its bound approval', () => {
  for (const field of ['reviewer','scope','date']) {const article = approved();article.lifecycle.review[field] = {reviewer:'Another editor',scope:'source-author-editorial',date:'2026-10-08'}[field];assert.equal(publicationStatus(article).publishable,false);}
});
test('missing records, pending rights and impossible dates fail closed', () => {
  const missing = approved(); delete missing.lifecycle.review;
  assert.equal(publicationStatus(missing).publishable,false);
  const draft = fixture(); draft.rights.status = 'pending';
  assert.throws(() => reviewArticle(draft,metadata),/rights/);
  assert.throws(() => reviewArticle(fixture(),{...metadata,date:'2026-10-08'}),/precedes/);
  assert.throws(() => reviewArticle(fixture(),{...metadata,date:'2026-02-30'}),/date/);
  assert.throws(() => reviewArticle(fixture(),{...metadata,date:'9999-01-01'}),/date/);
  assert.throws(() => reviewArticle(fixture(),{...metadata,reviewer:''}),/reviewer/);
  assert.throws(() => reviewArticle(fixture(),{...metadata,scope:'AI-autoapproved'}),/scope/);
  const sourceLate = fixture(); sourceLate.sources[0].accessed = '2099-10-10';
  assert.throws(() => reviewArticle(sourceLate,metadata));
});
test('date-only evidence retains a legitimate timezone day while future dates remain invalid', () => {
  assert.equal(evidenceDateBoundary(new Date('2026-10-08T22:30:00Z')),'2026-10-09');
  assert.equal(evidenceDateBoundary(new Date('2026-10-08T00:00:00Z')),'2026-10-08');
  assert.equal(publicationStatus(approved()).publishable,true);
  const future = fixture(); future.created = '2099-01-01';
  assert.throws(() => validateArticle(future),/future date/);
});
test('unsafe and credential-bearing source URLs are rejected', () => {
  for (const url of ['javascript:alert(1)','data:text/html,test','http://example.com','//example.com','https://user:password@example.com','https://example.com/" onclick="bad','https://example.com/\nfoo','https://example.com\\evil','https://example.com/#fragment','https://example.com/%0a','https://example.com/%5c']) assert.throws(() => sourceHref(url),undefined,url);
  assert.equal(sourceHref('https://www.cdc.gov/physical-activity-basics/guidelines/adults.html'),fixture().sources[0].url);
});
test('Outrank bounded plain-text adapter always creates an unapproved rights-pending draft', () => {
  const a = fixture(); const input = {schemaVersion:1,slug:a.slug,title:a.title,summary:a.summary,author:a.author,sections:a.sections,sources:a.sources,origin:'https://www.outrank.so/',rightsStatement:'Rights require confirmation'};
  const result = importOutrank(input,{siteId:a.siteId,created:day});
  assert.deepEqual(result.lifecycle,{state:'draft'});
  assert.equal(result.rights.status,'pending');
  assert.equal(result.provenance.kind,'outrank-import');
  assert.throws(() => reviewArticle(result,metadata),/rights/);
  for (const key of ['html','token','account','approval','lifecycle']) assert.throws(() => importOutrank({...input,[key]:'untrusted'},{siteId:a.siteId,created:day}),/unknown field/);
  assert.throws(() => importOutrank({...input,sections:Array.from({length:13},() => a.sections[0])},{siteId:a.siteId,created:day}),/list/);
  assert.throws(() => importOutrank({...input,title:'x'.repeat(181)},{siteId:a.siteId,created:day}),/plain text/);
  assert.throws(() => importOutrank({...input,slug:'../../outside'},{siteId:a.siteId,created:day}),/id/);
});
test('local draft generator uses audience template and resets lifecycle', async () => {
  const sites = validateSites(await readLocalJson(join(root,'content','editorial-sites.json')));
  const result = generateDraft(sites[0],{slug:'new-draft',title:'A working draft',author:'Test author',created:day});
  assert.equal(result.siteId,sites[0].id);
  assert.equal(result.provenance.kind,'local-template');
  assert.equal(publicationStatus(result).publishable,false);
  assert.equal(result.rights.status,'pending');
  assert.notEqual(result.sections,sites[0].draftTemplate);
});
test('seven site configs require unique identities and materially distinct layout selectors', async () => {
  const config = await readLocalJson(join(root,'content','editorial-sites.json'));
  const sites = validateSites(config);
  assert.equal(new Set(sites.map(site => site.layout)).size,7);
  assert.equal(new Set(sites.map(site => site.intro)).size,7);
  assert.deepEqual(sites.map(site => site.phase).sort(),[1,1,2,2,3,3,3]);
  const duplicate = structuredClone(config); duplicate.sites[1].layout = duplicate.sites[0].layout;
  assert.throws(() => validateSites(duplicate),/distinct layout/);
  const badNav = structuredClone(config); badNav.sites[0].navigation[0].target = 'javascript:alert(1)';
  assert.throws(() => validateSites(badNav),/navigation/);
});
test('all seven source seeds have valid content hashes, source-author review and no clinical-review claim', async () => {
  const {readdir} = await import('node:fs/promises');
  const filenames = await readdir(join(root,'content','articles'));
  const seeds = [];
  for (const filename of filenames.filter(name => name.endsWith('.json'))) {
    const article = await readLocalJson(join(root,'content','articles',filename));
    if (article.provenance.kind === 'original' && article.provenance.origin === 'WEB-A3 editorial source lane') seeds.push(article);
  }
  assert.equal(seeds.length,7);
  for (const article of seeds) {assert.equal(publicationStatus(article).publishable,true,article.slug);assert.equal(article.lifecycle.review.contentHash,contentHash(article));assert.equal(article.lifecycle.review.scope,'source-author-editorial');assert.ok(article.sections.length >= 4);}
});
async function sandbox(t) {
  const directory = await mkdtemp(join(root,'tests','.editorial-test-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  await mkdir(join(directory,'content','articles'),{recursive:true});
  await writeFile(join(directory,'content','editorial-sites.json'),await readFile(join(root,'content','editorial-sites.json')));
  return directory;
}
test('publication routes exclude drafts and stale approvals, and escape every raw article field', async t => {
  const directory = await sandbox(t);
  const draft = fixture();draft.slug = 'unapproved';
  const stale = approved();stale.slug = 'changed';
  const hostile = fixture();hostile.slug = 'escaped-guide';hostile.title = '<script>alert(1)</script>';hostile.sections[0].paragraphs[0] = '<img src=x onerror=alert(1)>';hostile.sources[0].title = '<svg onload=bad>';hostile.provenance.note = '<iframe src=bad>';hostile.rights.statement = '<b>raw rights</b>';
  const safe = approveArticle(reviewArticle(hostile,metadata),metadata);
  for (const a of [draft,stale,safe]) await writeFile(join(directory,'content','articles',`${a.slug}.json`),JSON.stringify(a));
  const pages = await editorialPages({root:directory});
  assert.equal(pages.length,10);
  assert.ok(pages.some(p => p.path === 'journal/escaped-guide/index.html'));
  assert.ok(!pages.some(p => /unapproved|changed/.test(p.path)));
  const article = pages.find(p => p.path === 'journal/escaped-guide/index.html').html;
  assert.ok(article.includes('&lt;script&gt;'));
  assert.ok(article.includes('&lt;img'));
  assert.ok(article.includes('&lt;svg'));
  assert.ok(article.includes('&lt;iframe'));
  assert.ok(!article.includes('<script>alert(1)</script>'));
  assert.ok(!article.includes('<img src=x'));
  assert.match(article,/not independent or clinical review|Editorial review; no clinical review/);
  for (const site of (await readLocalJson(join(directory,'content','editorial-sites.json'))).sites) {
    const html = pages.find(p => p.path === `editorial/${site.id}/index.html`).html;
    assert.ok(html.includes(`ed-${site.layout}`));
    assert.match(html,/Owned and published by Form/);
    assert.ok(html.includes(site.toolTitle));
  }
});
test('malformed config fails generation; unknown site and file identity cannot publish', async t => {
  const directory = await sandbox(t);
  const article = approved();article.siteId = 'unknown-site';
  await writeFile(join(directory,'content','articles',`${article.slug}.json`),JSON.stringify(article));
  await assert.rejects(editorialPages({root:directory}),/mismatch/);
  await writeFile(join(directory,'content','editorial-sites.json'),'{}');
  await assert.rejects(editorialPages({root:directory}),/schema/);
});
test('file reader rejects oversized JSON and symlinks; fixture cleanup stays in a unique owned root', async t => {
  const directory = await sandbox(t);
  const tooBig = join(directory,'large.json');await writeFile(tooBig,' '.repeat(MAX_JSON_BYTES+1));
  await assert.rejects(readLocalJson(tooBig),/bounded/);
  const {symlink} = await import('node:fs/promises');
  const link = join(directory,'link.json');await symlink(join(directory,'content','editorial-sites.json'),link);
  await assert.rejects(readLocalJson(link),/bounded/);
  assert.throws(() => validateArticle({...fixture(),unexpected:'field'}),/unknown/);
});

test('local preview shows a rights-pending draft without receipts or publication and preserves exact bytes', async t => {
  const directory = await sandbox(t);
  const draft = fixture(); draft.rights.status = 'pending';
  const path = join(directory,'content','articles',`${draft.slug}.json`);
  const bytes = `\n${JSON.stringify(draft,null,2)}\n`;
  await writeFile(path,bytes);
  const before = await editorialPages({root:directory});
  const html = await previewArticle({root:directory,slug:draft.slug});
  assert.match(html,/^<!DOCTYPE html>/);
  assert.match(html,/LOCAL EDITORIAL PREVIEW \/ NOT PUBLISHED/);
  assert.match(html,/Lifecycle: draft · Rights: pending/);
  assert.match(html,/Publication eligibility: withheld — draft/);
  assert.match(html,/No review receipt recorded/);
  assert.match(html,/No approval receipt recorded/);
  assert.doesNotMatch(html,/· Editorial review |<p>Approval:|Owned and published by Form/);
  assert.match(html,/href="#section-0"/);
  assert.match(html,/class="ed-article"/);
  assert.equal(await readFile(path,'utf8'),bytes);
  assert.deepEqual(await editorialPages({root:directory}),before);
  assert.ok(!before.some(page => page.path === `journal/${draft.slug}/index.html`));
});

test('local preview distinguishes reviewed, approved and stale receipts without asserting current review', async t => {
  const directory = await sandbox(t);
  const reviewed = reviewArticle(fixture(),metadata);
  const current = approveArticle(reviewed,metadata);
  const stale = structuredClone(current); stale.title += ' changed';
  const staleReceipt = structuredClone(current); staleReceipt.lifecycle.review.reviewer = 'Changed reviewer';
  const chronology = structuredClone(current); chronology.lifecycle.review.date = '2026-10-08';
  for (const [article,reason] of [[reviewed,'reviewed'],[current,'approved'],[stale,'changed since review'],[staleReceipt,'changed since review'],[chronology,'changed since review']]) {
    const path = join(directory,'content','articles',`${article.slug}.json`);
    const bytes = JSON.stringify(article); await writeFile(path,bytes);
    const html = await previewArticle({root:directory,slug:article.slug});
    assert.ok(html.includes(`Lifecycle: ${article.lifecycle.state}`));
    assert.ok(html.includes(`Publication eligibility: ${article === current ? 'eligible' : 'withheld'} — ${reason}`));
    assert.match(html,/Recorded review receipt \(current applicability not asserted\)/);
    assert.doesNotMatch(html,/· Editorial review |<p>Approval:/);
    if (article.lifecycle.approval) assert.match(html,/Recorded approval receipt \(current applicability not asserted\)/);
    else assert.match(html,/No approval receipt recorded/);
    assert.equal(await readFile(path,'utf8'),bytes);
  }
});

test('local preview escapes content, source text, provenance, collection and receipt metadata', async t => {
  const directory = await sandbox(t);
  const article = fixture();
  const hostile = '<img src=x onerror="bad">&\'';
  for (const field of ['title','summary','author']) article[field] = hostile;
  article.sections = [{heading:hostile,paragraphs:[hostile],checklist:[hostile]}];
  for (const field of ['title','publisher','supports']) article.sources[0][field] = hostile;
  article.sources[0].url = 'https://example.com/source?a=1&b=2';
  article.rights.statement = hostile;
  article.provenance.origin = hostile; article.provenance.note = hostile;
  const receipt = {...metadata,reviewer:hostile};
  const signed = approveArticle(reviewArticle(article,receipt),receipt);
  await writeFile(join(directory,'content','articles',`${signed.slug}.json`),JSON.stringify(signed));
  const configPath = join(directory,'content','editorial-sites.json');
  const config = await readLocalJson(configPath); config.sites.find(site => site.id === article.siteId).name = hostile;
  await writeFile(configPath,JSON.stringify(config));
  const html = await previewArticle({root:directory,slug:signed.slug});
  assert.doesNotMatch(html,/<img|onerror="bad"/);
  const escaped = '&lt;img src=x onerror=&quot;bad&quot;&gt;&amp;&#39;';
  for (const fragment of [`<h1>${escaped}</h1>`,`class="ed-lede">${escaped}`,`By ${escaped}`,`<h2>${escaped}</h2>`,`<li>${escaped}</li>`,`<small>${escaped}</small>`,`Collection: ${escaped}`,`original · ${escaped}`,`asserted): ${escaped}`]) assert.ok(html.includes(fragment),fragment);
  assert.ok(html.includes('href="https://example.com/source?a=1&amp;b=2"'));
  assert.ok(html.includes(`>${escaped}</a> — ${escaped}`));
  assert.ok(html.includes(`<p>${escaped}</p><p>${escaped}</p>`));
});

test('local preview rejects unsafe slug, malformed content, filename mismatch, unknown site and unsafe source', async t => {
  const directory = await sandbox(t);
  const path = join(directory,'content','articles','synthetic-guide.json');
  await assert.rejects(previewArticle({root:directory,slug:'../../outside'}),/id/);
  for (const edit of [a => {a.slug = 'different';},a => {a.siteId = 'unknown-site';},a => {a.sources[0].url = 'javascript:alert(1)';},a => {a.unexpected = true;}]) {
    const article = fixture(); edit(article); const bytes = JSON.stringify(article); await writeFile(path,bytes);
    await assert.rejects(previewArticle({root:directory,slug:'synthetic-guide'}));
    assert.equal(await readFile(path,'utf8'),bytes);
  }
  await writeFile(path,'{');
  await assert.rejects(previewArticle({root:directory,slug:'synthetic-guide'}),SyntaxError);
  assert.equal(await readFile(path,'utf8'),'{');
  const {symlink} = await import('node:fs/promises');
  await symlink(path,join(directory,'content','articles','linked.json'));
  await assert.rejects(previewArticle({root:directory,slug:'linked'}),/bounded/);
});
