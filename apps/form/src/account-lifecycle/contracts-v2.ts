// This codec checks representation, not evidence authority or currentness.
export type Method = 'password' | 'email_action_code' | 'phone_action_code';
export type Status = 'complete' | 'pending' | 'unavailable' | 'unknown' | 'retained';
export type Evidence =
  | { readonly state: 'unavailable' | 'unknown'; readonly reason: string; readonly projection: null }
  | { readonly state: 'current'; readonly reason: null; readonly projection: { readonly bindingDigest: string; readonly observedAtMs: number } };
export type StepV2 = { readonly category: string; readonly status: Status; readonly reason: string | null;
  readonly retainUntilMs: number | null; readonly retentionPolicyVersion: string | null };
export type ScopedCompletion = { readonly scope: 'declared_server_targets'; readonly status: CompletionStatus;
  readonly requiredCategories: readonly string[]; readonly localCategories: readonly string[]; readonly evidence: Evidence };
export type BackupV2 = { readonly status: Status; readonly policyVersion: string | null;
  readonly inventoryDigest: string | null; readonly dispositionEvidenceDigest: string | null };
export type CapabilitiesV2 = { readonly accountId: string; readonly status: 'unavailable' | 'configured_unverified';
  readonly initiation: boolean; readonly actionReauthenticationMethods: readonly Method[];
  readonly policyVersion: 'form-account-lifecycle-v1'; readonly wholeAccountDeletionComplete: false;
  readonly exportMaxBytes: 16777216; readonly billingCancellation: 'not_performed' };
export type ActionGrantV2 = { readonly grant: string; readonly purpose: Purpose; readonly method: Method; readonly expiresAt: string };
export type DeletionV2 = { readonly requestId: string; readonly phase: Phase; readonly initiated: true;
  readonly disabled: boolean; readonly localPurged: boolean; readonly complete: false; readonly requestedAt: string;
  readonly verifiedActionMethod: Method | null; readonly backupExpiryAt: string | null; readonly backup: BackupV2;
  readonly billingCancellation: 'not_performed'; readonly completion: ScopedCompletion; readonly steps: readonly StepV2[] };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ExportCategoryV2 = { readonly category: string; readonly status: Status; readonly count: number;
  readonly omittedCount: number; readonly reason: string | null };
export type ExportOmissionV2 = { readonly category: string; readonly reason: string; readonly count: number | null;
  readonly effect: 'excluded_from_scope' | 'in_scope_missing' };
export type ExportResidualV2 = { readonly category: string; readonly status: Status; readonly reason: string };
export type ExportV2 = { readonly records: readonly { readonly category: string; readonly value: JsonValue }[];
  readonly manifest: { readonly schemaVersion: 'form.account-export.v2'; readonly snapshotAtMs: number; readonly complete: false;
    readonly scope: { readonly accountId: string; readonly epoch: number };
    readonly provenance: { readonly source: 'account-scoped-sqlite-read-transaction'; readonly consistency: 'single-connection-snapshot';
      readonly authorization: 'caller-authoritative-session-epoch-suppression-before-generation-and-release';
      readonly adapterConsistency: 'caller-qualified-synchronous-adapters' };
    readonly categories: readonly ExportCategoryV2[]; readonly omissions: readonly ExportOmissionV2[];
    readonly residuals: readonly ExportResidualV2[];
    readonly snapshotCompletion: { readonly scope: 'declared_server_snapshot'; readonly status: CompletionStatus;
      readonly requiredCategories: readonly string[]; readonly evidence: Evidence } } };
