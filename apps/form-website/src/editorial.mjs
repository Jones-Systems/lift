import { createHash } from 'node:crypto';
import { open, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { page, escapeHtml, safeHref } from './shell.mjs';

export const MAX_JSON_BYTES = 65536;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const layouts = ['magazine', 'steps', 'planner', 'questions', 'pathway', 'directory', 'weekly'];
const fail = (message) => { throw new Error(message); };
function object(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name}: expected object`);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${name}: unknown field`);
  return value;
}
function text(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(`${name}: invalid plain text`);
  return value;
}
function id(value) { text(value, 80, 'id'); if (!ID.test(value)) fail('Invalid id'); return value; }
function array(value, min, max, name) { if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${name}: invalid list`); return value; }
export function evidenceDateBoundary(now = new Date()) {
  return new Date(now.getTime() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function date(value, today = evidenceDateBoundary()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value || value > today) fail('Invalid or future date');
  return value;
}
export function sourceHref(value) {
  text(value, 2048, 'source URL');
  if (/[\s\\\u0000-\u001f<>"']/u.test(value)) fail('Unsafe source URL');
  let url; try { url = new URL(value); } catch { fail('Invalid source URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || url.hash) fail('Unsafe source URL');
  safeHref(value);
  return value;
}
function sources(value) {
  return array(value, 1, 12, 'sources').map(source => {
    object(source, ['title','url','publisher','accessed','supports'], 'source');
    return { title: text(source.title, 240, 'source title'), url: sourceHref(source.url), publisher: text(source.publisher, 160, 'publisher'), accessed: date(source.accessed), supports: text(source.supports, 800, 'source scope') };
  });
}
function sections(value) {
  return array(value, 1, 12, 'sections').map(section => {
    object(section, ['heading','paragraphs','checklist'], 'section');
    const result = { heading: text(section.heading, 160, 'heading'), paragraphs: array(section.paragraphs, 1, 8, 'paragraphs').map(p => text(p, 2400, 'paragraph')) };
    if (section.checklist !== undefined) result.checklist = array(section.checklist, 1, 12, 'checklist').map(p => text(p, 400, 'checklist item'));
    return result;
  });
}
function content(article) {
  object(article, ['schemaVersion','slug','siteId','title','summary','author','created','sections','sources','rights','provenance','lifecycle'], 'article');
  if (article.schemaVersion !== 1) fail('Unsupported article schema');
  object(article.rights, ['status','statement'], 'rights');
  if (!['original','permission-confirmed','pending'].includes(article.rights.status)) fail('Invalid rights status');
  object(article.provenance, ['kind','origin','note'], 'provenance');
  if (!['original','local-template','outrank-import'].includes(article.provenance.kind)) fail('Invalid provenance kind');
  return {
    schemaVersion: 1, slug: id(article.slug), siteId: id(article.siteId), title: text(article.title, 180, 'title'), summary: text(article.summary, 600, 'summary'), author: text(article.author, 160, 'author'), created: date(article.created),
    sections: sections(article.sections), sources: sources(article.sources),
    rights: {status: article.rights.status, statement: text(article.rights.statement, 1200, 'rights statement')},
    provenance: {kind: article.provenance.kind, origin: text(article.provenance.origin, 400, 'origin'), note: text(article.provenance.note, 1200, 'provenance note')}
  };
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const contentHash = article => hash(content(article));
function receipt(value, approval = false) {
  object(value, approval ? ['reviewer','date','scope','contentHash','reviewHash'] : ['reviewer','date','scope','contentHash'], 'receipt');
  text(value.reviewer, 160, 'reviewer'); date(value.date);
  if (!['source-author-editorial','independent-editorial','clinical'].includes(value.scope)) fail('Invalid review scope');
  if (!/^[a-f0-9]{64}$/.test(value.contentHash)) fail('Invalid content hash');
  if (approval && !/^[a-f0-9]{64}$/.test(value.reviewHash)) fail('Invalid review hash');
}
export function validateArticle(article) {
  content(article);
  if (Buffer.byteLength(JSON.stringify(article)) > MAX_JSON_BYTES) fail('Article exceeds size limit');
  object(article.lifecycle, ['state','review','approval'], 'lifecycle');
  if (!['draft','reviewed','approved'].includes(article.lifecycle.state)) fail('Invalid lifecycle state');
  if (article.lifecycle.review !== undefined) receipt(article.lifecycle.review);
  if (article.lifecycle.approval !== undefined) receipt(article.lifecycle.approval, true);
  return article;
}
export function publicationStatus(article) {
  try {
    validateArticle(article);
    const {state, review, approval} = article.lifecycle;
    if (state !== 'approved') return {publishable:false, reason:state};
    if (!review || !approval) return {publishable:false, reason:'missing review or approval'};
    const current = contentHash(article);
    if (review.contentHash !== current || approval.contentHash !== current || approval.reviewHash !== hash(review)) return {publishable:false, reason:'changed since review'};
    if (review.date < article.created || approval.date < review.date || article.sources.some(source => source.accessed > review.date)) return {publishable:false, reason:'invalid chronology'};
    if (article.rights.status === 'pending') return {publishable:false, reason:'rights pending'};
    return {publishable:true, reason:'approved'};
  } catch (error) { return {publishable:false, reason:error.message}; }
}
export function reviewArticle(article, {reviewer, date: reviewedDate, scope}) {
  validateArticle(article);
  if (article.rights.status === 'pending') fail('Confirm publication rights before review');
  const review = {reviewer, date:reviewedDate, scope, contentHash:contentHash(article)};
  receipt(review);
  if (review.date < article.created || article.sources.some(source => source.accessed > review.date)) fail('Review precedes content or source verification');
  return {...article, lifecycle:{state:'reviewed', review}};
}
export function approveArticle(article, {reviewer, date: approvedDate, scope}) {
  validateArticle(article);
  const review = article.lifecycle.review;
  if (article.lifecycle.state !== 'reviewed' || !review || review.contentHash !== contentHash(article)) fail('A current reviewed record is required');
  const approval = {reviewer, date:approvedDate, scope, contentHash:contentHash(article), reviewHash:hash(review)};
  receipt(approval, true);
  if (approval.date < review.date) fail('Approval precedes review');
  const result = {...article, lifecycle:{state:'approved', review, approval}};
  if (!publicationStatus(result).publishable) fail('Publication requirements not met');
  return result;
}
export function importOutrank(input, {siteId, created}) {
  object(input, ['schemaVersion','slug','title','summary','author','sections','sources','origin','rightsStatement'], 'Outrank plain-text export');
  if (input.schemaVersion !== 1) fail('Unsupported Outrank export schema');
  sourceHref(input.origin);
  const result = {schemaVersion:1, slug:input.slug, siteId, title:input.title, summary:input.summary, author:input.author, created, sections:input.sections, sources:input.sources,
    rights:{status:'pending', statement:input.rightsStatement}, provenance:{kind:'outrank-import', origin:input.origin, note:'Imported from a local plain-text export. Vendor publication rights and factual claims require human verification.'}, lifecycle:{state:'draft'}};
  validateArticle(result);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_JSON_BYTES) fail('Article exceeds size limit');
  return result;
}
export function validateSites(input) {
  object(input, ['schemaVersion','sites'], 'site config');
  if (input.schemaVersion !== 1) fail('Unsupported site config schema');
  const ids = new Set(); const usedLayouts = new Set();
  for (const site of array(input.sites, 7, 7, 'sites')) {
    object(site, ['id','name','audience','layout','phase','intro','navigation','toolTitle','prompts','sources','draftTemplate'], 'site');
    id(site.id); if (ids.has(site.id)) fail('Duplicate site id'); ids.add(site.id);
    if (!layouts.includes(site.layout) || usedLayouts.has(site.layout)) fail('Each site needs a distinct layout'); usedLayouts.add(site.layout);
    if (![1,2,3].includes(site.phase)) fail('Invalid rollout phase');
    for (const key of ['name','audience','intro','toolTitle']) text(site[key], key === 'intro' ? 1000 : 240, key);
    array(site.navigation, 2, 4, 'navigation').forEach(item => {object(item,['label','target'],'navigation item'); text(item.label,80,'nav label'); if (!['tool','reading','about'].includes(item.target)) fail('Invalid navigation target');});
    array(site.prompts, 3, site.layout === 'weekly' ? 3 : 8, 'prompts').forEach(p => text(p,400,'prompt'));
    sources(site.sources); sections(site.draftTemplate);
  }
  return input.sites;
}
export function generateDraft(site, {slug, title, author, created}) {
  const result = {schemaVersion:1, slug, siteId:site.id, title, summary:`A working editorial draft for ${site.audience}.`, author, created, sections:structuredClone(site.draftTemplate), sources:structuredClone(site.sources), rights:{status:'pending', statement:'Confirm authorship and any third-party publication permissions before review.'}, provenance:{kind:'local-template', origin:`editorial-sites.json:${site.id}`, note:'Local template draft; requires original reporting, source checking and editorial review before publication.'}, lifecycle:{state:'draft'}};
  return validateArticle(result);
}
export async function readLocalJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) fail('Expected bounded local JSON file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_JSON_BYTES) fail('Expected bounded local JSON file');
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const {bytesRead} = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_JSON_BYTES) fail('JSON exceeds size limit');
    return JSON.parse(bytes.subarray(0,count).toString('utf8'));
  } finally { await handle.close(); }
}
const e = escapeHtml;
function sourceLinks(items) { return `<ol>${items.map(source => `<li><a href="${e(safeHref(sourceHref(source.url)))}" rel="noopener noreferrer">${e(source.title)}</a> — ${e(source.publisher)}. Checked ${e(source.accessed)}. <small>${e(source.supports)}</small></li>`).join('')}</ol>`; }
function articleBody(article, {preview = false} = {}) {
  const review = article.lifecycle.review;
  const reviewLine = preview
    ? `<p>By ${e(article.author)}</p><p class="ed-note">${review ? `Recorded review receipt (current applicability not asserted): ${e(review.reviewer)}, ${e(review.date)}, scope ${e(review.scope)}.` : 'No review receipt recorded.'}</p>`
    : `<p>By ${e(article.author)} · Editorial review ${e(review.date)}</p><p class="ed-note">${review.scope === 'source-author-editorial' ? 'Source-author editorial review; not independent or clinical review.' : review.scope === 'clinical' ? 'Clinical review scope recorded; this is general information, not individual care.' : 'Editorial review; no clinical review is claimed.'}</p>`;
  const approval = article.lifecycle.approval;
  const approvalLine = preview
    ? `<p>${approval ? `Recorded approval receipt (current applicability not asserted): ${e(approval.reviewer)}, ${e(approval.date)}, scope ${e(approval.scope)}.` : 'No approval receipt recorded.'} Previewing does not perform review or approval.</p>`
    : `<p>Approval: ${e(approval.reviewer)}, ${e(approval.date)}. To flag a correction, retain this article URL and use Form’s published contact route when available. No correction submission service is connected here.</p>`;
  return `<article class="ed-article"><p class="ed-kicker">Form Journal / ${e(article.siteId)}</p><h1>${e(article.title)}</h1><p class="ed-lede">${e(article.summary)}</p>${reviewLine}<nav aria-label="Article contents">${article.sections.map((s,i) => `<a href="#section-${i}">${e(s.heading)}</a>`).join(' · ')}</nav>${article.sections.map((section,i) => `<section id="section-${i}"><h2>${e(section.heading)}</h2>${section.paragraphs.map(p => `<p>${e(p)}</p>`).join('')}${section.checklist ? `<ul>${section.checklist.map(p => `<li>${e(p)}</li>`).join('')}</ul>` : ''}</section>`).join('')}<section><h2>Sources and scope</h2>${sourceLinks(article.sources)}<p>These sources support the limited context identified above. Our original planning prompts are editorial tools, not validated clinical instruments.</p></section><details><summary>Authorship, rights and corrections</summary><p>${e(article.rights.statement)}</p><p>${e(article.provenance.note)}</p>${approvalLine}</details><p><a href="/editorial/${e(article.siteId)}/">Explore this reader guide</a> · <a href="/journal/">All articles</a></p></article>`;
}
const styles = `<style>
.ed{max-width:1160px;margin:auto;padding:clamp(24px,5vw,72px) 20px;color:#19312c}.ed h1{font-size:clamp(2.5rem,6vw,5rem);line-height:1.02;max-width:18ch}.ed h2{margin-top:1.6em}.ed p,.ed li{line-height:1.75}.ed a{color:inherit;text-decoration:underline;text-underline-offset:4px}.ed-kicker{font-size:.8rem;letter-spacing:.12em;text-transform:uppercase}.ed-lede{font-size:1.3rem;max-width:65ch}.ed-note{padding:16px;border-left:3px solid #708174;background:#eef2eb}.ed-localnav{display:flex;gap:22px;flex-wrap:wrap;margin:24px 0 40px}.ed-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:24px}.ed-card{padding:24px;border:1px solid #ccd6ce;border-radius:4px}.ed-card h2{margin-top:0}.ed-tool{padding:28px;background:#f3f1e9}.ed-tool li{padding:12px 0;border-bottom:1px solid #d8dbd0}.ed-article{max-width:760px;margin:auto}.ed-article section{margin:40px 0}.ed-article small{display:block}.ed-article details{padding:20px;border:1px solid #ccd6ce}.ed-magazine .ed-feature{display:grid;grid-template-columns:1.3fr 1fr;gap:40px;align-items:start}.ed-steps .ed-tool ol{counter-reset:steps;list-style:none;padding:0}.ed-steps .ed-tool li{counter-increment:steps;display:flex;gap:24px}.ed-steps .ed-tool li:before{content:counter(steps,decimal-leading-zero);font-size:2rem;color:#657363}.ed-planner .ed-tool ul{list-style:none;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:16px}.ed-planner .ed-tool li{min-height:110px;border:1px solid #becdc2;padding:20px;background:white}.ed-questions{display:grid;grid-template-columns:220px 1fr;gap:40px}.ed-questions aside{border-right:1px solid #ccd6ce;padding-right:20px}.ed-questions .ed-localnav{flex-direction:column}.ed-questions details{padding:18px;border-bottom:1px solid #ccd6ce}.ed-pathway .ed-path{border-left:3px solid #9ba994;padding-left:30px;display:grid;gap:28px}.ed-directory .ed-tool li{display:grid;grid-template-columns:60px 1fr;gap:18px}.ed-directory .ed-tool li strong{font-size:2rem}.ed-weekly .ed-week{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.ed-weekly .ed-week section{padding:24px;background:#f3f1e9}.ed-weekly .ed-week h2{margin:0}.ed-disclosure{border-top:1px solid #ccd6ce;padding-top:24px;margin-top:48px;font-size:.95rem}.ed-print{font:inherit;cursor:pointer;padding:10px 16px;background:white;border:1px solid #809184}.ed textarea{width:100%;min-height:80px;box-sizing:border-box;font:inherit;padding:12px;border:1px solid #8c9c90}.ed label{display:block;margin:16px 0}.ed textarea:focus{outline:3px solid #53785e;outline-offset:2px}@media(max-width:700px){.ed-magazine .ed-feature,.ed-questions,.ed-weekly .ed-week{display:block}.ed-questions aside{border-right:0;border-bottom:1px solid #ccd6ce}.ed-planner .ed-tool ul{grid-template-columns:1fr}.ed-weekly .ed-week section{margin-bottom:16px}}@media print{.ed-localnav,.ed-disclosure{display:none}.ed{padding:0}.ed textarea{min-height:100px}}
</style>`;
const card = article => `<article class="ed-card"><p class="ed-kicker">Reader guide</p><h2><a href="/journal/${e(article.slug)}/">${e(article.title)}</a></h2><p>${e(article.summary)}</p></article>`;
function tool(site) { return `<section class="ed-tool" id="tool"><h2>${e(site.toolTitle)}</h2><p>Use these prompts on paper. They are optional planning questions, not an assessment; this page does not collect answers.</p><${site.layout === 'steps' ? 'ol' : 'ul'}>${site.prompts.map(p => `<li>${e(p)}</li>`).join('')}</${site.layout === 'steps' ? 'ol' : 'ul'}></section>`; }
function disclosure(site) { return `<footer class="ed-disclosure" id="about"><p><strong>Owned and published by Form.</strong> ${e(site.name)} is a Form editorial collection, not an independent review of Form. Phase ${site.phase} audience concept, available here as a private preview. Public rollout and clinical editorial review are separate gates.</p><p>General planning information; no diagnosis, treatment or individual exercise prescription. No price, clinical outcome or product availability is promised. <a href="/">About Form</a> · <a href="/privacy/">Privacy</a></p></footer>`; }
function siteBody(site, articles) {
  const nav = `<nav class="ed-localnav" aria-label="${e(site.name)}">${site.navigation.map(item => `<a href="#${e(item.target)}">${e(item.label)}</a>`).join('')}</nav>`;
  const header = `<header><p class="ed-kicker">${e(site.audience)} · A Form publication</p><h1>${e(site.name)}</h1><p class="ed-lede">${e(site.intro)}</p></header>`;
  const reading = `<section id="reading"><h2>Read and reflect</h2>${articles.length ? `<div class="ed-grid">${articles.map(card).join('')}</div>` : '<p>No approved articles yet. The planning prompts below stand on their own.</p>'}</section>`;
  let body;
  switch (site.layout) {
    case 'magazine': body = `${header}${nav}<div class="ed-feature">${reading}${tool(site)}</div>`; break;
    case 'steps': body = `${header}${nav}${tool(site)}${reading}`; break;
    case 'planner': body = `${nav}${header}${tool(site)}${reading}`; break;
    case 'questions': body = `<aside><p class="ed-kicker">Appointment companion</p>${nav}<p>Bring your individual restrictions and your questions to your clinician.</p></aside><div>${header}<section id="tool"><h2>${e(site.toolTitle)}</h2>${site.prompts.map((p,i) => `<details><summary>${e(p)}</summary><p>Write your clinician’s answer on paper. Include the date, who answered, any limits, and when to check back. A generic online answer cannot substitute for your instructions.</p></details>`).join('')}</section>${reading}${disclosure(site)}</div>`; return `<div class="ed ed-questions">${body}</div>`;
    case 'pathway': body = `${header}${nav}<div class="ed-path">${tool(site)}<section><h2>Keep your limits visible</h2><p>A clearance decision belongs to your clinician. Keep the scope, restrictions and reassessment date together; an app or article cannot extend that permission.</p></section>${reading}</div>`; break;
    case 'directory': body = `${header}${nav}<section id="tool" class="ed-tool"><h2>${e(site.toolTitle)}</h2><ul>${site.prompts.map((p,i) => `<li><strong aria-hidden="true">${String(i+1).padStart(2,'0')}</strong><span>${e(p)}</span></li>`).join('')}</ul></section>${reading}`; break;
    case 'weekly': body = `${header}${nav}<section id="tool"><h2>${e(site.toolTitle)}</h2><div class="ed-week">${site.prompts.map((p,i) => `<section><h2>${e(['Before the week','During the week','After the week'][i])}</h2><p>${e(p)}</p></section>`).join('')}</div></section>${reading}`; break;
  }
  return `<div class="ed ed-${site.layout}">${body}${disclosure(site)}</div>`;
}
export async function previewArticle({root, slug}) {
  id(slug);
  const sites = validateSites(await readLocalJson(join(root, 'content', 'editorial-sites.json')));
  const article = validateArticle(await readLocalJson(join(root, 'content', 'articles', `${slug}.json`)));
  const site = sites.find(site => site.id === article.siteId);
  if (article.slug !== slug || !site) fail('Article filename or site mismatch');
  const status = publicationStatus(article);
  const notice = `<aside class="ed-note" aria-label="Local editorial preview"><strong>LOCAL EDITORIAL PREVIEW / NOT PUBLISHED</strong><p>This preview is not a publication or a review receipt. Stored receipts below are records, not a claim that this content has current review. Content and source-support statements are supplied editorial material; this preview does not verify them or establish original authorship.</p><p>Lifecycle: ${e(article.lifecycle.state)} · Rights: ${e(article.rights.status)}</p><p>Publication eligibility: ${status.publishable ? 'eligible' : 'withheld'} — ${e(status.reason)}. Eligibility does not establish deployment or permission to launch.</p><p>Article: ${e(article.slug)} · Collection: ${e(site.name)} (${e(article.siteId)}) · Created: ${e(article.created)}</p><p>Provenance: ${e(article.provenance.kind)} · ${e(article.provenance.origin)}</p></aside>`;
  return page(`LOCAL EDITORIAL PREVIEW — ${article.title}`, `${styles}<div class="ed">${notice}${articleBody(article, {preview: true})}</div>`, {description: 'Local editorial preview. Not published; rights, review and approval require separate verification.'});
}
export async function editorialPages({root}) {
  const sites = validateSites(await readLocalJson(join(root,'content','editorial-sites.json')));
  const articles = []; const slugs = new Set();
  const directory = join(root,'content','articles');
  for (const filename of (await readdir(directory)).sort()) {
    if (!filename.endsWith('.json')) continue;
    const article = validateArticle(await readLocalJson(join(directory,filename)));
    if (filename !== `${article.slug}.json` || !sites.some(site => site.id === article.siteId)) fail('Article filename or site mismatch');
    if (slugs.has(article.slug)) fail('Duplicate article slug'); slugs.add(article.slug);
    if (publicationStatus(article).publishable) articles.push(article);
  }
  const render = (title, body) => page(title, `${styles}${body}`);
  return [
    {path:'journal/index.html', html:render('Form Journal', `<div class="ed"><p class="ed-kicker">Ideas for real life</p><h1>Form Journal</h1><p class="ed-lede">Original planning guides, primary sources, and clear limits. Source-author editorial review is labelled on every seed article.</p><div class="ed-grid">${articles.map(card).join('')}</div><p><a href="/editorial/">Find a guide for your situation</a></p></div>`)},
    ...articles.map(article => ({path:`journal/${article.slug}/index.html`, html:render(article.title, `<div class="ed">${articleBody(article)}${disclosure(sites.find(site => site.id === article.siteId))}</div>`)})),
    {path:'editorial/index.html', html:render('Reader collections', `<div class="ed"><p class="ed-kicker">Seven ways into movement</p><h1>Start with your situation.</h1><p class="ed-lede">Seven Form-owned reader collections. Each has a different practical focus; these private concepts do not establish market demand or a public launch.</p><div class="ed-grid">${sites.map(site => `<section class="ed-card"><p class="ed-kicker">Phase ${site.phase}</p><h2><a href="/editorial/${e(site.id)}/">${e(site.name)}</a></h2><p>${e(site.intro)}</p></section>`).join('')}</div></div>`)},
    ...sites.map(site => ({path:`editorial/${site.id}/index.html`, html:render(site.name,siteBody(site,articles.filter(a => a.siteId === site.id)))}))
  ];
}
