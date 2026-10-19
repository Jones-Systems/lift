import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';

export const runtimeModulesConfiguration = z.object({
  version: z.literal(1), mode: z.literal('private-modules'),
  authorityDirectory: z.string().min(1).max(4096).refine(p => isAbsolute(p) && resolve(p) === p),
  authorityId: z.uuid(), ownerUid: z.number().int().nonnegative().safe(),
  publicLifecycle: z.literal('disabled'), communityLimiter: z.literal('bounded-single-process-v1'),
}).strict();
export type RuntimeModulesConfiguration = z.infer<typeof runtimeModulesConfiguration>;

// Scan keys before JSON.parse: duplicate keys must never silently select authority.
export function strictJson(text: string, maxBytes = 65536): unknown {
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Oversized JSON');
  let at = 0, depth = 0;
  const whitespace = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string => {
    const start = at++; let escaped = false;
    while (at < text.length) {
      const c = text[at++];
      if (!escaped && c === '"') return JSON.parse(text.slice(start, at)) as string;
      if (!escaped && c === '\\') escaped = true; else escaped = false;
    }
    throw new Error('Invalid JSON string');
  };
  const value = (): void => {
    whitespace(); if (++depth > 64) throw new Error('JSON nesting limit');
    if (text[at] === '{') {
      at++; whitespace(); const keys = new Set<string>();
      if (text[at] !== '}') for (;;) {
        whitespace(); if (text[at] !== '"') throw new Error('Invalid JSON key');
        const key = string(); if (keys.has(key)) throw new Error('Duplicate JSON key'); keys.add(key);
        whitespace(); if (text[at++] !== ':') throw new Error('Invalid JSON object'); value(); whitespace();
        if (text[at] !== ',') break; at++;
      }
      if (text[at++] !== '}') throw new Error('Invalid JSON object');
    } else if (text[at] === '[') {
      at++; whitespace(); if (text[at] !== ']') for (;;) { value(); whitespace(); if (text[at] !== ',') break; at++; }
      if (text[at++] !== ']') throw new Error('Invalid JSON array');
    } else if (text[at] === '"') string();
    else { const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at)); if (!match) throw new Error('Invalid JSON value'); at += match[0].length; }
    depth--;
  };
  value(); whitespace(); if (at !== text.length) throw new Error('Trailing JSON input');
  return JSON.parse(text) as unknown;
}
export function parseRuntimeModules(value: unknown, production = false): RuntimeModulesConfiguration | undefined {
  if (value === undefined) return undefined;
  const parsed = runtimeModulesConfiguration.parse(value);
  if (production && parsed.ownerUid !== 1000) throw new Error('Runtime owner must be Malcolm UID1000');
  return Object.freeze(parsed);
}