type Purpose = 'account_export' | 'account_delete';
type CompletionStatus = 'unavailable' | 'unknown' | 'pending' | 'complete';
type Phase = 'awaiting_reauthentication' | 'disabled_pending_purge' | 'disabled_pending_reconciliation' | 'purging' | 'pending_external' | 'declared_scope_complete';
type Payloads = { capabilities: CapabilitiesV2; action_grant: ActionGrantV2; deletion: DeletionV2; export: ExportV2 };
export type LifecycleV2 = { [K in keyof Payloads]: { readonly schemaVersion: 'form.account-lifecycle.v2'; readonly kind: K; readonly payload: Payloads[K] } }[keyof Payloads];
export type ExpectedV2 = { readonly schemaVersion: 'form.account-lifecycle.v2' } & (
  | { readonly kind: 'capabilities'; readonly accountId: string }
  | { readonly kind: 'deletion'; readonly requestId: string }
  | { readonly kind: 'export'; readonly accountId: string; readonly epoch: number }
  | { readonly kind: 'action_grant'; readonly purpose: Purpose; readonly nowMs: number; readonly allowedMethods: readonly Method[] });
export type LifecycleV2ErrorCode = 'unsupported_lifecycle_version' | 'lifecycle_kind_mismatch' | 'lifecycle_subject_mismatch'
  | 'lifecycle_grant_mismatch' | 'invalid_lifecycle_v2' | 'lifecycle_v2_inconsistent' | 'lifecycle_v2_limit_exceeded';
export class LifecycleV2Error extends Error {
  readonly effectUnknown = true;
  constructor(readonly code: LifecycleV2ErrorCode) { super(code); this.name = 'LifecycleV2Error'; }
}
const failures = new WeakMap<object, LifecycleV2ErrorCode>();
function reject(code: LifecycleV2ErrorCode = 'invalid_lifecycle_v2'): never {
  const error = new LifecycleV2Error(code); failures.set(error, code); throw error;
}
const consistent = (ok: boolean) => { if (!ok) reject('lifecycle_v2_inconsistent'); };
const VERSION = 'form.account-lifecycle.v2';
const blockedKey = (key: string) => ['__proto__', 'constructor', 'prototype'].includes(key);
function utf8(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) reject();
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) reject();
    else bytes += code <= 127 ? 1 : code <= 2047 ? 2 : 3;
    if (bytes > 16777216) reject('lifecycle_v2_limit_exceeded');
  }
  return bytes;
}

// Check the raw token stream before JSON.parse can erase duplicate keys.
// The scan retains no record tree and grants the export budget only to an
// explicit outer export kind. Metadata is validated after the bounded parse.
function parseWire(source: string): unknown {
  if (typeof source !== 'string') reject();
  const bytes = utf8(source);
  let cursor = 0, outerKind: unknown;
  const white = () => { while (' \t\r\n'.includes(source[cursor] ?? '\u0000')) cursor++; };
  const stringToken = (): string => {
    const start = cursor;
    if (source[cursor++] !== '"') return reject();
    let escaped = false;
    while (cursor < source.length) {
      const ch = source[cursor++];
      if (!escaped && ch === '"') {
        let value: unknown;
        try { value = JSON.parse(source.slice(start, cursor)); } catch { return reject(); }
        if (typeof value !== 'string') return reject();
        utf8(value); return value;
      }
      if (!escaped && ch === '\\') escaped = true;
      else escaped = false;
    }
    return reject();
  };
  function scan(depth: number, capture = false, path = '', open = false): unknown {
    white(); const ch = source[cursor];
    if (ch === '"') { const value = stringToken(); return capture ? value : null; }
    if (ch === '[' || ch === '{') {
      if (depth > 64) reject('lifecycle_v2_limit_exceeded');
      cursor++; white(); const end = ch === '[' ? ']' : '}', keys = new Set<string>();
      if (source[cursor] === end) { cursor++; return null; }
      let entries = 0;
      for (;;) {
        if (ch === '{') {
          const key = stringToken();
          if (blockedKey(key) || keys.has(key)) reject();
          keys.add(key); white(); if (source[cursor++] !== ':') reject();
          const kind = depth === 1 && key === 'kind';
          const childPath = path + '.' + key;
          const value = scan(depth + 1, kind, childPath, open || childPath === '.payload.records[].value'); if (kind) outerKind = value;
        } else {
          if (++entries > 256 && !open && path !== '.payload.records') reject('lifecycle_v2_limit_exceeded');
          scan(depth + 1, false, path + '[]', open);
        }
        white(); const next = source[cursor++];
        if (next === end) return null;
        if (next !== ',') reject(); white();
      }
    }
    const token = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
    token.lastIndex = cursor; const match = token.exec(source);
    if (!match) return reject();
    cursor = token.lastIndex;
    if (!['true', 'false', 'null'].includes(match[0]) && !Number.isFinite(Number(match[0]))) reject();
    return null;
  }
  scan(1); white(); if (cursor !== source.length) reject();
  if (bytes > (outerKind === 'export' ? 16777216 : 65536)) reject('lifecycle_v2_limit_exceeded');
  try { return JSON.parse(source); } catch { return reject(); }
}

