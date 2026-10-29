import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { syntheticTrainingBindings } from '../../src/training-feedback/synthetic-lineage/bindings.js';
import { syntheticSuccessFixture } from '../../src/training-feedback/synthetic-lineage/fixtures.js';
import { canonical, detach } from '../../src/training-feedback/synthetic-lineage/strict-json.js';
import { row, type Row } from '../../src/training-feedback/synthetic-lineage/schema.js';
import { hash } from '../../src/training-feedback/synthetic-lineage/meaning.js';
import { sourceFiles, implementationManifestDigest, implementationPins } from '../../src/training-feedback/synthetic-lineage/source-pins.js';

function draft(): Row { return row(structuredClone(detach(syntheticSuccessFixture(), 2 * 1024 * 1024, true))); }
function at(value: Row, ...keys: string[]): Row { for (const key of keys) value = row(value[key]!); return value; }
function evidence(value: Row): Row { return at(value, 'attempt', 'intent', 'review', 'recommendation', 'evidence'); }
function entries(value: Row): Row[] { return value.evidence as Row[]; }
function embedded(value: Row, schema: string): Row {
  const entry = entries(value).find(e => row(e.blob!).schema === schema); assert.ok(entry); return row(entry.value!);
}
function reseal(value: Row): void {
  const e = evidence(value);
  for (const entry of entries(value)) {
    const blob = row(entry.blob!); blob.canonicalJson = canonical(entry.value!); blob.payloadDigest = hash('blob', entry.value);
  }
  e.blobs = entries(value).map(entry => entry.blob!);
  const intent = at(value, 'attempt', 'intent'), review = at(intent, 'review'), recommendation = at(review, 'recommendation');
  recommendation.evidenceDigest = hash('evidence', e);
  review.reviewedMeaningDigest = hash('review', { reviewId: review.reviewId, recommendation, reviewingActor: review.reviewingActor, consent: review.consent });
  row(value.attempt!).intentDigest = hash('intent', intent);
}
// Deliberately cross the typed seam with untrusted test data: no product validator or brand constructor is bypassed.
function run(value: unknown) { return Reflect.apply(syntheticTrainingBindings.producer.validateClosure, undefined, [value]); }
const readSchema = 'synthetic.training-feedback-analysis.pinned-v1';
const lineageSchema = 'synthetic.feedback-comparison-lineage.pinned-v1';
const witnessSchema = 'synthetic.comparison-witness.pinned-v2';
const recipeSchema = 'synthetic.registration-manifest/v1';
const inputsSchema = 'synthetic.accepted-input-dispositions/v1';

test('complete invented full attempt retains exact evidence, review and attempt bindings', () => {
  const input = syntheticSuccessFixture(), checked = syntheticTrainingBindings.producer.validateClosure(input);
  assert.equal(checked.ok, true); if (!checked.ok) return;
  assert.deepEqual(checked.value, input); assert.notEqual(checked.value, input);
  assert.ok(Object.isFrozen(checked.value)); assert.ok(Object.isFrozen(checked.value.attempt.intent.review.recommendation));
});

