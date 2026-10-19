export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type FeedbackScope =
  | { kind: 'session'; contextId: string; sessionId: string; planId: string | null }
  | { kind: 'plan'; contextId: string; planId: string }
  | { kind: 'context'; contextId: string };

export type FeedbackDimension = 'rir' | 'effort' | 'discomfort' | 'weakness' | 'function'
  | 'performance' | 'sensation' | 'soreness';

export type FeedbackSignal = { dimension: FeedbackDimension } & (
  | { state: 'reported'; value: Exclude<JsonValue, null>; unit: string | null; scale: string | null }
  | { state: 'missing'; reason: 'not-asked' | 'not-reported' | 'unknown' | 'declined' }
);

export interface SourceReference {
  sourceId: string;
  revision: string;
  locator: string;
  qualification: string;
}

export interface FeedbackContent {
  scope: FeedbackScope;
  sourceRefs: SourceReference[];
  qualifications: string[];
  payload:
    | { kind: 'feedback'; signals: FeedbackSignal[] }
    | { kind: 'edit'; field: string; before: JsonValue; after: JsonValue };
}

interface EventIdentity {
  eventId: string;
  accountId: string;
  recordId: string;
  expectedRevision: number;
}

export type FeedbackEvent = EventIdentity & (
  | { kind: 'record' | 'correct'; content: FeedbackContent }
  | { kind: 'confirm' | 'withdraw' | 'delete' }
  | { kind: 'undo'; targetEventId: string }
);

export interface FeedbackRecord {
  recordId: string;
  revision: number;
  status: 'active' | 'withdrawn' | 'deleted' | 'undone';
  confirmed: boolean;
  content: FeedbackContent | null;
}

export interface SourceLineage {
  recordId: string;
  revision: number;
  status: FeedbackRecord['status'] | 'missing';
  confirmed: boolean;
  scope: FeedbackScope | null;
  sourceRefs: SourceReference[];
  qualifications: string[];
}

export interface DerivationSpec {
  id: string;
  version: string;
  kind: 'history' | 'summary' | 'recommendation';
  scope: FeedbackScope;
  sourceIds: string[];
  dependsOn: string[];
  sourceRefs: SourceReference[];
  qualifications: string[];
  compute: (input: { sources: FeedbackRecord[]; parents: DerivedFeedback[] }) => JsonValue;
}

export interface DerivedFeedback {
  id: string;
  version: string;
  kind: DerivationSpec['kind'];
  scope: FeedbackScope;
  status: 'ready' | 'blocked';
  value: JsonValue;
  blockedBy: string[];
  lineage: SourceLineage[];
  recipeLineage: { id: string; version: string; sourceRefs: SourceReference[]; qualifications: string[] }[];
}

export interface FeedbackReceipt {
  eventId: string;
  recordId: string;
  cause: FeedbackEvent['kind'];
  outcome: 'changed' | 'unchanged' | 'rejected';
  revision: number;
  reason: string | null;
  scopeBefore: FeedbackScope | null;
  scopeAfter: FeedbackScope | null;
  invalidatedDerivationIds: string[];
}

export interface FeedbackProjection {
  accountId: string;
  records: FeedbackRecord[];
  derivations: DerivedFeedback[];
  receipts: FeedbackReceipt[];
}

const dimensions = new Set<FeedbackDimension>([
  'rir', 'effort', 'discomfort', 'weakness', 'function', 'performance', 'sensation', 'soreness',
]);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nullableText = (value: unknown) => value === null || text(value);

function json(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value).every(json);
}

function scopeValid(scope: FeedbackScope): boolean {
  if (!scope || !text(scope.contextId)) return false;
  switch (scope.kind) {
    case 'context': return true;
    case 'plan': return text(scope.planId);
    case 'session': return text(scope.sessionId) && nullableText(scope.planId);
    default: return false;
  }
}

function refsValid(refs: SourceReference[]): boolean {
  return Array.isArray(refs) && refs.length > 0 && refs.every(ref => ref &&
    text(ref.sourceId) && text(ref.revision) && text(ref.locator) && text(ref.qualification));
}

function qualificationsValid(values: string[]): boolean {
  return Array.isArray(values) && values.length > 0 && values.every(text);
}

