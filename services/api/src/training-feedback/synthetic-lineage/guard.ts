import type { AttemptV1, DependencyKind, EvidenceClosureV1, SourceRef } from '../../planning/synthetic-lineage/types.js';
import type { SourceReference } from '../index.js';
import type { DecodedEmbeddedEvidenceV1, EmbeddedClosureInputV1, EmbeddedPayloadsV1, EmbeddedReadonly,
  ProducerCheckedClosureV1 } from '../../planning/synthetic-lineage/subcodec-types.js';
import { detach, canonical, result, requireThat, type Json } from './strict-json.js';
import { unique, object, list } from './schema.js';
import { attemptShape } from './attempt-shape.js';
import { validateEmbedded, decodeEmbedded } from './codecs.js';
import { hash, same, dependencyDigest } from './meaning.js';
import { identities, implementationPins, implementationManifestDigest } from './source-pins.js';
import { fixtureRecipe, fixtureAfter } from './fixture-recipe.js';

type Closure = EmbeddedReadonly<EvidenceClosureV1>;
type Need = Readonly<{ kind: DependencyKind; id: string; value: unknown }>;
type ValidatedSourceReference = EmbeddedReadonly<SourceReference> | EmbeddedReadonly<SourceRef>;
type SelectedInputId = NonNullable<Closure['registry']>['selectedInputIds'][number] |
  EmbeddedPayloadsV1['synthetic.feedback-comparison-lineage.pinned-v1']['inputId'];
