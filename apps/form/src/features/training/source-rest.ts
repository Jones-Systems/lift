export type SourceRest = Readonly<{
  occurrenceId: string;
  durationSeconds: number;
  remainingMs: number;
  status: 'running' | 'paused' | 'finished';
}>;

export type RestTiming = {
  now: () => number;
  wallNow: () => number;
  subscribe: (tick: () => void) => () => void;
};

export const monotonicRestTiming: RestTiming = {
  now: () => globalThis.performance?.now() ?? NaN,
  wallNow: () => Date.now(),
  subscribe: tick => {
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  },
};

type Occurrence = { id: string; target: { native: { rest_seconds: number } } };

export function createSourceRest(occurrences: readonly Occurrence[], isCurrent: () => boolean,
  changed: () => void, timing: RestTiming = monotonicRestTiming) {
  const targets = occurrences.map(item => ({ id: item.id, seconds: item.target?.native?.rest_seconds }));
  let value: SourceRest | null = null, endsAt = 0, lastNow = -Infinity, lastWall = -Infinity;
  let unsubscribe: (() => void) | null = null, generation = 0, disposed = false;
  const stop = () => { generation++; const cleanup = unsubscribe; unsubscribe = null; cleanup?.(); };
  const dispose = () => { disposed = true; stop(); value = null; };
  const current = () => {
    if (disposed) return false;
    if (!isCurrent()) { dispose(); return false; }
    return true;
  };
  const now = () => {
    let next: number, wall: number;
    try { next = timing.now(); wall = timing.wallNow(); } catch { return null; }
    if (!Number.isFinite(next) || next < 0 || next < lastNow
      || !Number.isFinite(wall) || wall < 0 || wall < lastWall) return null;
    lastNow = next; lastWall = wall;
    return wall;
  };
  const publish = (next: SourceRest | null) => { value = next; changed(); };
  const tick = () => {
    if (!current() || value?.status !== 'running') return;
    const time = now();
    if (time === null) { stop(); publish(null); return; }
    const left = Math.max(0, endsAt - time);
    if (!left) stop();
    if (left !== value.remainingMs) publish(Object.freeze({ ...value, remainingMs: left, status: left ? 'running' : 'finished' }));
  };
  const listen = () => {
    const subscribedGeneration = generation;
    unsubscribe = timing.subscribe(() => { if (subscribedGeneration === generation) tick(); });
  };
  const start = (occurrenceId: string): boolean => {
    if (!current() || typeof occurrenceId !== 'string' || !occurrenceId) return false;
    const matches = targets.filter(item => item.id === occurrenceId);
    const duration = matches.length === 1 ? matches[0].seconds : undefined;
    if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 0 || duration > 10800) return false;
    const time = now(); if (time === null) return false;
    stop(); const remaining = duration * 1000; endsAt = time + remaining;
    publish(Object.freeze({ occurrenceId, durationSeconds: duration, remainingMs: remaining, status: remaining ? 'running' : 'finished' }));
    if (remaining) listen();
    return true;
  };
  const pause = (): boolean => {
    if (!current() || value?.status !== 'running') return false;
    tick();
    if (value?.status !== 'running') return false;
    stop(); publish(Object.freeze({ ...value, status: 'paused' }));
    return true;
  };
  const resume = (): boolean => {
    if (!current() || value?.status !== 'paused') return false;
    const time = now(); if (time === null) return false;
    endsAt = time + value.remainingMs;
    publish(Object.freeze({ ...value, status: 'running' })); listen();
    return true;
  };
  const dismiss = (): boolean => {
    if (!current()) return false;
    stop(); publish(null); return true;
  };
  return { snapshot: () => value, start, pause, resume, dismiss, dispose };
}
