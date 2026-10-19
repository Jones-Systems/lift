export type StandardWireLimits = Readonly<{
  maxAudioBytes: number;
  maxEnvelopeBytes: number;
  /** UTF-16 code units per reason, transcript or reply; no normalization. */
  maxTextCharacters: number;
}>;
export type StandardWireAudio = Readonly<{ audio: Uint8Array; mediaType: 'audio/wav' }>;
export type StandardWireResult = Readonly<{
  outcome: Readonly<{ kind: 'succeeded'; value: StandardWireAudio }>
    | Readonly<{ kind: 'not_dispatched' | 'rejected' | 'unknown'; reason: string }>;
  accounting: 'not_reserved' | 'replay' | 'released' | 'settled' | 'not_consumed' | 'unknown' | 'unresolved';
  review?: Readonly<{ transcript: string; reply?: string }>;
}>;
export class StandardWireError extends Error {
  readonly tag = 'standard_wire_error';
  constructor(readonly code: 'limits' | 'size' | 'shape' | 'version' | 'media' | 'base64' | 'json') {
    super(`standard_wire_${code}`);
    this.name = 'StandardWireError';
  }
}
const bad = (code: StandardWireError['code']): never => { throw new StandardWireError(code); };
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const accounting = ['not_reserved', 'replay', 'released', 'settled', 'not_consumed', 'unknown', 'unresolved'];
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
function shape(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('shape');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return bad('shape');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !owns(value, key))) return bad('shape');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!owns(descriptor, 'value') || !descriptor.enumerable) return bad('shape');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return bad('shape');
  if (value.length > maximum) return bad('size');
  return value;
}
// Count UTF-8 and JSON escaping before allocation/stringify, including lone surrogates.
function stringBytes(value: string, json: boolean): number {
  let bytes = json ? 2 : 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (json && (c === 34 || c === 92)) bytes += 2;
    else if (json && c < 32) bytes += [8, 9, 10, 12, 13].includes(c) ? 2 : 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length
      && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += json && c >= 0xd800 && c <= 0xdfff ? 6 : 3;
  }
  return bytes;
}
function jsonBytes(value: unknown): number {
  if (typeof value === 'string') return stringBytes(value, true);
  if (typeof value === 'number') return String(value).length;
  const entries = Object.entries(value as Record<string, unknown>);
  return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, item]) => sum + stringBytes(key, true) + 1 + jsonBytes(item), 0);
}
function encode64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chunk += alphabet[(n >>> 18) & 63]! + alphabet[(n >>> 12) & 63]!
      + (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63]! : '=')
      + (i + 2 < bytes.length ? alphabet[n & 63]! : '=');
    if (chunk.length >= 8192) { chunks.push(chunk); chunk = ''; }
  }
  chunks.push(chunk);
  return chunks.join('');
}
function decode64(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0) return bad('base64');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const length = value.length / 4 * 3 - padding;
  if (length < 1 || length > maximum) return bad('size');
  const end = value.length - padding;
  for (let i = 0; i < end; i++) if (alphabet.indexOf(value[i]!) < 0) return bad('base64');
  if ((padding === 2 && (alphabet.indexOf(value[end - 1]!) & 15) !== 0)
    || (padding === 1 && (alphabet.indexOf(value[end - 1]!) & 3) !== 0)) return bad('base64');
  const result = new Uint8Array(length);
  let offset = 0;
  for (let i = 0; i < value.length; i += 4) {
    const n = (alphabet.indexOf(value[i]!) << 18) | (alphabet.indexOf(value[i + 1]!) << 12)
      | (Math.max(0, alphabet.indexOf(value[i + 2]!)) << 6) | Math.max(0, alphabet.indexOf(value[i + 3]!));
    result[offset++] = n >>> 16;
    if (offset < length) result[offset++] = (n >>> 8) & 255;
    if (offset < length) result[offset++] = n & 255;
  }
  return result;
}

