import { z } from 'zod';
import { strictJson } from '../../runtime-modules/configuration.js';
import { evidenceCanonical, evidenceDigest, evidenceIdSchema } from '../evidence-codec.js';
import { appendCompletionFact, createCompletionHistory, type CompletionFact, type CompletionTarget } from '../completion.js';
import type { RestrictedReference } from './types.js';

const id = evidenceIdSchema, shortId = id.max(128), digest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().safe(), positive = counter.min(1);
export const providerBindingSchema = z.object({ requestId: id, accountId: id, authUserId: id, epoch: positive, sequence: positive,
  databaseGeneration: digest, schemaDigest: digest, cohort: z.literal('provider-revocation-v1'), checkpoint: z.object({
    authorityId: id, ledgerSchemaDigest: digest, revision: counter, committedSequence: positive, committedHeadDigest: digest }).strict() }).strict();
export const intentSchema = z.object({ intent_id: shortId, request_id: id, account_id: id, auth_user_id: id,
  source_account_row_id: id, provider: id.max(64), subject_digest: digest, client_binding_id: id.nullable(), client_digest: digest.nullable(),
  token_kind: z.enum(['refresh_token', 'access_token']).nullable(), reference_version: digest.nullable(),
  material_state: z.enum(['captured', 'unavailable']), residual_code: z.enum(['unsupported_provider', 'material_missing',
    'client_binding_unavailable', 'token_provenance_unavailable', 'material_invalid']).nullable(),
  lifecycle_epoch: positive, suppression_sequence: positive, database_generation: digest, schema_digest: digest, authority_id: id,
  ledger_schema_digest: digest, checkpoint_revision: counter, checkpoint_sequence: positive, checkpoint_head_digest: digest,
  policy_version: id, proof_digest: digest, created_at_ms: counter, payload_digest: digest }).strict();
export type ProviderIntent = z.infer<typeof intentSchema>;
export const referenceFor = (i: ProviderIntent): RestrictedReference => Object.freeze({ sourceAccountRowId: i.source_account_row_id,
  authUserId: i.auth_user_id, provider: i.provider, subjectDigest: i.subject_digest, clientBindingId: i.client_binding_id,
  clientDigest: i.client_digest, tokenKind: i.token_kind, referenceVersion: i.reference_version, materialState: i.material_state, residualCode: i.residual_code });
export const intentCheckpoint = (i: ProviderIntent) => ({ authorityId: i.authority_id, ledgerSchemaDigest: i.ledger_schema_digest,
  revision: i.checkpoint_revision, committedSequence: i.checkpoint_sequence, committedHeadDigest: i.checkpoint_head_digest });
export function intentIdentity(i: Omit<ProviderIntent, 'intent_id' | 'payload_digest'>): string {
  return evidenceDigest([i.material_state === 'captured' ? 'provider-intent-v1' : 'provider-unavailable-v1', i.request_id,
    i.account_id, i.auth_user_id, i.source_account_row_id, i.provider, i.subject_digest, i.client_binding_id, i.client_digest,
    i.token_kind, i.reference_version, i.residual_code]);
}
export function parseIntent(input: unknown): ProviderIntent {
  const i = intentSchema.parse(input), { payload_digest, ...payload } = i;
  if (payload_digest !== evidenceDigest(payload) || i.intent_id !== intentIdentity(i) || i.checkpoint_sequence < i.suppression_sequence ||
    (i.material_state === 'captured' ? i.provider !== 'apple' || i.client_binding_id === null || i.client_digest === null ||
      i.token_kind === null || i.reference_version === null || i.residual_code !== null
      : i.token_kind !== null || i.reference_version !== null || i.residual_code === null)) throw new Error('provider_intent_invalid');
  return Object.freeze(i);
}
export function providerTarget(i: ProviderIntent): CompletionTarget & { kind: 'provider' } {
  if (i.material_state !== 'captured' || !i.client_digest || !i.reference_version) throw new Error('provider_target_unavailable');
  return Object.freeze({ kind: 'provider', provider: i.provider, clientDigest: i.client_digest,
    subjectDigest: i.subject_digest, referenceVersion: i.reference_version });
}
const target = z.object({ kind: z.literal('provider'), provider: id.max(64), clientDigest: digest, subjectDigest: digest, referenceVersion: digest }).strict();
const common = { operationId: shortId, binding: providerBindingSchema, target, resolves: z.array(shortId).max(32) };
const fact = z.discriminatedUnion('status', [z.object({ ...common, status: z.literal('qualifying'), witness: z.object({
  kind: z.literal('provider_revocation_acknowledgment'), evidenceDigest: digest, observedAtMs: counter }).strict() }).strict(),
  z.object({ ...common, status: z.enum(['unknown', 'unavailable']), witness: z.null() }).strict()]);
