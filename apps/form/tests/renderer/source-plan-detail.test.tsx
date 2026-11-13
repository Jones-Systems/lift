import React, { isValidElement } from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo, Text } from 'react-native';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { Account, SourcePlan } from '../../src/api/domain';
import { FormResources } from '../../src/api/resources';
import { FormTransport } from '../../src/api/transport';
import { decodePlan } from '../../src/api/trainingCodec';
import type { FormAccountAppProps, SourcePlanDetailSlotContext } from '../../src/features/contract';
import { createSourcePlanDetailRenderer, SourcePlanDetailScreen } from '../../src/features/training/source-plan-detail';

function sourcePlan(): SourcePlan {
  const item = (id: string) => ({ id, native: { exercise_id: 'native_identifier', movement_pattern: 'unfamiliar pattern',
    role: 'unfamiliar role', sets: 3, rest_seconds: 0, rep_range: [6, 10], target_rir: 0,
    substituted_for: 'original_identifier', notes: ['  Original note  ', '', 'x'.repeat(4000)] },
  registeredDomain: { exerciseId: 'domain_identifier', variantId: 'variant-pin',
    identity: { repository: 'synthetic/implementation', revision: 'source-pin', path: 'catalog/private-pin.json',
      sha256: 'a'.repeat(64), nativeId: 'native_identifier' },
    registration: { id: 'registration-pin', revision: 'registration-revision', digest: 'b'.repeat(64), bytes: 123 },
    recordDigest: 'c'.repeat(64) }, load: { kind: 'unspecified', basis: 'unknown' } });
  const decoded = decodePlan({ schema: 'form.source-prescription-plan/v1', id: 'plan_original', revision: 0, name: 'Original saved plan',
    origin: { kind: 'form-adaptation', id: 'adaptation-pin', revision: 'adaptation-revision' },
    duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 }, items: [item('item_first'), item('item_second')],
    archived: false, createdAt: '2026-11-13T12:00:00Z', updatedAt: '2026-11-13T12:30:00Z' });
  if (!('schema' in decoded)) throw new Error('Expected a decoded source plan');
  return decoded;
}

function fixture(options: { absentStart?: boolean; result?: boolean; archived?: boolean } = {}) {
  const plan = sourcePlan(); plan.archived = !!options.archived;
  const account: Account = { accountId: 'synthetic-original', appAccountToken: 'synthetic-token',
    onboarding: { revision: 1, step: 'review', answers: {}, preferences: {}, status: 'completed', completedAt: null },
    profile: { revision: 1, name: 'Private account name', age: null, heightCm: null, weightKg: null,
      trainingBackground: null, injuryHistory: '', goals: [] },
    preferences: { revision: 1, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 30,
      equipment: [], remindersEnabled: false } };
  const request = jest.fn<() => Promise<Response>>(async () => { throw new Error('Read-only detail must not request data or write'); });
  const resources = new FormResources(new FormTransport('https://form.renderer.invalid', {
    async load() { return null; }, async save() { throw new Error('No credential writes'); }, async clear() {},
  }, request));
  let active = true;
  const selected: SourcePlan[] = [];
  const start = jest.fn(() => { selected.push(plan); return options.result ?? true; });
  const close = jest.fn<() => void>();
  const context: SourcePlanDetailSlotContext = Object.freeze({ plan, account, appMode: 'basic', resources,
    sessionGeneration: 'original-generation', isCurrentSession: () => active, close,
    ...(options.absentStart ? {} : { start }) });
  return { context, plan, selected, start, close, request, expire() { active = false; }, restore() { active = true; } };
}

const slot: NonNullable<FormAccountAppProps['renderSourcePlanDetail']> = createSourcePlanDetailRenderer();
afterEach(async () => { await cleanup(); });

