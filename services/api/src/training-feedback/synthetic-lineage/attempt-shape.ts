import type { Json } from './strict-json.js';
import { requireThat } from './strict-json.js';
import { type Check, row, object, shape, one, list, syn, exact, digest, revision, numeric, bool, nullable, text,
  syntheticRef, recipe } from './schema.js';

const scope: Check = value => {
  const kind = row(value).kind;
  object(value, { kind: one('context', 'session', 'activity'), contextId: syn,
    ...(kind === 'session' ? { sessionId: syn } : kind === 'activity' ? { activityId: syn } : {}) });
};
const join = shape({ sourceKind: one('session', 'activity'), sourceId: syn, sourceRevision: revision('source', 1), occurrenceId: syn,
  itemId: syn, itemRevision: revision('source-item', 1), set: nullable(shape({ id: syn, revision: revision('source-set', 1) })),
  historicalPlan: nullable(shape({ planId: syn, planRevision: revision('historical-plan', 1) })), identityId: syn,
  identityRevision: revision('comparison-identity', 1), associationEvidenceDigest: digest });
const association = shape({ accountId: syn, contextId: syn, scope, profileRevision: revision('profile', 1),
  preferencesRevision: revision('preferences', 1), joins: list(join, 0, 128), sourceRefs: list(syntheticRef, 1) });
const native: Check = value => {
  const r = object(value, { exercise_id: syn, movement_pattern: text(200), role: text(200), sets: numeric(1, 20), rest_seconds: numeric(0, 10800) },
    { rep_range: list(numeric(1, 100), 2, 2), target_rir: numeric(0, 100), substituted_for: syn, notes: list(text(4000, 0), 1, 30) });
  if (r.rep_range) { const pair = r.rep_range as number[]; requireThat(pair[0]! <= pair[1]!); }
};
const sourceItem = shape({ id: syn, native, registeredDomain: shape({ exerciseId: syn, variantId: exact,
  identity: shape({ repository: exact, revision: exact, path: exact, sha256: digest, nativeId: syn }),
  registration: shape({ id: exact, revision: exact, digest, bytes: numeric(1) }), recordDigest: digest }),
  load: shape({ kind: one('unspecified'), basis: one('unknown') }) });
const fields: Check = value => {
  const r = object(value, { schema: one('form.source-prescription-plan/v1'), name: text(100), origin: shape({ kind: one('form-adaptation'), id: exact, revision: exact }),
    duration: shape({ kind: one('estimated-range'), minMinutes: numeric(5, 180), maxMinutes: numeric(5, 180) }), items: list(sourceItem, 1, 50) });
  requireThat(r.name === (r.name as string).trim()); const d = row(r.duration!); requireThat((d.minMinutes as number) <= (d.maxMinutes as number));
};
const change = shape({ schema: one('form.synthetic-source-change/v1'), kind: one('replace-source-plan'), capability: one('source_prescription_adoption_synthetic_v1'),
  targetPlanId: syn, expectedRevision: revision('plan', 1), before: shape({ planId: syn, planRevision: revision('plan', 1), archived: bool, fields }), after: fields,
  itemMapping: list(shape({ afterItemId: syn, beforeItemId: nullable(syn) }), 1, 50) });
export const dependencyKinds = ['context', 'profile', 'preferences', 'target-plan', 'historical-plan', 'session', 'session-item', 'session-set',
  'activity', 'activity-item', 'activity-set', 'comparison-identity', 'association', 'feedback-record', 'ledger', 'projection', 'source', 'catalog-row',
  'input-disposition', 'recipe', 'executable', 'constants', 'registry', 'recipe-authority', 'rights', 'retention', 'schema', 'codec', 'boundary'] as const;
const token: Check = value => {
  const r = object(value, { key: shape({ kind: one(...dependencyKinds), ownerId: syn, id: syn }),
    revision: v => { const kind = row(rkey(value)).kind; revision(`dependency:${kind}`)(v); },
    contentDigest: digest, state: one('current', 'changed', 'missing', 'void', 'withdrawn', 'unconfirmed') });
  requireThat(r.key !== null);
};
function rkey(v: Json): Json { return row(v).key!; }
const actor = shape({ accountId: syn, authUserId: syn, sessionId: syn, epoch: revision('account-epoch', 1) });
const decision = shape({ schema: one('form.synthetic-policy-decision/v1'), kind: one('recipe-authority', 'rights', 'retention'), realmId: syn, issuerId: syn,
  decisionId: syn, revision: revision('policy-decision'), revocationRevision: revision('policy-revocation'), accountId: syn, recommendationId: syn,
  operation: one('review-display', 'review-retain', 'adopt', 'reconcile', 'compensate'), purpose: one('isolated-contract-fixture'),
  dataCategories: list(one('recommendation', 'review', 'intent', 'minimal-receipt', 'receipt-detail'), 1), permittedFieldPaths: list(exact, 1, 128),
  applicabilityDigest: digest, outcome: one('allow', 'deny', 'unavailable') });
const evidence = shape({ schema: one('form.synthetic-evidence-closure/v1'), association, ledgerRevision: revision('feedback-ledger'), projectionRevision: revision('feedback-projection'),
  records: list(shape({ recordId: syn, eventId: syn, recordRevision: revision('feedback-record', 1), status: one('active', 'withdrawn', 'deleted', 'undone', 'missing'),
    confirmed: bool, acceptedLedgerRevision: revision('feedback-ledger'), evidenceId: syn }), 1), recipe,
  registry: nullable(shape({ schema: one('feedback-comparison-inputs-v1'), version: exact, digest, selectedInputIds: list(syn, 0, 128), lineageEvidenceIds: list(syn, 0, 64) })),
  inputsEvidenceId: syn, blobs: list(shape({ id: syn, schema: one('synthetic.training-feedback-analysis.pinned-v1', 'synthetic.feedback-comparison-lineage.pinned-v1',
    'synthetic.comparison-witness.pinned-v2', 'synthetic.registration-manifest/v1', 'synthetic.accepted-input-dispositions/v1'), subcodecDigest: digest,
    payloadDigest: digest, canonicalJson: text(256 * 1024) }), 1, 64), dependencies: list(token, 1), decisions: list(decision, 1, 64) });
const recommendation = shape({ schema: one('form.training-recommendation.synthetic/v1'), environment: one('synthetic-only'), realmId: syn, recommendationId: syn,
  kind: one('recommendation'), status: one('ready'), blockedBy: list(one(), 0, 0), derivationId: syn, derivationVersion: exact, change, evidence, evidenceDigest: digest });
const review = shape({ schema: one('form.training-review.synthetic/v1'), reviewId: syn, recommendation, reviewingActor: actor,
  reviewedMeaningDigest: digest, consent: one('explicit-synthetic-review') });
export const attemptShape = shape({ intent: shape({ schema: one('form.training-lineage.synthetic/v1'), environment: one('synthetic-only'), codec: one('form.synthetic-cjson/v1'),
  boundary: one('source_prescription_adoption_synthetic_v1'), operationNamespace: one('training.synthetic-lineage/v1'), realmId: syn, adoptionId: syn, attemptId: syn,
  originalActor: actor, review, action: value => {
    if (row(value).kind === 'adopt') object(value, { kind: one('adopt'), consent: one('explicit-synthetic-adoption'), undoOf: one(null) });
    else object(value, { kind: one('compensate'), consent: one('explicit-synthetic-compensation'), undoOf: syn, appliedRevision: revision('plan', 1), appliedAfterDigest: digest });
  } }), intentDigest: digest });