function contentValid(content: FeedbackContent): boolean {
  if (!content || !scopeValid(content.scope) || !refsValid(content.sourceRefs)
      || !qualificationsValid(content.qualifications) || !content.payload) return false;
  const payload = content.payload;
  if (payload.kind === 'edit') return text(payload.field) && json(payload.before) && json(payload.after);
  return payload.kind === 'feedback' && Array.isArray(payload.signals) && payload.signals.length > 0
    && payload.signals.every(signal => signal && dimensions.has(signal.dimension) && (
      signal.state === 'missing'
        ? ['not-asked', 'not-reported', 'unknown', 'declined'].includes(signal.reason)
        : signal.state === 'reported' && signal.value !== null && json(signal.value)
          && nullableText(signal.unit) && nullableText(signal.scale)
    ));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function sourcePermitted(source: FeedbackScope, target: FeedbackScope, kind: DerivationSpec['kind']): boolean {
  if (source.contextId !== target.contextId) return false;
  if (kind !== 'recommendation') return true;
  if (source.kind === 'context') return true;
  if (source.kind === 'plan') return target.kind !== 'context' && source.planId === target.planId;
  return target.kind === 'session' && source.sessionId === target.sessionId && source.planId === target.planId;
}

function graph(specs: DerivationSpec[]): { ordered: DerivationSpec[]; roots: Map<string, string[]> } {
  const byId = new Map<string, DerivationSpec>();
  for (const spec of specs) {
    if (!text(spec.id) || byId.has(spec.id) || !text(spec.version) || !scopeValid(spec.scope)
        || !['history', 'summary', 'recommendation'].includes(spec.kind)
        || !Array.isArray(spec.sourceIds) || !Array.isArray(spec.dependsOn)
        || ![...spec.sourceIds, ...spec.dependsOn].every(text)
        || spec.sourceIds.length + spec.dependsOn.length === 0
        || new Set(spec.sourceIds).size !== spec.sourceIds.length
        || new Set(spec.dependsOn).size !== spec.dependsOn.length
        || !refsValid(spec.sourceRefs) || !qualificationsValid(spec.qualifications)
        || typeof spec.compute !== 'function') throw new Error('Invalid feedback derivation definition');
    byId.set(spec.id, spec);
  }
  const ordered: DerivationSpec[] = [];
  const roots = new Map<string, string[]>();
  const visiting = new Set<string>();
  function visit(id: string): string[] {
    const cached = roots.get(id);
    if (cached) return cached;
    const spec = byId.get(id);
    if (!spec || visiting.has(id)) throw new Error('Missing or cyclic feedback derivation dependency');
    visiting.add(id);
    const sources = [...new Set([...spec.sourceIds, ...spec.dependsOn.flatMap(visit)])];
    visiting.delete(id);
    roots.set(id, sources);
    ordered.push(spec);
    return sources;
  }
  for (const id of byId.keys()) visit(id);
  return { ordered, roots };
}

// The caller owns authenticated input, event retention/purge, and atomic persistence of replay results.
export function replayFeedback(input: {
  accountId: string;
  events: FeedbackEvent[];
  derivations: DerivationSpec[];
}): FeedbackProjection {
  if (!text(input.accountId)) throw new Error('An account binding is required');
  const { ordered, roots } = graph(input.derivations);
  const records = new Map<string, FeedbackRecord>();
  const seen = new Map<string, { fingerprint: string; receipt: FeedbackReceipt }>();
  const latest = new Map<string, { event: FeedbackEvent; before: FeedbackRecord | null }>();
  const confirmations = new Map<string, string>();
  const receipts: FeedbackReceipt[] = [];

  for (const event of input.events) {
    const current = records.get(event.recordId);
    const receipt: FeedbackReceipt = {
      eventId: event.eventId, recordId: event.recordId, cause: event.kind, outcome: 'rejected',
      revision: current?.revision ?? 0, reason: null,
      scopeBefore: structuredClone(current?.content?.scope ?? null),
      scopeAfter: structuredClone(current?.content?.scope ?? null), invalidatedDerivationIds: [],
    };
    const fingerprint = canonical(event);
    const duplicate = seen.get(event.eventId);
    let next: FeedbackRecord | null = null;
    let undoesConfirmation = false;
    if (event.accountId !== input.accountId) receipt.reason = 'account-mismatch';
    else if (!text(event.eventId) || !text(event.recordId)
        || !Number.isSafeInteger(event.expectedRevision) || event.expectedRevision < 0) receipt.reason = 'invalid-event';
    else if (duplicate) {
      receipt.reason = duplicate.fingerprint === fingerprint ? 'duplicate-event' : 'event-id-conflict';
      if (duplicate.fingerprint === fingerprint && duplicate.receipt.outcome !== 'rejected') receipt.outcome = 'unchanged';
    } else if (event.expectedRevision !== receipt.revision) receipt.reason = 'revision-conflict';
    else if (current?.status === 'deleted') receipt.reason = 'deleted-terminal';
    else if (event.kind === 'record') {
      if (current) receipt.reason = 'record-exists';
      else if (!contentValid(event.content)) receipt.reason = 'invalid-content';
      else next = { recordId: event.recordId, revision: 1, status: 'active', confirmed: false,
        content: structuredClone(event.content) };
    } else if (!current) receipt.reason = 'record-missing';
    else if (event.kind === 'correct') {
      if (!contentValid(event.content)) receipt.reason = 'invalid-content';
      else next = { ...current, status: 'active', confirmed: false, content: structuredClone(event.content) };
    } else if (event.kind === 'confirm') {
      if (current.status !== 'active') receipt.reason = 'record-inactive';
      else if (current.confirmed) { receipt.outcome = 'unchanged'; receipt.reason = 'already-confirmed'; }
      else next = { ...current, confirmed: true };
    } else if (event.kind === 'withdraw') {
      if (current.status !== 'active') receipt.reason = 'record-inactive';
      else next = { ...current, status: 'withdrawn', confirmed: false };
    } else if (event.kind === 'delete') {
      next = { ...current, status: 'deleted', confirmed: false, content: null };
    } else if (event.kind === 'undo') {
      const target = latest.get(event.recordId);
      undoesConfirmation = current.confirmed && confirmations.get(event.recordId) === event.targetEventId;
      if (undoesConfirmation) next = { ...current, confirmed: false };
      else if (!target || target.event.eventId !== event.targetEventId) receipt.reason = 'undo-target-conflict';
      else next = target.before ? { ...structuredClone(target.before), confirmed: false }
        : { ...current, status: 'undone', confirmed: false, content: null };
    } else receipt.reason = 'invalid-event-kind';
    if (next) {
      next.revision = (current?.revision ?? 0) + 1;
      records.set(event.recordId, next);
      if (event.kind === 'confirm') confirmations.set(event.recordId, event.eventId);
      else {
        confirmations.delete(event.recordId);
        if (event.kind === 'undo') {
          if (!undoesConfirmation) latest.delete(event.recordId);
        } else latest.set(event.recordId, { event: structuredClone(event), before: current ? structuredClone(current) : null });
      }
      receipt.outcome = 'changed';
      receipt.revision = next.revision;
      receipt.scopeAfter = structuredClone(next.content?.scope ?? null);
      receipt.invalidatedDerivationIds = ordered.filter(spec => roots.get(spec.id)!.includes(event.recordId)).map(spec => spec.id);
    }
    if (!duplicate && event.accountId === input.accountId) seen.set(event.eventId, { fingerprint, receipt });
    receipts.push(receipt);
  }

  const results = new Map<string, DerivedFeedback>();
  for (const spec of ordered) {
    const parents = spec.dependsOn.map(id => results.get(id)!);
    const lineage = roots.get(spec.id)!.map(recordId => {
      const record = records.get(recordId);
      return { recordId, revision: record?.revision ?? 0, status: record?.status ?? 'missing',
        confirmed: record?.confirmed ?? false, scope: structuredClone(record?.content?.scope ?? null),
        sourceRefs: structuredClone(record?.content?.sourceRefs ?? []),
        qualifications: structuredClone(record?.content?.qualifications ?? []) } satisfies SourceLineage;
    });
    const blockedBy: string[] = [];
    for (const source of lineage) {
      if (source.status !== 'active') blockedBy.push(`source:${source.recordId}:${source.status}`);
      else if (!source.confirmed) blockedBy.push(`source:${source.recordId}:unconfirmed`);
      else if (!source.scope || !sourcePermitted(source.scope, spec.scope, spec.kind)) blockedBy.push(`source:${source.recordId}:scope-mismatch`);
    }
    for (const parent of parents) {
      if (parent.status !== 'ready') blockedBy.push(`derivation:${parent.id}:blocked`);
      else if (!sourcePermitted(parent.scope, spec.scope, spec.kind)) blockedBy.push(`derivation:${parent.id}:scope-mismatch`);
    }
    const recipeLineage = [...new Map([
      ...parents.flatMap(parent => parent.recipeLineage).map(recipe => [recipe.id, recipe] as const),
      [spec.id, { id: spec.id, version: spec.version, sourceRefs: spec.sourceRefs, qualifications: spec.qualifications }] as const,
    ]).values()];
    let value: JsonValue = null;
    if (!blockedBy.length) {
      try {
        const computed = spec.compute(structuredClone({ sources: spec.sourceIds.map(id => records.get(id)!), parents }));
        if (!json(computed)) blockedBy.push(`derivation:${spec.id}:invalid-result`);
        else value = structuredClone(computed);
      } catch { blockedBy.push(`derivation:${spec.id}:compute-failed`); }
    }
    results.set(spec.id, { id: spec.id, version: spec.version, kind: spec.kind, scope: structuredClone(spec.scope),
      status: blockedBy.length ? 'blocked' : 'ready', value, blockedBy, lineage, recipeLineage: structuredClone(recipeLineage) });
  }
  return { accountId: input.accountId, records: structuredClone([...records.values()]), derivations: [...results.values()], receipts };
}
