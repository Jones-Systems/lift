import { estimateCommunityRows, addCommunityExportBounds, assertCommunityExportBounds, type CommunityExportBounds } from '../export-bounds.js';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, revision } from '../../errors.js';
import * as s from './schemas.js';
import { BOARD_POLICY_VERSION, type AccountContext, type BoardCategory, type BoardCounts, type BoardDependencies,
  type BoardRestoreAuthority, type BoardStatus, type BoardVisibility, type FeatureAliasResolution,
  type FeatureSubmissionView, type FeatureView, type OwnFeatureVote, type FeatureCorrectionReceipt, type FeatureCorrectionResult } from './types.js';

type Feature = { id: string; category: BoardCategory; status: BoardStatus; status_reason: string | null; revision: number; created_at: string };
type Submission = { id: string; feature_id: string; author_account_id: string | null; title: string; description: string;
  category: BoardCategory; policy_version: string; visibility: BoardVisibility; revision: number; created_at: string;
  suppressed_epoch: number | null; moderation_version: number; restore_barrier: number; redacted: number };
type Vote = { feature_id: string; account_id: string; active: number; revision: number };
const MAX_ROWS = 10000;
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
function absent(): never { throw new DomainError(404, 'board_not_found'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export class FeatureBoardService {
  constructor(private readonly deps: BoardDependencies) {}
  private get<T>(sql: string, ...args: unknown[]): T | undefined { return this.deps.db.prepare(sql).get(...args) as T | undefined; }
  private all<T>(sql: string, ...args: unknown[]): T[] { return this.deps.db.prepare(sql).all(...args) as T[]; }
  private run(sql: string, ...args: unknown[]) { return this.deps.db.prepare(sql).run(...args); }
  private now(): string {
    const date = this.deps.now(); if (!Number.isFinite(date.getTime())) throw new DomainError(503, 'board_clock_unavailable'); return date.toISOString();
  }
  assertActor(actor: AccountContext): void {
    if (!actor?.accountId || !actor.authUserId || !actor.sessionId || !Number.isSafeInteger(actor.epoch) || actor.epoch < 0)
      throw new DomainError(401, 'unauthenticated');
    if (!this.deps.lifecycle) throw new DomainError(503, 'board_lifecycle_unavailable');
    this.deps.lifecycle.assertActive(actor);
  }
  private active<T>(actor: AccountContext, effect: () => T, adult = true): T {
    this.assertActor(actor);
    return this.deps.lifecycle!.withActiveWrite(actor, () => {
      this.assertActor(actor); this.serialized();
      if (adult && !this.validEligibility(this.deps.lifecycle!.adultEligibility(actor))) throw new DomainError(403, 'board_adult_eligibility_unavailable');
      const result = effect(); this.assertActor(actor); return result;
    });
  }
  private serialized(): void {
    if (!this.deps.db.inTransaction) throw new DomainError(503, 'board_lifecycle_serialization_required');
  }
  private validEligibility(result: ReturnType<NonNullable<BoardDependencies['subjectEligibility']>> | undefined): boolean {
    return result?.policy === 'self_reported_adult_v1' && result.status === 'eligible' && Number.isSafeInteger(result.profileRevision) && (result.profileRevision ?? -1) >= 0;
  }
  private subjectActive(id: string): boolean {
    try { return this.validEligibility(this.deps.subjectEligibility?.(id)); } catch { return false; }
  }
  private feature(id: string): Feature {
    s.parse(s.identifier, id); const row = this.get<Feature>('SELECT * FROM community_board_features WHERE id=?', id); if (!row) absent(); return row;
  }
  private submission(id: string): Submission {
    const row = this.get<Submission>('SELECT * FROM community_board_submissions WHERE feature_id=?', id); if (!row) absent(); return row;
  }
  private root(id: string): string {
    this.feature(id); const seen = new Set<string>(); let current = id;
    for (let depth = 0; depth < 64; depth++) {
      if (seen.has(current)) throw new DomainError(503, 'board_alias_integrity_unavailable'); seen.add(current);
      const alias = this.get<{ target_id: string }>('SELECT target_id FROM community_board_aliases WHERE source_id=?', current);
      if (!alias) return current; current = alias.target_id; this.feature(current);
    }
    throw new DomainError(503, 'board_alias_integrity_unavailable');
  }
  private visible(actor: AccountContext, submission: Submission): boolean {
    if (submission.restore_barrier || submission.redacted || submission.suppressed_epoch !== null || submission.visibility === 'withdrawn' || !submission.author_account_id) return false;
    if (submission.author_account_id === actor.accountId) return true;
    if (submission.visibility !== 'published' || !this.deps.isBlocked) return false;
    try {
      if (this.deps.isBlocked(actor, submission.author_account_id)) return false;
      return this.subjectActive(submission.author_account_id);
    } catch { return false; }
  }
  private authorized(actor: AccountContext, id: string): { requested: Submission; feature: Feature; submission: Submission } {
    const requested = this.submission(this.feature(id).id); if (!this.visible(actor, requested)) absent();
    const feature = this.feature(this.root(id)); const submission = this.submission(feature.id);
    if (!this.visible(actor, submission)) absent(); return { requested, feature, submission };
  }
  private bounded(sql: string, ...args: unknown[]): void {
    const row = this.get<{ count: number }>(sql, ...args); if ((row?.count ?? 0) > MAX_ROWS) throw new DomainError(413, 'board_result_too_large');
  }
  private voters(id: string): string[] {
    this.bounded('SELECT count(*) AS count FROM community_board_votes WHERE feature_id=? AND active=1', id);
    return this.all<{ account_id: string }>('SELECT account_id FROM community_board_votes WHERE feature_id=? AND active=1 ORDER BY account_id', id)
      .filter(row => this.subjectActive(row.account_id)).map(row => row.account_id);
  }
  private view(actor: AccountContext, feature: Feature, submission: Submission): FeatureView {
    const voters = this.voters(feature.id);
    return { id: feature.id, title: submission.title, description: submission.description, category: feature.category,
      status: feature.status, statusReason: feature.status_reason, revision: feature.revision, createdAt: feature.created_at,
      visibility: submission.visibility, authorLabel: 'Form member', voteCount: voters.length, supported: voters.includes(actor.accountId) };
  }
  private correctionsInstalled(): boolean {
    return !!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_board_correction_events'");
  }
  private ownSubmission(row: Submission): FeatureSubmissionView {
    const previous = this.correctionsInstalled() ? this.get<{ predecessor_id: string }>('SELECT predecessor_id FROM community_board_correction_events WHERE successor_id=?', row.id) : undefined;
    const next = this.correctionsInstalled() ? this.get<{ successor_id: string }>('SELECT successor_id FROM community_board_correction_events WHERE predecessor_id=?', row.id) : undefined;
    return { id: row.id, featureId: row.feature_id, canonicalFeatureId: this.root(row.feature_id), title: row.title, description: row.description,
      category: row.category, revision: row.revision, visibility: row.visibility, createdAt: row.created_at,
      ...(previous ? { predecessorSubmissionId: previous.predecessor_id } : {}), ...(next ? { successorSubmissionId: next.successor_id } : {}) };
  }
  private receipt(actor: AccountContext, operation: string, key: string, intent: unknown): string | undefined {
    s.parse(s.key, key);
    const row = this.get<{ intent_hash: string; effect_id: string }>('SELECT intent_hash,effect_id FROM community_board_command_receipts WHERE account_id=? AND operation=? AND key=?', actor.accountId, operation, key);
    if (row && row.intent_hash !== digest(intent)) throw new DomainError(409, 'idempotency_conflict'); return row?.effect_id;
  }
  private record(actor: AccountContext, operation: string, key: string, intent: unknown, effectId: string): void {
    this.run('INSERT INTO community_board_command_receipts VALUES(?,?,?,?,?,?)', actor.accountId, operation, key, digest(intent), effectId, this.now());
  }
  private quota(actor: AccountContext, action: 'submit' | 'vote' | 'search'): void {
    const now = this.now(); const duration = action === 'vote' ? 3600000 : 60000;
    const since = action === 'submit' ? `${now.slice(0, 10)}T00:00:00.000Z` : new Date(Date.parse(now) - duration).toISOString();
    const count = this.get<{ count: number }>('SELECT count(*) AS count FROM community_board_quota_events WHERE account_id=? AND action=? AND created_at>=?', actor.accountId, action, since)?.count ?? 0;
    if (count >= (action === 'submit' ? 3 : 30)) throw new DomainError(429, 'board_rate_limited');
    this.run('INSERT INTO community_board_quota_events VALUES(?,?,?,?)', randomUUID(), actor.accountId, action, now);
  }
  capabilities(actor: AccountContext) {
    return this.active(actor, () => ({ submissions: 'pending_author_only' as const, liveActivation: 'unqualified' as const,
      moderation: this.deps.moderation && this.deps.textModeration ? 'injected_unqualified' as const : 'unavailable' as const,
      steward: this.deps.steward ? 'injected_unqualified' as const : 'unavailable' as const,
      safety: this.deps.safety ? 'injected_unqualified' as const : 'unavailable' as const,
      retention: this.deps.retention ? 'injected_unqualified' as const : 'unavailable' as const,
      support: this.deps.support ? 'injected_unqualified' as const : 'unavailable' as const,
      publicProjection: this.deps.subjectEligibility && this.deps.isBlocked ? 'injected_unqualified' as const : 'unavailable' as const,
      purge: 'pending_qualification' as const }));
  }
  browse(actor: AccountContext, raw: unknown = {}) {
    return this.active(actor, () => {
      const input = s.parse(s.query, raw); if (input.q) this.quota(actor, 'search');
      this.bounded('SELECT count(*) AS count FROM community_board_features');
      this.bounded('SELECT count(*) AS count FROM community_board_votes WHERE active=1');
      const features = this.all<Feature>('SELECT f.* FROM community_board_features f WHERE NOT EXISTS(SELECT 1 FROM community_board_aliases a WHERE a.source_id=f.id) ORDER BY f.created_at DESC,f.id');
      const results: FeatureView[] = [];
      for (const feature of features) {
        if (input.category && feature.category !== input.category || input.status && feature.status !== input.status) continue;
        const submission = this.submission(feature.id); if (!this.visible(actor, submission)) continue;
        if (input.q && (submission.visibility !== 'published' || !`${submission.title}\n${submission.description}`.normalize('NFC').toLocaleLowerCase('en-US').includes(input.q.normalize('NFC').toLocaleLowerCase('en-US')))) continue;
        if (input.mine === 'submissions' && !this.get('SELECT 1 FROM community_board_submissions WHERE author_account_id=? AND (feature_id=? OR feature_id IN(SELECT source_id FROM community_board_aliases WHERE target_id=?))', actor.accountId, feature.id, feature.id)) continue;
        const view = this.view(actor, feature, submission); if (input.mine === 'votes' && !view.supported) continue; results.push(view);
      }
      results.sort((a, b) => (input.sort === 'most_supported' ? b.voteCount - a.voteCount : 0) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      const offset = (input.page - 1) * input.pageSize;
      return { features: results.slice(offset, offset + input.pageSize), page: input.page, pageSize: input.pageSize, hasMore: results.length > offset + input.pageSize };
    });
  }
  detail(actor: AccountContext, id: string): FeatureAliasResolution {
    return this.active(actor, () => {
      const resolved = this.authorized(actor, id);
      const result: FeatureAliasResolution = { requestedId: id, canonicalId: resolved.feature.id, combined: id !== resolved.feature.id,
        feature: this.view(actor, resolved.feature, resolved.submission),
        ...(id !== resolved.feature.id && resolved.requested.visibility === 'published' ? { original: { title: resolved.requested.title, description: resolved.requested.description } } : {}) };
      return result;
    });
  }
  submit(actor: AccountContext, raw: unknown, key: string): FeatureSubmissionView {
    return this.active(actor, () => {
      const input = s.parse(s.submit, raw); const replay = this.receipt(actor, 'submit', key, input);
      if (replay) {
        const row = this.get<Submission>('SELECT * FROM community_board_submissions WHERE id=? AND author_account_id=?', replay, actor.accountId);
        if (!row) absent(); return this.ownSubmission(row);
      }
      const moderation = this.deps.textModeration?.checkText({ purpose: 'feature_board', title: input.title, description: input.description, policyVersion: BOARD_POLICY_VERSION });
      if (moderation === 'rejected') throw new DomainError(422, 'board_text_rejected');
      this.quota(actor, 'submit'); if (input.voteOnSubmit) this.quota(actor, 'vote');
      const id = randomUUID(); const submissionId = randomUUID(); const now = this.now();
      this.run('INSERT INTO community_board_features(id,category,created_at) VALUES(?,?,?)', id, input.category, now);
      this.run(`INSERT INTO community_board_submissions(id,feature_id,author_account_id,title,description,category,policy_version,audience_accepted,visibility,created_at)
        VALUES(?,?,?,?,?,?,?,1,'pending',?)`, submissionId, id, actor.accountId, input.title, input.description, input.category, input.policyVersion, now);
      if (input.voteOnSubmit) this.setVoteRow(actor, id, id, true);
      this.record(actor, 'submit', key, input, submissionId); return this.ownSubmission(this.submission(id));
    });
  }
  correct(actor: AccountContext, submissionId: string, raw: unknown, key: string): FeatureCorrectionResult {
    return this.active(actor, () => {
      if (!this.correctionsInstalled()) throw new DomainError(503, 'board_correction_unavailable');
      s.parse(s.identifier, submissionId); const input = s.parse(s.correction, raw);
      const row = this.get<Submission>('SELECT * FROM community_board_submissions WHERE id=? AND author_account_id=?', submissionId, actor.accountId);
      if (!row || row.redacted || row.suppressed_epoch !== null) absent();
      if (row.restore_barrier) throw new DomainError(409, 'board_restore_reconsent_required');
      const intent = { submissionId, ...input, actor: { authUserId: actor.authUserId, sessionId: actor.sessionId, epoch: actor.epoch } };
      const replay = this.receipt(actor, 'correct', key, intent);
      if (replay) return this.correctionResult(actor, replay);
      if (row.visibility === 'withdrawn') absent();
      revision(row.revision, input.expectedRevision);
      const canonicalFeatureId = this.root(row.feature_id);
      if (canonicalFeatureId !== input.expectedCanonicalFeatureId) throw new DomainError(409, 'board_canonical_changed');
      if (this.get('SELECT 1 FROM community_board_correction_events WHERE predecessor_id=?', row.id)) throw new DomainError(409, 'board_already_corrected');
      if (row.title === input.title && row.description === input.description && row.category === input.category) throw new DomainError(422, 'board_correction_unchanged');
      const moderation = this.deps.textModeration?.checkText({ purpose: 'feature_board', title: input.title, description: input.description, policyVersion: input.policyVersion });
      if (moderation === 'rejected') throw new DomainError(422, 'board_text_rejected');
      const current = this.get<Submission>('SELECT * FROM community_board_submissions WHERE id=? AND author_account_id=?', submissionId, actor.accountId);
      if (!current || current.redacted || current.suppressed_epoch !== null || current.visibility === 'withdrawn') absent();
      if (current.restore_barrier) throw new DomainError(409, 'board_restore_reconsent_required');
      revision(current.revision, input.expectedRevision);
      if (this.root(current.feature_id) !== canonicalFeatureId) throw new DomainError(409, 'board_canonical_changed');
      this.quota(actor, 'submit');
      const featureId = randomUUID(), successorId = randomUUID(), eventId = randomUUID(), createdAt = this.now();
      const receipt: FeatureCorrectionReceipt = { schema: 'form.feature-board-correction/v1', key, eventId,
        submissionId, featureId: row.feature_id, expectedRevision: row.revision, resultRevision: row.revision + 1,
        canonicalFeatureId, canonicalRevision: this.feature(canonicalFeatureId).revision,
        successor: { submissionId: successorId, featureId },
        replacement: { title: input.title, description: input.description, category: input.category,
          policyVersion: input.policyVersion, policyAccepted: true, audienceAccepted: true }, createdAt };
      this.run('INSERT INTO community_board_features(id,category,created_at) VALUES(?,?,?)', featureId, input.category, createdAt);
      this.run(`INSERT INTO community_board_submissions(id,feature_id,author_account_id,title,description,category,policy_version,audience_accepted,visibility,created_at)
        VALUES(?,?,?,?,?,?,?,1,'pending',?)`, successorId, featureId, actor.accountId, input.title, input.description, input.category, input.policyVersion, createdAt);
      this.run('UPDATE community_board_submissions SET revision=revision+1 WHERE id=?', submissionId);
      this.run('INSERT INTO community_board_correction_events VALUES(?,?,?,?)', eventId, submissionId, successorId, JSON.stringify(receipt));
      this.record(actor, 'correct', key, intent, eventId);
      return this.correctionResult(actor, eventId);
    });
  }
  private readCorrectionReceipt(json: string): FeatureCorrectionReceipt {
    try { return s.parse(s.correctionReceipt, JSON.parse(json)); }
    catch { throw new DomainError(503, 'board_correction_receipt_unavailable'); }
  }
  private correctionResult(actor: AccountContext, eventId: string): FeatureCorrectionResult {
    const event = this.get<{ receipt_json: string; predecessor_id: string; successor_id: string; feature_id: string }>(`SELECT e.receipt_json,e.predecessor_id,e.successor_id,p.feature_id FROM community_board_correction_events e
      JOIN community_board_submissions p ON p.id=e.predecessor_id WHERE e.id=? AND p.author_account_id=?`, eventId, actor.accountId);
    if (!event) throw new DomainError(503, 'board_correction_receipt_unavailable');
    const receipt = this.readCorrectionReceipt(event.receipt_json);
    if (receipt.eventId !== eventId || receipt.submissionId !== event.predecessor_id || receipt.featureId !== event.feature_id || receipt.successor.submissionId !== event.successor_id)
      throw new DomainError(503, 'board_correction_receipt_unavailable');
    const row = this.get<Submission>('SELECT * FROM community_board_submissions WHERE id=? AND author_account_id=? AND redacted=0 AND suppressed_epoch IS NULL AND restore_barrier=0', event.successor_id, actor.accountId);
    if (row && row.feature_id !== receipt.successor.featureId) throw new DomainError(503, 'board_correction_receipt_unavailable');
    return { receipt, successor: row ? this.ownSubmission(row) : null };
  }
  private setVoteRow(actor: AccountContext, origin: string, id: string, active: boolean): void {
    this.run(`INSERT INTO community_board_votes(feature_id,account_id,active,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(feature_id,account_id) DO UPDATE SET active=excluded.active,revision=revision+1,updated_at=excluded.updated_at`, id, actor.accountId, Number(active), this.now());
    this.run('INSERT INTO community_board_vote_events VALUES(?,?,?,?,?,?)', randomUUID(), actor.accountId, origin, id, Number(active), this.now());
  }
  private ownVote(actor: AccountContext, id: string): OwnFeatureVote {
    const row = this.get<Vote>('SELECT * FROM community_board_votes WHERE feature_id=? AND account_id=?', id, actor.accountId);
    return { featureId: id, active: row?.active === 1, revision: row?.revision ?? 1 };
  }
  setVote(actor: AccountContext, id: string, raw: unknown, key: string): OwnFeatureVote {
    this.assertActor(actor); const input = s.parse(s.vote, raw);
    return this.active(actor, () => {
      const root = this.root(id);
      if (input.active) {
        const resolved = this.authorized(actor, id);
        if (resolved.submission.restore_barrier) throw new DomainError(409, 'board_restore_reconsent_required');
      }
      else if (!this.get('SELECT 1 FROM community_board_votes WHERE feature_id=? AND account_id=?', root, actor.accountId)) {
        this.authorized(actor, id);
      }
      const intent = { id, ...input }; const replay = this.receipt(actor, 'vote', key, intent); if (replay) return this.ownVote(actor, root);
      const feature = this.feature(root); revision(feature.revision, input.expectedRevision);
      const current = this.ownVote(actor, root);
      if (current.active !== input.active) {
        if (input.active) this.quota(actor, 'vote');
        this.setVoteRow(actor, id, root, input.active); this.run('UPDATE community_board_features SET revision=revision+1 WHERE id=?', root);
      }
      this.record(actor, 'vote', key, intent, root); return this.ownVote(actor, root);
    }, input.active);
  }
  ownSubmissions(actor: AccountContext, raw: unknown = {}): FeatureSubmissionView[] {
    return this.active(actor, () => {
      this.ownBounds(actor.accountId);
      const query = s.parse(s.ownQuery, raw);
      return this.all<Submission>('SELECT * FROM community_board_submissions WHERE author_account_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?', actor.accountId, query.pageSize, (query.page - 1) * query.pageSize).map(row => this.ownSubmission(row));
    }, false);
  }
  ownVotes(actor: AccountContext, raw: unknown = {}): OwnFeatureVote[] {
    return this.active(actor, () => {
      this.ownBounds(actor.accountId);
      const query = s.parse(s.ownQuery, raw);
      return this.all<Vote>('SELECT v.* FROM community_board_votes v WHERE v.account_id=? AND NOT EXISTS(SELECT 1 FROM community_board_aliases a WHERE a.source_id=v.feature_id) ORDER BY v.feature_id LIMIT ? OFFSET ?', actor.accountId, query.pageSize, (query.page - 1) * query.pageSize)
        .map(row => ({ featureId: row.feature_id, active: row.active === 1, revision: row.revision }));
    }, false);
  }
  withdraw(actor: AccountContext, submissionId: string, raw: unknown, key: string): FeatureSubmissionView {
    return this.active(actor, () => {
      s.parse(s.identifier, submissionId); const input = s.parse(s.withdraw, raw);
      const row = this.get<Submission>('SELECT * FROM community_board_submissions WHERE id=? AND author_account_id=?', submissionId, actor.accountId); if (!row) absent();
      const intent = { submissionId, ...input }; if (this.receipt(actor, 'withdraw', key, intent)) return this.ownSubmission(row);
      revision(row.revision, input.expectedRevision);
      this.run("UPDATE community_board_submissions SET visibility='withdrawn',revision=revision+1 WHERE id=?", submissionId);
      this.run('UPDATE community_board_features SET revision=revision+1 WHERE id=?', row.feature_id);
      this.record(actor, 'withdraw', key, intent, submissionId); return this.ownSubmission(this.submission(row.feature_id));
    }, false);
  }
  report(actor: AccountContext, id: string, raw: unknown, key: string) {
    return this.active(actor, () => {
      const input = s.parse(s.report, raw); const resolved = this.authorized(actor, id);
      if (!this.deps.safety) throw new DomainError(503, 'board_safety_unavailable');
      const intent = { id, ...input }; const replay = this.receipt(actor, 'report', key, intent);
      if (replay) return { receiptId: replay, status: 'pending' as const };
      const result = this.deps.safety.report({ actor, featureId: resolved.feature.id, reason: input.reason,
        operationId: digest({ accountId: actor.accountId, key, operation: 'board_report' }) });
      s.parse(s.identifier, result.receiptId); if (result.status !== 'pending') throw new DomainError(503, 'board_safety_unavailable');
      this.record(actor, 'report', key, intent, result.receiptId); return { receiptId: result.receiptId, status: 'pending' as const };
    }, false);
  }
  moderate(actor: AccountContext, submissionId: string, raw: unknown, key: string): { submissionId: string; visibility: BoardVisibility; revision: number } {
    return this.active(actor, () => {
      const input = s.parse(s.moderation, raw); s.parse(s.identifier, submissionId);
      if (!this.deps.moderation) throw new DomainError(503, 'board_moderation_unavailable');
      this.deps.moderation.assertAuthorized(actor, submissionId, input.visibility === 'published' ? 'publish' : 'hide');
      const row = this.get<Submission>('SELECT * FROM community_board_submissions WHERE id=?', submissionId); if (!row) absent();
      if (row.visibility === 'withdrawn' || row.redacted || row.suppressed_epoch !== null || !row.author_account_id || !this.subjectActive(row.author_account_id)) absent();
      if (input.visibility === 'published') {
        if (row.restore_barrier) throw new DomainError(409, 'board_restore_reconsent_required');
        if (!this.deps.retention || !this.deps.support || !this.deps.safety || !this.deps.isBlocked) throw new DomainError(503, 'board_publication_dependencies_unavailable');
        this.deps.retention.assertPublicationQualified(submissionId); this.deps.support.assertStaffed();
      }
      const intent = { submissionId, ...input };
      if (!this.receipt(actor, 'moderate', key, intent)) {
        revision(row.revision, input.expectedRevision);
        if (input.visibility === 'published') {
          const result = this.deps.textModeration?.checkText({ purpose: 'feature_board', title: row.title, description: row.description, policyVersion: row.policy_version });
          if (result !== 'allowed') throw new DomainError(503, 'board_text_moderation_unavailable');
        }
        this.run('UPDATE community_board_submissions SET visibility=?,revision=revision+1,moderation_version=moderation_version+1 WHERE id=?', input.visibility, submissionId);
        this.run('UPDATE community_board_features SET revision=revision+1 WHERE id=?', row.feature_id);
        this.record(actor, 'moderate', key, intent, submissionId);
      }
      const current = this.submission(row.feature_id); return { submissionId, visibility: current.visibility, revision: current.revision };
    });
  }
  private steward(actor: AccountContext, ids: readonly string[], action: 'merge' | 'status'): void {
    if (!this.deps.steward) throw new DomainError(503, 'board_steward_unavailable'); this.deps.steward.assertAuthorized(actor, ids, action);
  }
  merge(actor: AccountContext, raw: unknown, key: string): { canonicalId: string; revision: number; merged: true } {
    return this.active(actor, () => {
      const input = s.parse(s.merge, raw); this.steward(actor, [input.sourceId, input.targetId], 'merge');
      const sourceId = this.root(input.sourceId); const targetId = this.root(input.targetId);
      this.steward(actor, [sourceId, targetId], 'merge');
      const replay = this.receipt(actor, 'merge', key, input);
      if (replay) { const current = this.feature(this.root(replay)); return { canonicalId: current.id, revision: current.revision, merged: true }; }
      if (sourceId === targetId) throw new DomainError(409, 'board_merge_cycle_or_self');
      const source = this.feature(sourceId); const target = this.feature(targetId);
      revision(source.revision, input.sourceRevision); revision(target.revision, input.targetRevision);
      for (const id of [sourceId, targetId]) {
        const row = this.submission(id);
        if (row.visibility !== 'published' || row.redacted || row.suppressed_epoch !== null || !row.author_account_id || !this.subjectActive(row.author_account_id)) absent();
      }
      if (!this.deps.subjectEligibility) throw new DomainError(503, 'board_subject_eligibility_unavailable');
      const voters = new Set([...this.voters(sourceId), ...this.voters(targetId)]);
      if (voters.size > MAX_ROWS) throw new DomainError(413, 'board_result_too_large');
      this.run('UPDATE community_board_votes SET active=0,revision=revision+1,updated_at=? WHERE feature_id IN(?,?) AND active=1', this.now(), sourceId, targetId);
      for (const accountId of voters) {
        this.run(`INSERT INTO community_board_votes(feature_id,account_id,active,updated_at) VALUES(?,?,1,?)
          ON CONFLICT(feature_id,account_id) DO UPDATE SET active=1,revision=revision+1,updated_at=excluded.updated_at`, targetId, accountId, this.now());
      }
      this.run('UPDATE community_board_aliases SET target_id=?,revision=revision+1 WHERE target_id=?', targetId, sourceId);
      this.run('INSERT INTO community_board_aliases(source_id,target_id) VALUES(?,?)', sourceId, targetId);
      this.run('INSERT INTO community_board_merge_events VALUES(?,?,?,?,?,?,?,?)', randomUUID(), sourceId, targetId, actor.accountId, source.revision, target.revision, input.reason, this.now());
      this.run('UPDATE community_board_features SET revision=revision+1 WHERE id IN(?,?)', sourceId, targetId);
      this.record(actor, 'merge', key, input, targetId); return { canonicalId: targetId, revision: this.feature(targetId).revision, merged: true };
    });
  }
  setStatus(actor: AccountContext, id: string, raw: unknown, key: string): { featureId: string; status: BoardStatus; revision: number } {
    return this.active(actor, () => {
      const input = s.parse(s.status, raw); const root = this.root(id); this.steward(actor, [id, root], 'status');
      const feature = this.feature(root); const intent = { id, ...input };
      if (!this.receipt(actor, 'status', key, intent)) {
        revision(feature.revision, input.expectedRevision);
        if (input.status === 'released') {
          if (!input.releaseEvidence) throw new DomainError(422, 'board_release_evidence_required');
          this.deps.steward!.assertReleasedEvidence(actor, root, input.releaseEvidence);
        } else if (input.releaseEvidence) throw new DomainError(422, 'board_invalid_input');
        this.run('INSERT INTO community_board_status_events VALUES(?,?,?,?,?,?,?,?,?)', randomUUID(), root, actor.accountId, feature.status, input.status, feature.revision, input.reason, input.releaseEvidence ?? null, this.now());
        this.run('UPDATE community_board_features SET status=?,status_reason=?,revision=revision+1 WHERE id=?', input.status, input.reason, root);
        this.record(actor, 'status', key, intent, root);
      }
      const current = this.feature(root); return { featureId: root, status: current.status, revision: current.revision };
    });
  }
  private lifecycleInput(accountId: string, epoch: number): void {
    this.serialized(); if (!accountId || !Number.isSafeInteger(epoch) || epoch < 0) throw new DomainError(422, 'board_invalid_lifecycle_input');
  }
  private counts(accountId: string): BoardCounts {
    const count = (table: string, column = 'account_id') => this.get<{ count: number }>(`SELECT count(*) AS count FROM ${table} WHERE ${column}=?`, accountId)?.count ?? 0;
    return { submissions: count('community_board_submissions', 'author_account_id'), votes: count('community_board_votes'), voteEvents: count('community_board_vote_events'),
      receipts: count('community_board_command_receipts'), quotas: count('community_board_quota_events'),
      stewardEvents: count('community_board_merge_events', 'actor_account_id') + count('community_board_status_events', 'actor_account_id'),
      corrections: this.correctionsInstalled() ? this.get<{ count: number }>('SELECT count(*) AS count FROM community_board_correction_events e JOIN community_board_submissions s ON s.id=e.predecessor_id WHERE s.author_account_id=?', accountId)?.count ?? 0 : 0 };
  }
  private ownBounds(accountId: string): BoardCounts {
    const counts = this.counts(accountId); if (Object.values(counts).reduce((a, b) => a + b, 0) > MAX_ROWS) throw new DomainError(413, 'board_export_too_large');
    const size = this.get<{ bytes: number }>(`SELECT coalesce(sum(2*length(CAST(title AS BLOB))+2*length(CAST(description AS BLOB))+512),0) AS bytes
      FROM community_board_submissions WHERE author_account_id=?`, accountId)?.bytes ?? 0;
    if (size + (counts.votes + counts.voteEvents + counts.receipts + counts.quotas + counts.stewardEvents + counts.corrections) * 1024 > MAX_EXPORT_BYTES) throw new DomainError(413, 'board_export_too_large');
    return counts;
  }
  inventoryAccount(actor: AccountContext): BoardCounts { this.serialized(); this.assertActor(actor); const result = this.ownBounds(actor.accountId); this.assertActor(actor); return result; }
  exportBounds(actor: AccountContext): CommunityExportBounds {
    this.serialized(); this.assertActor(actor);
    return addCommunityExportBounds([
      { rows: 0, bytes: 2048 },
      ...(this.correctionsInstalled() ? [estimateCommunityRows(this.deps.db, 'SELECT e.receipt_json FROM community_board_correction_events e JOIN community_board_submissions s ON s.id=e.predecessor_id WHERE s.author_account_id=?', [actor.accountId])] : []),
      estimateCommunityRows(this.deps.db, 'SELECT * FROM community_board_submissions WHERE author_account_id=?', [actor.accountId]),
      estimateCommunityRows(this.deps.db, 'SELECT * FROM community_board_votes WHERE account_id=?', [actor.accountId]),
      estimateCommunityRows(this.deps.db, 'SELECT origin_feature_id,canonical_feature_id,active,created_at FROM community_board_vote_events WHERE account_id=?', [actor.accountId]),
    ]);
  }
  exportAccount(actor: AccountContext, append: (category: string, value: unknown) => void): number {
    this.serialized(); this.assertActor(actor);
    const counts = this.ownBounds(actor.accountId); assertCommunityExportBounds(this.exportBounds(actor));
    const submissions = this.all<Submission>('SELECT * FROM community_board_submissions WHERE author_account_id=? ORDER BY id', actor.accountId).map(row => this.ownSubmission(row));
    const votes = this.all<Vote>('SELECT * FROM community_board_votes WHERE account_id=? ORDER BY feature_id', actor.accountId)
      .map(row => ({ featureId: row.feature_id, active: row.active === 1, revision: row.revision }));
    const events = this.all<{ origin_feature_id: string; canonical_feature_id: string; active: number; created_at: string }>('SELECT origin_feature_id,canonical_feature_id,active,created_at FROM community_board_vote_events WHERE account_id=? ORDER BY id', actor.accountId);
    const corrections = this.correctionsInstalled() ? this.all<{ receipt_json: string }>('SELECT e.receipt_json FROM community_board_correction_events e JOIN community_board_submissions s ON s.id=e.predecessor_id WHERE s.author_account_id=? ORDER BY e.id', actor.accountId).map(row => this.readCorrectionReceipt(row.receipt_json)) : [];
    append('community', { featureBoard: { submissions, votes, events, ...(this.correctionsInstalled() ? { corrections } : {}) } });
    this.assertActor(actor); return counts.submissions + counts.votes + counts.voteEvents + counts.corrections;
  }
  suppressAccount(accountId: string, epoch: number): BoardCounts {
    this.lifecycleInput(accountId, epoch); const counts = this.counts(accountId);
    this.run("UPDATE community_board_submissions SET visibility=CASE WHEN visibility='withdrawn' THEN 'withdrawn' ELSE 'hidden' END,suppressed_epoch=max(coalesce(suppressed_epoch,0),?),revision=revision+1 WHERE author_account_id=?", epoch, accountId);
    this.run('UPDATE community_board_votes SET active=0,revision=revision+1,updated_at=? WHERE account_id=? AND active=1', this.now(), accountId);
    this.run('UPDATE community_board_features SET revision=revision+1 WHERE id IN(SELECT feature_id FROM community_board_submissions WHERE author_account_id=?)', accountId);
    return counts;
  }
  verifySuppressed(accountId: string, epoch: number): boolean {
    this.lifecycleInput(accountId, epoch);
    return !this.get("SELECT 1 FROM community_board_submissions WHERE author_account_id=? AND (visibility NOT IN('hidden','withdrawn') OR suppressed_epoch IS NULL OR suppressed_epoch<?) LIMIT 1", accountId, epoch)
      && !this.get('SELECT 1 FROM community_board_votes WHERE account_id=? AND active=1 LIMIT 1', accountId);
  }
  purgeAccount(requestId: string, accountId: string, qualification: Readonly<{ retentionAndAuditRedactionQualified: true }>): BoardCounts {
    this.lifecycleInput(accountId, 0); s.parse(s.identifier, requestId);
    if (qualification?.retentionAndAuditRedactionQualified !== true) throw new DomainError(503, 'board_purge_unqualified');
    if (!this.verifySuppressed(accountId, 0)) throw new DomainError(409, 'board_suppression_required'); const counts = this.counts(accountId);
    this.run("UPDATE community_board_features SET status_reason=NULL WHERE id IN(SELECT feature_id FROM community_board_submissions WHERE author_account_id=?)", accountId);
    this.run("UPDATE community_board_merge_events SET reason='' WHERE source_id IN(SELECT feature_id FROM community_board_submissions WHERE author_account_id=?) OR target_id IN(SELECT feature_id FROM community_board_submissions WHERE author_account_id=?)", accountId, accountId);
    this.run("UPDATE community_board_status_events SET reason='',evidence=NULL WHERE feature_id IN(SELECT feature_id FROM community_board_submissions WHERE author_account_id=?)", accountId);
    if (this.correctionsInstalled()) this.run('DELETE FROM community_board_correction_events WHERE predecessor_id IN(SELECT id FROM community_board_submissions WHERE author_account_id=?) OR successor_id IN(SELECT id FROM community_board_submissions WHERE author_account_id=?)', accountId, accountId);
    this.run("UPDATE community_board_submissions SET author_account_id=NULL,title='',description='',redacted=1,revision=revision+1 WHERE author_account_id=?", accountId);
    this.run("UPDATE community_board_merge_events SET actor_account_id=NULL,reason='' WHERE actor_account_id=?", accountId);
    this.run("UPDATE community_board_status_events SET actor_account_id=NULL,reason='',evidence=NULL WHERE actor_account_id=?", accountId);
    for (const table of ['community_board_votes', 'community_board_vote_events', 'community_board_command_receipts', 'community_board_quota_events']) this.run(`DELETE FROM ${table} WHERE account_id=?`, accountId);
    if (Object.values(this.counts(accountId)).some(value => value !== 0)) throw new DomainError(503, 'board_purge_readback_failed'); return counts;
  }
  reconcileRestore(authority: BoardRestoreAuthority): { submissionsHidden: number; votesReset: number } {
    this.serialized(); if (authority?.ready !== true || typeof authority.lookup !== 'function') throw new DomainError(503, 'board_restore_authority_required');
    this.bounded('SELECT count(*) AS count FROM community_board_submissions');
    this.bounded('SELECT count(*) AS count FROM community_board_votes');
    const accounts = this.all<{ account_id: string }>(`SELECT author_account_id AS account_id FROM community_board_submissions WHERE author_account_id IS NOT NULL UNION SELECT account_id FROM community_board_votes`);
    for (const row of accounts) {
      const state = authority.lookup(row.account_id); if (!state || !Number.isSafeInteger(state.epoch) || state.epoch < 0 || !['active', 'suppressed'].includes(state.state)) throw new DomainError(503, 'board_restore_authority_required');
      if (state.state === 'suppressed') this.suppressAccount(row.account_id, state.epoch);
    }
    this.run('DELETE FROM community_board_command_receipts');
    if (this.get('SELECT 1 FROM community_board_command_receipts LIMIT 1')) throw new DomainError(503, 'board_restore_integrity_failed');
    const hidden = this.run("UPDATE community_board_submissions SET visibility=CASE WHEN visibility='withdrawn' THEN 'withdrawn' ELSE 'hidden' END,restore_barrier=1,revision=revision+1 WHERE author_account_id IS NOT NULL").changes;
    const votes = this.run('UPDATE community_board_votes SET active=0,revision=revision+1,updated_at=? WHERE active=1', this.now()).changes;
    this.run('UPDATE community_board_features SET revision=revision+1'); return { submissionsHidden: hidden, votesReset: votes };
  }
}
export function createFeatureBoard(deps: BoardDependencies): FeatureBoardService { return new FeatureBoardService(deps); }
