import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { Pressable, Text, View } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { TrainingSlot, type SourceTrainingSlotContext, type SourceTrainingRenderer } from '../../src/features/training/TrainingSlot';
import { FormTransport } from '../../src/api/transport';
import { FormResources } from '../../src/api/resources';
import type { HomeSlotContext } from '../../src/features/contract';
import type { Account, SourcePlan, SourceWorkoutSession } from '../../src/api/domain';

// Only unrelated tab chrome is omitted. React, TrainingSlot, hooks, codecs,
// resource custody, command keys and the injected HTTP transport are real.
jest.mock('../../src/variants/a/frame', () => ({ TabBar: () => null }));
jest.mock('expo-crypto', () => {
  let sequence = 0;
  return { randomUUID: () => `synthetic-command-${++sequence}` };
});
const pendingCleanup: (() => void)[] = [];
afterEach(async () => {
  await cleanup();
  await act(async () => { pendingCleanup.splice(0).forEach(settle => settle()); });
});

const date = '2026-10-18T12:00:00.000Z';
const origin = 'https://training.renderer.invalid';
function json(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  const response = new Response(body, { status });
  // Node's host Response parses outside Jest's realm; browser JSON belongs to the caller's realm.
  response.json = async () => JSON.parse(body);
  return response;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const plan: SourcePlan = { schema: 'form.source-prescription-plan/v1', id: 'source_plan', revision: 2,
  archived: false, name: 'Synthetic practice', createdAt: date, updatedAt: date,
  origin: { kind: 'form-adaptation', id: 'recipe', revision: 'v1' },
  duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 },
  items: [{ id: 'practice_item', native: { exercise_id: 'native_practice', movement_pattern: 'core', role: 'practice',
    sets: 2, rest_seconds: 90, notes: ['Synthetic practice target.'] },
    registeredDomain: { exerciseId: 'domain_practice', variantId: 'variant:practice',
      identity: { repository: 'synthetic/catalog', revision: 'v1', path: 'catalog.json', sha256: 'a'.repeat(64), nativeId: 'native_practice' },
      registration: { id: 'registration', revision: 'v1', digest: 'b'.repeat(64), bytes: 512 }, recordDigest: 'c'.repeat(64) },
    load: { kind: 'unspecified', basis: 'unknown' } }] };
function session(): SourceWorkoutSession {
  return { id: 'source_workout', revision: 1, planId: plan.id, planRevision: plan.revision, status: 'active',
    startedAt: date, completedAt: null, planSnapshot: plan,
    occurrences: [{ id: 'occ_0', itemId: plan.items[0].id, exerciseId: 'domain_practice', position: 0, target: plan.items[0] }], sets: [] };
}
const draft = { schema: 'form.source-performed-set/v1' as const, occurrenceId: 'occ_0', setNumber: 1, status: 'confirmed' as const,
  performance: { schema: 'form.source-performance/v1' as const, kind: 'controlled-practice' as const,
    load: { kind: 'unspecified' as const, basis: 'unknown' as const } } };
function account(id: string): Account {
  return { accountId: id, appAccountToken: `synthetic-${id}`,
    onboarding: { revision: 1, step: 'review', answers: {}, preferences: {}, status: 'completed', completedAt: null },
    profile: { revision: 1, name: id, age: null, heightCm: null, weightKg: null,
      trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 1, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30,
      equipment: ['dumbbell'], remindersEnabled: false } };
}
type Call = { path: string; method: string; body: string | undefined; key: string | null };
type Workout = Extract<SourceTrainingSlotContext, { kind: 'workout' }>['workout'];