test('the actual typed slot renders the full original source object and wrapped ordered prescription without fetching metadata', async () => {
  const f = fixture();
  f.plan.items[0].native.movement_pattern = 'Unfamiliar-pattern-'.repeat(10);
  f.plan.items[0].native.role = 'Unfamiliar-role-'.repeat(10);
  const before = JSON.stringify(f.plan), element = slot(f.context);
  expect(isValidElement(element)).toBe(true);
  if (!isValidElement<{ context: SourcePlanDetailSlotContext }>(element)) throw new Error('Expected a React element');
  expect(element.type).toBe(SourcePlanDetailScreen);
  expect(element.props.context).toBe(f.context);
  expect(element.props.context.plan).toBe(f.plan);
  const next = slot(f.context);
  if (!isValidElement(next)) throw new Error('Expected a stable component');
  expect(next.type).toBe(element.type);
  await render(<>{element}</>);
  expect(screen.getByTestId('a-source-plan-title')).toHaveTextContent('Original saved plan');
  expect(screen.getByText('15–25 minutes (estimated)')).toBeTruthy();
  expect(screen.getByText('1. Exercise ID: native_identifier')).toBeTruthy();
  expect(screen.getByText('2. Exercise ID: native_identifier')).toBeTruthy();
  expect(screen.getByTestId('a-source-plan-item-1')).toHaveTextContent('0 seconds');
  expect(screen.getByTestId('a-source-plan-item-1')).toHaveTextContent('6–10 reps');
  expect(within(screen.getByTestId('a-source-plan-item-1')).getByText('0')).toBeTruthy();
  expect(screen.getByText('Unfamiliar-pattern-'.repeat(10))).toBeTruthy();
  expect(screen.getByText('Unfamiliar-role-'.repeat(10))).toBeTruthy();
  expect(screen.getByTestId('a-source-plan-item-1')).toHaveTextContent('Unspecified (basis unknown)');
  expect(screen.getByTestId('a-source-plan-item-1')).toHaveTextContent('original_identifier');
  expect(screen.getByTestId('a-source-plan-item-1')).toHaveTextContent('Empty note');
  const longNotes = screen.getAllByText('x'.repeat(4000));
  expect(longNotes).toHaveLength(2);
  for (const node of screen.UNSAFE_getAllByType(Text)) expect(node.props.numberOfLines).toBeUndefined();
  for (const hidden of ['Private account name', 'synthetic-token', 'domain_identifier', 'variant-pin', 'source-pin',
    'synthetic/implementation', 'catalog/private-pin.json', 'registration-pin', 'registration-revision',
    'adaptation-pin', 'adaptation-revision', 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]) {
    expect(screen.queryByText(hidden, { exact: false })).toBeNull();
  }
  expect(f.request).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  expect(JSON.stringify(f.plan)).toBe(before);
});

test('selection invokes the exact captured callback once with its original plan and never invents navigation or a workout', async () => {
  const f = fixture();
  await render(<>{slot(f.context)}</>);
  const retained = screen.getByTestId('a-source-plan-select').props.onPress as () => void;
  await act(async () => { retained(); retained(); });
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledWith();
  expect(f.selected).toHaveLength(1); expect(f.selected[0]).toBe(f.plan);
  expect(f.close).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  expect(screen.getByTestId('a-source-plan-select')).toBeDisabled();
  expect(screen.getByText('Plan selected. A workout has not been started.')).toBeTruthy();
  expect(screen.getByTestId('screen-source-plan-detail')).toBeTruthy();
});

test.each([
  { options: { absentStart: true }, reason: 'Plan selection is unavailable in this view.' },
  { options: { archived: true }, reason: 'This plan is archived and cannot be selected.' },
])('unavailable selection stays disabled and explained: $reason', async ({ options, reason }) => {
  const f = fixture(options);
  await render(<>{slot(f.context)}</>);
  expect(screen.getByTestId('a-source-plan-select')).toBeDisabled();
  expect(screen.getByText(reason)).toBeTruthy();
  const explanation = screen.getByTestId('a-source-plan-selection-help');
  expect(explanation.props.accessibilityLabel).toBe('Select this plan');
  expect(explanation.props.accessibilityHint).toBe(reason);
  expect(explanation.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(screen.getByTestId('a-source-plan-select'));
  expect(f.start).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('a-source-plan-close'));
  expect(f.close).toHaveBeenCalledTimes(1);
});

test('a false result is announced as unavailable and a retained action cannot replay it', async () => {
  const f = fixture({ result: false });
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  await render(<>{slot(f.context)}</>);
  const retained = screen.getByTestId('a-source-plan-select').props.onPress as () => void;
  await act(async () => { retained(); retained(); });
  const message = 'This plan could not be selected. Selection is unavailable in this view.';
  expect(screen.getByText(message)).toBeTruthy();
  expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(message);
  expect(screen.queryByText('Plan selected. A workout has not been started.')).toBeNull();
  expect(screen.getByTestId('a-source-plan-select')).toBeDisabled();
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.close).not.toHaveBeenCalled();
});

test.each(['select', 'close'] as const)('session loss at retained %s removes private content and dispatches nothing', async action => {
  const f = fixture();
  await render(<>{slot(f.context)}</>);
  const retained = screen.getByTestId(`a-source-plan-${action}`).props.onPress as () => void;
  f.expire();
  await act(async () => { retained(); });
  expect(screen.getByTestId('screen-source-plan-unavailable')).toBeTruthy();
  expect(screen.queryByText('Original saved plan')).toBeNull();
  expect(screen.queryByText('native_identifier', { exact: false })).toBeNull();
  expect(screen.queryByText('Private account name')).toBeNull();
  expect(f.start).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  f.restore();
  await act(async () => { retained(); });
  expect(f.start).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  expect(screen.getByTestId('screen-source-plan-unavailable')).toBeTruthy();
});

test('an already stale session and a stale rerender contain no plan or account text', async () => {
  const f = fixture(); f.expire();
  const view = await render(<>{slot(f.context)}</>);
  expect(screen.getByTestId('screen-source-plan-unavailable')).toBeTruthy();
  expect(screen.queryByText('Original saved plan')).toBeNull();
  await view.unmount();
  const fresh = fixture();
  const next = await render(<>{slot(fresh.context)}</>);
  fresh.expire();
  await next.rerender(<>{slot(fresh.context)}</>);
  expect(screen.getByTestId('screen-source-plan-unavailable')).toBeTruthy();
  expect(screen.queryByText('Original saved plan')).toBeNull();
});