type Parser<T> = (input: unknown) => T;
function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return reject();
  return input as Record<string, unknown>;
}
function closed<T extends Record<string, Parser<unknown>>>(input: unknown, fields: T): { [K in keyof T]: ReturnType<T[K]> } {
  const value = record(input), names = Object.keys(fields);
  if (Object.keys(value).length !== names.length || names.some(key => !Object.hasOwn(value, key))) reject();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const parser = fields[name]; if (!parser) return reject(); result[name] = parser(value[name]);
  }
  return result as { [K in keyof T]: ReturnType<T[K]> };
}
const exact = <T extends string | boolean | number>(expected: T): Parser<T> => input => input === expected ? expected : reject();
function enumOf<T extends string>(...values: T[]): Parser<T> { return input => { for (const v of values) if (input === v) return v; return reject(); }; }
const matching = (pattern: RegExp): Parser<string> => input => typeof input === 'string' && pattern.exec(input)?.[0] === input ? input : reject();
const id = matching(/^[A-Za-z0-9_.:-]{1,256}$/), category = matching(/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/);
const code = matching(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/), digest = matching(/^[a-f0-9]{64}$/);
const requestId = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const number: Parser<number> = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : reject();
const time: Parser<number> = v => { const n = number(v); return n <= 8640000000000000 ? n : reject(); };
const boolean: Parser<boolean> = v => typeof v === 'boolean' ? v : reject();
const nullable = <T>(parser: Parser<T>): Parser<T | null> => v => v === null ? null : parser(v);
const utc: Parser<string> = v => {
  const value = matching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)(v), millis = Date.parse(value);
  return Number.isFinite(millis) && millis >= 0 && new Date(millis).toISOString() === value ? value : reject();
};
function list<T>(parser: Parser<T>, metadata = true): Parser<T[]> {
  return v => { if (!Array.isArray(v)) return reject(); if (metadata && v.length > 256) reject('lifecycle_v2_limit_exceeded'); return v.map(parser); };
}
function distinct<T>(parser: Parser<T[]>, key: (item: T) => string): Parser<T[]> {
  return v => { const items = parser(v); consistent(new Set(items.map(key)).size === items.length); return items; };
}
const names = distinct(list(category), v => v), method = enumOf('password', 'email_action_code', 'phone_action_code');
const methods = distinct(list(method), v => v), status = enumOf('complete', 'pending', 'unavailable', 'unknown', 'retained');
const progress = enumOf('complete', 'pending', 'unavailable', 'unknown'), purpose = enumOf('account_export', 'account_delete');
const evidence: Parser<Evidence> = input => {
  const p = record(input);
  if (p.state === 'current') return closed(input, { state: exact('current'), reason: nullParser, projection: v => closed(v, { bindingDigest: digest, observedAtMs: time }) });
  return closed(input, { state: enumOf('unavailable', 'unknown'), reason: code, projection: nullParser });
};
const nullParser: Parser<null> = v => v === null ? null : reject();
const capability: Parser<CapabilitiesV2> = input => {
  const c = closed(input, { accountId: id, status: enumOf('unavailable', 'configured_unverified'), initiation: boolean,
    actionReauthenticationMethods: methods, policyVersion: exact('form-account-lifecycle-v1'), wholeAccountDeletionComplete: exact(false),
    exportMaxBytes: exact(16777216), billingCancellation: exact('not_performed') });
  consistent(c.status === 'unavailable' ? !c.initiation && c.actionReauthenticationMethods.length === 0 : c.initiation && c.actionReauthenticationMethods.length > 0);
  return c;
};
const action: Parser<ActionGrantV2> = input => closed(input, { grant: matching(/^[A-Za-z0-9_-]{43,128}$/), purpose, method, expiresAt: utc });
const deletion: Parser<DeletionV2> = input => {
  const d = closed(input, {
    requestId, phase: enumOf('awaiting_reauthentication', 'disabled_pending_purge', 'disabled_pending_reconciliation', 'purging', 'pending_external', 'declared_scope_complete'),
    initiated: exact(true), disabled: boolean, localPurged: boolean, complete: exact(false), requestedAt: utc, verifiedActionMethod: nullable(method), backupExpiryAt: nullable(utc),
    backup: v => closed(v, { status, policyVersion: nullable(id), inventoryDigest: nullable(digest), dispositionEvidenceDigest: nullable(digest) }),
    billingCancellation: exact('not_performed'),
    completion: v => closed(v, { scope: exact('declared_server_targets'), status: progress, requiredCategories: names, localCategories: names, evidence }),
    steps: distinct(list(v => closed(v, { category, status, reason: nullable(code), retainUntilMs: nullable(time), retentionPolicyVersion: nullable(id) })), v => v.category),
  });
  const byName = new Map(d.steps.map(v => [v.category, v])), c = d.completion, current = c.evidence.state === 'current';
  consistent(['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community'].every(v => byName.has(v)));
  consistent(c.localCategories.every(v => c.requiredCategories.includes(v)) && c.requiredCategories.every(v => byName.has(v)));
  consistent(d.steps.every(v => v.retainUntilMs === null || v.retentionPolicyVersion !== null));
  const allLocal = current && c.localCategories.length !== 0 && c.localCategories.every(v => byName.get(v)?.status === 'complete');
  const allRequired = current && c.requiredCategories.length !== 0 && c.requiredCategories.every(v => byName.get(v)?.status === 'complete');
  consistent(d.localPurged === allLocal);
  consistent(c.status === (current ? allRequired ? 'complete' : 'pending' : c.evidence.state));
  if (!current) consistent(d.steps.every(v => v.status !== 'complete') && d.backup.status !== 'complete');
  consistent(d.disabled !== (d.phase === 'awaiting_reauthentication'));
  if (!d.disabled) consistent(d.verifiedActionMethod === null && !d.localPurged);
  consistent((d.phase === 'declared_scope_complete') === allRequired);
  if (allRequired) consistent(d.disabled && d.localPurged && d.verifiedActionMethod !== null);
  consistent(byName.get('backups')?.status === d.backup.status);
  if (d.backup.status === 'complete') consistent(current && d.backup.policyVersion !== null && d.backup.inventoryDigest !== null && d.backup.dispositionEvidenceDigest !== null);
  if (d.backupExpiryAt !== null) {
    consistent(d.backup.status === 'complete' && c.evidence.state === 'current');
    if (c.evidence.state === 'current') consistent(Date.parse(d.backupExpiryAt) <= c.evidence.projection.observedAtMs);
  }
  return d;
};
const json: Parser<JsonValue> = v => {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(json);
  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(record(v))) result[key] = json(item);
  return result;
};
const exported: Parser<ExportV2> = input => {
  const result = closed(input, {
    records: list(v => closed(v, { category, value: json }), false),
    manifest: v => closed(v, {
      schemaVersion: exact('form.account-export.v2'), snapshotAtMs: time, complete: exact(false), scope: v => closed(v, { accountId: id, epoch: number }),
      provenance: v => closed(v, { source: exact('account-scoped-sqlite-read-transaction'), consistency: exact('single-connection-snapshot'),
        authorization: exact('caller-authoritative-session-epoch-suppression-before-generation-and-release'), adapterConsistency: exact('caller-qualified-synchronous-adapters') }),
      categories: distinct(list(v => closed(v, { category, status, count: number, omittedCount: number, reason: nullable(code) })), v => v.category),
      omissions: distinct(list(v => closed(v, { category, reason: code, count: nullable(number), effect: enumOf('excluded_from_scope', 'in_scope_missing') })), v => v.category),
      residuals: distinct(list(v => closed(v, { category, status, reason: code })), v => v.category),
      snapshotCompletion: v => closed(v, { scope: exact('declared_server_snapshot'), status: progress, requiredCategories: names, evidence }),
    }),
  });
  const m = result.manifest, c = m.snapshotCompletion, actual = new Map(m.categories.map(v => [v.category, 0]));
  for (const r of result.records) {
    consistent(actual.has(r.category)); actual.set(r.category, (actual.get(r.category) ?? 0) + 1);
    if (r.category === 'identity') {
      const v = r.value;
      consistent(v !== null && typeof v === 'object' && !Array.isArray(v) && 'accountId' in v && v.accountId === m.scope.accountId);
    }
  }
  consistent(m.categories.every(v => actual.get(v.category) === v.count));
  consistent(c.requiredCategories.every(v => actual.has(v)));
  const current = c.evidence.state === 'current';
  const complete = current && c.requiredCategories.length > 0
    && c.requiredCategories.every(key => m.categories.some(v => v.category === key && v.status === 'complete' && v.omittedCount === 0))
    && !m.omissions.some(v => v.effect === 'in_scope_missing' && v.count !== 0);
  consistent(c.status === (current ? complete ? 'complete' : 'pending' : c.evidence.state));
  if (!current) consistent(m.categories.every(v => v.status !== 'complete'));
  return result;
};
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); } return value;
}
export function decodeLifecycleV2(text: string, expected: ExpectedV2): LifecycleV2 {
  try { return decode(text, expected); } catch (error) {
    const code = error !== null && typeof error === 'object' ? failures.get(error) : undefined;
    throw new LifecycleV2Error(code ?? 'invalid_lifecycle_v2');
  }
}
function decode(text: string, expected: ExpectedV2): LifecycleV2 {
  const raw = parseWire(text), root = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? record(raw) : {};
  if (root.schemaVersion !== VERSION || !expected || expected.schemaVersion !== VERSION) reject('unsupported_lifecycle_version');
  if (root.kind !== expected.kind || !['capabilities', 'action_grant', 'deletion', 'export'].includes(typeof root.kind === 'string' ? root.kind : '')) reject('lifecycle_kind_mismatch');
  closed(root, { schemaVersion: exact(VERSION), kind: enumOf('capabilities', 'action_grant', 'deletion', 'export'), payload: v => v });
  let result: LifecycleV2;
  switch (root.kind) {
    case 'capabilities': result = { schemaVersion: VERSION, kind: 'capabilities', payload: capability(root.payload) }; break;
    case 'action_grant': result = { schemaVersion: VERSION, kind: 'action_grant', payload: action(root.payload) }; break;
    case 'deletion': result = { schemaVersion: VERSION, kind: 'deletion', payload: deletion(root.payload) }; break;
    case 'export': result = { schemaVersion: VERSION, kind: 'export', payload: exported(root.payload) }; break;
    default: return reject('lifecycle_kind_mismatch');
  }
  if (result.kind === 'capabilities' && expected.kind === 'capabilities') {
    if (id(expected.accountId) !== result.payload.accountId) reject('lifecycle_subject_mismatch');
  } else if (result.kind === 'deletion' && expected.kind === 'deletion') {
    if (requestId(expected.requestId) !== result.payload.requestId) reject('lifecycle_subject_mismatch');
  } else if (result.kind === 'export' && expected.kind === 'export') {
    if (id(expected.accountId) !== result.payload.manifest.scope.accountId || number(expected.epoch) !== result.payload.manifest.scope.epoch) reject('lifecycle_subject_mismatch');
  } else if (result.kind === 'action_grant' && expected.kind === 'action_grant') {
    const allowed = methods(expected.allowedMethods), now = time(expected.nowMs), selected = purpose(expected.purpose);
    if (!allowed.length || !allowed.includes(result.payload.method) || selected !== result.payload.purpose || Date.parse(result.payload.expiresAt) <= now) reject('lifecycle_grant_mismatch');
  }
  return immutable(result);
}
