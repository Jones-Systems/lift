import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { actor, bindings, eligibility, fixture, type CommunityFixture } from './fixture.js';
import { createCommunityExtension, type CommunityExtensionService } from '../../src/community/extension-service.js';
import type { BatchAuthority, EnrollmentPreferences, ExtensionDependencies } from '../../src/community/extension-types.js';
export const syntheticPreferences = (extra: Partial<EnrollmentPreferences> = {}): EnrollmentPreferences => ({ alias: 'Synthetic member', intent: 'accountability', language: 'en', goals: ['consistency'], region: null, location: 'anywhere', priorities: ['location', 'goals'], relax: { broaderRegion: true, mixedGoals: true }, willingHost: true, fillExistingGroups: false, membershipDisclosureAccepted: true, policyVersion: 'community-v1', ...extra });
export type B4Fixture = CommunityFixture & { extension: CommunityExtensionService; people: ReturnType<typeof actor>[]; dependencies: ExtensionDependencies; batch: BatchAuthority };
export function b4Fixture(extra: Partial<ExtensionDependencies> = {}): B4Fixture {
 const f = fixture();
 const people = [f.a, f.b, f.c, f.outsider, actor(f.db), actor(f.db)]; for (const person of people.slice(1)) f.join(person);
 f.db.prepare("INSERT INTO community_group_policy VALUES(?,'matched','accountability',12,1,'community-v1',NULL)").run(f.group.id);
 const batch: BatchAuthority = {
  withEnrollmentWrite: <T>(effect: () => T): T => f.db.transaction(effect).immediate(),
  current: accountId => ({ active: eligibility(f.db, accountId).status === 'eligible', eligibility: eligibility(f.db, accountId), exclusionRevision: 0 }),
  snapshot: (_policy, intent, language) => ({ intent, language, exclusionsKnown: true, exclusionGeneration: 0, excludedPairs: [], candidates:
   (f.db.prepare("SELECT * FROM community_match_enrollments WHERE state='queued' ORDER BY id LIMIT 501").all() as { id: string; account_id: string; revision: number; generation: number; queued_at: string; consent_at: string; preferences: string }[]).map(row => ({ enrollmentId: row.id, accountId: row.account_id, revision: row.revision, generation: row.generation, queuedAt: row.queued_at, consentAt: row.consent_at, eligible: true, exclusionRevision: 0, preferences: JSON.parse(row.preferences) as EnrollmentPreferences })) }),
 };
 const dependencies: ExtensionDependencies = { db: f.db, now: f.now, lifecycle: bindings(f.db), subjectEligibility: id => eligibility(f.db, id), accountCreatedAt: () => '2026-09-01T00:00:00.000Z',
  textModeration: { policyVersion: 'community-v1', checkText: () => 'allowed' }, support: { qualified: true }, retention: { qualified: true }, assertRateLimit: () => {},
  batch, moderation: { withReviewWrite: <T>(effect: () => T): T => f.db.transaction(effect).immediate(), assertReview: () => {}, assertAppealReview: () => {} }, ...extra };
 return { ...f, extension: createCommunityExtension(dependencies), people, dependencies, batch };
}
export function syntheticCandidates(db: Database.Database, extension: CommunityExtensionService, count: number): ReturnType<typeof actor>[] {
 const people = Array.from({ length: count }, () => actor(db)); for (const person of people) extension.enroll(person, { expectedRevision: 0, preferences: syntheticPreferences() }, randomUUID()); return people;
}
