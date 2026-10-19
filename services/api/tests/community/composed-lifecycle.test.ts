import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../../src/errors.js';
import type { AccountContext, LifecycleAdapter, LifecycleResult } from '../../src/lifecycle/types.js';
import { createComposedCommunityLifecycleAdapter, type CommunityAdapterSet, type ComposedCommunityResult } from '../../src/community/composed-lifecycle.js';
const actor: AccountContext = { accountId: 'synthetic-account', authUserId: 'synthetic-user', sessionId: 'synthetic-session', epoch: 0 };
function adapters(log: string[], extra: Partial<Record<'b2' | 'b4' | 'b5', Partial<LifecycleAdapter>>> = {}): CommunityAdapterSet {
  const make = (name: 'b2' | 'b4' | 'b5'): LifecycleAdapter => ({ category: 'community',
    inventory: () => { log.push(`${name}:inventory`); return { category: 'community', status: 'complete', count: 1 }; },
    export: (_actor, snapshot) => { log.push(`${name}:export`); snapshot.append('community', { module: name, snapshot: snapshot.snapshotAtMs }); return { category: 'community', status: 'complete', count: 1 }; },
    suppress: () => { log.push(`${name}:suppress`); return { status: 'complete', count: 1 }; },
    verifySuppressed: () => { log.push(`${name}:verify`); return { status: 'complete' }; },
    purge: () => { log.push(`${name}:purge`); return { status: 'pending', reason: `${name}:unqualified` }; },
    ...extra[name] });
  return { b2: make('b2'), b4: make('b4'), b5: make('b5') };
}
const bounds = (log: string[], sizes: readonly number[] = [50, 50, 50]) => ({
  b2: () => { log.push('b2:bound'); return { rows: 1, bytes: sizes[0]! }; },
  b4: () => { log.push('b4:bound'); return { rows: 1, bytes: sizes[1]! }; },
  b5: () => { log.push('b5:bound'); return { rows: 1, bytes: sizes[2]! }; },
});

test('composition preserves each inventory status and never sums partial success', () => {
  const log: string[] = [];
  const adapter = createComposedCommunityLifecycleAdapter(adapters(log, {
    b4: { inventory: () => { log.push('b4:inventory'); return { category: 'community', status: 'retained', reason: 'safety_hold', count: 4 }; } },
    b5: { inventory: () => { log.push('b5:inventory'); return { category: 'community', status: 'unavailable', reason: 'missing_boundary' }; } },
  }), { assertSerialized: () => {}, exportBounds: bounds(log) });
  const result = adapter.inventory(actor) as ComposedCommunityResult;
  assert.equal(result.status, 'unavailable'); assert.equal(result.count, undefined);
  assert.deepEqual(result.modules.b4, { category: 'community', status: 'retained', reason: 'safety_hold', count: 4 });
  assert.equal(result.modules.b5.reason, 'missing_boundary');
  assert.deepEqual(log, ['b2:inventory', 'b4:inventory', 'b5:inventory']);
});

test('composition invokes every export with actual snapshot sink after all bounds', () => {
  const log: string[] = [], output: unknown[] = [];
  const adapter = createComposedCommunityLifecycleAdapter(adapters(log), { assertSerialized: () => {}, exportBounds: bounds(log) });
  const result = adapter.export(actor, { snapshotAtMs: 123, append: (category, value) => { assert.equal(category, 'community'); output.push(value); } }) as ComposedCommunityResult;
  assert.equal(result.status, 'complete'); assert.equal(result.count, 3); assert.equal(output.length, 3);
  assert.deepEqual(log, ['b2:bound', 'b4:bound', 'b5:bound', 'b2:export', 'b4:export', 'b5:export']);
});

test('cumulative SQL estimate rejects before any export materialization or append', () => {
  const log: string[] = [];
  const adapter = createComposedCommunityLifecycleAdapter(adapters(log), { assertSerialized: () => {}, exportBounds: bounds(log, [80, 80, 80]), maxBytes: 200 });
  assert.throws(() => adapter.export(actor, { snapshotAtMs: 0, append: () => { throw new Error('must not append'); } }), (error: unknown) => error instanceof DomainError && error.status === 413);
  assert.deepEqual(log, ['b2:bound', 'b4:bound', 'b5:bound']);
});

