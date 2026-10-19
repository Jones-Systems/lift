import { FALLBACK_POLICY, produceFallbackCandidate, sourcePrescriptionKey } from '../../../src/planning/first-plan/index.ts';
import { createRegisteredNativeCatalogFactory } from '../../../src/catalog-qualification/registered-identity.ts';
import { readFileSync } from 'node:fs';

const root = new URL('../../../../../', import.meta.url);
const pin = { id: 'form-native-engine-registration-candidate', revision: '442c5cd07f14142326af10fe0eb6d079b0e62a71-v1',
  digest: 'c326ccbba03fcc1fe5807d20811e7cd57b87be4c2ebf0361e922028e7bb131ed', bytes: 77470 };
const registrationBytes = readFileSync(new URL('docs/knowledge/catalog-cues/registrations/native-engine-v1.candidate.json', root));
const legacyBytes = readFileSync(new URL('sources/businesslessons/core/research/form-knowledge-campaign-2026-10-01/inventory/legacy-movement-engine.json', root));
const catalog = createRegisteredNativeCatalogFactory([pin])({ legacyBytes, registrationBytes });
const entries = JSON.parse(registrationBytes.toString('utf8')).entries;
const ids = ['bodyweight-squat', 'wall-push-up', 'chest-supported-machine-row', 'dead-bug'];

// Recipe and pinned records are real; active-row projections and eligible constraints are synthetic, with no database or R1 claim.
export function sourceFixture() {
  const context = {
    accountId: 'account-a',
    profile: { revision: 4, goals: ['strength'], trainingBackground: 'returning', injuryHistory: '', trainingContext: 'Confirmed text' },
    preferences: { revision: 2, equipment: ['bodyweight', 'wall', 'machine'], sessionMinutes: 25, trainingDaysPerWeek: 2 },
  };
  const confirmation = { accountId: 'account-a', profileRevision: 4, preferencesRevision: 2 };
  const request = {
    context, confirmation, policy: { qualification: 'qualified', source: structuredClone(FALLBACK_POLICY.source) },
    registration: { pin: { ...pin }, bindings: ids.map(nativeId => {
      const entry = entries.find(row => row.sourceIdentity.nativeId === nativeId);
      const record = catalog.getRegisteredRecord(entry.exerciseId);
      return structuredClone(catalog.bindRegisteredDomainExercise({ nativeId, exerciseId: entry.exerciseId, active: {
        exerciseId: entry.exerciseId, embeddedId: record.id, recordDigest: entry.recordDigest, retired: false,
        registration: { id: pin.id, revision: pin.revision, digest: pin.digest },
        sourceIdentity: record.provenance.sourceIdentity, catalogRevision: pin.revision, currentness: 'current',
      } }));
    }) },
  };
  const produced = produceFallbackCandidate(request);
  if (produced.status !== 'produced') throw new Error('Fixture did not produce a candidate');
  const candidate = structuredClone(produced.candidate);
  const evidenceSource = { id: 'synthetic-authority', revision: 'fixture-1', locator: 'fixture:source-fixture.mjs',
    currentness: 'current', qualification: 'synthetic mechanics only' };
  const calls = [];
  const ports = {
    qualifyCatalog(input) {
      calls.push(['catalog', input]);
      return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified', source: evidenceSource,
        items: input.candidate.plan.items.map(item => ({ itemId: item.id, exerciseId: item.registeredDomain.exerciseId,
          variantId: item.registeredDomain.variantId, prescriptionKey: sourcePrescriptionKey(item), retired: false, source: evidenceSource })) };
    },
    evaluateConstraints(input) {
      calls.push(['constraints', input]);
      return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'eligible', source: evidenceSource,
        reasons: [], rules: [], evidence: { schema: 'synthetic-constraint-evidence/v1', value: { applied: false } } };
    },
  };
  return { request, context, confirmation, candidate, ports, calls, selection: { context, confirmation, candidates: [candidate] } };
}