test('semantic failures remain failures after all disclosed embedded and envelope hashes are refreshed', () => {
  const cases: readonly [string, (v: Row) => void][] = [
    ['wrong original account', v => { at(v, 'attempt', 'intent', 'originalActor').accountId = 'syn_other_account'; }],
    ['original scope mismatch', v => { at(evidence(v), 'association', 'scope').contextId = 'syn_other_context'; }],
    ['record association unavailable', v => { const s = at(embedded(v, readSchema), 'result').sources as Row[]; s[0]!.binding = null; }],
    ['record revision mismatch', v => { const rs = evidence(v).records as Row[]; row(rs[0]!.recordRevision!).value = 2; }],
    ['record is unconfirmed', v => { (evidence(v).records as Row[])[0]!.confirmed = false; }],
    ['record withdrawn', v => { (evidence(v).records as Row[])[0]!.status = 'withdrawn'; }],
    ['record content missing', v => { (at(embedded(v, readSchema), 'result').records as Row[])[0]!.content = null; }],
    ['source is unbound', v => { (at(embedded(v, readSchema), 'result').sources as Row[])[0]!.state = 'unbound'; }],
    ['source set voided', v => { const b = row((at(embedded(v, readSchema), 'result').sources as Row[])[0]!.binding!);
      (at(b, 'witness', 'sessionSource').sets as Row[])[0]!.status = 'voided'; }],
    ['target item remapped', v => { const c = at(v, 'attempt', 'intent', 'review', 'recommendation', 'change'); (c.itemMapping as Row[])[0]!.beforeItemId = 'syn_missing_item'; }],
    ['registration mismatch', v => { const c = at(v, 'attempt', 'intent', 'review', 'recommendation', 'change');
      at((at(c, 'after').items as Row[])[0]!, 'registeredDomain', 'registration').digest = 'f'.repeat(64); }],
    ['recipe graph cycle', v => { const node = (at(evidence(v), 'recipe').nodes as Row[])[0]!; node.parentIds = [node.id!]; }],
    ['recipe graph unresolved', v => { (at(evidence(v), 'recipe').nodes as Row[])[0]!.parentIds = ['syn_missing_node']; }],
    ['same output changed semantic version', v => { at(evidence(v), 'recipe').semanticVersion = 'identity-fixture-v2'; }],
    ['wrong executable bytes', v => { at(evidence(v), 'recipe', 'executable').sha256 = 'f'.repeat(64); }],
    ['manifest disagrees with recipe', v => { embedded(v, recipeSchema).recipeId = 'syn_other_recipe'; }],
    ['registry changed version', v => { at(evidence(v), 'registry').version = 'invented-registry-v2'; }],
    ['declaration missing', v => { embedded(v, lineageSchema).declaration = null; }],
    ['producer unavailable', v => { embedded(v, lineageSchema).producer = { status: 'unavailable', reason: 'reader_unavailable', side: 'baseline' }; }],
    ['association unproved', v => { embedded(v, lineageSchema).association = { status: 'unavailable', reason: 'association_unproved' }; }],
    ['blocked lineage', v => { embedded(v, lineageSchema).blockedBy = ['comparison:identity-unqualified']; }],
    ['unqualified witness', v => { at(embedded(v, witnessSchema), 'inputs', 'baseline', 'identity').state = 'unqualified'; }],
    ['withdrawn identity', v => { at(embedded(v, witnessSchema), 'inputs', 'baseline', 'identity').status = 'withdrawn'; }],
    ['missing performed-work evidence', v => { embedded(v, witnessSchema).result = { status: 'unknown', policy: 'confirmed-work-comparison-v1',
      evidenceToken: 'invented-observed-work-v1', reasons: ['work_unconfirmed'] }; }],
    ['disposition refresh', v => { (embedded(v, inputsSchema).rows as Row[])[0]!.disposition = 'refresh'; }],
    ['disposition retire', v => { (embedded(v, inputsSchema).rows as Row[])[0]!.disposition = 'retire'; }],
    ['disposition unqualified', v => { (embedded(v, inputsSchema).rows as Row[])[0]!.qualified = false; }],
    ['currentness content mismatch', v => { (evidence(v).dependencies as Row[])[0]!.contentDigest = 'f'.repeat(64); }],
    ['missing dependency', v => { (evidence(v).dependencies as Row[]).pop(); }],
    ['duplicate dependency', v => { const ds = evidence(v).dependencies as Row[]; ds.push(structuredClone(ds[0]!)); }],
  ];
  for (const [name, mutate] of cases) { const v = draft(); mutate(v); reseal(v); assert.equal(run(v).ok, false, name); }
});

test('noncurrent tokens, missing codecs/evidence and arbitrary codec identities never default to success', () => {
  for (const state of ['changed', 'missing', 'void', 'withdrawn', 'unconfirmed']) {
    const v = draft(); (evidence(v).dependencies as Row[])[0]!.state = state; reseal(v); assert.equal(run(v).ok, false, state);
  }
  for (const schema of [readSchema, lineageSchema, witnessSchema, recipeSchema, inputsSchema]) {
    const v = draft(); v.evidence = entries(v).filter(e => row(e.blob!).schema !== schema); reseal(v); assert.equal(run(v).ok, false, schema);
  }
  const wrong = draft(); at(entries(wrong)[0]!, 'identity', 'implementation').sha256 = 'f'.repeat(64); assert.equal(run(wrong).ok, false);
  const missing = draft(); delete entries(missing)[0]!.identity; assert.equal(run(missing).ok, false);
  assert.equal(Object.isFrozen(syntheticTrainingBindings.codecs), true);
});

test('immutable meaning digests bind review, attempt, generation and source domains', () => {
  const v = draft(); at(v, 'attempt', 'intent').attemptId = 'syn_new_attempt'; assert.equal(run(v).ok, false);
  const review = draft(); at(review, 'attempt', 'intent', 'review').reviewId = 'syn_new_review'; assert.equal(run(review).ok, false);
  const generation = draft(); row((evidence(generation).dependencies as Row[])[0]!.revision!).domain = 'dependency:profile'; reseal(generation); assert.equal(run(generation).ok, false);
  const source = draft(); row((at(evidence(source), 'association').joins as Row[])[0]!.sourceRevision!).domain = 'historical-plan'; reseal(source); assert.equal(run(source).ok, false);
});

test('implementation identities pin actual unchanged source bytes, not document hashes', () => {
  const set = createHash('sha256').update('form.training.synthetic.implementation-set/v1\0');
  for (const file of sourceFiles) {
    const source = readFileSync(new URL((import.meta.url.includes('/dist/tests/') ? '../../../' : '../../') + 'src/training-feedback/synthetic-lineage/' + file.path, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), file.sha256);
    const name = Buffer.from(file.path); set.update(`${name.length}\0`).update(name).update(`\0${source.length}\0`).update(source);
  }
  assert.equal(set.digest('hex'), implementationManifestDigest);
  const guard = sourceFiles.find(file => file.path === 'guard.ts')!;
  assert.equal(guard.sha256, implementationPins.guard.sha256);
});
