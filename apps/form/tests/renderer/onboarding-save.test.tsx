import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { Account, Onboarding } from '../../src/api/domain';
import { FormResources } from '../../src/api/resources';
import { FormTransport } from '../../src/api/transport';
import type { SpeechPort } from '../../src/features/contract';
import { OnboardingFlow } from '../../src/features/onboarding/OnboardingFlow';

const pendingCleanup: (() => void)[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function unexpectedSpeech(): never { throw new Error('Injury save must not invoke speech'); }
const speech: SpeechPort = {
  availability: async () => unexpectedSpeech(), requestPermissions: async () => unexpectedSpeech(),
  start: async () => unexpectedSpeech(), stop: async () => {}, cancel: async () => {},
  subscribe: unexpectedSpeech, acceptReview: unexpectedSpeech, dispose: async () => {},
};
type Patch = Pick<Onboarding, 'step'> & Partial<Pick<Onboarding, 'answers' | 'preferences'>> & { expectedRevision: number };

async function mountInjury() {
  const account: Account = {
    accountId: 'synthetic-onboarding', appAccountToken: 'synthetic-token',
    onboarding: { revision: 4, step: 'injuries', answers: {}, preferences: {}, status: 'draft', completedAt: null },
    profile: { revision: 1, name: 'Synthetic', age: null, heightCm: null, weightKg: null,
      trainingBackground: 'returning', injuryHistory: '', goals: ['stronger'] },
    preferences: { revision: 1, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 35,
      equipment: ['dumbbells'], remindersEnabled: false },
  };
  const requests: { body: Patch; resolve: (response: Response) => void }[] = [];
  const api = new FormTransport('https://form.renderer.invalid', {
    async load() { return null; }, async save() { throw new Error('Unexpected session save'); }, async clear() {},
  }, async (url, init) => {
    expect(new URL(String(url)).pathname).toBe('/v1/me/onboarding');
    expect(init?.method).toBe('PATCH');
    const body: Patch = JSON.parse(String(init?.body));
    return new Promise<Response>(resolve => {
      requests.push({ body, resolve });
      pendingCleanup.push(() => resolve(json({ error: { code: 'unavailable', message: 'Test cleanup' } }, 503)));
    });
  });
  let current = true;
  const onAccount = jest.fn(), onUnauthenticated = jest.fn(), onDone = jest.fn();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  await render(<OnboardingFlow resources={new FormResources(api)} account={account} speech={speech}
    isCurrentSession={() => current} onAccount={onAccount} onUnauthenticated={onUnauthenticated} onDone={onDone} />);
  expect(screen.getByTestId('screen-onboarding-injury')).toBeTruthy();
  return {
    requests, onAccount, onUnauthenticated, onDone,
    expire() { current = false; },
    async acknowledge(index = 0) {
      const { body, resolve } = requests[index];
      await act(async () => { resolve(json({ ...account.onboarding, step: body.step,
        answers: { ...account.onboarding.answers, ...body.answers },
        preferences: { ...account.onboarding.preferences, ...body.preferences }, revision: body.expectedRevision + 1 })); });
    },
  };
}

afterEach(async () => {
  await cleanup();
  await act(async () => { pendingCleanup.splice(0).forEach(finish => finish()); });
});

async function submitKnee() {
  await fireEvent.press(screen.getByTestId('a-area-knee'));
  expect(screen.getByTestId('a-area-knee').props.accessibilityState).toMatchObject({ checked: true });
  await fireEvent.press(screen.getByTestId('a-continue'));
  expect(screen.getByTestId('screen-onboarding-injury')).toBeTruthy();
}

test('injury Continue advances after the submitted Knee state commits and its save succeeds', async () => {
  const f = await mountInjury();
  await submitKnee();
  expect(f.requests.map(request => request.body)).toEqual([{ step: 'injuries', expectedRevision: 4,
    answers: { injuryHistory: JSON.stringify({ format: 'form.injury.v1', areas: ['knee'], worsening: null, note: '' }) } }]);
  await f.acknowledge();
  expect(screen.getByTestId('screen-onboarding-injury-check')).toBeTruthy();
});

test('an injury edit during save stays visible and requires resubmission at the acknowledged revision', async () => {
  const f = await mountInjury();
  await submitKnee();
  await fireEvent.changeText(screen.getByTestId('a-injury-note-input'), 'A later local detail');
  await f.acknowledge();
  expect(screen.getByTestId('screen-onboarding-injury')).toBeTruthy();
  expect(screen.getByTestId('a-injury-note-input').props.value).toBe('A later local detail');
  expect(f.requests).toHaveLength(1);
  await fireEvent.press(screen.getByTestId('a-continue'));
  expect(f.requests[1].body).toEqual({ step: 'injuries', expectedRevision: 5,
    answers: { injuryHistory: JSON.stringify({ format: 'form.injury.v1', areas: ['knee'], worsening: null, note: 'A later local detail' }) } });
  await f.acknowledge(1);
  expect(screen.getByTestId('screen-onboarding-injury-check')).toBeTruthy();
});

test('an empty injury answer advances directly to coach after saving', async () => {
  const f = await mountInjury();
  await fireEvent.press(screen.getByTestId('a-continue'));
  expect(f.requests[0].body).toEqual({ step: 'injuries', expectedRevision: 4,
    answers: { injuryHistory: JSON.stringify({ format: 'form.injury.v1', areas: [], worsening: null, note: '' }) } });
  await f.acknowledge();
  expect(screen.getByTestId('screen-onboarding-coach')).toBeTruthy();
});

test.each(['no', 'yes', 'unsure'] as const)('injury acknowledgement %s saves before following its existing route', async worsening => {
  const f = await mountInjury();
  await submitKnee();
  await f.acknowledge();
  await fireEvent.press(screen.getByTestId(`a-check-${worsening}`));
  await fireEvent.press(screen.getByTestId('a-continue'));
  expect(screen.getByTestId('screen-onboarding-injury-check')).toBeTruthy();
  expect(f.requests[1].body).toEqual({ step: 'injuries', expectedRevision: 5,
    answers: { injuryHistory: JSON.stringify({ format: 'form.injury.v1', areas: ['knee'], worsening, note: '' }) } });
  await f.acknowledge(1);
  expect(screen.getByTestId(`screen-onboarding-${worsening === 'no' ? 'coach' : 'injury-pause'}`)).toBeTruthy();
});

test('an expired session cannot advance after an injury acknowledgement or dispatch another save', async () => {
  const f = await mountInjury();
  await submitKnee();
  f.expire();
  await f.acknowledge();
  expect(screen.getByTestId('screen-onboarding-injury')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('a-continue'));
  expect(f.requests).toHaveLength(1);
  expect(f.onAccount).not.toHaveBeenCalled();
  expect(f.onUnauthenticated).not.toHaveBeenCalled();
  expect(f.onDone).not.toHaveBeenCalled();
});
