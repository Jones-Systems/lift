import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../src/errors.js';
import { actor, bindings, eligibility, install } from '../fixture.js';
import { createFeatureBoard, featureBoardMigrationSql, BOARD_POLICY_VERSION, type BoardDependencies,
  type FeatureBoardService, type AccountContext, type FeatureSubmissionView } from '../../../src/community/board/index.js';
export const submission = (title = 'Improve workout planning') => ({ title, description: 'Please improve the flexibility of workout plans.', category: 'plans',
  policyVersion: BOARD_POLICY_VERSION, policyAccepted: true, audienceAccepted: true });
export type BoardFixture = {
  db: Database.Database; a: AccountContext; b: AccountContext; c: AccountContext; steward: AccountContext; moderator: AccountContext;
  clock: { value: string }; now: () => Date; board: FeatureBoardService; deps: BoardDependencies;
  published: (person: AccountContext, title?: string) => FeatureSubmissionView;
};
export function fixture(database?: Database.Database): BoardFixture {
  const db = database ?? new Database(':memory:'); db.pragma('foreign_keys=ON'); if (!database) { install(db); db.exec(featureBoardMigrationSql); }
  const a = actor(db); const b = actor(db); const c = actor(db); const steward = actor(db); const moderator = actor(db);
  const clock = { value: '2026-10-09T12:00:00.000Z' }; const now = () => new Date(clock.value);
  const requireActor = (candidate: AccountContext, allowed: AccountContext) => { if (candidate.accountId !== allowed.accountId) throw new DomainError(403, 'synthetic_capability_denied'); };
  const deps: BoardDependencies = { db, now, lifecycle: bindings(db), subjectEligibility: id => eligibility(db, id), isBlocked: () => false,
    textModeration: { checkText: () => 'allowed' }, moderation: { assertAuthorized: who => requireActor(who, moderator) },
    steward: { assertAuthorized: who => requireActor(who, steward), assertReleasedEvidence: (who, _id, evidence) => {
      requireActor(who, steward); if (evidence !== 'synthetic-release-evidence') throw new DomainError(503, 'synthetic_release_unproved');
    } }, retention: { assertPublicationQualified: () => {} }, support: { assertStaffed: () => {} }, safety: { report: () => ({ receiptId: randomUUID(), status: 'pending' }) } };
  const board = createFeatureBoard(deps);
  const published = (person: AccountContext, title?: string) => {
    const row = board.submit(person, submission(title), randomUUID());
    board.moderate(moderator, row.id, { expectedRevision: row.revision, visibility: 'published' }, randomUUID()); return board.ownSubmissions(person).find(item => item.id === row.id)!;
  };
  return { db, a, b, c, steward, moderator, clock, now, board, deps, published };
}
export function featureRevision(f: BoardFixture, id: string): number { return f.board.detail(f.steward, id).feature.revision; }
export function vote(f: BoardFixture, actor: AccountContext, id: string, active = true, key = randomUUID()) {
  return f.board.setVote(actor, id, { active, expectedRevision: featureRevision(f, id) }, key);
}
export function merge(f: BoardFixture, sourceId: string, targetId: string, key = randomUUID()) {
  return f.board.merge(f.steward, { sourceId, targetId, sourceRevision: featureRevision(f, sourceId), targetRevision: featureRevision(f, targetId),
    reason: 'Same synthetic feature scope', semanticEquivalent: true }, key);
}
