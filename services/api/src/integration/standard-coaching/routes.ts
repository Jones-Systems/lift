import { Hono, type Context, type Env } from 'hono';
import { DomainError } from '../../errors.js';
import type { AccountContext, LifecycleBindings } from '../../lifecycle/types.js';
import { createCoachingRequestScope } from '../../voice-coaching/request-scope.js';
import { StandardWireError } from '../../voice-coaching/standard/wire-codec.js';
import { createStandardCoachingComposition, type StandardCoachingConfiguration } from './composition.js';

/** Unmounted source router. Mount under /v1/coaching/standard after independent authenticated account middleware. */
export function createStandardCoachingRoutes<E extends Env>(bindings: Readonly<{
  context(context: Context<E>): AccountContext;
  lifecycle: Pick<LifecycleBindings, 'assertActive'>;
  configuration?: StandardCoachingConfiguration;
}>): Hono<E> {
  const app = new Hono<E>();
  const composition = createStandardCoachingComposition(bindings.configuration);
  app.post('/turn', async c => {
    const actor = bindings.context(c);
    if (!actor || !actor.accountId || !actor.authUserId || !actor.sessionId || !Number.isSafeInteger(actor.epoch) || actor.epoch < 0)
      throw new DomainError(401, 'unauthenticated');
    bindings.lifecycle.assertActive(actor);
    if (!composition) throw new DomainError(503, 'standard_coaching_unavailable');
    if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new DomainError(415, 'json_required');
    const abort = new AbortController(), originalSignal = c.req.raw.signal;
    const cancel = () => abort.abort();
    originalSignal.addEventListener('abort', cancel, { once: true });
    if (originalSignal.aborted) cancel();
    const timer = setTimeout(cancel, composition.deadlineMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      abort.signal.addEventListener('abort', () => {
        if (reader) void reader.cancel().catch(() => {});
        reject(new DomainError(503, 'standard_coaching_interrupted'));
      }, { once: true });
    });
    void interrupted.catch(() => {});
    try {
      const scope = createCoachingRequestScope(actor, bindings.lifecycle, abort.signal);
      const wait = async <T>(work: Promise<T>): Promise<T> => {
        scope.assertCurrent(); const value = await Promise.race([work, interrupted]); scope.assertCurrent(); return value;
      };
      reader = c.req.raw.body?.getReader();
      if (!reader) throw new DomainError(400, 'invalid_json');
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const part = await wait(reader.read());
        if (part.done) break;
        length += part.value.byteLength;
        if (length > composition.limits.maxEnvelopeBytes) throw new DomainError(413, 'body_too_large');
        chunks.push(part.value);
      }
      scope.assertCurrent();
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let request: string;
      try { request = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new DomainError(400, 'invalid_json'); }
      const response = await wait(composition.run(scope, request));
      scope.assertCurrent();
      return new Response(response, { status: 200, headers: {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    } catch (error) {
      if (abort.signal.aborted) throw new DomainError(503, 'standard_coaching_interrupted');
      if (error instanceof StandardWireError) throw new DomainError(error.code === 'size' ? 413 : 422, 'invalid_standard_wire');
      throw error;
    } finally {
      clearTimeout(timer); originalSignal.removeEventListener('abort', cancel);
      if (reader) void reader.cancel().catch(() => {});
      else if (c.req.raw.body && !c.req.raw.body.locked) void c.req.raw.body.cancel().catch(() => {});
    }
  });
  return app;
}
