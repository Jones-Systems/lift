import { Hono, type Context } from 'hono';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { CommunityExtensionService } from './extension-service.js';
export const COMMUNITY_EXTENSION_BODY_MAX_BYTES = 8192;
type RequestBinding = Readonly<{ actor: AccountContext; service: CommunityExtensionService }>;
export type CommunityExtensionEnvironment = { Variables: { communityExtension: RequestBinding } };
export type CommunityExtensionRouteDependencies = Readonly<{ context: (c: Context) => AccountContext; serviceFor: (actor: AccountContext, c: Context) => CommunityExtensionService }>;
async function body(c: Context): Promise<unknown> {
 if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) throw new DomainError(415, 'community_json_required');
 const length = c.req.header('content-length'); if (length && (!/^\d+$/.test(length) || Number(length) > COMMUNITY_EXTENSION_BODY_MAX_BYTES)) throw new DomainError(413, 'community_body_too_large');
 const reader = c.req.raw.body?.getReader(); if (!reader) throw new DomainError(422, 'community_invalid_input'); const chunks: Uint8Array[] = []; let size = 0;
 try { for (;;) { const read = await reader.read(); if (read.done) break; size += read.value.byteLength; if (size > COMMUNITY_EXTENSION_BODY_MAX_BYTES) { await reader.cancel(); throw new DomainError(413, 'community_body_too_large'); } chunks.push(read.value); } } finally { reader.releaseLock(); }
 try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new DomainError(422, 'community_invalid_input'); }
}
const key = (c: Context): string => { const value = c.req.header('idempotency-key'); if (!value) throw new DomainError(400, 'idempotency_key_required'); return value; };
export function createCommunityExtensionRoutes(deps: CommunityExtensionRouteDependencies): Hono<CommunityExtensionEnvironment> {
 const routes = new Hono<CommunityExtensionEnvironment>(); const request = (c: Context<CommunityExtensionEnvironment>) => c.get('communityExtension');
 routes.use('*', async (c, next) => { c.header('cache-control', 'no-store'); const actor = Object.freeze({ ...deps.context(c) }); const service = deps.serviceFor(actor, c); c.set('communityExtension', Object.freeze({ actor, service })); await next(); });
 routes.onError((error, c) => { c.header('cache-control', 'no-store'); return error instanceof DomainError ? c.json({ error: { code: error.code, ...(error.code === 'stale_revision' ? { details: error.details } : {}) } }, error.status) : c.json({ error: { code: 'community_unavailable' } }, 503); });
 routes.get('/me/matching', c => c.json(request(c).service.readMatching(request(c).actor)));
 routes.post('/me/matching/enroll', async c => c.json(request(c).service.enroll(request(c).actor, await body(c), key(c))));
 routes.patch('/me/matching', async c => c.json(request(c).service.enroll(request(c).actor, await body(c), key(c))));
 routes.post('/me/matching/cancel', async c => c.json(request(c).service.cancelEnrollment(request(c).actor, await body(c), key(c))));
 routes.get('/groups/:groupId/policy', c => c.json(request(c).service.readPolicy(request(c).actor, c.req.param('groupId'))));
 routes.get('/groups/:groupId/me/profile-sharing', c => c.json(request(c).service.readProfile(request(c).actor, c.req.param('groupId'))));
 routes.patch('/groups/:groupId/me/profile-sharing', async c => c.json(request(c).service.updateProfile(request(c).actor, c.req.param('groupId'), await body(c), key(c))));
 routes.get('/groups/:groupId/profiles', c => c.json(request(c).service.rosterProfiles(request(c).actor, c.req.param('groupId'))));
 routes.get('/groups/:groupId/posts', c => { const query = new URL(c.req.url).searchParams; if ([...query.keys()].some(k => !['cursor', 'limit'].includes(k)) || query.getAll('cursor').length > 1 || query.getAll('limit').length > 1 || (query.has('limit') && !/^\d{1,2}$/.test(query.get('limit')!))) throw new DomainError(422, 'community_invalid_input'); return c.json(request(c).service.readPostsPage(request(c).actor, c.req.param('groupId'), query.get('cursor') ?? undefined, query.has('limit') ? Number(query.get('limit')) : 20)); });
 routes.post('/groups/:groupId/posts', async c => c.json(request(c).service.createPost(request(c).actor, c.req.param('groupId'), await body(c), key(c)), 201));
 routes.post('/groups/:groupId/posts/:postId/hide', async c => c.json(request(c).service.hidePost(request(c).actor, c.req.param('groupId'), c.req.param('postId'), await body(c), key(c))));
 routes.post('/groups/:groupId/posts/:postId/react', async c => c.json(request(c).service.setReaction(request(c).actor, c.req.param('groupId'), c.req.param('postId'), await body(c), key(c))));
 routes.get('/groups/:groupId/motions', c => c.json(request(c).service.listMotions(request(c).actor, c.req.param('groupId'))));
 routes.get('/groups/:groupId/me/friend-reservations', c => c.json(request(c).service.listFriendReservations(request(c).actor, c.req.param('groupId'))));
 routes.get('/groups/:groupId/me/friend-reservations/:reservationId/invitation', c => { if (new URL(c.req.url).searchParams.size) throw new DomainError(422, 'community_invalid_input'); return c.json(request(c).service.readFriendInvitation(request(c).actor, c.req.param('groupId'), c.req.param('reservationId'))); });
 routes.post('/groups/:groupId/motions', async c => c.json(request(c).service.createMotion(request(c).actor, c.req.param('groupId'), await body(c), key(c)), 201));
 routes.post('/groups/:groupId/motions/:motionId/ballot', async c => c.json(request(c).service.setBallot(request(c).actor, c.req.param('groupId'), c.req.param('motionId'), await body(c), key(c))));
 routes.post('/groups/:groupId/motions/:motionId/finalize', async c => c.json(request(c).service.finalizeMotionCommand(request(c).actor, c.req.param('groupId'), c.req.param('motionId'), await body(c), key(c))));
 routes.post('/groups/:groupId/members/:memberId/block', async c => c.json(request(c).service.blockMember(request(c).actor, c.req.param('groupId'), c.req.param('memberId'), await body(c), key(c))));
 routes.get('/me/blocks', c => c.json(request(c).service.listBlocks(request(c).actor)));
 routes.post('/me/blocks/:blockId/unblock', async c => c.json(request(c).service.unblock(request(c).actor, c.req.param('blockId'), await body(c), key(c))));
 routes.post('/groups/:groupId/safety-references', async c => c.json(request(c).service.createSafetyReference(request(c).actor, c.req.param('groupId'), await body(c), key(c)), 201));
 routes.post('/reports', async c => c.json(request(c).service.report(request(c).actor, await body(c), key(c)), 201));
 routes.get('/me/reports', c => c.json(request(c).service.listReports(request(c).actor)));
 routes.get('/me/safety-notices', c => c.json(request(c).service.listNotices(request(c).actor)));
 routes.post('/me/safety-notices/:noticeId/appeal', async c => c.json(request(c).service.appeal(request(c).actor, c.req.param('noticeId'), await body(c), key(c)), 201));
 routes.get('/me/appeals', c => c.json(request(c).service.listAppeals(request(c).actor)));
 routes.get('/groups/:groupId/rankings', c => { const query = new URL(c.req.url).searchParams; if ([...query.keys()].some(k => k !== 'metric') || query.getAll('metric').length !== 1) throw new DomainError(422, 'community_invalid_input'); return c.json(request(c).service.rankings(request(c).actor, c.req.param('groupId'), query.get('metric')!)); });
 return routes;
}
