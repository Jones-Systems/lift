import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readLocalJson, validateArticle, validateSites, publicationStatus, sourceHref } from '../editorial.mjs';
import { escapeHtml as e, safeHref } from '../shell.mjs';

const href = value => e(safeHref(value));
const day = value => `<time datetime="${e(value)}">${e(value)}</time>`;
const scopes = {
  'source-author-editorial': 'Source-author editorial review; not independent or clinical review.',
  'independent-editorial': 'Independent editorial review; no clinical review is claimed.',
  clinical: 'Clinical review scope recorded; general information, not individual care.'
};

async function records(root) {
  const sites = validateSites(await readLocalJson(join(root, 'content', 'editorial-sites.json')));
  const articles = [];
  const slugs = new Set();
  const directory = join(root, 'content', 'articles');
  for (const filename of (await readdir(directory)).sort()) {
    if (!filename.endsWith('.json')) continue;
    const article = validateArticle(await readLocalJson(join(directory, filename)));
    if (filename !== `${article.slug}.json` || !sites.some(site => site.id === article.siteId)) throw new Error('Article filename or site mismatch');
    if (slugs.has(article.slug)) throw new Error('Duplicate article slug');
    slugs.add(article.slug);
    if (publicationStatus(article).publishable) articles.push(article);
  }
  return { sites, articles };
}

function card(article, site) {
  const { review, approval } = article.lifecycle;
  return `<li class="me-journal-card" data-journal-card data-collection="${e(site.id)}">
    <article>
      <div class="me-journal-card-top"><p class="me-journal-kicker">${e(site.name)}</p><span class="me-journal-state">Approved editorial</span></div>
      <h3><a href="${href(`/journal/${article.slug}/`)}">${e(article.title)} <span aria-hidden="true">↗</span></a></h3>
      <p class="me-journal-summary">${e(article.summary)}</p>
      <p class="me-journal-author">By ${e(article.author)}</p>
      <dl class="me-journal-dates"><div><dt>Created</dt><dd>${day(article.created)}</dd></div><div><dt>Reviewed</dt><dd>${day(review.date)}</dd></div><div><dt>Approved</dt><dd>${day(approval.date)}</dd></div></dl>
      <p class="me-journal-qualification">${e(scopes[review.scope])}</p>
      <details><summary>Sources &amp; editorial record</summary>
        <ul class="me-journal-sources">${article.sources.map(source => `<li><a href="${href(sourceHref(source.url))}" rel="noopener noreferrer">${e(source.title)}</a><p>${e(source.publisher)} · Source checked ${day(source.accessed)}</p><p>${e(source.supports)}</p></li>`).join('')}</ul>
        <p>Review: ${e(review.reviewer)} · ${e(review.scope)} · ${day(review.date)}.</p>
        <p>Approval: ${e(approval.reviewer)} · ${e(approval.scope)} · ${day(approval.date)}.</p>
        <p>${e(article.provenance.note)}</p>
        <p>${e(article.rights.statement)}</p>
      </details>
    </article>
  </li>`;
}

export async function journalBody({ root }) {
  const { sites, articles } = await records(root);
  const collections = sites.filter(site => articles.some(article => article.siteId === site.id));
  return `<section class="me-journal" data-me-journal aria-label="Form journal">
    <header class="me-journal-heading"><div><p class="me-journal-kicker">Form / Your session / Journal</p><h2>A little perspective.<br>Space to reflect.</h2><p>Planning guides for the life around your sessions. Read at your own pace, with sources and editorial limits in view.</p></div><div class="me-journal-count"><strong>${articles.length}</strong><span>approved ${articles.length === 1 ? 'article' : 'articles'}</span></div></header>
    <div class="me-journal-layout"><aside class="me-journal-aside"><h3>Reading, with context.</h3><p>Owned and published by Form. These collections are not independent reviews of Form.</p><p>General planning information, not diagnosis, treatment or individual exercise prescription. Public rollout and clinical editorial review remain separate gates.</p><a href="/editorial/">Explore reader collections ↗</a></aside>
    <div class="me-journal-canvas">
      <form class="me-journal-filters" data-journal-form hidden role="search" aria-label="Filter journal articles">
        <label>Search articles<input type="search" data-journal-search maxlength="200" placeholder="Title, topic or source" autocomplete="off"></label>
        <label>Collection<select data-journal-collection><option value="">All collections</option>${collections.map(site => `<option value="${e(site.id)}">${e(site.name)}</option>`).join('')}</select></label>
        <div class="me-journal-actions"><button type="submit">Apply filters</button><button type="reset">Reset</button></div>
      </form>
      <p class="me-journal-status" data-journal-status role="status" aria-live="polite" aria-atomic="true">${articles.length} ${articles.length === 1 ? 'article' : 'articles'} available.</p>
      <p class="me-journal-empty" data-journal-empty${articles.length ? ' hidden' : ''}>${articles.length ? 'No articles match these filters. Try another search or reset the filters.' : 'No approved articles are available yet. Please check back later.'}</p>
      <ul class="me-journal-list">${articles.map(article => card(article, sites.find(site => site.id === article.siteId))).join('')}</ul>
      <noscript><p>All available articles are shown. Search and filtering need JavaScript; reading does not.</p></noscript>
    </div></div>
  </section>`;
}

export async function journalPages({ root }) {
  const body = await journalBody({ root });
  return [{ path: 'app/journal/index.html', html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f2f2ee"><meta name="description" content="Form planning guides with sources, exact editorial dates and review qualifications."><title>Journal · Your session · Form</title><link rel="stylesheet" href="/assets/variations.css"><link rel="stylesheet" href="/assets/member-ecosystem/journal.css"></head><body class="me-journal-page"><a class="me-journal-skip" href="#main">Skip to journal</a><header class="me-journal-topbar"><a class="me-journal-brand" href="/">form<span aria-hidden="true">●</span></a><nav aria-label="Workspace navigation"><a href="/app/">Your session</a><a href="/app/journal/" aria-current="page">Journal</a></nav></header><main id="main"><h1 class="me-journal-page-title">Form Journal</h1>${body}</main><footer class="me-journal-footer"><a href="/">Explore Form</a><a href="/privacy/">Privacy</a><p>Private website preview · Form is in development.</p></footer><script type="module" src="/assets/member-ecosystem/journal.mjs"></script></body></html>` }];
}