async function fixture(id = 'owner') {
  const calls: Call[] = [], pending: ReturnType<typeof deferred<Response>>[] = [];
  let stored = JSON.stringify({ version: 1, baseURL: origin, token: `synthetic-${id}` });
  const api = new FormTransport(origin, {
    async load() { return stored; }, async save(value) { stored = value; }, async clear() { stored = ''; },
  }, async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body as string | undefined,
      key: new Headers(init?.headers).get('Idempotency-Key') });
    if (path === '/v1/me') return json(account(id));
    if (path === '/v1/history') return json({ items: [], nextBefore: null });
    if (path === '/v1/stats') return json({ confirmedSets: 0, repetitions: 0, volumeKg: 0, completedSessions: 0, byExercise: [],
      units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true });
    if (path === '/v1/workout-sessions') return json(session());
    if (path === '/v1/workout-sessions/source_workout') return json(session());
    if (path.endsWith('/sets')) { const result = deferred<Response>(); pending.push(result);
      pendingCleanup.push(() => result.reject(new Error('Synthetic request teardown'))); return result.promise; }
    throw new Error(`Unexpected synthetic request: ${path}`);
  });
  expect(await api.restore()).toBe(true);
  let current = true, latest: SourceTrainingSlotContext | undefined;
  const resources = new FormResources(api).boundTo(() => current);
  try { await resources.sourceTraining(); } catch (error) { throw new Error(`Source acquisition diagnostic: ${String(error)}`); }
  function probe(value: SourceTrainingSlotContext) {
    latest = value;
    if (value.kind === 'navigation') return <View>
      <Text testID="owner">{id}</Text><Text testID="availability">{value.availability}</Text>
      <Text testID="start-error">{value.start && 'error' in value.start.state ? value.start.state.error.message : ''}</Text>
      <Text testID="read-error">{value.history.status === 'error' ? value.history.error.message : ''}</Text>
      <Pressable testID="select" onPress={() => { expect(value.selectPlan(plan)).toBe(true); }}><Text>Select</Text></Pressable>
      <Pressable testID="start" onPress={value.startSelected}><Text>Start</Text></Pressable>
    </View>;
    const { workout } = value;
    return <View>
      <Text testID="owner">{id}</Text>
      <Text testID="saved">{String(workout.session.sets.length)}</Text>
      <Text testID="command">{workout.commands[0]?.state.status ?? 'none'}</Text>
      <Pressable testID="log" onPress={() => workout.logSet(draft)}><Text>Log</Text></Pressable>
      <Pressable testID="retry" onPress={() => { if (workout.commands[0]) workout.retryCommand(workout.commands[0].key); }}><Text>Retry</Text></Pressable>
    </View>;
  }
  const ctx: HomeSlotContext = { account: account(id), appMode: 'basic', sessionGeneration: `generation-${id}`,
    isCurrentSession: () => current, resources, plans: [], activePlan: null, storedPlans: [plan], exercises: [], entitlements: null,
    renderSourceTraining: probe, openAccount() {}, openPlans() {}, openPlan() {}, openCues() {}, openSettings() {},
    savedFirstPlanDestination: () => null, reload: async () => {} };
  return { ctx, calls, pending, probe, expire: () => { current = false; },
    replaceRenderer: (): SourceTrainingRenderer => value => probe(value),
    writes: () => calls.filter(call => call.path.endsWith('/sets')),
    workout: (): Workout => { if (latest?.kind !== 'workout') throw new Error('Workout not rendered'); return latest.workout; },
    ack(index: number) { const sent = JSON.parse(this.writes()[index].body!); const { expectedRevision, ...set } = sent;
      pending[index].resolve(json({ set: { ...set, id: 'saved_set', revision: 1, createdAt: date, updatedAt: date },
        sessionRevision: expectedRevision + 1 })); },
  };
}
async function start() {
  await screen.findByTestId('availability');
  if (screen.getByTestId('read-error').props.children) throw new Error(screen.getByTestId('read-error').props.children);
  expect(screen.getByTestId('availability')).toHaveTextContent('ready');
  await fireEvent.press(screen.getByTestId('select'));
  await fireEvent.press(screen.getByTestId('start'));
  expect(await screen.findByTestId('saved')).toHaveTextContent('0');
}

