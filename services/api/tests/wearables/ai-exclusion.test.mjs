// FORM-WEAR09 regression guard. Imported health/wearable data stays aiEligible:false with
// provenance:'unqualified_import' until trusted provenance AND use rights are qualified elsewhere.
// This file only asserts the exclusion; it grants no rights and enables no AI, coach or voice use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, ctxA, batch, record } from './support.mjs';
import { fixture, a, connection, page } from './persistence/fixture.mjs';
import { createHealthRouter } from '../../src/wearables/router.ts';
import { decodeOura } from '../../src/wearables/providers/oura.ts';
import { importProviderPage } from '../../src/wearables/providers/importer.ts';

const FROM = '2026-10-09', TO = '2026-10-10';
const metrics = [
  record(),
  record({ id: 'hrv', metric: 'hrv_sdnn', unit: 'ms', value: 41, aggregation: 'mean' }),
  record({ id: 'score', metric: 'vendor_score', unit: 'score', value: 80, aggregation: 'vendor_algorithm',
    source: { bundleId: 'com.apple.health', name: 'Apple Health', device: 'Apple Watch', algorithm: 'vendor-v1', originalId: null } }),
];

// Walks any JSON-like value and reports every aiEligible / provenance it carries.
function labels(value, found = { ai: [], provenance: [] }) {
  if (Array.isArray(value)) value.forEach(item => labels(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'aiEligible') found.ai.push(child);
      if (key === 'provenance') found.provenance.push(child);
      labels(child, found);
    }
  }
  return found;
}
function assertExcluded(value, { requireLabels = false } = {}) {
  const found = labels(value);
  if (requireLabels) assert.ok(found.ai.length > 0, 'expected at least one aiEligible label');
  assert.ok(found.ai.every(flag => flag === false), `aiEligible must only ever be false: ${JSON.stringify(found.ai)}`);
  assert.ok(found.provenance.every(p => p === 'unqualified_import'), `provenance must stay unqualified_import: ${JSON.stringify(found.provenance)}`);
  assert.equal(JSON.stringify(value).includes('"aiEligible":true'), false);
}

test('ingest, store reads, summary and router bodies never emit AI eligibility or trusted provenance', () => {
  const h = harness();
  h.service.ingest(ctxA, 'k', batch({ batch: metrics }));
  h.service.ingest(ctxA, 'k2', batch({ pageId: 'p2', fromCursor: 'anchor1', nextCursor: 'anchor2', batch: [],
    tombstones: [{ id: 'steps:day', revision: { token: 'r2', order: 2 } }] }));
  const stored = h.store.measures(ctxA, FROM, TO, 100);
  assert.equal(stored.length, metrics.length);
  assert.ok(stored.some(m => m.deleted), 'tombstones are exercised');
  for (const m of stored) { assert.equal(m.aiEligible, false); assert.equal(m.provenance, 'unqualified_import'); }
  assertExcluded(stored, { requireLabels: true });
  const summary = h.service.summary(ctxA, FROM, TO);
  assert.ok(summary.items.length > 0);
  assert.equal(summary.aiEligible, false);
  assert.ok(summary.items.every(item => item.aiEligible === false && item.selected.aiEligible === false));
  assertExcluded(summary, { requireLabels: true });
  const router = createHealthRouter(h.service);
  for (const path of ['/v1/health/summary', '/v1/health/capabilities', '/v1/health/connections', '/v1/health/suggestions']) {
    const response = router(ctxA, { method: 'GET', path, query: new URLSearchParams({ from: FROM, to: TO }) });
    assert.equal(response.status, 200, path);
    assertExcluded(response.body);
  }
  assert.equal(h.service.capabilities().aiUse, 'excluded');
  assert.deepEqual(h.service.coachInputs(ctxA), []);
});

test('forged AI, provenance or use-rights fields are rejected before any store write or receipt', () => {
  const h = harness();
  const receipts = h.bucket(ctxA).receipts.size;
  const forged = [{ aiEligible: true }, { aiEligible: 'true' }, { provenance: 'trusted' }, { provenance: 'unqualified_import' },
    { useRights: 'granted' }, { aiUse: 'allowed' }, { coachEligible: true }];
  for (const extra of forged) {
    assert.throws(() => h.service.ingest(ctxA, 'k', batch({ batch: [{ ...record(), ...extra }] })), /health_invalid_input/, JSON.stringify(extra));
    assert.throws(() => h.service.ingest(ctxA, 'k', { ...batch(), ...extra }), /health_invalid_input/, JSON.stringify(extra));
  }
  assert.equal(h.store.measures(ctxA, FROM, TO, 100).length, 0);
  assert.equal(h.bucket(ctxA).receipts.size, receipts);
});

