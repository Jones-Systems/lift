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
function fail(code: LifecycleV2ErrorCode = 'invalid_lifecycle_v2'): never {
  const error = new LifecycleV2Error(code); failures.set(error, code); throw error;
}
function failureCode(error: unknown): LifecycleV2ErrorCode {
  return (error !== null && typeof error === 'object' ? failures.get(error) : undefined) ?? 'invalid_lifecycle_v2';
}
const invariant = (condition: boolean): void => { if (!condition) fail('lifecycle_v2_inconsistent'); };
const VERSION = 'form.account-lifecycle.v2', SMALL = 65536, LARGE = 16777216;
const forbidden = (key: string) => key === '__proto__' || key === 'prototype' || key === 'constructor';
const ID = /^[A-Za-z0-9_.:-]{1,256}$/, CATEGORY = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/, DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requiredSteps = ['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community'];
function unicodeBytes(text: string, quoted = false): number {
  let bytes = quoted ? 2 : 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
      bytes += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) fail();
    else if (quoted && (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c))) bytes += 2;
    else if (quoted && c < 32) bytes += 6;
    else bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
    if (bytes > LARGE) fail('lifecycle_v2_limit_exceeded');
  }
  return bytes;
}

// The first pass validates syntax and captures only the outer kind. It does
// not materialize records before the smaller message limit has been selected.
class JsonReader {
  private at = 0;
  kind: unknown;
  constructor(private readonly text: string) {}
  private space(): void { while (/^[\x20\t\r\n]$/.test(this.text[this.at] ?? '')) this.at++; }
  private string(materialize: boolean): string {
    const start = this.at++;
    let high = false;
    while (this.at < this.text.length) {
      let c = this.text.charCodeAt(this.at++);
      if (c === 34) {
        if (high) fail();
        return materialize ? JSON.parse(this.text.slice(start, this.at)) : '';
      }
      if (c < 32) fail();
      if (c === 92) {
        const escape = this.text[this.at++];
        if (escape === 'u') {
          const hex = this.text.slice(this.at, this.at + 4);
          if (!/^[a-fA-F0-9]{4}$/.test(hex)) fail();
          this.at += 4; c = parseInt(hex, 16);
        } else {
          if (!escape || !'"\\/bfnrt'.includes(escape)) fail();
          c = 0;
        }
      }
      if (high) { if (c < 0xdc00 || c > 0xdfff) fail(); high = false; }
      else if (c >= 0xd800 && c <= 0xdbff) high = true;
      else if (c >= 0xdc00 && c <= 0xdfff) fail();
    }
    return fail();
  }
  private value(build: boolean, depth: number, path = '', open = false): JsonValue {
    this.space();
    const c = this.text[this.at];
    if (c === '"') return this.string(build);
    if (c === '{' || c === '[') {
      if (depth > 64) fail('lifecycle_v2_limit_exceeded');
      this.at++; this.space();
      const object: { [key: string]: JsonValue } = {}, array: JsonValue[] = [], seen = new Set<string>();
      const end = c === '{' ? '}' : ']';
      if (this.text[this.at] === end) { this.at++; return c === '{' ? object : array; }
      let entries = 0;
      for (;;) {
        if (c === '{') {
          if (this.text[this.at] !== '"') fail();
          const key = this.string(true);
          if (seen.has(key) || forbidden(key)) fail();
          seen.add(key); this.space(); if (this.text[this.at++] !== ':') fail();
          const capture = depth === 1 && key === 'kind';
          const childPath = path + '.' + key;
          this.space();
          const value = this.value(build || (capture && this.text[this.at] === '"'), depth + 1, childPath, open || childPath === '.payload.records[].value');
          if (capture) this.kind = value;
          if (build) object[key] = value;
        } else {
          if (++entries > 256 && !open && path !== '.payload.records') fail('lifecycle_v2_limit_exceeded');
          const value = this.value(build, depth + 1, path + '[]', open);
          if (build) array.push(value);
        }
        this.space(); const delimiter = this.text[this.at++];
        if (delimiter === end) return c === '{' ? object : array;
        if (delimiter !== ',') fail();
        this.space();
      }
    }
    for (const [token, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.text.startsWith(token, this.at)) { this.at += token.length; return value; }
    }
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.at;
    const number = match.exec(this.text);
    if (!number) return fail();
    this.at = match.lastIndex;
    const value = Number(number[0]);
    if (!Number.isFinite(value)) fail();
    return value;
  }
  read(build: boolean): JsonValue { const value = this.value(build, 1); this.space(); if (this.at !== this.text.length) fail(); return value; }
}
function readText(text: string): unknown {
  if (typeof text !== 'string') fail();
  const bytes = unicodeBytes(text);
  const scan = new JsonReader(text); scan.read(false);
  if (bytes > (scan.kind === 'export' ? LARGE : SMALL)) fail('lifecycle_v2_limit_exceeded');
  return new JsonReader(text).read(true);
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) || keys.some(key => !fields.includes(key))) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) return fail(); return value; }
function literal<T extends string | number | boolean>(value: unknown, expected: T): T { if (value !== expected) return fail(); return expected; }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  for (const candidate of choices) if (value === candidate) return candidate;
  return fail();
}
const method = (v: unknown): Method => choice(v, ['password', 'email_action_code', 'phone_action_code']);
const status = (v: unknown): Status => choice(v, ['complete', 'pending', 'unavailable', 'unknown', 'retained']);
const completionStatus = (v: unknown): CompletionStatus => choice(v, ['complete', 'pending', 'unavailable', 'unknown']);
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(); return value; }
function ms(value: unknown): number { const n = integer(value); if (n > 8640000000000000) fail(); return n; }
function utc(value: unknown): string {
  const s = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const n = Date.parse(s); if (!Number.isFinite(n) || n < 0 || new Date(n).toISOString() !== s) fail(); return s;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value; }
