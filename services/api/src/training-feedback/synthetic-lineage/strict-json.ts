import { types } from 'node:util';
import type { CodecError, Decode } from '../../planning/synthetic-lineage/types.js';

export const EMBEDDED_LIMITS = Object.freeze({ bytes: 256 * 1024, depth: 32, nodes: 32768, string: 4000 });
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export class Invalid extends Error {
  constructor(readonly code: CodecError['code'], readonly path = '$') { super(code); }
}
export function fail(code: CodecError['code'], path = '$'): never { throw new Invalid(code, path); }
export function requireThat(condition: unknown, code: CodecError['code'] = 'context_mismatch', path = '$'): asserts condition {
  if (!condition) fail(code, path);
}
export function result<T>(work: () => T): Decode<T> {
  try { return { ok: true, value: work() }; }
  catch (error) { return { ok: false, error: { kind: 'codec-error', code: error instanceof Invalid ? error.code : 'wrong_type',
    path: error instanceof Invalid ? error.path.slice(0, 256) : '$' } }; }
}
export function validString(value: string, max: number = EMBEDDED_LIMITS.string): void {
  requireThat(value.length <= max, 'bounds_exceeded');
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i); requireThat(next >= 0xdc00 && next <= 0xdfff, 'invalid_string');
    } else requireThat(n < 0xdc00 || n > 0xdfff, 'invalid_string');
  }
}
function validNumber(n: number): void {
  requireThat(Number.isFinite(n) && !Object.is(n, -0) && Math.abs(n) <= Number.MAX_SAFE_INTEGER, 'invalid_number');
}

/** Internal embedded JSON seam. It is not Platform's outer container codec. */
export function parseBytes(bytes: Uint8Array): Json {
  requireThat(typeof bytes === 'object' && bytes !== null && !types.isProxy(bytes) && Object.getPrototypeOf(bytes) === Uint8Array.prototype, 'wrong_type');
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!.call(bytes) as number;
  requireThat(length <= EMBEDDED_LIMITS.bytes, 'bounds_exceeded');
  const descriptors = Object.getOwnPropertyDescriptors(bytes);
  requireThat(Reflect.ownKeys(descriptors).length === length, 'wrong_type');
  for (let i = 0; i < length; i++) requireThat(Object.hasOwn(descriptors, String(i)) && 'value' in descriptors[String(i)]!, 'wrong_type');
  requireThat(Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!.call(bytes) instanceof ArrayBuffer, 'wrong_type');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail('bad_utf8'); }
  requireThat(!text.startsWith('\ufeff'), 'bad_utf8');
  let at = 0, nodes = 0;
  const ws = () => { while (at < text.length && /[\x20\x09\x0a\x0d]/.test(text[at]!)) at++; };
  function string(): string {
    const start = at++; let escaped = false;
    for (; at < text.length; at++) {
      const c = text[at]!;
      if (!escaped && c === '"') {
        const token = text.slice(start, ++at); let value: unknown;
        try { value = JSON.parse(token); } catch { return fail('bad_json'); }
        requireThat(typeof value === 'string', 'bad_json'); validString(value); return value;
      }
      if (!escaped && c === '\\') escaped = true; else escaped = false;
    }
    return fail('bad_json');
  }
  function read(depth: number): Json {
    requireThat(depth <= EMBEDDED_LIMITS.depth && ++nodes <= EMBEDDED_LIMITS.nodes, 'bounds_exceeded'); ws();
    const c = text[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; ws(); const row: { [key: string]: Json } = {}; const seen = new Set<string>();
      if (text[at] === '}') { at++; return row; }
      while (true) {
        requireThat(text[at] === '"', 'bad_json'); const key = string();
        requireThat(!seen.has(key), 'duplicate_key'); seen.add(key); ws();
        requireThat(text[at++] === ':', 'bad_json'); const value = read(depth + 1);
        Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true }); ws();
        if (text[at] === '}') { at++; return row; }
        requireThat(text[at++] === ',', 'bad_json'); ws();
      }
    }
    if (c === '[') {
      at++; ws(); const list: Json[] = []; if (text[at] === ']') { at++; return list; }
      while (true) { list.push(read(depth + 1)); ws(); if (text[at] === ']') { at++; return list; }
        requireThat(text[at++] === ',', 'bad_json'); }
    }
    for (const [token, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, at)) { at += token.length; return value; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
    requireThat(match, 'bad_json'); at += match[0].length;
    const n = Number(match[0]); validNumber(n); return n;
  }
  const value = read(1); ws(); requireThat(at === text.length, 'bad_json'); return value;
}

/** Descriptor-only traversal: even a rejected accessor or thenable is never invoked. */
export function detach(value: unknown, maxBytes = EMBEDDED_LIMITS.bytes, largeCanonicalStrings = false): Json {
  let nodes = 0, units = 0; const ancestors = new Set<object>();
  function copy(input: unknown, depth: number, key = ''): Json {
    requireThat(++nodes <= EMBEDDED_LIMITS.nodes && depth <= EMBEDDED_LIMITS.depth, 'bounds_exceeded');
    if (typeof input === 'string') {
      validString(input, largeCanonicalStrings && key === 'canonicalJson' ? EMBEDDED_LIMITS.bytes : EMBEDDED_LIMITS.string);
      units += input.length; requireThat(units <= maxBytes, 'bounds_exceeded'); return input;
    }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') { validNumber(input); return input; }
    requireThat(typeof input === 'object' && !types.isProxy(input), 'wrong_type');
    requireThat(!ancestors.has(input), 'cycle');
    const list = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    requireThat(prototype === (list ? Array.prototype : Object.prototype), 'wrong_type');
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
    requireThat(keys.every(k => typeof k === 'string'), 'wrong_type');
    const output: Json[] | { [key: string]: Json } = list ? [] : {};
    let length = 0;
    if (list) {
      const ld = descriptors.length; requireThat(ld && 'value' in ld && Number.isSafeInteger(ld.value), 'wrong_type');
      length = ld.value; requireThat(length >= 0 && length <= EMBEDDED_LIMITS.nodes && keys.length === length + 1, 'bounds_exceeded');
      for (let i = 0; i < length; i++) requireThat(Object.hasOwn(descriptors, String(i)), 'wrong_type');
    }
    ancestors.add(input);
    for (const k of keys) {
      requireThat(typeof k === 'string', 'wrong_type'); if (list && k === 'length') continue;
      validString(k); units += k.length; requireThat(units <= maxBytes, 'bounds_exceeded');
      if (list) requireThat(/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < length, 'wrong_type');
      const d = descriptors[k]!; requireThat('value' in d && d.enumerable, 'wrong_type');
      Object.defineProperty(output, k, { value: copy(d.value, depth + 1, k), enumerable: true });
    }
    ancestors.delete(input); return Object.freeze(output) as Json;
  }
  const owned = copy(value, 1);
  requireThat(new TextEncoder().encode(canonical(owned)).length <= maxBytes, 'bounds_exceeded'); return owned;
}
export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k =>
    `${JSON.stringify(k)}:${canonical(value[k]!)}`).join(',')}}`;
  return JSON.stringify(value);
}