test('provider (Oura) ingest stays unqualified and coach inputs stay empty', async () => {
  const h = harness();
  h.store.putConnection(ctxA, { ...h.store.connection(ctxA, 'hk'), id: 'oura', provider: 'oura', types: ['steps', 'active_energy'] });
  let pending = null;
  const result = await importProviderPage({ ctx: ctxA, provider: 'oura', connectionId: 'oura', generation: 1, stream: 'daily_activity:2026-10-09',
    cursor: null, service: h.service, newKey: () => 'provider-key', assertCurrent() {},
    source: { read: async () => decodeOura('daily_activity', { data: [{ id: 'invented-oura', day: FROM, timestamp: '2026-10-09T04:00:00+02:00', steps: 10, active_calories: 20 }], next_token: null }) },
    intent: { load: () => pending, save: p => { pending = structuredClone(p); }, acknowledged() { pending = null; } } });
  assert.equal(result.accepted, 2);
  const stored = h.store.measures(ctxA, FROM, TO, 100).filter(m => m.provider === 'oura');
  assert.equal(stored.length, 2);
  assertExcluded(stored, { requireLabels: true });
  assert.deepEqual(h.service.coachInputs(ctxA), []);
  assertExcluded(h.service.summary(ctxA, FROM, TO), { requireLabels: true });
});

test('suggestions carry only digest references, never measures or AI eligibility', () => {
  const h = harness();
  h.service.ingest(ctxA, 'k', batch({ batch: metrics }));
  const measure = h.store.measure(ctxA, 'hk', 1, 'steps:day');
  const before = structuredClone(h.bucket(ctxA).plan.items), after = structuredClone(before);
  after[0].setTarget = 2;
  h.store.putSuggestion(ctxA, { id: 's', planId: 'plan', baseRevision: 1, appliedRevision: null, state: 'pending', beforeItems: before, afterItems: after,
    reviewDigest: 'reviewed', expiresAt: '2026-10-11T00:00:00Z', reason: 'Invented example only', limits: [], policyVersion: 'test-only',
    evidenceRefs: [{ connectionId: 'hk', generation: 1, id: measure.id, digest: measure.digest }] });
  const listed = createHealthRouter(h.service)(ctxA, { method: 'GET', path: '/v1/health/suggestions', query: new URLSearchParams() }).body;
  assert.equal(listed.items.length, 1);
  assertExcluded(listed);
  for (const ref of listed.items[0].evidenceRefs) assert.deepEqual(Object.keys(ref).sort(), ['connectionId', 'digest', 'generation', 'id']);
  assert.equal(JSON.stringify(listed).includes('"value":120'), false, 'suggestion payload must not embed measure values');
  h.service.suggestion(ctxA, 'accept', 's', 'accept', { expectedPlanRevision: 1, reviewDigest: 'reviewed' });
  assertExcluded(h.service.suggestions(ctxA));
  assert.deepEqual(h.service.coachInputs(ctxA), []);
});

test('persistence stores only unqualified rows and refuses any other AI label or provenance', t => {
  const h = fixture(t);
  h.service.ingest(a, 'command', page());
  const original = h.store.measure(a, 'hk', 1, 'day');
  assert.equal(original.aiEligible, false);
  assert.equal(original.provenance, 'unqualified_import');
  assertExcluded(h.store.measures(a, FROM, TO, 100), { requireLabels: true });
  for (const forged of [{ aiEligible: true }, { aiEligible: 'false' }, { aiEligible: 0 }, { provenance: 'trusted' }, { provenance: 'qualified_import' }]) {
    assert.throws(() => h.write(a, () => h.store.putMeasure(a, { ...original, id: 'forged', ...forged })), /health_storage_provenance_invalid/, JSON.stringify(forged));
    assert.throws(() => h.db.prepare('UPDATE wearable_measures SET data=? WHERE account_id=?').run(JSON.stringify({ ...original, ...forged }), 'a'),
      /CHECK constraint/, JSON.stringify(forged));
  }
  assert.equal(h.store.measure(a, 'hk', 1, 'forged'), null);
  assertExcluded(h.store.measure(a, 'hk', 1, 'day'), { requireLabels: true });
});

