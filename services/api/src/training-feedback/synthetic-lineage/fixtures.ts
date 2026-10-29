import type { AttemptV1, EmbeddedSchema } from '../../planning/synthetic-lineage/types.js';
import type { EmbeddedClosureInputV1, EmbeddedPayloadsV1 } from '../../planning/synthetic-lineage/subcodec-types.js';
import { attemptShape } from './attempt-shape.js';
import { canonical, detach, requireThat, type Json } from './strict-json.js';
import { hash, dependencyDigest } from './meaning.js';
import { dependencyRequirements, registryDigest } from './guard.js';
import { implementationPins, implementationManifestDigest, identities } from './source-pins.js';
import { fixtureRecipe } from './fixture-recipe.js';
import { validateEmbedded } from './codecs.js';

function checkedAttempt(input: unknown): AttemptV1 {
  const value = detach(input, 2 * 1024 * 1024, true); attemptShape(value); return value as Json & AttemptV1;
}
function payload<S extends EmbeddedSchema>(schema: S, input: unknown): EmbeddedPayloadsV1[S] {
  const value = validateEmbedded(schema, input); requireThat(value.ok); return value.value;
}
const rev = (domain: string, value = 1) => ({ domain, value });
const zeroDigest = '0'.repeat(64);

/** Wholly invented identity-transform data; no account, corpus row, provider or medical recipe is reused. */
export function syntheticSuccessFixture(): EmbeddedClosureInputV1 {
  const accountId = 'syn_account_fixture', contextId = 'syn_context_fixture', planId = 'syn_plan_target';
  const refs = ['baseline', 'current'].map(side => ({ sourceId: `syn_session_${side}`, revision: 'invented-source-v1',
    locator: `fixture/${side}`, qualification: 'invented-nonprescriptive' }));
  const native = { exercise_id: 'syn_native_fixture', movement_pattern: 'invented', role: 'fixture', sets: 1, rest_seconds: 0,
    rep_range: [1, 1], target_rir: 0, notes: ['synthetic first', 'synthetic second'] };
  const identity = { ...implementationPins.recipe, nativeId: native.exercise_id };
  const registration = { id: 'syn_item_fixture', exerciseId: 'syn_domain_fixture', variantId: 'invented-variant', identity, native,
    load: { kind: 'unspecified', basis: 'unknown' } };
  const fields = { schema: 'form.source-prescription-plan/v1', name: 'Synthetic identity fixture',
    origin: { kind: 'form-adaptation', id: 'syn_origin_fixture', revision: 'invented-origin-v1' },
    duration: { kind: 'estimated-range', minMinutes: 5, maxMinutes: 5 }, items: [{ id: registration.id, native, registeredDomain: {
      exerciseId: registration.exerciseId, variantId: registration.variantId, identity,
      registration: { id: registration.id, revision: implementationPins.recipe.revision, digest: dependencyDigest(registration),
        bytes: new TextEncoder().encode(canonical(detach(registration))).length }, recordDigest: dependencyDigest(registration) }, load: registration.load }] };
  const associationProof = { status: 'associated', evidenceToken: 'invented-association-v1', sourceRefs: refs };
  const joins = ['baseline', 'current'].map(side => ({ sourceKind: 'session', sourceId: `syn_session_${side}`, sourceRevision: rev('source'),
    occurrenceId: `syn_occurrence_${side}`, itemId: `syn_item_${side}`, itemRevision: rev('source-item'),
    set: { id: `syn_set_${side}`, revision: rev('source-set') }, historicalPlan: { planId: `syn_plan_${side}`, planRevision: rev('historical-plan') },
    identityId: `syn_identity_${side}`, identityRevision: rev('comparison-identity'), associationEvidenceDigest: dependencyDigest(associationProof) }));
  const association = { accountId, contextId, scope: { kind: 'context', contextId }, profileRevision: rev('profile'), preferencesRevision: rev('preferences'), joins, sourceRefs: refs };
  const before = { planId, planRevision: rev('plan'), archived: false, fields };
  const change = { schema: 'form.synthetic-source-change/v1', kind: 'replace-source-plan', capability: 'source_prescription_adoption_synthetic_v1',
    targetPlanId: planId, expectedRevision: rev('plan'), before, after: fields, itemMapping: [{ afterItemId: registration.id, beforeItemId: registration.id }] };
  const recipe = { schema: 'form.synthetic-recipe-manifest/v1', recipeId: fixtureRecipe.id, semanticVersion: fixtureRecipe.version,
    executable: implementationPins.recipe, implementationManifestDigest,
    constants: { fixtureId: fixtureRecipe.constants.fixtureId, digest: dependencyDigest(fixtureRecipe.constants), justification: 'synthetic-nonprescriptive' },
    registrationEvidenceId: 'syn_evidence_recipe', rootDerivationId: 'syn_derivation_root', nodes: [{ id: 'syn_derivation_root', semanticVersion: fixtureRecipe.version,
      kind: 'recommendation', parentIds: [], sourceRecordIds: ['syn_record_baseline', 'syn_record_current'], sourceRefs: refs, qualifications: ['invented-nonprescriptive'] }] };
  const source = (side: string) => ({ accountId, kind: 'session', id: `syn_session_${side}`, revision: 1, itemId: `syn_occurrence_${side}` });
  const occurrence = (side: string) => ({ id: `syn_occurrence_${side}`, itemId: `syn_item_${side}`, exerciseId: native.exercise_id });
  const identityWitness = (side: string) => ({ id: `syn_identity_${side}`, revision: 1, status: 'confirmed', current: true });
  const input = (side: string) => ({ identity: { ...identityWitness(side), state: 'qualified' }, scope: { source: source(side),
    exercise: { source: 'global', id: native.exercise_id }, session: { planId: `syn_plan_${side}`, planRevision: 1, occurrence: occurrence(side) } } });
  const summary = (side: string, repetitions: number) => ({ confirmedSets: 1, repetitions, volumeKgRepetitions: null,
    loads: [{ setId: `syn_set_${side}`, repetitions, kg: null }] });
  const witness = payload('synthetic.comparison-witness.pinned-v2', { accountId, contextId, witnessVersion: 'progress-comparison-witness-v2',
    inputs: { baseline: input('baseline'), current: input('current') }, scope: { baseline: source('baseline'), current: source('current') },
    bindings: [identityWitness('baseline'), identityWitness('current')], sourceRefs: refs,
    result: { status: 'comparable', policy: 'confirmed-work-comparison-v1', evidenceToken: 'invented-observed-work-v1',
      baseline: summary('baseline', 1), current: summary('current', 2), delta: { confirmedSets: 0, repetitions: 1, volumeKgRepetitions: null },
      units: { load: 'kg', volume: 'kg-repetitions' }, interpretation: 'observed_work_only' }, evidenceToken: 'invented-observed-work-v1', interpretation: 'observed_work_only' });
  const declaration = { id: 'syn_comparison_fixture', contextId, selections: {
    baseline: { kind: 'session', id: 'syn_session_baseline', itemId: 'syn_occurrence_baseline' },
    current: { kind: 'session', id: 'syn_session_current', itemId: 'syn_occurrence_current' } } };
  const registry = { schema: 'feedback-comparison-inputs-v1', version: 'invented-registry-v1', inputs: [declaration] };
  const lineage = payload('synthetic.feedback-comparison-lineage.pinned-v1', { registryVersion: registry.version, registryDigest: registryDigest(registry),
    recipeId: recipe.rootDerivationId, recipeVersion: fixtureRecipe.version, inputId: declaration.id, declaration,
    producer: { status: 'observed', witness }, association: associationProof, blockedBy: [] });
  const records = ['baseline', 'current'].map(side => ({ recordId: `syn_record_${side}`, revision: 1, status: 'active', confirmed: true, content: {
    scope: { kind: 'session', contextId, sessionId: `syn_session_${side}`, planId: `syn_plan_${side}` }, sourceRefs: refs, qualifications: ['invented-nonprescriptive'],
    payload: { kind: 'feedback', signals: [{ dimension: 'function', state: 'reported', value: { invented: true }, unit: null, scale: null }] } } }));
  const read = payload('synthetic.training-feedback-analysis.pinned-v1', { analysis: { basis: 'current_profile_and_goals', contextId, profileRevision: 1, preferencesRevision: 1 },
    result: { ledgerRevision: 2, projectionRevision: 3, records, sources: records.map((record, index) => {
      const side = index ? 'current' : 'baseline';
      return { recordId: record.recordId, state: 'current', binding: { scope: record.content.scope,
        selection: { sessionId: `syn_session_${side}`, occurrenceId: `syn_occurrence_${side}` }, witness: { contextId, profileRevision: 1, preferencesRevision: 1,
          sessionSource: { source: source(side), sessionStatus: 'completed', planSnapshot: { planId: `syn_plan_${side}`, planRevision: 1 }, occurrence: occurrence(side),
            sets: [{ id: `syn_set_${side}`, revision: 1, status: 'confirmed' }] }, targetPlan: { id: planId, revision: 1, archived: false } } } };
    }), derivations: [{ id: recipe.rootDerivationId, version: fixtureRecipe.version, kind: 'recommendation', scope: association.scope, status: 'ready', value: fields,
      blockedBy: [], lineage: records.map(record => ({ recordId: record.recordId, revision: record.revision, status: record.status, confirmed: record.confirmed,
        scope: record.content.scope, sourceRefs: record.content.sourceRefs, qualifications: record.content.qualifications })),
      recipeLineage: recipe.nodes.map(node => ({ id: node.id, version: node.semanticVersion, sourceRefs: node.sourceRefs, qualifications: node.qualifications })),
      comparisonLineage: [lineage], comparisonDependencies: [{ kind: 'context', id: contextId }, ...['baseline', 'current'].flatMap(side => [
        { kind: 'session', id: `syn_session_${side}` }, { kind: 'comparisonIdentity', sourceKind: 'session', sourceId: `syn_session_${side}`, itemId: `syn_occurrence_${side}` },
        { kind: 'plan', id: `syn_plan_${side}` }])] }] } });
  const inputs = payload('synthetic.accepted-input-dispositions/v1', { schema: 'synthetic.accepted-input-dispositions/v1', rows: refs.map((sourceRef, index) => ({
    inputId: `syn_input_${index}`, sourceRef, disposition: 'keep', applicabilityRevision: rev('input-applicability'), qualified: true,
    dependencyKey: { kind: 'input-disposition', ownerId: accountId, id: `syn_disposition_${index}` } })) });
  function entry<S extends EmbeddedSchema>(schema: S, id: string, value: EmbeddedPayloadsV1[S]) {
    return { blob: { id, schema, subcodecDigest: identities[schema].subcodecDigest, payloadDigest: hash('blob', value), canonicalJson: canonical(detach(value)) }, identity: identities[schema], value };
  }
  const entries = [entry('synthetic.training-feedback-analysis.pinned-v1', 'syn_evidence_read', read),
    entry('synthetic.feedback-comparison-lineage.pinned-v1', 'syn_evidence_lineage', lineage),
    entry('synthetic.comparison-witness.pinned-v2', 'syn_evidence_witness', witness),
    entry('synthetic.registration-manifest/v1', 'syn_evidence_recipe', payload('synthetic.registration-manifest/v1', recipe)),
    entry('synthetic.accepted-input-dispositions/v1', 'syn_evidence_inputs', inputs)];
  const applicabilityDigest = dependencyDigest({ accountId, recommendationId: 'syn_recommendation_fixture', recipe, change, association });
  const decisions = ['recipe-authority', 'rights', 'retention'].flatMap(kind => ['review-display', 'review-retain', 'adopt'].map(operation => ({
    schema: 'form.synthetic-policy-decision/v1', kind, realmId: 'syn_realm_fixture', issuerId: 'syn_issuer_fixture', decisionId: `syn_decision_${kind}_${operation}`,
    revision: rev('policy-decision'), revocationRevision: rev('policy-revocation', 0), accountId, recommendationId: 'syn_recommendation_fixture', operation,
    purpose: 'isolated-contract-fixture', dataCategories: ['recommendation', 'review', 'intent', 'minimal-receipt'], permittedFieldPaths: ['syntheticFixture'], applicabilityDigest, outcome: 'allow' })));
  const evidence = { schema: 'form.synthetic-evidence-closure/v1', association, ledgerRevision: rev('feedback-ledger', 2), projectionRevision: rev('feedback-projection', 3),
    records: records.map(record => ({ recordId: record.recordId, eventId: record.recordId.replace('syn_record_', 'syn_event_'), recordRevision: rev('feedback-record'),
      status: 'active', confirmed: true, acceptedLedgerRevision: rev('feedback-ledger', 2), evidenceId: 'syn_evidence_read' })), recipe,
    registry: { schema: registry.schema, version: registry.version, digest: lineage.registryDigest, selectedInputIds: [declaration.id], lineageEvidenceIds: ['syn_evidence_lineage'] },
    inputsEvidenceId: 'syn_evidence_inputs', blobs: entries.map(e => e.blob), dependencies: [{ key: { kind: 'boundary', ownerId: accountId, id: 'syn_boundary_v1' },
      revision: rev('dependency:boundary'), contentDigest: zeroDigest, state: 'current' }], decisions };
  const recommendation = { schema: 'form.training-recommendation.synthetic/v1', environment: 'synthetic-only', realmId: 'syn_realm_fixture', recommendationId: 'syn_recommendation_fixture',
    kind: 'recommendation', status: 'ready', blockedBy: [], derivationId: recipe.rootDerivationId, derivationVersion: fixtureRecipe.version, change, evidence, evidenceDigest: zeroDigest };
  const actor = { accountId, authUserId: 'syn_auth_fixture', sessionId: 'syn_auth_session', epoch: rev('account-epoch') };
  const review = { schema: 'form.training-review.synthetic/v1', reviewId: 'syn_review_fixture', recommendation, reviewingActor: actor, reviewedMeaningDigest: zeroDigest, consent: 'explicit-synthetic-review' };
  const intent = { schema: 'form.training-lineage.synthetic/v1', environment: 'synthetic-only', codec: 'form.synthetic-cjson/v1', boundary: 'source_prescription_adoption_synthetic_v1',
    operationNamespace: 'training.synthetic-lineage/v1', realmId: 'syn_realm_fixture', adoptionId: 'syn_adoption_fixture', attemptId: 'syn_attempt_fixture', originalActor: actor, review,
    action: { kind: 'adopt', consent: 'explicit-synthetic-adoption', undoOf: null } };
  const attempt = { intent, intentDigest: zeroDigest };
  const needs = [...dependencyRequirements(checkedAttempt(attempt)), ...inputs.rows.map(row => ({ kind: 'input-disposition', id: row.dependencyKey.id, value: row }))];
  evidence.dependencies = needs.map(need => ({ key: { kind: need.kind, ownerId: accountId, id: need.id }, revision: rev(`dependency:${need.kind}`),
    contentDigest: dependencyDigest(need.value), state: 'current' }));
  recommendation.evidenceDigest = hash('evidence', evidence);
  review.reviewedMeaningDigest = hash('review', { reviewId: review.reviewId, recommendation, reviewingActor: actor, consent: review.consent });
  attempt.intentDigest = hash('intent', intent);
  const complete = detach({ attempt: checkedAttempt(attempt), evidence: entries }, 2 * 1024 * 1024, true);
  // All five payloads were fully validated above; this is data refinement, not realm or authority issuance.
  return complete as Json & EmbeddedClosureInputV1;
}
