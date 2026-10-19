import { Hono, type Context, type Env } from 'hono';
import { DomainError } from '../../errors.js';
import type { AccountContext, LifecycleBindings } from '../../lifecycle/types.js';
import { nutritionEnvelope, nutritionSelection, nutritionSubmit, type NutritionWireOperation } from './wire.js';
import { nutritionLimits, type NutritionController } from './host.js';

async function readBody<E extends Env>(c: Context<E>, signal: AbortSignal, guard: () => void): Promise<unknown> {
  if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new DomainError(415, 'json_required');
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new DomainError(400, 'invalid_json');
  const chunks: Uint8Array[] = []; let size = 0;
  const check = () => { guard(); if (signal.aborted) throw new DomainError(400, 'request_aborted'); };
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    check();
    for (;;) {
      const chunk = await reader.read(); check();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16 * 1024) throw new DomainError(413, 'body_too_large');
      chunks.push(chunk.value);
    }
    check();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new DomainError(400, 'invalid_json'); }
  } catch (error) {
    cancel(); guard();
    throw error;
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export function createNutritionConversationRoutes<E extends Env>(bindings: {
  context: (context: Context<E>) => AccountContext;
  lifecycle: Pick<LifecycleBindings, 'assertActive'>;
  controller: NutritionController;
}): Hono<E> {
  const app = new Hono<E>();
  const register = (path: string, operation: NutritionWireOperation) => app.post(path, async c => {
    const actor = Object.freeze({ ...bindings.context(c) });
    const guard = () => bindings.lifecycle.assertActive(actor);
    guard();
    const lifetime = new AbortController();
    const abort = () => lifetime.abort();
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    if (c.req.raw.signal.aborted) abort();
    const timer = setTimeout(abort, nutritionLimits.deadlineMs); timer.unref();
    try {
      const raw = await readBody(c, lifetime.signal, guard); guard();
      const request = operation === 'submit' ? nutritionSubmit.parse(raw) :
        operation === 'selectCitation' ? nutritionSelection.parse(raw) : nutritionEnvelope.parse(raw);
      const delivery = await bindings.controller.dispatch(actor, operation, request, lifetime.signal, c.req.param('id'));
      const response = delivery.serialize();
      return new Response(response.json, { status: response.status, headers: {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    } finally {
      clearTimeout(timer); c.req.raw.signal.removeEventListener('abort', abort);
    }
  });
  register('/reset-fresh-empty', 'resetFreshEmpty');
  register('/:id/submit', 'submit');
  register('/:id/select-citation', 'selectCitation');
  register('/:id/snapshot', 'snapshot');
  register('/:id/dispose', 'dispose');
  return app;
}
