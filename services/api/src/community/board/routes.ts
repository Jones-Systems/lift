import { Hono, type Context } from 'hono';
import { DomainError } from '../../errors.js';
import type { AccountContext } from './types.js';
import type { FeatureBoardService } from './service.js';
export const FEATURE_BOARD_BODY_MAX_BYTES = 8192;
export type FeatureBoardRouteDependencies = { context: (context: Context) => AccountContext } & (
  | { service: FeatureBoardService; serviceFor?: never }
  | { service?: never; serviceFor: (actor: AccountContext, context: Context) => FeatureBoardService }
);
type RequestScope = Readonly<{ actor: AccountContext; service: FeatureBoardService }>;
export type FeatureBoardRouteEnvironment = { Variables: { featureBoardRequest: RequestScope } };
async function body(c: Context): Promise<unknown> {
  const req = c.req.raw;
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) throw new DomainError(415, 'board_json_required');
  const length = req.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > FEATURE_BOARD_BODY_MAX_BYTES)) throw new DomainError(413, 'board_body_too_large');
  const reader = req.body?.getReader(); if (!reader) throw new DomainError(422, 'board_invalid_input');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > FEATURE_BOARD_BODY_MAX_BYTES) { await reader.cancel(); throw new DomainError(413, 'board_body_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new DomainError(422, 'board_invalid_input'); }
}
function key(c: Context): string {
  const key = c.req.header('idempotency-key'); if (!key) throw new DomainError(400, 'idempotency_key_required'); return key;
}
function query(c: Context): Record<string, unknown> {
  const params = new URL(c.req.url).searchParams; const result: Record<string, unknown> = {};
  for (const [name, value] of params) {
    if (name in result || !['q', 'category', 'status', 'mine', 'sort', 'page', 'pageSize'].includes(name)) throw new DomainError(422, 'board_invalid_input');
    if (name === 'page' || name === 'pageSize') {
      if (!/^[1-9]\d{0,3}$/.test(value)) throw new DomainError(422, 'board_invalid_input'); result[name] = Number(value);
    } else result[name] = value;
  }
  return result;
}
export function createFeatureBoardRoutes(deps: FeatureBoardRouteDependencies): Hono<FeatureBoardRouteEnvironment> {
  const routes = new Hono<FeatureBoardRouteEnvironment>();
  const scope = (c: Context<FeatureBoardRouteEnvironment>) => c.get('featureBoardRequest');
  routes.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    const actor = Object.freeze({ ...deps.context(c) }); const service = deps.serviceFor ? deps.serviceFor(actor, c) : deps.service;
    if (!service) throw new DomainError(503, 'board_unavailable'); service.assertActor(actor);
    c.set('featureBoardRequest', Object.freeze({ actor, service })); await next();
  });
  routes.onError((error, c) => {
    c.header('cache-control', 'no-store');
    return error instanceof DomainError ? c.json({ error: { code: error.code,
      ...(error.code === 'stale_revision' ? { details: error.details } : {}) } }, error.status)
      : c.json({ error: { code: 'board_unavailable' } }, 503);
  });
  routes.post('/submissions/:id/correct', async c => c.json(scope(c).service.correct(scope(c).actor, c.req.param('id'), await body(c), key(c)), 201));
  routes.get('/capabilities', c => c.json(scope(c).service.capabilities(scope(c).actor)));
  routes.get('/features', c => c.json(scope(c).service.browse(scope(c).actor, query(c))));
  routes.post('/features', async c => c.json(scope(c).service.submit(scope(c).actor, await body(c), key(c)), 201));
  routes.get('/features/:id', c => c.json(scope(c).service.detail(scope(c).actor, c.req.param('id'))));
  routes.post('/features/:id/vote', async c => c.json(scope(c).service.setVote(scope(c).actor, c.req.param('id'), await body(c), key(c))));
  routes.post('/features/:id/report', async c => c.json(scope(c).service.report(scope(c).actor, c.req.param('id'), await body(c), key(c)), 202));
  routes.post('/submissions/:id/withdraw', async c => c.json(scope(c).service.withdraw(scope(c).actor, c.req.param('id'), await body(c), key(c))));
  routes.get('/me/submissions', c => c.json({ submissions: scope(c).service.ownSubmissions(scope(c).actor, query(c)) }));
  routes.get('/me/votes', c => c.json({ votes: scope(c).service.ownVotes(scope(c).actor, query(c)) }));
  return routes;
}
