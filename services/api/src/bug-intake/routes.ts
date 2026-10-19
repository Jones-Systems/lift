import { Hono, type Context, type Env } from 'hono';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { bugIntakeLimits, parseKey } from './schemas.js';
import type { BugIntakeService } from './service.js';

export type BugIntakeRouteBindings<E extends Env> = Readonly<{
  context: (context: Context<E>) => AccountContext;
  serviceFor: (context: AccountContext) => BugIntakeService;
}>;
async function body<E extends Env>(c: Context<E>, service: BugIntakeService): Promise<unknown> {
  if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new DomainError(415, 'json_required');
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new DomainError(400, 'invalid_json');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); service.assertActive();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > bugIntakeLimits.bodyBytes) throw new DomainError(413, 'body_too_large');
      chunks.push(chunk.value);
    }
    service.assertActive();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new DomainError(400, 'invalid_json'); }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original denial without exposing stream errors. */ }
    throw error;
  } finally { reader.releaseLock(); }
}
// The composition root mounts this factory under /v1/bug-reports and supplies authenticated context per request.
export function createBugIntakeRoutes<E extends Env>(bindings: BugIntakeRouteBindings<E>): Hono<E> {
  const app = new Hono<E>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.onError((error, c) => error instanceof DomainError
    ? c.json({ error: { code: error.code } }, error.status)
    : c.json({ error: { code: 'bug_intake_unavailable' } }, 503));
  const serviceFor = (c: Context<E>) => {
    const context = bindings.context(c);
    if (!context) throw new DomainError(401, 'authentication_required');
    const service = bindings.serviceFor(context); service.assertActive(); return service;
  };
  const response = (service: BugIntakeService, value: unknown, status: 200 | 201 = 200) => {
    service.assertActive(); const serialized = JSON.stringify(value); service.assertActive();
    return new Response(serialized, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  };
  app.post('/', async c => {
    const service = serviceFor(c), key = parseKey(c.req.header('Idempotency-Key'));
    const raw = await body(c, service);
    const result = service.submit(raw, key);
    return response(service, result, result.replayed || result.duplicate ? 200 : 201);
  });
  app.get('/', c => {
    const service = serviceFor(c), query = c.req.query();
    const params = new URL(c.req.url).searchParams;
    if (params.getAll('limit').length > 1 || params.getAll('after').length > 1) throw new DomainError(400, 'invalid_bug_report_page');
    if (Object.keys(query).some(key => key !== 'after' && key !== 'limit')) throw new DomainError(400, 'invalid_bug_report_page');
    if (query.limit !== undefined && !/^[1-9][0-9]?$/.test(query.limit)) throw new DomainError(400, 'invalid_bug_report_page');
    return response(service, { reports: service.list({ ...(query.limit === undefined ? {} : { limit: Number(query.limit) }), ...(query.after === undefined ? {} : { after: query.after }) }) });
  });
  app.get('/:id', c => { const service = serviceFor(c); return response(service, { report: service.get(c.req.param('id')) }); });
  return app;
}