type OwnerAccountText = Closure['dependencies'][number]['key']['ownerId'] | Closure['association']['accountId'];
// Equality compares validated text without converting either nominal identity domain.
const ownerAccountEqual = (owner: OwnerAccountText, account: OwnerAccountText): boolean => owner === account;
function matching<T>(values: readonly T[], match: (value: T) => boolean): T {
  const found = values.filter(match); requireThat(found.length === 1, 'unresolved_reference'); return found[0]!;
}
const equal = (a: unknown, b: unknown) => requireThat(same(a, b));
const references = (refs: readonly ValidatedSourceReference[], allowed: readonly EmbeddedReadonly<SourceRef>[]) => {
  unique(refs.map(ref => canonical(detach(ref))));
  refs.forEach(ref => matching(allowed, candidate => same(candidate, ref)));
};
function graph(e: Closure, r: EmbeddedReadonly<AttemptV1>['intent']['review']['recommendation']): void {
  const recipe = e.recipe;
  requireThat(recipe.recipeId === fixtureRecipe.id && recipe.semanticVersion === fixtureRecipe.version);
  equal(recipe.executable, implementationPins.recipe);
  requireThat(recipe.implementationManifestDigest === implementationManifestDigest, 'digest_mismatch');
  equal(recipe.constants, { fixtureId: fixtureRecipe.constants.fixtureId, digest: dependencyDigest(fixtureRecipe.constants), justification: 'synthetic-nonprescriptive' });
  const nodes = recipe.nodes; unique(nodes.map(n => n.id));
  requireThat(recipe.rootDerivationId === r.derivationId && r.derivationVersion === recipe.semanticVersion);
  const root = matching(nodes, n => n.id === recipe.rootDerivationId);
  requireThat(root.kind === 'recommendation' && root.semanticVersion === r.derivationVersion);
  const visiting = new Set<string>(), visited = new Set<string>(); let edges = 0;
  function visit(id: string) {
    requireThat(!visiting.has(id), 'cycle'); if (visited.has(id)) return;
    const node = matching(nodes, n => n.id === id); visiting.add(id);
    requireThat(node.semanticVersion === fixtureRecipe.version);
    unique(node.parentIds); unique(node.sourceRecordIds); requireThat(node.parentIds.length + node.sourceRecordIds.length > 0);
    edges += node.parentIds.length; requireThat(edges <= 256, 'bounds_exceeded');
    references(node.sourceRefs, e.association.sourceRefs); requireThat(node.qualifications.length > 0);
    node.sourceRecordIds.forEach(recordId => matching(e.records, record => record.recordId === recordId));
    node.parentIds.forEach(visit); visiting.delete(id); visited.add(id);
  }
  visit(root.id); requireThat(visited.size === nodes.length, 'unresolved_reference');
  const used = new Set(nodes.flatMap(n => [...n.sourceRecordIds]));
  requireThat(used.size === e.records.length && e.records.every(rec => used.has(rec.recordId)), 'unresolved_reference');
}
function sourceChange(attempt: EmbeddedReadonly<AttemptV1>): void {
  const c = attempt.intent.review.recommendation.change;
  requireThat(!c.before.archived && c.targetPlanId === c.before.planId && c.expectedRevision.value < Number.MAX_SAFE_INTEGER);
  equal(c.expectedRevision, c.before.planRevision);
  unique(c.before.fields.items.map(i => i.id)); unique(c.after.items.map(i => i.id));
  unique(c.itemMapping.map(i => i.afterItemId)); unique(c.itemMapping.flatMap(i => i.beforeItemId === null ? [] : [i.beforeItemId]));
  requireThat(c.itemMapping.length === c.after.items.length);
  c.itemMapping.forEach((map, index) => {
    const item = c.after.items[index]!; requireThat(item.id === map.afterItemId);
    if (map.beforeItemId === null) requireThat(!c.before.fields.items.some(old => old.id === item.id));
    else {
      const before = matching(c.before.fields.items, old => old.id === map.beforeItemId);
      requireThat(before.id === item.id); equal(before.registeredDomain, item.registeredDomain);
      requireThat(before.native.exercise_id === item.native.exercise_id);
    }
  });
  // This fixed nonprescriptive implementation supports only an identity transformation.
  equal(c.after, fixtureAfter(c.before.fields));
  for (const item of [...c.before.fields.items, ...c.after.items]) {
    requireThat(item.native.exercise_id === item.registeredDomain.identity.nativeId);
    equal(item.registeredDomain.identity, { ...implementationPins.recipe, nativeId: item.native.exercise_id });
    const registration = { id: item.id, exerciseId: item.registeredDomain.exerciseId, variantId: item.registeredDomain.variantId,
      identity: item.registeredDomain.identity, native: item.native, load: item.load };
    const bytes = new TextEncoder().encode(canonical(detach(registration))).length;
    equal(item.registeredDomain.registration, { id: item.id, revision: implementationPins.recipe.revision,
      digest: dependencyDigest(registration), bytes });
    requireThat(item.registeredDomain.recordDigest === dependencyDigest(registration), 'digest_mismatch');
  }
  const action = attempt.intent.action;
  if (action.kind === 'compensate') {
    equal(action.appliedRevision, c.expectedRevision); requireThat(action.appliedAfterDigest === hash('snapshot', c.before), 'digest_mismatch');
  }
}
function checkWitness(w: EmbeddedPayloadsV1['synthetic.comparison-witness.pinned-v2'], e: Closure): void {
  requireThat(w.accountId === e.association.accountId && w.contextId === e.association.contextId);
  requireThat(w.result.status === 'comparable' && w.evidenceToken === w.result.evidenceToken && w.bindings.length === 2);
  references(w.sourceRefs, e.association.sourceRefs); requireThat(w.sourceRefs.length > 0);
  for (const [index, side] of (['baseline', 'current'] as const).entries()) {
    const input = w.inputs[side], source = w.scope[side], identity = input.identity;
    equal(input.scope.source, source);
    requireThat(identity.state === 'qualified' && identity.status === 'confirmed' && identity.current && identity.id !== null && identity.revision !== null);
    equal(w.bindings[index], { id: identity.id, revision: identity.revision, status: identity.status, current: identity.current });
    const join = matching(e.association.joins, j => j.sourceKind === source.kind && j.sourceId === source.id && j.occurrenceId === source.itemId);
    requireThat(join.sourceRevision.value === source.revision && join.identityId === identity.id && join.identityRevision.value === identity.revision);
    requireThat(input.scope.exercise !== null);
    if (input.scope.session !== null) {
      const session = input.scope.session;
      requireThat(join.historicalPlan !== null && join.historicalPlan.planId === session.planId && join.historicalPlan.planRevision.value === session.planRevision);
      requireThat(session.occurrence !== null && session.occurrence.id === join.occurrenceId && session.occurrence.itemId === join.itemId);
      requireThat(session.occurrence.exerciseId === input.scope.exercise.id);
    } else requireThat(join.historicalPlan === null);
    const summary = w.result[side]; unique(summary.loads.map(l => l.setId));
    requireThat(summary.confirmedSets === summary.loads.length && summary.loads.length > 0);
    requireThat(summary.loads.every(load => load.repetitions > 0));
    requireThat(summary.repetitions === summary.loads.reduce((sum, load) => sum + load.repetitions, 0));
    const nulls = summary.loads.filter(l => l.kg === null).length;
    requireThat(nulls === 0 || nulls === summary.loads.length);
    equal(summary.volumeKgRepetitions, nulls ? null : summary.loads.reduce((sum, load) => sum + load.repetitions * load.kg!, 0));
    if (join.set !== null) matching(summary.loads, load => load.setId === join.set!.id);
  }
  requireThat(!same(w.scope.baseline, w.scope.current));
  equal(w.result.delta, { confirmedSets: w.result.current.confirmedSets - w.result.baseline.confirmedSets,
    repetitions: w.result.current.repetitions - w.result.baseline.repetitions,
    volumeKgRepetitions: w.result.baseline.volumeKgRepetitions === null || w.result.current.volumeKgRepetitions === null ? null :
      w.result.current.volumeKgRepetitions - w.result.baseline.volumeKgRepetitions });
}
function checkLineage(l: EmbeddedPayloadsV1['synthetic.feedback-comparison-lineage.pinned-v1'], e: Closure,
  witnesses: readonly EmbeddedPayloadsV1['synthetic.comparison-witness.pinned-v2'][]): void {
  requireThat(e.registry !== null && l.registryVersion === e.registry.version && l.registryDigest === e.registry.digest);
  matching(e.recipe.nodes, n => n.id === l.recipeId && n.semanticVersion === l.recipeVersion);
  requireThat(l.blockedBy.length === 0 && l.declaration !== null && l.producer !== null && l.producer.status === 'observed' &&
    l.association !== null && l.association.status === 'associated');
  requireThat(l.declaration.id === l.inputId && l.declaration.contextId === e.association.contextId);
  const w = l.producer.witness; matching(witnesses, other => same(other, w)); checkWitness(w, e);
  for (const side of ['baseline', 'current'] as const) {
    const s = w.scope[side]; equal(l.declaration.selections[side], { kind: s.kind, id: s.id, itemId: s.itemId });
    const join = matching(e.association.joins, j => j.sourceKind === s.kind && j.sourceId === s.id && j.occurrenceId === s.itemId);
    requireThat(join.associationEvidenceDigest === dependencyDigest(l.association), 'digest_mismatch');
  }
  references(l.association.sourceRefs, e.association.sourceRefs); requireThat(l.association.sourceRefs.length > 0);
}
function checkRead(read: EmbeddedPayloadsV1['synthetic.training-feedback-analysis.pinned-v1'], e: Closure,
  attempt: EmbeddedReadonly<AttemptV1>, lineages: readonly EmbeddedPayloadsV1['synthetic.feedback-comparison-lineage.pinned-v1'][]): void {
  const a = e.association, view = read.result, recommendation = attempt.intent.review.recommendation;
  requireThat(read.analysis.contextId === a.contextId && read.analysis.profileRevision === a.profileRevision.value && read.analysis.preferencesRevision === a.preferencesRevision.value);
  requireThat(view.ledgerRevision === e.ledgerRevision.value && view.projectionRevision === e.projectionRevision.value);
  unique(view.records.map(r => r.recordId)); unique(view.sources.map(s => s.recordId)); unique(view.derivations.map(d => d.id));
  requireThat(view.records.length === e.records.length && view.sources.length === e.records.length && view.derivations.length === e.recipe.nodes.length);
  for (const r of e.records) {
    const record = matching(view.records, v => v.recordId === r.recordId);
    requireThat(record.revision === r.recordRevision.value && record.status === 'active' && r.status === 'active' && record.confirmed && r.confirmed && record.content !== null);
    requireThat(r.acceptedLedgerRevision.value <= e.ledgerRevision.value);
    const content = record.content;
    requireThat(content.scope.contextId === a.contextId && content.qualifications.length > 0);
    references(content.sourceRefs, a.sourceRefs);
    if (a.scope.kind === 'session') requireThat(content.scope.kind === 'session' && content.scope.sessionId === a.scope.sessionId);
    if (a.scope.kind === 'activity') requireThat(false, 'context_mismatch'); // Existing feedback scopes cannot prove an Activity association.
    const source = matching(view.sources, v => v.recordId === r.recordId);
    requireThat(source.state === 'current' && source.binding !== null); const b = source.binding;
    equal(b.scope, content.scope);
    const witness = b.witness;
    requireThat(witness.contextId === a.contextId && witness.profileRevision === a.profileRevision.value && witness.preferencesRevision === a.preferencesRevision.value);
    requireThat(witness.targetPlan !== null); equal(witness.targetPlan, { id: recommendation.change.before.planId, revision: recommendation.change.before.planRevision.value, archived: false });
    if (content.scope.kind === 'session') {
      requireThat(witness.sessionSource !== null && b.selection !== null);
      const session = witness.sessionSource, s = session.source;
      const join = matching(a.joins, j => j.sourceKind === 'session' && j.sourceId === s.id && j.occurrenceId === s.itemId);
      requireThat(s.accountId === a.accountId && s.id === content.scope.sessionId && s.revision === join.sourceRevision.value);
      requireThat(b.selection.sessionId === s.id && b.selection.occurrenceId === join.occurrenceId);
      equal(session.occurrence, { id: join.occurrenceId, itemId: join.itemId, exerciseId: session.occurrence.exerciseId });
      requireThat(join.historicalPlan !== null);
      equal(session.planSnapshot, { planId: join.historicalPlan.planId, planRevision: join.historicalPlan.planRevision.value });
      requireThat(content.scope.planId === join.historicalPlan.planId);
      if (join.set !== null) {
        const set = matching(session.sets, v => v.id === join.set!.id);
        requireThat(set.revision === join.set.revision.value && set.status === 'confirmed');
      }
      requireThat(session.sets.every(set => set.status === 'confirmed'));
    } else requireThat(b.selection === null && witness.sessionSource === null);
  }
  for (const derived of view.derivations) {
    const node = matching(e.recipe.nodes, n => n.id === derived.id);
    requireThat(derived.version === node.semanticVersion && derived.kind === node.kind && derived.status === 'ready' && derived.blockedBy.length === 0);
    requireThat(derived.scope.contextId === a.contextId);
    const ancestors = new Set<string>(), records = new Set<string>();
    function visit(id: string) { if (ancestors.has(id)) return; ancestors.add(id); const n = matching(e.recipe.nodes, n => n.id === id);
      n.sourceRecordIds.forEach(v => records.add(v)); n.parentIds.forEach(visit); }
    visit(node.id);
    unique(derived.lineage.map(l => l.recordId)); requireThat(derived.lineage.length === records.size);
    for (const l of derived.lineage) {
      requireThat(records.has(l.recordId)); const record = matching(view.records, r => r.recordId === l.recordId);
      requireThat(record.content !== null);
      equal(l, { recordId: record.recordId, revision: record.revision, status: record.status, confirmed: record.confirmed,
        scope: record.content.scope, sourceRefs: record.content.sourceRefs, qualifications: record.content.qualifications });
    }
    unique(derived.recipeLineage.map(l => l.id)); requireThat(derived.recipeLineage.length === ancestors.size);
    for (const l of derived.recipeLineage) {
      requireThat(ancestors.has(l.id)); const n = matching(e.recipe.nodes, n => n.id === l.id);
      equal(l, { id: n.id, version: n.semanticVersion, sourceRefs: n.sourceRefs, qualifications: n.qualifications });
    }
    for (const l of derived.comparisonLineage) matching(lineages, other => same(other, l));
    if (node.id === recommendation.derivationId) {
      equal(derived.value, recommendation.change.after); equal(derived.comparisonLineage, lineages);
    }
    unique(derived.comparisonDependencies.map(v => canonical(detach(v))));
    const expected = new Map<string, unknown>(); const add = (v: unknown) => expected.set(canonical(detach(v)), v);
    for (const l of derived.comparisonLineage) {
      requireThat(l.declaration !== null && l.producer?.status === 'observed');
      add({ kind: 'context', id: l.declaration.contextId });
      for (const side of ['baseline', 'current'] as const) {
        const s = l.declaration.selections[side]; add({ kind: s.kind, id: s.id });
        add({ kind: 'comparisonIdentity', sourceKind: s.kind, sourceId: s.id, itemId: s.itemId });
        const session = l.producer.witness.inputs[side].scope.session;
        if (session) add({ kind: 'plan', id: session.planId });
      }
    }
    requireThat(derived.comparisonDependencies.length === expected.size);
    derived.comparisonDependencies.forEach(v => requireThat(expected.has(canonical(detach(v)))));
  }
}