test.each(['context', 'plan', 'generation', 'resources'] as const)('replacement of %s fences old callbacks even for the same account', async change => {
  const f = fixture(), replacementStart = jest.fn(() => true), replacementClose = jest.fn<() => void>();
  const view = await render(<>{slot(f.context)}</>);
  const oldSelect = screen.getByTestId('a-source-plan-select').props.onPress as () => void;
  const oldClose = screen.getByTestId('a-source-plan-close').props.onPress as () => void;
  const replacement: SourcePlanDetailSlotContext = Object.freeze({ ...f.context,
    ...(change === 'plan' ? { plan: { ...sourcePlan(), name: 'Replacement saved plan' } } : {}),
    ...(change === 'generation' ? { sessionGeneration: 'replacement-generation' } : {}),
    ...(change === 'resources' ? { resources: fixture().context.resources } : {}),
    start: replacementStart, close: replacementClose });
  await view.rerender(<>{slot(replacement)}</>);
  await act(async () => { oldSelect(); oldClose(); });
  expect(f.start).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  expect(replacementStart).not.toHaveBeenCalled(); expect(replacementClose).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('a-source-plan-select'));
  expect(replacementStart).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByTestId('a-source-plan-close'));
  expect(replacementClose).toHaveBeenCalledTimes(1);
  await view.rerender(<>{slot(f.context)}</>);
  await act(async () => { oldSelect(); oldClose(); });
  expect(f.start).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('a-source-plan-select'));
  expect(f.start).toHaveBeenCalledTimes(1);
});

test('close is captured once and permanently invalidates actions from the closed attachment', async () => {
  const f = fixture();
  await render(<>{slot(f.context)}</>);
  const select = screen.getByTestId('a-source-plan-select').props.onPress as () => void;
  const close = screen.getByTestId('a-source-plan-close').props.onPress as () => void;
  await act(async () => { close(); close(); select(); });
  expect(f.close).toHaveBeenCalledTimes(1); expect(f.start).not.toHaveBeenCalled();
});

test('a new context with identical fields still invalidates old intent', async () => {
  const f = fixture();
  const view = await render(<>{slot(f.context)}</>);
  const select = screen.getByTestId('a-source-plan-select').props.onPress as () => void;
  const close = screen.getByTestId('a-source-plan-close').props.onPress as () => void;
  await view.rerender(<>{slot(Object.freeze({ ...f.context }))}</>);
  await act(async () => { select(); close(); });
  expect(f.start).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('a-source-plan-select'));
  expect(f.start).toHaveBeenCalledTimes(1);
});

test('session loss during selection suppresses private content and success even if the callback returns true', async () => {
  const f = fixture();
  f.start.mockImplementationOnce(() => { f.expire(); return true; });
  await render(<>{slot(f.context)}</>);
  await fireEvent.press(screen.getByTestId('a-source-plan-select'));
  expect(screen.getByTestId('screen-source-plan-unavailable')).toBeTruthy();
  expect(screen.queryByText('Original saved plan')).toBeNull();
  expect(screen.queryByText('Plan selected. A workout has not been started.')).toBeNull();
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.close).not.toHaveBeenCalled();
});

test('unmount invalidates retained callbacks forever and a new attachment to the same context works', async () => {
  const f = fixture();
  const view = await render(<>{slot(f.context)}</>);
  const select = screen.getByTestId('a-source-plan-select').props.onPress as () => void;
  const close = screen.getByTestId('a-source-plan-close').props.onPress as () => void;
  await view.unmount();
  await act(async () => { select(); close(); });
  await render(<>{slot(f.context)}</>);
  await act(async () => { select(); close(); });
  expect(f.start).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('a-source-plan-select'));
  expect(f.start).toHaveBeenCalledTimes(1);
});

test('reentrant selection and close cannot dispatch while the captured selection is busy', async () => {
  const f = fixture();
  await render(<>{slot(f.context)}</>);
  const select = screen.getByTestId('a-source-plan-select').props.onPress as () => void;
  const close = screen.getByTestId('a-source-plan-close').props.onPress as () => void;
  f.start.mockImplementationOnce(() => { select(); close(); return false; });
  await act(async () => { select(); });
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.close).not.toHaveBeenCalled();
});

test('React development reattachment supplies live actions without reviving an unmounted attachment', async () => {
  const f = fixture();
  const view = await render(<React.StrictMode>{slot(f.context)}</React.StrictMode>);
  const oldSelect = screen.getByTestId('a-source-plan-select').props.onPress as () => void;
  await view.unmount();
  await render(<React.StrictMode>{slot(f.context)}</React.StrictMode>);
  await act(async () => { oldSelect(); });
  expect(f.start).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('a-source-plan-select'));
  expect(f.start).toHaveBeenCalledTimes(1);
});