test('lifecycle export never lifts eligibility, even when the qualifier is permissive or mutates its copy', t => {
  const h = fixture(t);
  h.service.ingest(a, 'command', page());
  const output = [], snapshot = { snapshotAtMs: 1, append: (category, value) => output.push({ category, value }) };
  assert.equal(h.adapter.export(a, snapshot).status, 'unavailable');
  assert.equal(output.some(x => x.value.kind === 'measure'), false);
  assert.equal(output.at(-1).value.kind, 'manifest');
  assert.notEqual(output.at(-1).value.aiEligible, true);
  assertExcluded(output);

  output.length = 0;
  const seen = [];
  h.deps.qualifyExport = (_ctx, value) => { seen.push(structuredClone(value)); value.aiEligible = true; value.provenance = 'trusted'; return true; };
  assert.equal(h.adapter.export(a, snapshot).status, 'complete');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].aiEligible, false);
  assert.equal(seen[0].provenance, 'unqualified_import');
  const measures = output.filter(x => x.value.kind === 'measure');
  assert.equal(measures.length, 1);
  assert.equal(measures[0].value.data.aiEligible, false);
  assert.equal(measures[0].value.data.provenance, 'unqualified_import');
  const manifest = output.at(-1).value;
  assert.equal(manifest.kind, 'manifest');
  assert.equal(manifest.aiEligible, false);
  for (const omitted of ['credentials', 'cursors', 'raw_provider_intents', 'receipt_results', 'suggestion_plan_snapshots']) assert.ok(manifest.omissions.includes(omitted));
  assertExcluded(output, { requireLabels: true });
});

test('lifecycle export fails closed on a stored row with a non-false aiEligible or untrusted provenance', t => {
  for (const tampered of [{ aiEligible: true }, { aiEligible: 'false' }, { provenance: 'trusted' }, { provenance: 'qualified_import' }]) {
    const h = fixture(t);
    h.service.ingest(a, 'command', page());
    const original = h.store.measure(a, 'hk', 1, 'day');
    // SQL CHECKs refuse this write; bypass them only to prove the lifecycle layer is an independent second fence.
    h.db.pragma('ignore_check_constraints = ON');
    h.db.prepare('UPDATE wearable_measures SET data=? WHERE account_id=?').run(JSON.stringify({ ...original, ...tampered }), 'a');
    h.db.pragma('ignore_check_constraints = OFF');
    let qualifierCalls = 0;
    h.deps.qualifyExport = () => { qualifierCalls++; return true; };
    const output = [];
    assert.throws(() => h.adapter.export(a, { snapshotAtMs: 1, append: (category, value) => output.push({ category, value }) }),
      /health_storage_provenance_invalid/, JSON.stringify(tampered));
    assert.equal(qualifierCalls, 0, 'the qualifier is never consulted for a non-excluded row');
    assert.equal(output.length, 0, 'nothing is appended after the fence trips');
  }
});

// Static tripwire. Step-1 review found no grounding, coach, voice or app voice-coaching module that reads
// wearable data. A new reference there must come with a qualified rights design, so it fails here first.
const apiSrc = new URL('../../src/', import.meta.url);
const appSrc = new URL('../../../../apps/form/src/', import.meta.url);
const sourceFiles = (dir, skip = () => false) => readdirSync(fileURLToPath(dir), { recursive: true })
  .map(path => path.split(sep).join('/')).filter(path => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(path) && !skip(path)).sort();
const reader = /wearable|healthkit|form-?health|aiEligible|unqualified_import/i;

test('no grounding, coaching or voice context module references wearable data', () => {
  const scopes = [
    ['api grounding', new URL('grounding/', apiSrc)],
    ['api voice-coaching', new URL('voice-coaching/', apiSrc)],
    ['api domain-features', new URL('domain-features/', apiSrc)],
    ['api integration (grounded answers, domain reads, coaching, feedback, first plan)', new URL('integration/', apiSrc), path => path.startsWith('account-modules/')],
    ['app voice-coaching', new URL('voice-coaching/', appSrc)],
  ];
  for (const [name, dir, skip] of scopes) {
    const files = sourceFiles(dir, skip);
    assert.ok(files.length > 0, `${name} scope must not be vacuous`);
    for (const file of files) {
      assert.equal(reader.test(readFileSync(new URL(file, dir), 'utf8')), false, `${name}: ${file} must not read wearable data`);
    }
  }
});

test('only wearable, lifecycle-registry and type-only wiring modules reference wearable tables or types in the API', () => {
  const allowed = new Set(['lifecycle/coverage.ts', 'planning/plan-revision-port.ts', 'integration/account-modules/canonical-writer.ts']);
  const offenders = sourceFiles(apiSrc, path => path.startsWith('wearables/') || allowed.has(path))
    .filter(file => reader.test(readFileSync(new URL(file, apiSrc), 'utf8')));
  assert.deepEqual(offenders, [], 'new wearable readers need qualified provenance and use rights before any AI path');
  for (const typeOnly of ['planning/plan-revision-port.ts', 'integration/account-modules/canonical-writer.ts']) {
    const lines = readFileSync(new URL(typeOnly, apiSrc), 'utf8').split('\n').filter(line => /wearables\//i.test(line));
    assert.ok(lines.length > 0 && lines.every(line => /^import type /.test(line)), `${typeOnly} may only type-import wearable modules`);
  }
});
