import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Text, View } from 'react-native';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { MotionProvider } from '../../src/features/shared/motionProvider';
import { PressFeedback } from '../../src/features/shared/motionPrimitives';
import {
  ContinuityProvider, ContinuitySource, ContinuityTarget, useContinuity, type ContinuityMode,
} from '../../src/features/shared/motionContinuity';

type Quad = readonly [x: number, y: number, width: number, height: number];
type MeasureCallback = (x: number, y: number, width: number, height: number) => void;

/** Window rects by testID. A view without an entry gets the full window; 'silent' never calls back. */
let rects: Record<string, Quad | 'silent'> = {};
const viewProto = View.prototype as unknown as { measureInWindow: unknown };
const originalMeasure = viewProto.measureInWindow;

beforeEach(() => {
  rects = {};
  viewProto.measureInWindow = function measureInWindow(this: { props: { testID?: string } }, callback: MeasureCallback) {
    const quad = rects[this.props.testID ?? ''] ?? [0, 0, 390, 844];
    if (quad !== 'silent') callback(...quad);
  };
});
afterEach(() => {
  viewProto.measureInWindow = originalMeasure;
  jest.useRealTimers();
});

const CARD: Quad = [16, 120, 358, 140];
const HEADER: Quad = [0, 60, 390, 220];

type Handle = { current: ReturnType<typeof useContinuity> | null };
function Handle({ handle }: { handle: Handle }) {
  handle.current = useContinuity();
  return null;
}

const shell = (children: ReactElement, reduceMotion = false) => (
  <MotionProvider reduceMotion={reduceMotion}><ContinuityProvider>{children}</ContinuityProvider></MotionProvider>
);

function source(handle: Handle, ghost?: ReactElement) {
  return (
    <>
      <Handle handle={handle} />
      <ContinuitySource id="session" testID="card" ghost={ghost}><Text>Today card</Text></ContinuitySource>
    </>
  );
}

function target(modes: ContinuityMode[], onPress?: () => void) {
  return (
    <ContinuityTarget id="session" testID="header" onTransition={(mode) => modes.push(mode)}>
      <PressFeedback testID="open" onPress={onPress}><Text>Workout header</Text></PressFeedback>
    </ContinuityTarget>
  );
}

describe('without a provider', () => {
  test('capture resolves false and clear never throws', async () => {
    const { result } = await renderHook(() => useContinuity());
    await expect(result.current.capture('session')).resolves.toBe(false);
    expect(() => result.current.clear()).not.toThrow();
    expect(() => result.current.clear('session')).not.toThrow();
  });

  test('source and target render their children and the target fades in', async () => {
    const modes: ContinuityMode[] = [];
    await render(
      <MotionProvider reduceMotion={false}>
        <ContinuitySource id="session"><Text>Today card</Text></ContinuitySource>
        {target(modes)}
      </MotionProvider>,
    );
    expect(screen.getByText('Today card')).toBeTruthy();
    expect(screen.getByText('Workout header')).toBeTruthy();
    expect(modes).toEqual(['fade']);
  });
});

