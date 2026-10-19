import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { journalPages, journalBody } from '../src/member-ecosystem/journal.mjs';
import { publicationStatus, reviewArticle, approveArticle } from '../src/editorial.mjs';
import { matchesJournal, mountJournal } from '../public/member-ecosystem/journal.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const seedPath = join(root, 'content/articles/before-your-first-strength-plan.json');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function fixture(t, articles) {
  const directory = await mkdtemp(join(root, 'tests/member-ecosystem-journal-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'content/articles'), { recursive: true });
  await writeFile(join(directory, 'content/editorial-sites.json'), await readFile(join(root, 'content/editorial-sites.json')));
  for (const [filename, article] of articles) await writeFile(join(directory, 'content/articles', filename), JSON.stringify(article));
  return directory;
}

test('journal creates only the member index and links existing eligible canonical articles', async () => {
  const pages = await journalPages({ root });
  assert.deepEqual(pages.map(page => page.path), ['app/journal/index.html']);
  const html = pages[0].html;
  let eligible = 0;
  for (const filename of await readdir(join(root, 'content/articles'))) {
    if (!filename.endsWith('.json')) continue;
    const article = await json(join(root, 'content/articles', filename));
    assert.equal(html.includes(`href="/journal/${article.slug}/"`), publicationStatus(article).publishable);
    if (publicationStatus(article).publishable) {
      eligible += 1;
      assert.ok(html.includes(`datetime="${article.lifecycle.review.date}"`));
      assert.ok(html.includes(`datetime="${article.created}"`));
    }
  }
  assert.equal((html.match(/data-journal-card /g) ?? []).length, eligible);
  assert.ok(html.includes('not independent or clinical review'));
  assert.ok(html.includes('data-journal-form hidden'));
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('/assets/member-ecosystem/journal.css'));
  assert.ok(html.includes('/assets/member-ecosystem/journal.mjs'));
});

test('drafts, reviewed-only and changed-since-review content never enter generated markup', async t => {
  const seed = await json(seedPath);
  const draft = { ...structuredClone(seed), slug: 'draft-fixture', title: 'DRAFT PRIVATE MARKER', lifecycle: { state: 'draft' } };
  const reviewed = { ...structuredClone(seed), slug: 'reviewed-fixture', title: 'REVIEW PRIVATE MARKER', lifecycle: { state: 'reviewed', review: seed.lifecycle.review } };
  const stale = { ...structuredClone(seed), slug: 'stale-fixture', title: 'STALE PRIVATE MARKER' };
  const directory = await fixture(t, [[`${seed.slug}.json`, seed], ['draft-fixture.json', draft], ['reviewed-fixture.json', reviewed], ['stale-fixture.json', stale]]);
  const body = await journalBody({ root: directory });
  assert.equal((body.match(/data-journal-card /g) ?? []).length, 1);
  assert.doesNotMatch(body, /(?:DRAFT|REVIEW|STALE) PRIVATE MARKER/);
  assert.doesNotMatch(body, /journal\/(?:draft|reviewed|stale)-fixture/);
});

test('empty records explain absence; malformed identity fails closed', async t => {
  const directory = await fixture(t, []);
  assert.match(await journalBody({ root: directory }), /No approved articles are available yet/);
  await writeFile(join(directory, 'content/articles/wrong-name.json'), JSON.stringify(await json(seedPath)));
  await assert.rejects(journalBody({ root: directory }), /filename or site mismatch/);
});

test('approved plain text is escaped and unsafe source links cannot render', async t => {
  const seed = await json(seedPath);
  let article = { ...structuredClone(seed), title: '<script>bad()</script>', summary: 'Text with "quotes" & <tags>', lifecycle: { state: 'draft' } };
  const receipt = { reviewer: 'Test fixture only', date: seed.lifecycle.approval.date, scope: 'source-author-editorial' };
  article = approveArticle(reviewArticle(article, receipt), receipt);
  const directory = await fixture(t, [[`${article.slug}.json`, article]]);
  const body = await journalBody({ root: directory });
  assert.ok(body.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(body.includes('&quot;quotes&quot; &amp; &lt;tags&gt;'));
  assert.ok(!body.includes('<script>bad()'));
  article.sources[0].url = 'javascript:alert(1)';
  await writeFile(join(directory, 'content/articles', `${article.slug}.json`), JSON.stringify(article));
  await assert.rejects(journalBody({ root: directory }), /source URL/);
});

test('search matches normalized text and intersects the collection selection', () => {
  const record = { text: 'Strength plan · CDC · 2026-10-09', collection: 'first-steps' };
  assert.ok(matchesJournal(record, { query: '  STRENGTH   cdc ' }));
  assert.ok(matchesJournal(record, { query: 'ＳＴＲＥＮＧＴＨ', collection: 'first-steps' }));
  assert.ok(!matchesJournal(record, { query: 'strength', collection: 'other' }));
  assert.ok(!matchesJournal(record, { query: '<script>' }));
  assert.ok(matchesJournal(record, {}));
});

function view() {
  const listeners = new Map();
  const form = { hidden: true, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); } };
  const search = { value: '', focused: false, focus() { this.focused = true; } };
  const collection = { value: '' };
  const status = { textContent: '' };
  const empty = { hidden: true };
  const cards = [
    { textContent: 'Strength planning CDC', dataset: { collection: 'strength' }, hidden: false },
    { textContent: 'Reflect on your week', dataset: { collection: 'reflection' }, hidden: false }
  ];
  const nodes = { '[data-journal-form]': form, '[data-journal-search]': search, '[data-journal-collection]': collection, '[data-journal-status]': status, '[data-journal-empty]': empty };
  const element = { querySelector: selector => nodes[selector], querySelectorAll: () => cards };
  return { element, form, search, collection, status, empty, cards, listeners };
}

test('mount applies filters on submit, resets with focus, and releases listeners', () => {
  const ui = view();
  const cleanup = mountJournal(ui.element);
  assert.equal(mountJournal(ui.element), cleanup);
  assert.equal(ui.form.hidden, false);
  ui.search.value = 'missing';
  let prevented = 0;
  ui.listeners.get('submit')({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(ui.empty.hidden, false);
  assert.equal(ui.status.textContent, '0 of 2 articles shown.');
  assert.ok(ui.cards.every(card => card.hidden));
  ui.search.value = '';
  ui.collection.value = 'strength';
  ui.listeners.get('submit')({ preventDefault() {} });
  assert.deepEqual(ui.cards.map(card => card.hidden), [false, true]);
  ui.listeners.get('reset')({ preventDefault() {} });
  assert.equal(ui.search.focused, true);
  assert.equal(ui.collection.value, '');
  assert.ok(ui.cards.every(card => !card.hidden));
  assert.equal(ui.empty.hidden, true);
  cleanup();
  assert.equal(ui.listeners.size, 0);
  assert.equal(ui.form.hidden, true);
  assert.equal(ui.status.textContent, '2 articles available.');
});