/** Exact fake token preimages; trusted composition must independently supply generations/currentness. */
export function dependencyRequirements(attempt: EmbeddedReadonly<AttemptV1>): readonly Need[] {
  const r = attempt.intent.review.recommendation, e = r.evidence, a = e.association;
  const needs: Need[] = [], seen = new Map<string, unknown>();
  const add = (kind: DependencyKind, id: string, value: unknown) => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) { equal(seen.get(key), value); return; }
    seen.set(key, value); needs.push({ kind, id, value });
  };
  add('context', a.contextId, a.scope); add('profile', a.contextId, a.profileRevision); add('preferences', a.contextId, a.preferencesRevision);
  add('association', a.contextId, a); add('target-plan', r.change.targetPlanId, r.change.before);
  add('ledger', a.contextId, e.ledgerRevision); add('projection', a.contextId, e.projectionRevision);
  a.sourceRefs.forEach(ref => add('source', ref.sourceId, ref));
  a.joins.forEach(j => {
    add(j.sourceKind, j.sourceId, { sourceId: j.sourceId, revision: j.sourceRevision });
    add(j.sourceKind === 'session' ? 'session-item' : 'activity-item', j.occurrenceId,
      { sourceId: j.sourceId, occurrenceId: j.occurrenceId, itemId: j.itemId, revision: j.itemRevision });
    if (j.set) add(j.sourceKind === 'session' ? 'session-set' : 'activity-set', j.set.id, j.set);
    if (j.historicalPlan) add('historical-plan', j.historicalPlan.planId, j.historicalPlan);
    add('comparison-identity', j.identityId, { id: j.identityId, revision: j.identityRevision });
  });
  e.records.forEach(record => add('feedback-record', record.recordId, record));
  r.change.after.items.forEach(item => add('catalog-row', item.id, item.registeredDomain));
  add('recipe', e.recipe.recipeId, e.recipe); add('executable', e.recipe.recipeId, e.recipe.executable);
  add('constants', e.recipe.constants.fixtureId, e.recipe.constants);
  if (e.registry) add('registry', e.recipe.recipeId, e.registry);
  e.decisions.forEach(d => add(d.kind, d.decisionId, d));
  add('schema', 'syn_schema_v1', { recommendation: r.schema, evidence: e.schema, intent: attempt.intent.schema,
    embedded: Object.keys(identities).sort() });
  add('codec', 'syn_codec_v1', { codec: attempt.intent.codec, identities, guard: implementationPins.guard });
  add('boundary', 'syn_boundary_v1', { boundary: attempt.intent.boundary, namespace: attempt.intent.operationNamespace });
  return needs;
}

