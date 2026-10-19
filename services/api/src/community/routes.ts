import { Hono, type Context } from 'hono';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { CommunityService } from './service.js';

export const COMMUNITY_BODY_MAX_BYTES = 8192;
export type CommunityRequestService = Readonly<{ actor: AccountContext; service: CommunityService }>;
export type CommunityRouteEnvironment = { Variables: { communityRequest: CommunityRequestService } };
export type CommunityRouteDependencies = { context: (context: Context) => AccountContext } & (
  | { service: CommunityService; serviceFor?: never }
  | { service?: never; serviceFor: (actor: AccountContext, context: Context) => CommunityService }
);
async function body(context: Context): Promise<unknown> {
  const request = context.req.raw;
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new DomainError(415, 'community_json_required');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > COMMUNITY_BODY_MAX_BYTES)) throw new DomainError(413, 'community_body_too_large');
  const reader = request.body?.getReader(); if (!reader) throw new DomainError(422, 'community_invalid_input');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const read = await reader.read(); if (read.done) break;
      size += read.value.byteLength; if (size > COMMUNITY_BODY_MAX_BYTES) { await reader.cancel(); throw new DomainError(413, 'community_body_too_large'); }
      chunks.push(read.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new DomainError(422, 'community_invalid_input'); }
}
function key(context: Context): string {
  const value = context.req.header('idempotency-key'); if (!value) throw new DomainError(400, 'idempotency_key_required'); return value;
}
export function createCommunityRoutes(deps: CommunityRouteDependencies): Hono<CommunityRouteEnvironment> {
  const routes = new Hono<CommunityRouteEnvironment>();
  const request = (c: Context<CommunityRouteEnvironment>): CommunityRequestService => c.get('communityRequest');
  routes.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    const actor = Object.freeze({ ...deps.context(c) });
    const service = deps.serviceFor ? deps.serviceFor(actor, c) : deps.service;
    if (!service) throw new DomainError(503, 'community_unavailable');
    c.set('communityRequest', Object.freeze({ actor, service }));
    await next();
  });
  routes.onError((error, c) => error instanceof DomainError
    ? c.json({ error: { code: error.code, ...(error.code === 'stale_revision' ? { details: error.details } : {}) } }, error.status)
    : c.json({ error: { code: 'community_unavailable' } }, 503));
  routes.get('/me/removed-memberships', c => { if (new URL(c.req.url).searchParams.size) throw new DomainError(422, 'community_invalid_input'); return c.json(request(c).service.listRemovedMemberships(request(c).actor)); });
  routes.get('/groups', c => c.json(request(c).service.listGroups(request(c).actor)));
  routes.post('/groups', async c => { const actor = request(c).actor; const input = await body(c); return c.json(request(c).service.createGroup(actor, input, key(c)), 201); });
  routes.get('/groups/:groupId', c => c.json(request(c).service.readGroup(request(c).actor, c.req.param('groupId'))));
  routes.patch('/groups/:groupId', async c => { const actor = request(c).actor; return c.json(request(c).service.renameGroup(actor, c.req.param('groupId'), await body(c), key(c))); });
  routes.get('/groups/:groupId/invitations', c => c.json(request(c).service.listInvitations(request(c).actor, c.req.param('groupId'))));
  routes.post('/groups/:groupId/invitations', async c => { const actor = request(c).actor; return c.json(request(c).service.issueInvitation(actor, c.req.param('groupId'), await body(c), key(c)), 201); });
  routes.post('/groups/:groupId/reservations/:reservationId/invitations', async c => { const binding = request(c); return c.json(binding.service.issueFriendInvitation(binding.actor, c.req.param('groupId'), c.req.param('reservationId'), await body(c), key(c)), 201); });
  routes.post('/invitations/preview', async c => { const actor = request(c).actor; return c.json(request(c).service.previewInvitation(actor, await body(c))); });
  routes.post('/invitations/join', async c => { const actor = request(c).actor; return c.json(request(c).service.joinInvitation(actor, await body(c), key(c)), 201); });
  routes.post('/groups/:groupId/invitations/:inviteId/revoke', async c => { const actor = request(c).actor; return c.json(request(c).service.revokeInvitation(actor, c.req.param('groupId'), c.req.param('inviteId'), await body(c), key(c))); });
  routes.post('/groups/:groupId/invitations/:inviteId/replace', async c => { const actor = request(c).actor; return c.json(request(c).service.replaceInvitation(actor, c.req.param('groupId'), c.req.param('inviteId'), await body(c), key(c)), 201); });
  routes.get('/groups/:groupId/me/sharing', c => c.json(request(c).service.readSharing(request(c).actor, c.req.param('groupId'))));
  routes.patch('/groups/:groupId/me/sharing', async c => { const actor = request(c).actor; return c.json(request(c).service.updateSharing(actor, c.req.param('groupId'), await body(c), key(c))); });
  routes.post('/groups/:groupId/me/withdraw', async c => { const actor = request(c).actor; return c.json(request(c).service.withdraw(actor, c.req.param('groupId'), await body(c), key(c))); });
  routes.patch('/groups/:groupId/me', async c => { const actor = request(c).actor; return c.json(request(c).service.updateAlias(actor, c.req.param('groupId'), await body(c), key(c))); });
  routes.post('/groups/:groupId/leave', async c => { const actor = request(c).actor; return c.json(request(c).service.leave(actor, c.req.param('groupId'), await body(c), key(c))); });
  routes.post('/groups/:groupId/members/:memberId/remove', async c => { const actor = request(c).actor; return c.json(request(c).service.removeMember(actor, c.req.param('groupId'), c.req.param('memberId'), await body(c), key(c))); });
  routes.patch('/groups/:groupId/members/:memberId/role', async c => { const actor = request(c).actor; return c.json(request(c).service.updateRole(actor, c.req.param('groupId'), c.req.param('memberId'), await body(c), key(c))); });
  routes.post('/groups/:groupId/members/:memberId/allow-reinvite', async c => { const actor = request(c).actor; return c.json(request(c).service.allowReinvite(actor, c.req.param('groupId'), c.req.param('memberId'), await body(c), key(c))); });
  routes.post('/groups/:groupId/close', async c => { const actor = request(c).actor; return c.json(request(c).service.closeGroup(actor, c.req.param('groupId'), await body(c), key(c))); });
  routes.get('/groups/:groupId/summary', c => {
    const query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some(k => !['from', 'to'].includes(k)) || query.getAll('from').length !== 1 || query.getAll('to').length !== 1)
      throw new DomainError(422, 'community_invalid_input');
    return c.json(request(c).service.readSummary(request(c).actor, c.req.param('groupId'), { from: query.get('from'), to: query.get('to') }));
  });
  return routes;
}
