import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { bugIntakeLimits, dispatchOutcomeSchema, parseId, parseInput, parseKey, trustedBindingSchema } from './schemas.js';
import { bugReportFingerprint, createBugTriagePacket } from './triage.js';
import { createBugOutcomeView } from './outcome.js';
import type { BugIntakeDependencies, BugReport, PreparedHandoff, ReportState } from './types.js';

type Row = { id: string; data: string; state: ReportState; created_at: string; binding: string | null; intent_hash: string; dispatch_receipt: string | null };
export function createBugIntakeService(deps: BugIntakeDependencies, requestContext: AccountContext) {
  const context = Object.freeze({ ...requestContext });
  const { db, lifecycle } = deps;
  const assertActive = () => {
    lifecycle.assertActive(context);
    if (db.prepare('SELECT 1 FROM bug_intake_suppression WHERE account_id=?').get(context.accountId))
      throw new DomainError(403, 'account_disabled');
  };
  const read = <T>(effect: () => T): T => {
    assertActive(); const result = effect(); assertActive(); return result;
  };
  const write = <T>(effect: () => T): T => lifecycle.withActiveWrite(context, () => {
    assertActive(); const result = effect(); assertActive(); return result;
  });
  const rowFor = (id: string): Row => {
    const row = db.prepare('SELECT * FROM bug_intake_reports WHERE account_id=? AND id=?').get(context.accountId, parseId(id)) as Row | undefined;
    if (!row) throw new DomainError(404, 'bug_report_not_found');
    return row;
  };
  const report = (row: Row): BugReport => ({ ...parseInput(JSON.parse(row.data)), id: row.id, state: row.state, createdAt: row.created_at, ...(row.dispatch_receipt ? { dispatchReceiptId: row.dispatch_receipt } : {}) });
  const handoff = (row: Row): PreparedHandoff => {
    if (!row.binding || !deps.authority) throw new DomainError(503, 'bug_intake_authority_unavailable');
    const binding = trustedBindingSchema.parse(JSON.parse(row.binding));
    deps.authority.assertCurrent(context, row.id, binding);
    return { handoffId: row.id, binding, report: { kind: 'untrusted_user_report', content: parseInput(JSON.parse(row.data)) } };
  };
  return Object.freeze({
    assertActive,
    submit(raw: unknown, keyRaw: unknown): { report: BugReport; replayed: boolean; duplicate: boolean } {
      return write(() => {
        const key = parseKey(keyRaw), input = parseInput(raw);
        const data = JSON.stringify(input), hash = createHash('sha256').update(data).digest('hex');
        const prior = db.prepare('SELECT report_id,intent_hash FROM bug_intake_keys WHERE account_id=? AND key=?').get(context.accountId, key) as
          { report_id: string; intent_hash: string } | undefined;
        if (prior) {
          if (prior.intent_hash !== hash) throw new DomainError(409, 'idempotency_key_conflict');
          return { report: report(rowFor(prior.report_id)), replayed: true, duplicate: false };
        }
        const keyCount = (db.prepare('SELECT count(*) AS n FROM bug_intake_keys WHERE account_id=?').get(context.accountId) as { n: number }).n;
        if (keyCount >= bugIntakeLimits.keysPerAccount) throw new DomainError(429, 'bug_intake_key_limit');
        let row = db.prepare('SELECT * FROM bug_intake_reports WHERE account_id=? AND intent_hash=?').get(context.accountId, hash) as Row | undefined;
        const duplicate = !!row;
        if (!row) {
          const count = (db.prepare('SELECT count(*) AS n FROM bug_intake_reports WHERE account_id=?').get(context.accountId) as { n: number }).n;
          if (count >= bugIntakeLimits.reportsPerAccount) throw new DomainError(429, 'bug_intake_report_limit');
          row = { id: randomUUID(), data, state: 'received', created_at: (deps.now?.() ?? new Date()).toISOString(), binding: null, intent_hash: hash, dispatch_receipt: null };
          db.prepare('INSERT INTO bug_intake_reports(account_id,id,intent_hash,data,created_at,state) VALUES (?,?,?,?,?,?)')
            .run(context.accountId, row.id, hash, data, row.created_at, row.state);
        }
        db.prepare('INSERT INTO bug_intake_keys(account_id,key,intent_hash,report_id) VALUES (?,?,?,?)').run(context.accountId, key, hash, row.id);
        return { report: report(row), replayed: false, duplicate };
      });
    },
    get(id: string): BugReport { return read(() => report(rowFor(id))); },
    outcome(id: string) {
      return read(() => {
        const row = rowFor(id);
        return createBugOutcomeView({ reference: { reportId: row.id, reportFingerprint: bugReportFingerprint(parseInput(JSON.parse(row.data))) },
          context, assertActive, ...(deps.outcomeSource ? { source: deps.outcomeSource } : {}) });
      });
    },
    triage(id: string) {
      return read(() => createBugTriagePacket({ report: report(rowFor(id)), context, assertActive,
        ...(deps.triage ? { source: deps.triage } : {}) }));
    },
    list(options: { limit?: number; after?: string } = {}): BugReport[] {
      return read(() => {
        const limit = options.limit ?? 20;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > bugIntakeLimits.listPage) throw new DomainError(400, 'invalid_bug_report_page');
        const after = options.after === undefined ? '' : parseId(options.after);
        return (db.prepare('SELECT * FROM bug_intake_reports WHERE account_id=? AND id>? ORDER BY id LIMIT ?').all(context.accountId, after, limit) as Row[]).map(report);
      });
    },
    prepare(id: string): PreparedHandoff {
      return write(() => {
        const row = rowFor(id);
        if (row.state === 'dispatch_unknown' || row.state === 'dispatched') throw new DomainError(409, 'bug_dispatch_reconciliation_required');
        if (!row.binding) {
          const candidate = deps.authority?.bindingFor(context, row.id);
          const parsed = trustedBindingSchema.safeParse(candidate);
          if (!parsed.success) throw new DomainError(503, 'bug_intake_authority_unavailable');
          row.binding = JSON.stringify(parsed.data);
        }
        const prepared = handoff(row);
        db.prepare("UPDATE bug_intake_reports SET binding=?,state='prepared' WHERE account_id=? AND id=?").run(row.binding, context.accountId, row.id);
        return prepared;
      });
    },
    async dispatch(id: string): Promise<{ state: ReportState }> {
      if (db.inTransaction) throw new DomainError(409, 'bug_dispatch_requires_committed_boundary');
      const prepared = write(() => {
        const row = rowFor(id);
        if (row.state === 'dispatch_unknown' || row.state === 'dispatched') throw new DomainError(409, 'bug_dispatch_reconciliation_required');
        if (row.state !== 'prepared' && row.state !== 'dispatch_unavailable') throw new DomainError(409, 'bug_handoff_not_prepared');
        const value = handoff(row);
        if (!deps.dispatch) {
          db.prepare("UPDATE bug_intake_reports SET state='dispatch_unavailable' WHERE account_id=? AND id=?").run(context.accountId, row.id);
          return null;
        }
        // Commit uncertainty before crossing the port: crashes, throws and lost responses must never permit automatic retry.
        db.prepare("UPDATE bug_intake_reports SET state='dispatch_unknown' WHERE account_id=? AND id=?").run(context.accountId, row.id);
        return value;
      });
      if (!prepared) return { state: 'dispatch_unavailable' };
      let state: ReportState = 'dispatch_unknown';
      let receiptId: string | null = null;
      try {
        assertActive();
        deps.authority!.assertCurrent(context, prepared.handoffId, prepared.binding);
        const outcome = dispatchOutcomeSchema.parse(await deps.dispatch!.submit(prepared));
        if (outcome.status === 'accepted') { state = 'dispatched'; receiptId = outcome.receiptId; }
        if (outcome.status === 'known_no_effect') state = 'dispatch_unavailable';
      } catch { /* Unknown effects remain durable; adapter details may contain private data. */ }
      return write(() => {
        db.prepare('UPDATE bug_intake_reports SET state=?,dispatch_receipt=? WHERE account_id=? AND id=? AND state=\'dispatch_unknown\'').run(state, receiptId, context.accountId, prepared.handoffId);
        return { state };
      });
    },
  });
}
export type BugIntakeService = ReturnType<typeof createBugIntakeService>;
export function createBugIntakeServiceFactory(deps: BugIntakeDependencies): (context: AccountContext) => BugIntakeService {
  return context => createBugIntakeService(deps, context);
}