test('exception stays unknown while subsequent exports and all suppression readbacks execute', () => {
  const log: string[] = [];
  const adapter = createComposedCommunityLifecycleAdapter(adapters(log, { b4: {
    export: () => { log.push('b4:export'); throw new Error('synthetic effect exception'); },
    suppress: () => { log.push('b4:suppress'); throw new Error('synthetic effect exception'); },
  } }), { assertSerialized: () => {}, exportBounds: bounds(log) });
  const exported = adapter.export(actor, { snapshotAtMs: 0, append: () => {} }) as ComposedCommunityResult;
  assert.equal(exported.status, 'unknown'); assert.equal(exported.count, undefined); assert.equal(exported.modules.b5.status, 'complete');
  log.length = 0;
  const suppressed = adapter.suppress(actor.accountId, 1) as ComposedCommunityResult;
  assert.equal(suppressed.status, 'unknown'); assert.equal(suppressed.modules.b4.status, 'unknown'); assert.equal(suppressed.readback?.b4.status, 'complete');
  assert.deepEqual(log, ['b2:suppress', 'b4:suppress', 'b5:suppress', 'b2:verify', 'b4:verify', 'b5:verify']);
});

test('conjunctive readback rejects one pending/unknown module without exception-to-count success', () => {
  for (const status of ['pending', 'unknown', 'unavailable', 'retained'] as const) {
    const log: string[] = [];
    const adapter = createComposedCommunityLifecycleAdapter(adapters(log, { b5: { verifySuppressed: () => { log.push('b5:verify'); return { status, reason: 'synthetic_readback' }; } } }), { assertSerialized: () => {}, exportBounds: bounds(log) });
    const result = adapter.suppress(actor.accountId, 1) as ComposedCommunityResult;
    assert.equal(result.status, status); assert.equal(result.count, undefined); assert.equal(result.readback?.b5.reason, 'synthetic_readback');
    assert.equal(adapter.verifySuppressed(actor.accountId, 1).status, status);
  }
});

test('every purge stays unqualified and preserves exact module reasons', () => {
  const log: string[] = [];
  const adapter = createComposedCommunityLifecycleAdapter(adapters(log), { assertSerialized: () => {}, exportBounds: bounds(log) });
  const result = adapter.purge('synthetic-request', actor.accountId) as ComposedCommunityResult;
  assert.equal(result.status, 'pending'); assert.equal(result.count, undefined);
  assert.deepEqual(Object.values(result.modules).map(value => value.reason), ['b2:unqualified', 'b4:unqualified', 'b5:unqualified']);
  assert.deepEqual(log, ['b2:purge', 'b4:purge', 'b5:purge']);
});

test('capacity exception invokes remaining modules then fails closed', () => {
  const log: string[] = [];
  const adapter = createComposedCommunityLifecycleAdapter(adapters(log, { b4: { export: () => { log.push('b4:export'); throw new DomainError(413, 'synthetic_capacity'); } } }), { assertSerialized: () => {}, exportBounds: bounds(log) });
  assert.throws(() => adapter.export(actor, { snapshotAtMs: 0, append: () => {} }), (error: unknown) => error instanceof DomainError && error.code === 'synthetic_capacity');
  assert.equal(log.includes('b5:export'), true);
});

test('actual append byte guard and category guard fail closed even with understated injected estimates', () => {
  for (const category of ['community', 'wrong-module']) {
    const log: string[] = [], output: unknown[] = [];
    const adapter = createComposedCommunityLifecycleAdapter(adapters(log, { b4: { export: (_actor, snapshot) => {
      snapshot.append(category, { sentinel: 'x'.repeat(200) }); return { category: 'community', status: 'complete', count: 1 };
    } } }), { assertSerialized: () => {}, exportBounds: bounds(log, [1, 1, 1]), maxBytes: 160 });
    let result: LifecycleResult | undefined;
    if (category === 'community') assert.throws(() => adapter.export(actor, { snapshotAtMs: 0, append: (_category, value) => output.push(value) }), (error: unknown) => error instanceof DomainError && error.status === 413);
    else result = adapter.export(actor, { snapshotAtMs: 0, append: (_category, value) => output.push(value) });
    if (result) assert.equal(result.status, 'unknown');
    assert.equal(JSON.stringify(output).includes('sentinel'), false);
  }
});