/** Version 1 is private in-memory JSON. Scope, session and authority never enter this envelope. */
export function createStandardWireCodec(configured: StandardWireLimits) {
  const limits = Object.freeze({ ...configured });
  for (const key of ['maxAudioBytes', 'maxEnvelopeBytes', 'maxTextCharacters'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > 100_000_000) bad('limits');
  }
  function parse(wire: string, kind: 'request' | 'result'): Record<string, unknown> {
    if (typeof wire !== 'string') return bad('shape');
    if (wire.length > limits.maxEnvelopeBytes || stringBytes(wire, false) > limits.maxEnvelopeBytes) return bad('size');
    let value: unknown;
    try { value = JSON.parse(wire); } catch { return bad('json'); }
    const envelope = kind === 'request' ? shape(value, ['version', 'kind', 'audio'])
      : shape(value, ['version', 'kind', 'outcome', 'accounting'], ['review']);
    if (envelope.version !== 1) return bad('version');
    if (envelope.kind !== kind) return bad('shape');
    return envelope;
  }
  function serialize(value: object): string {
    if (jsonBytes(value) > limits.maxEnvelopeBytes) return bad('size');
    return JSON.stringify(value);
  }
  function encodedAudio(value: unknown): { mediaType: 'audio/wav'; base64: string } {
    const audio = shape(value, ['audio', 'mediaType']);
    if (audio.mediaType !== 'audio/wav') return bad('media');
    if (!(audio.audio instanceof Uint8Array)) return bad('shape');
    if (!audio.audio.byteLength || audio.audio.byteLength > limits.maxAudioBytes
      || 4 * Math.ceil(audio.audio.byteLength / 3) > limits.maxEnvelopeBytes) return bad('size');
    return { mediaType: 'audio/wav', base64: encode64(audio.audio) };
  }
  function decodedAudio(value: unknown): StandardWireAudio {
    const audio = shape(value, ['mediaType', 'base64']);
    if (audio.mediaType !== 'audio/wav') return bad('media');
    return Object.freeze({ mediaType: 'audio/wav', audio: decode64(audio.base64, limits.maxAudioBytes) });
  }
  function review(value: unknown): NonNullable<StandardWireResult['review']> {
    const item = shape(value, ['transcript'], ['reply']);
    return Object.freeze({ transcript: text(item.transcript, limits.maxTextCharacters),
      ...(owns(item, 'reply') ? { reply: text(item.reply, limits.maxTextCharacters) } : {}) });
  }
  return Object.freeze({
    limits,
    encodeRequest(audio: StandardWireAudio): string {
      return serialize({ version: 1, kind: 'request', audio: encodedAudio(audio) });
    },
    decodeRequest(wire: string): StandardWireAudio { return decodedAudio(parse(wire, 'request').audio); },
    encodeResult(value: StandardWireResult): string {
      const result = shape(value, ['outcome', 'accounting'], ['review']);
      if (typeof result.accounting !== 'string' || !accounting.includes(result.accounting)) return bad('shape');
      const outcome = shape(result.outcome, ['kind'], ['value', 'reason']);
      let encoded;
      if (outcome.kind === 'succeeded') {
        shape(outcome, ['kind', 'value']);
        encoded = { kind: 'succeeded', value: encodedAudio(outcome.value) };
      } else {
        shape(outcome, ['kind', 'reason']);
        if (!['not_dispatched', 'rejected', 'unknown'].includes(outcome.kind as string)) return bad('shape');
        encoded = { kind: outcome.kind, reason: text(outcome.reason, limits.maxTextCharacters) };
      }
      return serialize({ version: 1, kind: 'result', outcome: encoded, accounting: result.accounting,
        ...(owns(result, 'review') ? { review: review(result.review) } : {}) });
    },
    decodeResult(wire: string): StandardWireResult {
      const result = parse(wire, 'result');
      if (typeof result.accounting !== 'string' || !accounting.includes(result.accounting)) return bad('shape');
      const outcome = shape(result.outcome, ['kind'], ['value', 'reason']);
      let decoded: StandardWireResult['outcome'];
      if (outcome.kind === 'succeeded') {
        shape(outcome, ['kind', 'value']);
        decoded = { kind: 'succeeded', value: decodedAudio(outcome.value) };
      } else {
        shape(outcome, ['kind', 'reason']);
        if (outcome.kind !== 'not_dispatched' && outcome.kind !== 'rejected' && outcome.kind !== 'unknown') return bad('shape');
        decoded = { kind: outcome.kind, reason: text(outcome.reason, limits.maxTextCharacters) };
      }
      return Object.freeze({ outcome: Object.freeze(decoded), accounting: result.accounting as StandardWireResult['accounting'],
        ...(owns(result, 'review') ? { review: review(result.review) } : {}) });
    },
  });
}
export type StandardWireCodec = ReturnType<typeof createStandardWireCodec>;
