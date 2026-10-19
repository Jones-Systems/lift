import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AccountContext } from '../lifecycle/types.js';
import { DomainError } from '../errors.js';
import { MANUAL_RETENTION_HEADER, parseManualRetentionHeader } from './manual-retention-contract.js';
import type { ManualRetention } from './manual-retention.js';
import type { ManualMeasurements } from './measurements.js';

export function createBodyMeasurementRoutes(deps: { context(c: Context): AccountContext; serviceFor?: (actor: AccountContext) => ManualMeasurements }) {
  const routes = new Hono();
  const service = (c: Context) => { const actor = deps.context(c); if (!deps.serviceFor) throw new DomainError(501, 'body_retention_unavailable'); return { actor, service: deps.serviceFor(actor) }; };
  routes.use('*', async (c, next) => { service(c); await next(); });
  routes.use('*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: { code: 'body_too_large' } }, 413) }));
  const body = async (c: Context): Promise<unknown> => { if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new DomainError(415, 'json_required'); try { return await c.req.json(); } catch { throw new DomainError(422, 'body_invalid_input'); } };
  const key = (c: Context) => { const key = c.req.header('idempotency-key'); if (!key) throw new DomainError(400, 'idempotency_key_required'); return key; };
  routes.get('/', c => { const binding = service(c), query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some(key => !['from', 'to'].includes(key) || query.getAll(key).length !== 1)) throw new DomainError(422, 'body_invalid_input');
    return c.json(binding.service.list(binding.actor, Object.fromEntries(query))); });
  routes.post('/', async c => { const binding = service(c);
    // Request Headers combines duplicate custom fields with commas; the exact parser rejects those values.
    const authority = parseManualRetentionHeader(c.req.raw.headers.get(MANUAL_RETENTION_HEADER));
    return c.json(binding.service.create(binding.actor, await body(c), key(c), authority), 201); });
  routes.post('/:id/delete', async c => { const binding = service(c); return c.json(binding.service.delete(binding.actor, c.req.param('id'), await body(c), key(c))); });
  return routes;
}

export function createManualRetentionRoutes(deps: { context(c: Context): AccountContext; serviceFor?: (actor: AccountContext) => ManualRetention }) {
  const routes = new Hono();
  const binding = (c: Context) => { const actor = deps.context(c);
    if (!deps.serviceFor) throw new DomainError(501, 'body_manual_retention_unavailable');
    return { actor, service: deps.serviceFor(actor) };
  };
  routes.use('*', async (c, next) => { binding(c); await next(); });
  routes.use('*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: { code: 'body_too_large' } }, 413) }));
  const body = async (c: Context): Promise<unknown> => {
    if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new DomainError(415, 'json_required');
    try { return await c.req.json(); } catch { throw new DomainError(422, 'body_manual_retention_invalid_input'); }
  };
  const key = (c: Context) => { const value = c.req.header('idempotency-key');
    if (!value) throw new DomainError(400, 'idempotency_key_required'); return value;
  };
  routes.post('/', async c => { const { actor, service } = binding(c); return c.json(service.grant(actor, await body(c), key(c))); });
  routes.post('/:decisionId/revoke', async c => { const { actor, service } = binding(c);
    return c.json(service.revoke(actor, c.req.param('decisionId'), await body(c), key(c))); });
  routes.get('/:decisionId', c => { const { actor, service } = binding(c);
    if (new URL(c.req.url).search) throw new DomainError(422, 'body_manual_retention_invalid_input');
    return c.json(service.current(actor, c.req.param('decisionId'))); });
  return routes;
}
