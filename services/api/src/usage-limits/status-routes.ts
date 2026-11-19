import { Hono, type Context, type Env } from 'hono';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { UsageLimitsPort } from './types.js';

// Mount under /v1/usage after account authentication supplies the current session and epoch.
export function createUsageStatusRoutes<E extends Env>(bindings: Readonly<{
  context(c: Context<E>): AccountContext | undefined;
  usage: Pick<UsageLimitsPort, 'status'>;
}>): Hono<E> {
  const app = new Hono<E>();
  app.get('/', c => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const actor = bindings.context(c);
    if (!actor) throw new DomainError(401, 'unauthenticated');
    if (new URL(c.req.url).searchParams.size) throw new DomainError(422, 'invalid_request');
    return c.json(bindings.usage.status(actor));
  });
  return app;
}
