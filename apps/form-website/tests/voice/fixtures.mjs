export const account = Object.freeze({ accountId: 'synthetic-account', authSessionId: 'synthetic-session', accountEpoch: 3 });
export const fence = Object.freeze({ ...account, generation: 1 });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
export function track(kind = 'audio', { fail = false } = {}) {
  return { kind, readyState: 'live', stops: 0,
    stop() { this.stops++; if (fail) throw new Error('synthetic stop failure'); this.readyState = 'ended'; } };
}
export function stream(...tracks) { return { getTracks: () => tracks }; }
export async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
export function timers(initial = 1000) {
  let clock = initial, sequence = 0;
  const scheduled = new Map();
  return { now: () => clock, scheduled, setTimer(callback, delay) { const id = ++sequence; scheduled.set(id, { callback, due: clock + delay }); return id; },
    clearTimer: id => scheduled.delete(id), set: value => { clock = value; },
    fire() { for (const [id, entry] of [...scheduled]) if (entry.due <= clock) { scheduled.delete(id); entry.callback(); } } };
}

export class Target {
  listeners = new Map();
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, event = {}) { for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event); }
  count() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

export function wav({ formatTag = 1, channels = 1, sampleRate = 16000, data = new Uint8Array([1, 2]), extra = [] } = {}) {
  const fmt = new Uint8Array(16), view = new DataView(fmt.buffer);
  view.setUint16(0, formatTag, true); view.setUint16(2, channels, true); view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * 2, true); view.setUint16(12, 2, true); view.setUint16(14, 16, true);
  const chunks = [['fmt ', fmt], ...extra, ['data', data]];
  const bytes = new Uint8Array(12 + chunks.reduce((sum, [, value]) => sum + 8 + value.length + value.length % 2, 0));
  const body = new DataView(bytes.buffer);
  const tag = (offset, text) => bytes.set([...text].map(char => char.charCodeAt(0)), offset);
  tag(0, 'RIFF'); body.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE');
  let offset = 12;
  for (const [name, value] of chunks) {
    tag(offset, name); body.setUint32(offset + 4, value.length, true); bytes.set(value, offset + 8);
    offset += 8 + value.length + value.length % 2;
  }
  return { audio: bytes, mediaType: 'audio/wav' };
}