test('unknown set retry survives absent/replaced presentation with the original key/body and no optimistic save', async () => {
  const f = await fixture(); const mounted = await render(<TrainingSlot {...f.ctx} />); await start();
  await fireEvent.press(screen.getByTestId('log'));
  expect(screen.getByTestId('command')).toHaveTextContent('pending');
  expect(screen.getByTestId('saved')).toHaveTextContent('0');
  await act(async () => { f.pending[0].reject(new Error('Lost acknowledgement')); });
  expect(screen.getByTestId('command')).toHaveTextContent('unknown');
  const old = f.workout(), key = old.commands[0].key;
  expect(f.writes()).toHaveLength(1); expect(f.writes()[0].key).toBe(key);
  await mounted.rerender(<TrainingSlot {...f.ctx} renderSourceTraining={undefined} />);
  await act(async () => { old.retryCommand(key); old.logSet(draft); });
  expect(f.writes()).toHaveLength(1); expect(screen.queryByTestId('saved')).toBeNull();
  await mounted.rerender(<TrainingSlot {...f.ctx} renderSourceTraining={f.replaceRenderer()} />);
  expect(screen.getByTestId('command')).toHaveTextContent('unknown');
  expect(screen.getByTestId('saved')).toHaveTextContent('0');
  await act(async () => { old.retryCommand(key); }); expect(f.writes()).toHaveLength(1);
  const fresh = f.workout();
  await act(async () => { fresh.retryCommand(key); fresh.retryCommand(key); });
  expect(f.writes()).toHaveLength(2); expect(f.writes()[1]).toEqual(f.writes()[0]);
  await act(async () => { f.pending[1].resolve(json({ error: { code: 'invalid_set', message: 'Later rejection' } }, 422)); });
  expect(screen.getByTestId('command')).toHaveTextContent('unknown');
  expect(screen.getByTestId('saved')).toHaveTextContent('0');
  await fireEvent.press(screen.getByTestId('retry'));
  expect(f.writes()).toHaveLength(3); expect(f.writes()[2]).toEqual(f.writes()[0]);
  await act(async () => { f.ack(2); });
  expect(screen.getByTestId('saved')).toHaveTextContent('1');
  expect(screen.getByTestId('command')).toHaveTextContent('none');
});

test('account owner replacement fences a late acknowledgement and retained actions while the new owner remains usable', async () => {
  const old = await fixture('old'); const mounted = await render(<TrainingSlot {...old.ctx} />); await start();
  await fireEvent.press(screen.getByTestId('log')); const retained = old.workout();
  expect(old.pending).toHaveLength(1);
  const fresh = await fixture('new'); old.expire();
  await mounted.rerender(<TrainingSlot {...fresh.ctx} />); await start();
  expect(screen.getByTestId('owner')).toHaveTextContent('new');
  await act(async () => { old.ack(0); });
  expect(screen.getByTestId('saved')).toHaveTextContent('0');
  expect(screen.getByTestId('command')).toHaveTextContent('none');
  const oldCalls = old.calls.length, newCalls = fresh.calls.length;
  await act(async () => { retained.logSet(draft); retained.retryCommand(retained.commands[0].key); await retained.reconcile(); await retained.finish(); });
  expect(old.calls).toHaveLength(oldCalls); expect(fresh.calls).toHaveLength(newCalls);
  await fireEvent.press(screen.getByTestId('log')); await act(async () => { fresh.ack(0); });
  expect(screen.getByTestId('saved')).toHaveTextContent('1');
});

test('unmount fences an unresolved write and retained retry without dispatching or resurrecting presentation', async () => {
  const f = await fixture(); const mounted = await render(<TrainingSlot {...f.ctx} />); await start();
  await fireEvent.press(screen.getByTestId('log')); const retained = f.workout(), key = retained.commands[0].key;
  await mounted.unmount(); const calls = f.calls.length;
  await act(async () => { f.pending[0].reject(new Error('Lost after unmount')); });
  await act(async () => { retained.retryCommand(key); retained.logSet(draft); await retained.reconcile(); await retained.finish(); });
  expect(f.calls).toHaveLength(calls); expect(screen.queryByTestId('saved')).toBeNull();
});
