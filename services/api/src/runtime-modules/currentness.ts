import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hash } from '../storage.js';
import { ExistingSuppressionLedger, suppressionLedgerSchema } from '../lifecycle/ledger.js';
import type { DisableRecord, SuppressionLedger } from '../lifecycle/types.js';
import { AuthorityLock, JsonFile, assertIdentity, canonicalPath, identitySchema, type FaultPoint, noFault } from './files.js';
export const ledgerSchemaDigest = hash(suppressionLedgerSchema);
const counter = z.number().int().nonnegative().safe();
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const witnessSchema = z.object({ version: z.literal(1), authorityId: z.uuid(), ledgerSchemaDigest: digestSchema,
  revision: counter, directory: identitySchema, ledger: identitySchema, committedSequence: counter, committedHeadDigest: digestSchema,
  pending: z.object({ sequence: counter, priorHeadDigest: digestSchema, nextHeadDigest: digestSchema, recordDigest: digestSchema, operationId: z.uuid() }).strict().nullable(),
}).strict();
export type Witness = z.infer<typeof witnessSchema>;
export function canonicalDisable(record: DisableRecord): string {
  return JSON.stringify([record.sequence, record.accountId, record.authUserId, record.epoch, record.requestId, record.disabledAtMs]);
}
export const genesisHead = (authorityId: string): string => hash(JSON.stringify(['form-suppression-genesis-v1', authorityId, ledgerSchemaDigest]));
export const recordDigest = (record: DisableRecord): string => hash(JSON.stringify(['form-disable-record-v1', canonicalDisable(record)]));
export const advanceHead = (prior: string, record: DisableRecord): string => hash(JSON.stringify(['form-suppression-head-v1', prior, canonicalDisable(record)]));
export class CurrentSuppressionAuthority implements SuppressionLedger {
  private readonly ledger: ExistingSuppressionLedger;
  private unusable = false;
  private closed = false;
  constructor(private readonly lock: AuthorityLock, private readonly witness: JsonFile<Witness>, private readonly ledgerPath: string,
    private readonly authorityId: string, private readonly fault: FaultPoint = noFault) {
    lock.assert(); const value = witness.read(); this.bind(value);
    // Independent witness is read and validated before the SQLite authority is opened.
    if (existsSync(ledgerPath+'-wal') || existsSync(ledgerPath+'-shm')) throw new Error('Unexpected suppression WAL custody');
    if (existsSync(ledgerPath+'-journal')) canonicalPath(ledgerPath+'-journal',lock.uid);
    this.ledger = new ExistingSuppressionLedger(ledgerPath, authorityId, value.committedSequence);
    try {
      const chain = this.chain();
      if (value.pending) {
        const pending = value.pending;
        if (pending.sequence !== value.committedSequence + 1 || pending.priorHeadDigest !== value.committedHeadDigest ||
          chain.sequence !== pending.sequence || chain.prior !== pending.priorHeadDigest || chain.head !== pending.nextHeadDigest ||
          !chain.last || recordDigest(chain.last) !== pending.recordDigest) throw new Error('Reserved suppression unresolved');
        witness.replace({ ...value, revision: value.revision + 1, committedSequence: chain.sequence, committedHeadDigest: chain.head, pending: null }, 'pending-recovery');
      } else if (chain.sequence !== value.committedSequence || chain.head !== value.committedHeadDigest) throw new Error('Independent suppression floor/head mismatch');
      this.currentSequence();
    } catch (error) { this.ledger.close(); this.unusable = true; throw error; }
  }
  private bind(value: Witness): void {
    this.lock.assert();
    if (value.authorityId !== this.authorityId || value.ledgerSchemaDigest !== ledgerSchemaDigest ||
      !Number.isSafeInteger(value.revision + 1)) throw new Error('Witness identity/schema/revision mismatch');
    assertIdentity(this.lock.directory, this.lock.uid, value.directory, true); assertIdentity(this.ledgerPath, this.lock.uid, value.ledger);
  }
  private chain(): { sequence: number; head: string; prior: string; last: DisableRecord | null } {
    let head = genesisHead(this.authorityId), prior = head, last: DisableRecord | null = null, sequence = 0;
    this.ledger.forEachRecord(record => { prior = head; head = advanceHead(head, record); last = record; sequence++; });
    return { sequence, head, prior, last };
  }
  checkpoint(): Witness {
    this.currentSequence(); return this.witness.read();
  }
  currentSequence(): number {
    if (this.unusable || this.closed) throw new Error('Suppression owner unavailable');
    try {
      const value = this.witness.read(); this.bind(value);
      if (value.pending || this.ledger.currentSequence() !== value.committedSequence) throw new Error('Suppression currentness unresolved');
      return value.committedSequence;
    } catch (error) { this.unusable = true; throw error; }
  }
  lookup(accountId: string): DisableRecord | null { this.currentSequence(); return this.ledger.lookup(accountId); }
  recordDisable(input: Omit<DisableRecord, 'sequence'>): DisableRecord {
    this.currentSequence(); const before = this.witness.read(); const prior = this.ledger.lookup(input.accountId);
    if (prior) {
      if (canonicalDisable(prior) !== canonicalDisable({ ...input, sequence: prior.sequence })) throw new Error('Suppression evidence conflict');
      return prior;
    }
    if ([input.accountId,input.authUserId,input.requestId].some(value => typeof value !== 'string' || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 256) || !Number.isSafeInteger(input.epoch) || input.epoch < 1 ||
      !Number.isSafeInteger(input.disabledAtMs) || input.disabledAtMs < 0 || !Number.isSafeInteger(before.committedSequence + 1)) throw new Error('Invalid suppression evidence');
    const record = Object.freeze({ ...input, sequence: before.committedSequence + 1 });
    const next = advanceHead(before.committedHeadDigest, record);
    try {
      this.witness.replace({ ...before, revision: before.revision + 1, pending: { sequence: record.sequence,
        priorHeadDigest: before.committedHeadDigest, nextHeadDigest: next, recordDigest: recordDigest(record), operationId: randomUUID() } }, 'pending-witness');
      this.fault('ledger:before-commit'); const committed = this.ledger.recordDisable(input); this.fault('ledger:after-commit');
      const chain = this.chain();
      if (canonicalDisable(committed) !== canonicalDisable(record) || chain.sequence !== record.sequence || chain.head !== next) throw new Error('Ledger commit readback mismatch');
      this.witness.replace({ ...before, revision: before.revision + 2, committedSequence: record.sequence, committedHeadDigest: next, pending: null }, 'settled-witness');
      return record;
    } catch (error) { this.unusable = true; throw error; }
  }
  reconcileRestore(apply: (record: DisableRecord) => void): number {
    const before = this.checkpoint(); this.ledger.forEachRecord(apply);
    const after = this.checkpoint();
    if (before.revision !== after.revision || before.committedHeadDigest !== after.committedHeadDigest) throw new Error('Suppression changed during admission');
    return after.committedSequence;
  }
  close(): void { if (this.closed) return; this.closed = true; this.ledger.close(); }
}
