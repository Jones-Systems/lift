import { createHash } from 'node:crypto';
import { z } from 'zod';
import { strictJson } from '../runtime-modules/configuration.js';
import { appendCompletionFact, createCompletionHistory, type CompletionFact } from './completion.js';

export const evidenceIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().safe();
const positive = counter.min(1);
const identity = z.object({ requestId: evidenceIdSchema, accountId: evidenceIdSchema, authUserId: evidenceIdSchema, epoch: positive, sequence: positive }).strict();
const binding = identity.extend({ databaseGeneration: evidenceIdSchema, schemaDigest: digest, cohort: z.literal('lifecycle-evidence-v1'),
  checkpoint: z.object({ authorityId: evidenceIdSchema, ledgerSchemaDigest: digest, revision: counter,
    committedSequence: positive, committedHeadDigest: digest }).strict() }).strict();
const target = z.discriminatedUnion('kind', [z.object({ kind: z.literal('category'), category: evidenceIdSchema }).strict(),
  z.object({ kind: z.literal('provider'), provider: evidenceIdSchema, clientDigest: digest, subjectDigest: digest, referenceVersion: evidenceIdSchema }).strict(),
  z.object({ kind: z.literal('backup'), inventoryDigest: digest, policyVersion: evidenceIdSchema }).strict()]);
const witness = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local_purge_readback'), evidenceDigest: digest, observedAtMs: counter }).strict(),
  z.object({ kind: z.literal('provider_revocation_acknowledgment'), evidenceDigest: digest, observedAtMs: counter }).strict(),
  z.object({ kind: z.literal('backup_disposition'), disposition: z.enum(['destruction_witnessed', 'expiry_witnessed']),
    evidenceDigest: digest, observedAtMs: counter, inventoryWitnessDigest: digest }).strict(),
]);
const common = { operationId: evidenceIdSchema, binding, target, resolves: z.array(evidenceIdSchema).max(32) };
const fact = z.discriminatedUnion('status', [z.object({ ...common, status: z.literal('qualifying'), witness }).strict(),
  z.object({ ...common, status: z.enum(['unknown', 'pending', 'unavailable', 'retained', 'not_qualifying', 'conflicting']), witness: z.null() }).strict()]);
export const evidenceOperationSchema = identity.extend({ operationId: evidenceIdSchema, purpose: z.literal('local_purge'),
  scopeDigest: digest, proofDigest: digest, policyVersion: evidenceIdSchema, createdAtMs: counter }).strict();
export type EvidenceOperation = z.infer<typeof evidenceOperationSchema>;
const envelope = z.object({ version: z.literal(1), evidenceId: evidenceIdSchema, attemptId: evidenceIdSchema,
  observedAtMs: counter, policyVersion: evidenceIdSchema, fact }).strict();
export type DurableEvidence = z.infer<typeof envelope>;

export function evidenceCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(evidenceCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${evidenceCanonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const evidenceDigest = (value: unknown): string => createHash('sha256').update(evidenceCanonical(value)).digest('hex');
function invalid(): never { throw new Error('lifecycle_evidence_codec_invalid'); }
export function encodeDurableEvidence(input: unknown): string {
  try {
    const parsed = envelope.parse(input);
    if (parsed.fact.operationId !== parsed.evidenceId) invalid();
    if (parsed.fact.status === 'qualifying' && (parsed.fact.witness.kind === 'local_purge_readback'
      ? parsed.fact.witness.observedAtMs > parsed.observedAtMs
      : parsed.fact.witness.observedAtMs !== parsed.observedAtMs)) invalid();
    const validated = appendCompletionFact(createCompletionHistory(parsed.fact.binding), parsed.fact as CompletionFact).history.facts[0]!;
    const bytes = evidenceCanonical({ ...parsed, fact: validated });
    if (Buffer.byteLength(bytes) > 16384) invalid();
    return bytes;
  } catch { return invalid(); }
}
export function decodeDurableEvidence(bytes: unknown): DurableEvidence {
  try {
    if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > 16384) invalid();
    const parsed: unknown = strictJson(bytes);
    if (encodeDurableEvidence(parsed) !== bytes) invalid();
    return envelope.parse(parsed);
  } catch { return invalid(); }
}
export function compareEvidenceReplay(previous: string, next: string): 'identical' | 'conflict' {
  decodeDurableEvidence(previous); decodeDurableEvidence(next);
  return previous === next ? 'identical' : 'conflict';
}