describe('with a provider', () => {
  test('capturing an unregistered id resolves false and a target without a capture fades in', async () => {
    const handle: Handle = { current: null };
    const modes: ContinuityMode[] = [];
    await render(shell(<><Handle handle={handle} />{target(modes)}</>));
    await expect(handle.current?.capture('missing')).resolves.toBe(false);
    expect(screen.getByText('Workout header')).toBeTruthy();
    expect(modes).toEqual(['fade']);
  });

  test('a captured source flips the target, once, and the capture is consumed', async () => {
    rects.card = CARD;
    rects['header-probe'] = HEADER;
    const handle: Handle = { current: null };
    const first: ContinuityMode[] = [];
    const view = await render(shell(source(handle)));
    await expect(handle.current?.capture('session')).resolves.toBe(true);
    await view.rerender(shell(<>{source(handle)}{target(first)}</>));
    await act(async () => {});
    expect(first).toEqual(['flip']);

    const second: ContinuityMode[] = [];
    await view.rerender(shell(<>{source(handle)}{target(first)}<ContinuityTarget id="session" onTransition={(mode) => second.push(mode)}><Text>Again</Text></ContinuityTarget></>));
    await act(async () => {});
    expect(second).toEqual(['fade']);
  });

  test('the destination stays pressable while the flight runs', async () => {
    rects.card = CARD;
    rects['header-probe'] = HEADER;
    const handle: Handle = { current: null };
    const onPress = jest.fn();
    const view = await render(shell(source(handle)));
    await handle.current?.capture('session');
    await view.rerender(shell(<>{source(handle)}{target([], onPress)}</>));
    await fireEvent.press(screen.getByTestId('open'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('a ghost flies in the overlay and is removed after the flight', async () => {
    jest.useFakeTimers();
    rects.card = CARD;
    rects['header-probe'] = HEADER;
    const handle: Handle = { current: null };
    const view = await render(shell(source(handle, <Text>Ghost copy</Text>)));
    await handle.current?.capture('session');
    await view.rerender(shell(<>{source(handle, <Text>Ghost copy</Text>)}{target([])}</>));
    await act(async () => {});
    expect(screen.getByText('Ghost copy', { includeHiddenElements: true })).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(screen.queryByText('Ghost copy', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByText('Workout header')).toBeTruthy();
  });

  test('stale captures are ignored', async () => {
    jest.useFakeTimers();
    rects.card = CARD;
    rects['header-probe'] = HEADER;
    const handle: Handle = { current: null };
    const modes: ContinuityMode[] = [];
    const view = await render(shell(source(handle)));
    await expect(handle.current?.capture('session')).resolves.toBe(true);
    await act(async () => { jest.advanceTimersByTime(2000); });
    await view.rerender(shell(<>{source(handle)}{target(modes)}</>));
    await act(async () => {});
    expect(modes).toEqual(['fade']);
  });

  test('clear drops a capture before the target uses it', async () => {
    rects.card = CARD;
    rects['header-probe'] = HEADER;
    const handle: Handle = { current: null };
    const modes: ContinuityMode[] = [];
    const view = await render(shell(source(handle)));
    await handle.current?.capture('session');
    handle.current?.clear('session');
    await view.rerender(shell(<>{source(handle)}{target(modes)}</>));
    await act(async () => {});
    expect(modes).toEqual(['fade']);
  });

  test.each([
    ['a zero-size source', { card: [16, 120, 0, 0] as Quad }],
    ['a silent source', { card: 'silent' as const }],
  ])('%s cannot be captured', async (_name, override) => {
    jest.useFakeTimers();
    Object.assign(rects, override);
    const handle: Handle = { current: null };
    await render(shell(source(handle)));
    const result = handle.current?.capture('session');
    await act(async () => { jest.advanceTimersByTime(500); });
    await expect(result).resolves.toBe(false);
  });

  test.each([
    ['a zero-size target', { 'header-probe': [0, 60, 0, 0] as Quad }],
    ['a silent target', { 'header-probe': 'silent' as const }],
    ['an off-screen source', { card: [16, -400, 358, 140] as Quad, 'header-probe': HEADER }],
  ])('%s falls back to a fade', async (_name, override) => {
    jest.useFakeTimers();
    rects.card = CARD;
    Object.assign(rects, override);
    const handle: Handle = { current: null };
    const modes: ContinuityMode[] = [];
    const view = await render(shell(source(handle)));
    const captured = handle.current?.capture('session');
    await act(async () => { jest.advanceTimersByTime(500); });
    await captured;
    await view.rerender(shell(<>{source(handle)}{target(modes)}</>));
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(modes).toEqual(['fade']);
    expect(screen.getByText('Workout header')).toBeTruthy();
  });

  test('Reduce Motion only fades, and still consumes the capture', async () => {
    rects.card = CARD;
    rects['header-probe'] = HEADER;
    const handle: Handle = { current: null };
    const modes: ContinuityMode[] = [];
    const view = await render(shell(source(handle), true));
    await handle.current?.capture('session');
    await view.rerender(shell(<>{source(handle)}{target(modes)}</>, true));
    await act(async () => {});
    expect(modes).toEqual(['fade']);
    expect(screen.getByText('Workout header')).toBeTruthy();
  });
});