export function encodeProviderFact(input: unknown): string {
  const value = fact.parse(input);
  const checked = appendCompletionFact(createCompletionHistory(value.binding), value as CompletionFact).history.facts[0]!;
  const bytes = evidenceCanonical(checked);
  if (Buffer.byteLength(bytes) > 16384) throw new Error('provider_fact_invalid');
  return bytes;
}
export function decodeProviderFact(bytes: string): CompletionFact {
  if (Buffer.byteLength(bytes) > 16384) throw new Error('provider_fact_invalid');
  const value = strictJson(bytes);
  if (encodeProviderFact(value) !== bytes) throw new Error('provider_fact_invalid');
  return fact.parse(value) as CompletionFact;
}
export const attemptSchema = z.object({ attempt_id: shortId, intent_id: shortId, ordinal: positive.max(3),
  binding_json: z.string().max(16384), binding_digest: digest, state: z.enum(['preparing', 'in_flight', 'acknowledged', 'unknown', 'no_effect']),
  revision: counter.max(2), started_at_ms: counter, deadline_at_ms: counter, dispatch_at_ms: counter.nullable(), finished_at_ms: counter.nullable(),
  outcome_code: z.enum(['apple_ack', 'material_unavailable', 'reference_changed', 'currentness_changed', 'cancelled_before_dispatch',
    'preparation_expired', 'transport_unknown', 'provider_error', 'response_invalid', 'ack_commit_unknown']).nullable(),
  protocol_status: z.number().int().min(100).max(599).nullable(), result_fact_json: z.string().max(16384).nullable() }).strict();
export type ProviderAttempt = z.infer<typeof attemptSchema>;
export function parseAttempt(input: unknown, intent: ProviderIntent): ProviderAttempt {
  const a = attemptSchema.parse(input), b = providerBindingSchema.parse(strictJson(a.binding_json));
  if (a.intent_id !== intent.intent_id || evidenceCanonical(b) !== a.binding_json || evidenceDigest(b) !== a.binding_digest ||
    b.requestId !== intent.request_id || b.accountId !== intent.account_id || b.authUserId !== intent.auth_user_id ||
    b.epoch !== intent.lifecycle_epoch || b.sequence !== intent.suppression_sequence || b.databaseGeneration !== intent.database_generation ||
    b.schemaDigest !== intent.schema_digest || b.checkpoint.authorityId !== intent.authority_id || b.checkpoint.ledgerSchemaDigest !== intent.ledger_schema_digest ||
    b.checkpoint.revision < intent.checkpoint_revision || b.checkpoint.committedSequence < intent.checkpoint_sequence ||
    a.deadline_at_ms <= a.started_at_ms || a.deadline_at_ms > a.started_at_ms + 10000 || a.started_at_ms < intent.created_at_ms ||
    (a.dispatch_at_ms !== null && (a.dispatch_at_ms < a.started_at_ms || a.dispatch_at_ms >= a.deadline_at_ms)) ||
    (a.finished_at_ms !== null && a.finished_at_ms < (a.dispatch_at_ms ?? a.started_at_ms))) throw new Error('provider_attempt_invalid');
  if (a.state === 'preparing' || a.state === 'in_flight') {
    if (a.revision !== (a.state === 'preparing' ? 0 : 1) || (a.dispatch_at_ms === null) !== (a.state === 'preparing') ||
      a.finished_at_ms !== null || a.outcome_code !== null || a.protocol_status !== null || a.result_fact_json !== null) throw new Error('provider_attempt_invalid');
  } else {
    if (!a.result_fact_json || a.finished_at_ms === null || a.outcome_code === null) throw new Error('provider_attempt_invalid');
    const f = decodeProviderFact(a.result_fact_json);
    const { checkpoint: oldCheckpoint, ...oldBinding } = b;
    const { checkpoint: factCheckpoint, ...factBinding } = f.binding;
    if (f.operationId !== a.attempt_id || evidenceCanonical(f.target) !== evidenceCanonical(providerTarget(intent)) ||
      evidenceCanonical(factBinding) !== evidenceCanonical(oldBinding) || factCheckpoint.authorityId !== oldCheckpoint.authorityId ||
      factCheckpoint.ledgerSchemaDigest !== oldCheckpoint.ledgerSchemaDigest || factCheckpoint.revision < oldCheckpoint.revision ||
      factCheckpoint.committedSequence < oldCheckpoint.committedSequence || f.status !== (a.state === 'acknowledged' ? 'qualifying' : a.state === 'no_effect' ? 'unavailable' : 'unknown') ||
      (a.state === 'no_effect' ? a.revision !== 1 || a.dispatch_at_ms !== null || a.protocol_status !== null ||
        !['material_unavailable', 'reference_changed', 'currentness_changed', 'cancelled_before_dispatch', 'preparation_expired'].includes(a.outcome_code)
        : a.revision !== 2 || a.dispatch_at_ms === null) ||
      (a.state === 'unknown' && !['transport_unknown', 'provider_error', 'response_invalid', 'ack_commit_unknown', 'currentness_changed'].includes(a.outcome_code)) ||
      (a.state === 'acknowledged' && (a.outcome_code !== 'apple_ack' || a.protocol_status !== 200 || a.finished_at_ms > a.deadline_at_ms ||
        f.status !== 'qualifying' || f.witness.observedAtMs !== a.finished_at_ms || f.witness.evidenceDigest !==
          evidenceDigest(['apple-revoke-ack-v1', intent.payload_digest, a.attempt_id, f.binding, f.target, a.finished_at_ms, 200])))) throw new Error('provider_attempt_invalid');
  }
  return Object.freeze(a);
}
