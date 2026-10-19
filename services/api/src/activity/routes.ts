import type { Context, Env, Hono } from 'hono';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { CommandResult } from '../storage.js';
import type { ActivityService } from './service.js';

export type ActivityRouteBindings<E extends Env> = Readonly<{ service: ActivityService; context: (context: Context<E>) => AccountContext }>;
export function mountActivityRoutes<E extends Env>(app: Hono<E>, bindings: ActivityRouteBindings<E>): void {
  const { service } = bindings;
  const actor = (c: Context<E>) => {
    if (!bindings.context) throw new DomainError(503, 'activity_context_binding_required');
    const context = bindings.context(c); service.assertActive(context); return context;
  };
  const response = (context: AccountContext, body: unknown, status = 200) => {
    service.assertActive(context);
    const serialized = JSON.stringify(body);
    service.assertActive(context);
    return new Response(serialized, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  };
  const parseBody = async (c: Context<E>, context: AccountContext): Promise<unknown> => {
    service.assertActive(context);
    if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new DomainError(415, 'json_required');
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new DomainError(400, 'invalid_json');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); service.assertActive(context);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 64 * 1024) { await reader.cancel(); service.assertActive(context); throw new DomainError(413, 'body_too_large'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    service.assertActive(context);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new DomainError(400, 'invalid_json'); }
  };
  const get = (path: string, read: (context: AccountContext, c: Context<E>) => unknown) => {
    app.get(`/v1/activity${path}`, c => { const context = actor(c); const value = read(context, c); return response(context, value); });
  };
  const write = (method: 'post' | 'patch', path: string, effect: (context: AccountContext, key: string | undefined, input: unknown, c: Context<E>) => CommandResult) => {
    app[method](`/v1/activity${path}`, async c => {
      const context = actor(c), body = await parseBody(c, context);
      service.assertActive(context);
      const result = effect(context, c.req.header('Idempotency-Key'), body, c);
      service.assertActive(context);
      return response(context, result.body, result.status);
    });
  };
  get('/capabilities', context => service.capabilities(context));
  get('/calendar', context => service.calendar(context));
  write('post', '/calendar', (context, key, body) => service.createCalendar(context, key, body));
  get('/catalog', context => service.catalog(context));
  get('/exercises', (context, c) => service.exercises(context, c.req.query()));
  get('/exercises/:id', (context, c) => service.exercise(context, c.req.param('id')!));
  write('post', '/exercises', (context, key, body) => service.createExercise(context, key, body));
  write('patch', '/exercises/:id', (context, key, body, c) => service.patchExercise(context, c.req.param('id')!, key, body));
  write('post', '/exercises/:id/retire', (context, key, body, c) => service.retireExercise(context, c.req.param('id')!, key, body));
  get('/plans', (context, c) => service.plans(context, c.req.query()));
  get('/plans/:id', (context, c) => service.plan(context, c.req.param('id')!));
  write('post', '/plans', (context, key, body) => service.createPlan(context, key, body));
  write('post', '/plans/import-legacy', (context, key, body) => service.importLegacyPlan(context, key, body));
  write('patch', '/plans/:id', (context, key, body, c) => service.patchPlan(context, c.req.param('id')!, key, body));
  write('post', '/plans/:id/archive', (context, key, body, c) => service.archivePlan(context, c.req.param('id')!, key, body));
  get('/schedule', context => service.schedule(context));
  write('post', '/schedule', (context, key, body) => service.writeSchedule(context, key, body));
  write('post', '/schedule/days/:date/correct', (context, key, body, c) => service.correctDay(context, c.req.param('date')!, key, body));
  get('/entries', (context, c) => service.entries(context, c.req.query()));
  get('/entries/:id', (context, c) => service.entry(context, c.req.param('id')!));
  write('post', '/entries', (context, key, body) => service.createEntry(context, key, body));
  write('patch', '/entries/:id', (context, key, body, c) => service.patchEntry(context, c.req.param('id')!, key, body));
  write('post', '/entries/:id/void', (context, key, body, c) => service.voidEntry(context, c.req.param('id')!, key, body));
  get('/adherence', (context, c) => service.adherence(context, c.req.query()));
}