const nullable = <T>(v: unknown, parse: (v: unknown) => T): T | null => v === null ? null : parse(v);
function array<T>(value: unknown, parse: (v: unknown) => T, bounded = true): T[] {
  if (!Array.isArray(value)) return fail();
  if (bounded && value.length > 256) fail('lifecycle_v2_limit_exceeded');
  return value.map(parse);
}
function unique<T>(values: T[], key: (v: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) fail('lifecycle_v2_inconsistent'); return values;
}
const categories = (v: unknown) => unique(array(v, x => text(x, CATEGORY)), x => x);
function evidence(value: unknown): Evidence {
  const e = object(value, ['state', 'reason', 'projection']);
  const state = choice(e.state, ['current', 'unknown', 'unavailable']);
  if (state === 'current') {
    if (e.reason !== null) fail();
    const p = object(e.projection, ['bindingDigest', 'observedAtMs']);
    return { state, reason: null, projection: { bindingDigest: text(p.bindingDigest, DIGEST), observedAtMs: ms(p.observedAtMs) } };
  }
  if (e.projection !== null) fail();
  return { state, reason: text(e.reason, CODE), projection: null };
}
function capabilities(value: unknown): CapabilitiesV2 {
  const p = object(value, ['accountId', 'status', 'initiation', 'actionReauthenticationMethods', 'policyVersion', 'wholeAccountDeletionComplete', 'exportMaxBytes', 'billingCancellation']);
  const result: CapabilitiesV2 = { accountId: text(p.accountId, ID), status: choice(p.status, ['unavailable', 'configured_unverified']),
    initiation: bool(p.initiation), actionReauthenticationMethods: unique(array(p.actionReauthenticationMethods, method), x => x),
    policyVersion: literal(p.policyVersion, 'form-account-lifecycle-v1'), wholeAccountDeletionComplete: literal(p.wholeAccountDeletionComplete, false),
    exportMaxBytes: literal(p.exportMaxBytes, 16777216), billingCancellation: literal(p.billingCancellation, 'not_performed') };
  invariant(result.status === 'unavailable' ? !result.initiation && result.actionReauthenticationMethods.length === 0 : result.initiation && result.actionReauthenticationMethods.length > 0);
  return result;
}
function grant(value: unknown): ActionGrantV2 {
  const p = object(value, ['grant', 'purpose', 'method', 'expiresAt']);
  return { grant: text(p.grant, /^[A-Za-z0-9_-]{43,128}$/), purpose: choice(p.purpose, ['account_export', 'account_delete']), method: method(p.method), expiresAt: utc(p.expiresAt) };
}
function deletion(value: unknown): DeletionV2 {
  const p = object(value, ['requestId', 'phase', 'initiated', 'disabled', 'localPurged', 'complete', 'requestedAt', 'verifiedActionMethod', 'backupExpiryAt', 'backup', 'billingCancellation', 'completion', 'steps']);
  const b = object(p.backup, ['status', 'policyVersion', 'inventoryDigest', 'dispositionEvidenceDigest']);
  const c = object(p.completion, ['scope', 'status', 'requiredCategories', 'localCategories', 'evidence']);
  const result: DeletionV2 = {
    requestId: text(p.requestId, UUID), phase: choice(p.phase, ['awaiting_reauthentication', 'disabled_pending_purge', 'disabled_pending_reconciliation', 'purging', 'pending_external', 'declared_scope_complete']),
    initiated: literal(p.initiated, true), disabled: bool(p.disabled), localPurged: bool(p.localPurged), complete: literal(p.complete, false), requestedAt: utc(p.requestedAt),
    verifiedActionMethod: nullable(p.verifiedActionMethod, method), backupExpiryAt: nullable(p.backupExpiryAt, utc),
    backup: { status: status(b.status), policyVersion: nullable(b.policyVersion, v => text(v, ID)), inventoryDigest: nullable(b.inventoryDigest, v => text(v, DIGEST)), dispositionEvidenceDigest: nullable(b.dispositionEvidenceDigest, v => text(v, DIGEST)) },
    billingCancellation: literal(p.billingCancellation, 'not_performed'),
    completion: { scope: literal(c.scope, 'declared_server_targets'), status: completionStatus(c.status), requiredCategories: categories(c.requiredCategories), localCategories: categories(c.localCategories), evidence: evidence(c.evidence) },
    steps: unique(array(p.steps, v => {
      const s = object(v, ['category', 'status', 'reason', 'retainUntilMs', 'retentionPolicyVersion']);
      return { category: text(s.category, CATEGORY), status: status(s.status), reason: nullable(s.reason, x => text(x, CODE)), retainUntilMs: nullable(s.retainUntilMs, ms), retentionPolicyVersion: nullable(s.retentionPolicyVersion, x => text(x, ID)) };
    }), s => s.category),
  };
  const { completion: scope, steps, backup } = result, byCategory = new Map(steps.map(s => [s.category, s]));
  invariant(requiredSteps.every(s => byCategory.has(s)));
  invariant(scope.requiredCategories.every(s => byCategory.has(s)) && scope.localCategories.every(s => scope.requiredCategories.includes(s)));
  for (const s of steps) invariant(s.retainUntilMs === null || s.retentionPolicyVersion !== null);
  const current = scope.evidence.state === 'current';
  const local = current && scope.localCategories.length > 0 && scope.localCategories.every(s => byCategory.get(s)?.status === 'complete');
  invariant(result.localPurged === local);
  const complete = current && scope.requiredCategories.length > 0 && scope.requiredCategories.every(s => byCategory.get(s)?.status === 'complete');
  invariant(scope.status === (current ? complete ? 'complete' : 'pending' : scope.evidence.state));
  if (!current) invariant(steps.every(s => s.status !== 'complete') && backup.status !== 'complete');
  invariant(result.disabled === (result.phase !== 'awaiting_reauthentication'));
  if (!result.disabled) invariant(result.verifiedActionMethod === null && !result.localPurged);
  invariant((result.phase === 'declared_scope_complete') === complete);
  if (complete) invariant(result.disabled && result.localPurged && result.verifiedActionMethod !== null);
  const backupStep = byCategory.get('backups');
  invariant(backupStep?.status === backup.status);
  if (backup.status === 'complete') invariant(current && backup.policyVersion !== null && backup.inventoryDigest !== null && backup.dispositionEvidenceDigest !== null);
  if (result.backupExpiryAt !== null) {
    invariant(backup.status === 'complete' && scope.evidence.state === 'current');
    if (scope.evidence.state === 'current') invariant(Date.parse(result.backupExpiryAt) <= scope.evidence.projection.observedAtMs);
  }
  return result;
}
function exported(value: unknown): ExportV2 {
  const p = object(value, ['records', 'manifest']);
  const m = object(p.manifest, ['schemaVersion', 'snapshotAtMs', 'complete', 'scope', 'provenance', 'categories', 'omissions', 'residuals', 'snapshotCompletion']);
  const s = object(m.scope, ['accountId', 'epoch']), provenance = object(m.provenance, ['source', 'consistency', 'authorization', 'adapterConsistency']);
  const completion = object(m.snapshotCompletion, ['scope', 'status', 'requiredCategories', 'evidence']);
  const result: ExportV2 = {
    records: array(p.records, v => { const r = object(v, ['category', 'value']); return { category: text(r.category, CATEGORY), value: jsonValue(r.value) }; }, false),
    manifest: { schemaVersion: literal(m.schemaVersion, 'form.account-export.v2'), snapshotAtMs: ms(m.snapshotAtMs), complete: literal(m.complete, false),
      scope: { accountId: text(s.accountId, ID), epoch: integer(s.epoch) },
      provenance: { source: literal(provenance.source, 'account-scoped-sqlite-read-transaction'), consistency: literal(provenance.consistency, 'single-connection-snapshot'),
        authorization: literal(provenance.authorization, 'caller-authoritative-session-epoch-suppression-before-generation-and-release'), adapterConsistency: literal(provenance.adapterConsistency, 'caller-qualified-synchronous-adapters') },
      categories: unique(array(m.categories, v => { const c = object(v, ['category', 'status', 'count', 'omittedCount', 'reason']); return { category: text(c.category, CATEGORY), status: status(c.status), count: integer(c.count), omittedCount: integer(c.omittedCount), reason: nullable(c.reason, x => text(x, CODE)) }; }), c => c.category),
      omissions: unique(array(m.omissions, v => { const o = object(v, ['category', 'reason', 'count', 'effect']); return { category: text(o.category, CATEGORY), reason: text(o.reason, CODE), count: nullable(o.count, integer), effect: choice(o.effect, ['excluded_from_scope', 'in_scope_missing']) }; }), o => o.category),
      residuals: unique(array(m.residuals, v => { const r = object(v, ['category', 'status', 'reason']); return { category: text(r.category, CATEGORY), status: status(r.status), reason: text(r.reason, CODE) }; }), r => r.category),
      snapshotCompletion: { scope: literal(completion.scope, 'declared_server_snapshot'), status: completionStatus(completion.status), requiredCategories: categories(completion.requiredCategories), evidence: evidence(completion.evidence) },
    },
  };
  const manifest = result.manifest, scope = manifest.snapshotCompletion;
  const counts = new Map(manifest.categories.map(c => [c.category, c.count]));
  for (const record of result.records) {
    invariant(counts.has(record.category)); counts.set(record.category, (counts.get(record.category) ?? 0) - 1);
    if (record.category === 'identity') {
      const v = record.value;
      invariant(v !== null && typeof v === 'object' && !Array.isArray(v) && 'accountId' in v && v.accountId === manifest.scope.accountId);
    }
  }
  invariant([...counts.values()].every(n => n === 0));
  invariant(scope.requiredCategories.every(c => counts.has(c)));
  const current = scope.evidence.state === 'current';
  const complete = current && scope.requiredCategories.length > 0
    && scope.requiredCategories.every(key => manifest.categories.some(c => c.category === key && c.status === 'complete' && c.omittedCount === 0))
    && manifest.omissions.every(o => o.effect === 'excluded_from_scope' || o.count === 0);
  invariant(scope.status === (current ? complete ? 'complete' : 'pending' : scope.evidence.state));
  if (!current) invariant(manifest.categories.every(c => c.status !== 'complete'));
  return result;
}
function jsonValue(v: unknown): JsonValue {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  if (Array.isArray(v)) return v.map(jsonValue);
  if (typeof v !== 'object') return fail();
  const result: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(v)) result[key] = jsonValue(value);
  return result;
}
function envelope(value: unknown): LifecycleV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('unsupported_lifecycle_version');
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== VERSION) fail('unsupported_lifecycle_version');
  if (!['capabilities', 'action_grant', 'deletion', 'export'].includes(typeof root.kind === 'string' ? root.kind : '')) fail('lifecycle_kind_mismatch');
  object(root, ['schemaVersion', 'kind', 'payload']);
  switch (root.kind) {
    case 'capabilities': return { schemaVersion: VERSION, kind: 'capabilities', payload: capabilities(root.payload) };
    case 'action_grant': return { schemaVersion: VERSION, kind: 'action_grant', payload: grant(root.payload) };
    case 'deletion': return { schemaVersion: VERSION, kind: 'deletion', payload: deletion(root.payload) };
    case 'export': return { schemaVersion: VERSION, kind: 'export', payload: exported(root.payload) };
    default: return fail('lifecycle_kind_mismatch');
  }
}
function bind(value: LifecycleV2, expected: ExpectedV2): void {
  if (!expected || expected.schemaVersion !== VERSION) fail('unsupported_lifecycle_version');
  if (expected.kind !== value.kind) fail('lifecycle_kind_mismatch');
  if (value.kind === 'capabilities' && expected.kind === 'capabilities') {
    if (text(expected.accountId, ID) !== value.payload.accountId) fail('lifecycle_subject_mismatch');
  } else if (value.kind === 'deletion' && expected.kind === 'deletion') {
    if (text(expected.requestId, UUID) !== value.payload.requestId) fail('lifecycle_subject_mismatch');
  } else if (value.kind === 'export' && expected.kind === 'export') {
    if (text(expected.accountId, ID) !== value.payload.manifest.scope.accountId || integer(expected.epoch) !== value.payload.manifest.scope.epoch) fail('lifecycle_subject_mismatch');
  } else if (value.kind === 'action_grant' && expected.kind === 'action_grant') {
    const purpose = choice(expected.purpose, ['account_export', 'account_delete']), now = ms(expected.nowMs);
    const methods = unique(array(expected.allowedMethods, method), x => x);
    if (!methods.length || purpose !== value.payload.purpose || !methods.includes(value.payload.method) || Date.parse(value.payload.expiresAt) <= now) fail('lifecycle_grant_mismatch');
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
export function decodeLifecycleV2(text: string, expected: ExpectedV2): LifecycleV2 {
  try { return decode(text, expected); } catch (error) {
    throw new LifecycleV2Error(failureCode(error));
  }
}
function decode(text: string, expected: ExpectedV2): LifecycleV2 {
  const raw = readText(text);
  if (!expected || expected.schemaVersion !== VERSION) fail('unsupported_lifecycle_version');
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    if (!('schemaVersion' in raw) || raw.schemaVersion !== VERSION) fail('unsupported_lifecycle_version');
    if (!('kind' in raw) || raw.kind !== expected.kind) fail('lifecycle_kind_mismatch');
  }
  const value = envelope(raw); bind(value, expected); return freeze(value);
}

// Budget before normalization/stringification, without invoking accessors or
// toJSON. Only own enumerable data properties of plain JSON are admissible.
function snapshot(input: unknown): JsonValue {
  let spent = 0;
  const ancestors = new Set<object>();
  let limit = SMALL;
  if (input !== null && typeof input === 'object') {
    const descriptor = Object.getOwnPropertyDescriptor(input, 'kind');
    if (descriptor && 'value' in descriptor && descriptor.value === 'export') limit = LARGE;
  }
  const charge = (n: number) => { spent += n; if (spent > limit) fail('lifecycle_v2_limit_exceeded'); };
  function visit(v: unknown, depth: number, path = '', open = false): JsonValue {
    if (v === null) { charge(4); return null; }
    if (typeof v === 'string') { charge(unicodeBytes(v, true)); return v; }
    if (typeof v === 'boolean') { charge(v ? 4 : 5); return v; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) return fail(); charge(String(v).length); return v; }
    if (typeof v !== 'object') return fail();
    if (depth > 64) fail('lifecycle_v2_limit_exceeded');
    if (ancestors.has(v)) fail(); ancestors.add(v);
    const isArray = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (!isArray && proto !== null && proto !== Object.prototype) fail();
    if (isArray && proto !== Array.prototype) fail();
    if (isArray && v.length > 256 && !open && path !== '.payload.records') fail('lifecycle_v2_limit_exceeded');
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (keys.some(key => typeof key !== 'string')) fail();
    charge(2);
    let output: JsonValue;
    if (isArray) {
      if (keys.length !== v.length + 1) fail();
      const result: JsonValue[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !('value' in d) || !d.enumerable) fail();
        if (i) charge(1); result.push(visit(d.value, depth + 1, path + '[]', open));
      }
      output = result;
    } else {
      const result: { [key: string]: JsonValue } = {};
      let count = 0;
      for (const key of Object.keys(descriptors)) {
        const d = descriptors[key];
        if (!d || !('value' in d) || !d.enumerable || forbidden(key)) fail();
        const childPath = path + '.' + key;
        charge((count++ ? 1 : 0) + unicodeBytes(key, true) + 1); result[key] = visit(d.value, depth + 1, childPath, open || childPath === '.payload.records[].value');
      }
      output = result;
    }
    ancestors.delete(v); return output;
  }
  return visit(input, 1);
}
export function encodeLifecycleV2(value: unknown): string {
  try { return JSON.stringify(envelope(snapshot(value))); } catch (error) {
    throw new LifecycleV2Error(failureCode(error));
  }
}