export function validateClosure(input: EmbeddedClosureInputV1) {
  return result(() => {
    // No caller-owned aliases survive. Full outer shape is rechecked for guard safety, without implementing an outer byte codec.
    const owned = detach(input, 2 * 1024 * 1024, true);
    object(owned, { attempt: attemptShape, evidence: list(value => { object(value, {
      blob: () => {}, identity: () => {}, value: () => {},
    }); }, 1, 64) });
    const checked = owned as Json & EmbeddedClosureInputV1;
    const attempt = checked.attempt, intent = attempt.intent, review = intent.review, r = review.recommendation, e = r.evidence, a = e.association;
    equal(intent.originalActor, review.reviewingActor);
    requireThat(intent.realmId === r.realmId && intent.originalActor.accountId === a.accountId && a.scope.contextId === a.contextId);
    sourceChange(attempt); graph(e, r);
    unique(e.records.map(v => v.recordId)); unique(e.records.map(v => v.eventId)); unique(e.blobs.map(v => v.id));
    unique(a.sourceRefs.map(v => v.sourceId)); unique(a.joins.map(v => `${v.sourceKind}:${v.sourceId}:${v.occurrenceId}`));
    unique(a.joins.map(v => v.identityId));
    requireThat(checked.evidence.length === e.blobs.length);
    let totalBytes = 0;
    const decoded: DecodedEmbeddedEvidenceV1[] = [];
    for (const entry of checked.evidence) {
      const blob = matching(e.blobs, b => b.id === entry.blob.id); equal(blob, entry.blob);
      equal(entry.identity, identities[blob.schema]);
      requireThat(blob.subcodecDigest === identities[blob.schema].subcodecDigest, 'digest_mismatch');
      const bytes = new TextEncoder().encode(blob.canonicalJson); totalBytes += bytes.length;
      requireThat(totalBytes <= 1024 * 1024, 'bounds_exceeded');
      const payload = decodeEmbedded(blob.schema, bytes); requireThat(payload.ok, payload.ok ? 'wrong_type' : payload.error.code);
      const valid = validateEmbedded(blob.schema, entry.value); requireThat(valid.ok, valid.ok ? 'wrong_type' : valid.error.code);
      equal(payload.value, valid.value); requireThat(blob.canonicalJson === canonical(detach(payload.value)), 'bad_json');
      requireThat(blob.payloadDigest === hash('blob', payload.value), 'digest_mismatch');
      decoded.push(entry);
    }
    unique(decoded.map(d => d.blob.id));
    function values<S extends keyof EmbeddedPayloadsV1>(schema: S): EmbeddedPayloadsV1[S][] {
      // The discriminated union is preserved by the fixed schema equality above and the complete matching decoder.
      return decoded.filter(d => d.blob.schema === schema).map(d => d.value as EmbeddedPayloadsV1[S]);
    }
    const reads = values('synthetic.training-feedback-analysis.pinned-v1'); requireThat(reads.length === 1, 'unresolved_reference');
    const manifests = values('synthetic.registration-manifest/v1'); requireThat(manifests.length === 1, 'unresolved_reference'); equal(manifests[0], e.recipe);
    const manifestEntry = matching(decoded, d => d.blob.id === e.recipe.registrationEvidenceId);
    requireThat(manifestEntry.blob.schema === 'synthetic.registration-manifest/v1');
    e.records.forEach(record => requireThat(matching(decoded, d => d.blob.id === record.evidenceId).blob.schema === 'synthetic.training-feedback-analysis.pinned-v1'));
    const inputs = values('synthetic.accepted-input-dispositions/v1'); requireThat(inputs.length === 1, 'unresolved_reference');
    requireThat(matching(decoded, d => d.blob.id === e.inputsEvidenceId).blob.schema === 'synthetic.accepted-input-dispositions/v1');
    const lineages = values('synthetic.feedback-comparison-lineage.pinned-v1'), witnesses = values('synthetic.comparison-witness.pinned-v2');
    requireThat(e.registry !== null && lineages.length > 0 && witnesses.length > 0);
    unique(e.registry.selectedInputIds); unique(e.registry.lineageEvidenceIds); unique(lineages.map(l => l.inputId));
    requireThat(e.registry.selectedInputIds.length === lineages.length && e.registry.lineageEvidenceIds.length === lineages.length);
    const selectedInputIds: readonly SelectedInputId[] = e.registry.selectedInputIds;
    lineages.forEach(l => { requireThat(selectedInputIds.includes(l.inputId)); checkLineage(l, e, witnesses); });
    e.registry.lineageEvidenceIds.forEach((id, index) => {
      const entry = matching(decoded, d => d.blob.id === id);
      requireThat(entry.blob.schema === 'synthetic.feedback-comparison-lineage.pinned-v1'); equal(entry.value, lineages[index]);
      requireThat(lineages[index]!.inputId === e.registry!.selectedInputIds[index]);
    });
    witnesses.forEach(w => { checkWitness(w, e); matching(lineages, l => l.producer?.status === 'observed' && same(l.producer.witness, w)); });
    const declarations = lineages.map(l => l.declaration);
    // Registry declaration digest follows the pinned ledger producer's binary-key canonical JSON, without a new wrapper domain.
    requireThat(e.registry.digest === registryDigest({ schema: e.registry.schema, version: e.registry.version, inputs: declarations }), 'digest_mismatch');
    checkRead(reads[0]!, e, attempt, lineages);
    const usedJoins = new Set(witnesses.flatMap(w => [w.scope.baseline, w.scope.current]).map(s => `${s.kind}:${s.id}:${s.itemId}`));
    requireThat(usedJoins.size === a.joins.length && a.joins.every(j => usedJoins.has(`${j.sourceKind}:${j.sourceId}:${j.occurrenceId}`)));
    const dispositionRows = inputs[0]!.rows; unique(dispositionRows.map(row => row.inputId));
    unique(dispositionRows.map(row => canonical(detach(row.dependencyKey))));
    requireThat(dispositionRows.length === a.sourceRefs.length);
    const needs = [...dependencyRequirements(attempt)];
    for (const row of dispositionRows) {
      requireThat(row.disposition === 'keep' && row.qualified && ownerAccountEqual(row.dependencyKey.ownerId, a.accountId));
      matching(a.sourceRefs, ref => same(ref, row.sourceRef));
      needs.push({ kind: 'input-disposition', id: row.dependencyKey.id, value: row });
    }
    unique(dispositionRows.map(row => row.sourceRef.sourceId));
    unique(e.dependencies.map(token => canonical(detach(token.key))));
    requireThat(needs.length === e.dependencies.length, 'unresolved_reference');
    for (const need of needs) {
      const token = matching(e.dependencies, t => t.key.kind === need.kind && ownerAccountEqual(t.key.ownerId, a.accountId) && t.key.id === need.id);
      requireThat(token.state === 'current' && token.contentDigest === dependencyDigest(need.value), 'digest_mismatch');
    }
    unique(e.decisions.map(d => d.decisionId));
    const applicable = dependencyDigest({ accountId: a.accountId, recommendationId: r.recommendationId, recipe: e.recipe,
      change: r.change, association: a });
    for (const d of e.decisions) {
      requireThat(d.realmId === r.realmId && d.accountId === a.accountId && d.recommendationId === r.recommendationId && d.purpose === 'isolated-contract-fixture');
      requireThat(d.outcome === 'allow' && d.applicabilityDigest === applicable);
      unique(d.dataCategories); unique(d.permittedFieldPaths);
    }
    for (const kind of ['recipe-authority', 'rights', 'retention'] as const) {
      for (const operation of ['review-display', 'review-retain', intent.action.kind] as const) matching(e.decisions, d => d.kind === kind && d.operation === operation);
    }
    requireThat(r.evidenceDigest === hash('evidence', e), 'digest_mismatch');
    requireThat(review.reviewedMeaningDigest === hash('review', { reviewId: review.reviewId, recommendation: r, reviewingActor: review.reviewingActor, consent: review.consent }), 'digest_mismatch');
    requireThat(attempt.intentDigest === hash('intent', intent), 'digest_mismatch');
    const validated: EmbeddedClosureInputV1 = checked;
    // This brand asserts local consistency only. No realm/frame membership, policy authority, live currentness or effect is issued.
    return validated as ProducerCheckedClosureV1;
  });
}
import { createHash } from 'node:crypto';
export function registryDigest(value: unknown): string { return createHash('sha256').update(canonical(detach(value))).digest('hex'); }
