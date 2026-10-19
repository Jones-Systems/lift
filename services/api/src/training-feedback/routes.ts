import { Hono, type Context, type Env } from 'hono';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { SourceTrainingFeedback } from '../integration/account-modules/index.js';
import { parseTrainingFeedbackEventRequest, parseTrainingFeedbackIdempotencyKey,
  parseTrainingFeedbackWitnessRequest, trainingFeedbackHttpLimits } from './request-schema.js';

export type TrainingFeedbackRouteBindings<E extends Env> = Readonly<{
  context(c: Context<E>): AccountContext;
  assertActive(actor: AccountContext): void;
  training: SourceTrainingFeedback | undefined;
}>;
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
async function body<E extends Env>(c: Context<E>, assertActive: () => void): Promise<unknown> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new DomainError(400, 'invalid_json');
  let done = false;
  try {
    assertActive();
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new DomainError(415, 'json_required');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      assertActive();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } finally { assertActive(); }
      if (chunk.done) { done = true; break; }
      size += chunk.value.byteLength;
      if (size > trainingFeedbackHttpLimits.bodyBytes) throw new DomainError(413, 'body_too_large');
      chunks.push(chunk.value);
    }
    assertActive();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new DomainError(400, 'invalid_json'); }
  } finally {
    try {
      if (!done) {
        // Cancellation must still run when the original principal is already denied.
        let denied: unknown;
        try { assertActive(); } catch (error) { denied = error; }
        try { await reader.cancel(); } catch { /* Cleanup never exposes a stream's private error. */ }
        finally { try { assertActive(); } catch (error) { denied ??= error; } }
        if (denied !== undefined) throw denied;
      }
    } finally { reader.releaseLock(); }
  }
}

// WS01 mounts this factory under /v1/training-feedback and supplies the authenticated request principal.
export function createTrainingFeedbackRoutes<E extends Env>(bindings: TrainingFeedbackRouteBindings<E>): Hono<E> {
  const app = new Hono<E>();
  app.onError((error) => new Response(JSON.stringify({ error: { code: error instanceof DomainError
    ? error.code : 'training_feedback_unavailable' } }), { status: error instanceof DomainError ? error.status : 503, headers }));
  function capture(c: Context<E>) {
    const original = bindings.context(c);
    if (!original) throw new DomainError(401, 'authentication_required');
    const actor = Object.freeze({ accountId: original.accountId, authUserId: original.authUserId,
      sessionId: original.sessionId, epoch: original.epoch });
    const assertActive = () => bindings.assertActive(actor);
    assertActive();
    if ([...new URL(c.req.url).searchParams].length) throw new DomainError(422, 'training_feedback_invalid_request');
    const training = bindings.training;
    if (!training) throw new DomainError(503, 'training_feedback_unavailable');
    const guarded = <T>(effect: () => T): T => { assertActive(); try { return effect(); } finally { assertActive(); } };
    const response = (value: unknown): Response => guarded(() => {
      const encoded = guarded(() => JSON.stringify(value));
      if (encoded === undefined) throw new DomainError(503, 'training_feedback_unavailable');
      return new Response(encoded, { status: 200, headers });
    });
    const requestBody = async () => {
      assertActive();
      try { return await body(c, assertActive); } finally { assertActive(); }
    };
    return { actor, training, guarded, response, requestBody, assertActive };
  }
  app.get('/', c => {
    const request = capture(c);
    return request.response(request.guarded(() => request.training.read(request.actor)));
  });
  app.post('/witness', async c => {
    const request = capture(c); request.assertActive();
    let raw: unknown;
    try { raw = await request.requestBody(); } finally { request.assertActive(); }
    const input = parseTrainingFeedbackWitnessRequest(raw);
    return request.response(request.guarded(() => request.training.witness(request.actor, input)));
  });
  app.post('/events', async c => {
    const request = capture(c), idempotencyKey = parseTrainingFeedbackIdempotencyKey(c.req.header('Idempotency-Key'));
    request.assertActive();
    let raw: unknown;
    try { raw = await request.requestBody(); } finally { request.assertActive(); }
    const input = parseTrainingFeedbackEventRequest(raw);
    return request.response(request.guarded(() => request.training.mutate(request.actor, { ...input, idempotencyKey,
      event: { ...input.event, accountId: request.actor.accountId } })));
  });
  return app;
}
