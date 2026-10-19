export const MANUAL_RETENTION_PROTOCOL = 'form.manual-retention/v1' as const;
export const MANUAL_RETENTION_COMMAND_RESULT_SCHEMA = 'form.manual-retention-command-result/v1' as const;
export const MANUAL_RETENTION_CURRENT_RESULT_SCHEMA = 'form.manual-retention-current/v1' as const;
export const MANUAL_RETENTION_HEADER = 'X-Form-Manual-Retention' as const;
export const MANUAL_RETENTION_STATEMENT_SHA256 = '4ebd683942cc90b47ccd73613fc78c81cf8ed02bac57205349d798f42eda4ea3' as const;
export const MANUAL_RETENTION_STATEMENT = Object.freeze({
  schema: 'form.manual-retention-statement/v1',
  id: 'manual-personal-progress',
  version: 1,
  purpose: 'personal_measurement_progress',
  processing: 'manual_entry',
  text: 'I choose to save the manual circumference and weight measurements I submit during this interaction only for my personal measurement progress. I do not authorize photo retention, sharing with other users, rankings, sale, promotional reuse, research reuse, model training, or external-provider processing. Stopping future saves and deleting saved measurements are separate actions.',
} as const);
export const MANUAL_RETENTION_STATEMENT_BINDING = Object.freeze({
  id: MANUAL_RETENTION_STATEMENT.id,
  version: MANUAL_RETENTION_STATEMENT.version,
  sha256: MANUAL_RETENTION_STATEMENT_SHA256,
});

export type ManualRetentionProtocol = typeof MANUAL_RETENTION_PROTOCOL;
export type ManualRetentionStatementBinding = typeof MANUAL_RETENTION_STATEMENT_BINDING;
export type ManualRetentionGrantPayload = Readonly<{
  decisionId: string;
  processing: typeof MANUAL_RETENTION_STATEMENT.processing;
  purpose: typeof MANUAL_RETENTION_STATEMENT.purpose;
  choice: 'retain';
  statementId: typeof MANUAL_RETENTION_STATEMENT.id;
  statementVersion: typeof MANUAL_RETENTION_STATEMENT.version;
  statementSha256: typeof MANUAL_RETENTION_STATEMENT_SHA256;
}>;
export type ManualRetentionRevokePayload = Readonly<Record<string, never>>;
export type ManualRetentionAttemptAuthority = Readonly<{
  protocol: ManualRetentionProtocol;
  decisionId: string;
  revision: 1;
  statementSha256: typeof MANUAL_RETENTION_STATEMENT_SHA256;
}>;
export type ManualRetentionCurrent =
  | Readonly<{ decisionId: string; state: 'granted'; revision: 1; statement: ManualRetentionStatementBinding }>
  | Readonly<{ decisionId: string; state: 'revoked'; revision: 1; statement: null }>
  | Readonly<{ decisionId: string; state: 'revoked'; revision: 2; statement: ManualRetentionStatementBinding }>;
export type ManualRetentionReceipt =
  | Readonly<{ operation: 'grant'; decisionId: string; outcome: 'granted'; decisionRevision: 1 }>
  | Readonly<{ operation: 'grant'; decisionId: string; outcome: 'blocked_by_revocation'; decisionRevision: 1 | 2 }>
  | Readonly<{ operation: 'revoke'; decisionId: string; outcome: 'revoked'; decisionRevision: 1 | 2 }>;
export type ManualRetentionCommandResult = Readonly<{
  schema: typeof MANUAL_RETENTION_COMMAND_RESULT_SCHEMA;
  receipt: ManualRetentionReceipt;
  current: ManualRetentionCurrent;
}>;
export type ManualRetentionCurrentResult = Readonly<{
  schema: typeof MANUAL_RETENTION_CURRENT_RESULT_SCHEMA;
  current: ManualRetentionCurrent | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isManualRetentionDecisionId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}

// Copy descriptors, never property getters; callers use the detached frozen result before any await.
// Proxy traps can still run during reflection. This boundary is for data, not hostile executable objects.
function exactData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length) return null;
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key !== 'string' || !keys.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

export function captureManualRetentionStatementBinding(value: unknown): ManualRetentionStatementBinding | null {
  const row = exactData(value, ['id', 'version', 'sha256']);
  return row && row.id === MANUAL_RETENTION_STATEMENT.id && row.version === 1
    && row.sha256 === MANUAL_RETENTION_STATEMENT_SHA256 ? MANUAL_RETENTION_STATEMENT_BINDING : null;
}

export function captureManualRetentionGrantPayload(value: unknown): ManualRetentionGrantPayload | null {
  const row = exactData(value, ['decisionId', 'processing', 'purpose', 'choice', 'statementId', 'statementVersion', 'statementSha256']);
  if (!row || !isManualRetentionDecisionId(row.decisionId)
    || row.processing !== MANUAL_RETENTION_STATEMENT.processing || row.purpose !== MANUAL_RETENTION_STATEMENT.purpose
    || row.choice !== 'retain' || row.statementId !== MANUAL_RETENTION_STATEMENT.id
    || row.statementVersion !== 1 || row.statementSha256 !== MANUAL_RETENTION_STATEMENT_SHA256) return null;
  return Object.freeze({ decisionId: row.decisionId, processing: MANUAL_RETENTION_STATEMENT.processing,
    purpose: MANUAL_RETENTION_STATEMENT.purpose, choice: 'retain', statementId: MANUAL_RETENTION_STATEMENT.id,
    statementVersion: 1, statementSha256: MANUAL_RETENTION_STATEMENT_SHA256 });
}

export function captureManualRetentionRevokePayload(value: unknown): ManualRetentionRevokePayload | null {
  return exactData(value, []) ? Object.freeze({}) : null;
}

export function captureManualRetentionAttemptAuthority(value: unknown): ManualRetentionAttemptAuthority | null {
  const row = exactData(value, ['protocol', 'decisionId', 'revision', 'statementSha256']);
  if (!row || row.protocol !== MANUAL_RETENTION_PROTOCOL || !isManualRetentionDecisionId(row.decisionId)
    || row.revision !== 1 || row.statementSha256 !== MANUAL_RETENTION_STATEMENT_SHA256) return null;
  return Object.freeze({ protocol: MANUAL_RETENTION_PROTOCOL, decisionId: row.decisionId,
    revision: 1, statementSha256: MANUAL_RETENTION_STATEMENT_SHA256 });
}

export function captureManualRetentionCurrent(value: unknown): ManualRetentionCurrent | null {
  const row = exactData(value, ['decisionId', 'state', 'revision', 'statement']);
  if (!row || !isManualRetentionDecisionId(row.decisionId)) return null;
  if (row.state === 'revoked' && row.revision === 1 && row.statement === null) {
    return Object.freeze({ decisionId: row.decisionId, state: 'revoked', revision: 1, statement: null });
  }
  const statement = captureManualRetentionStatementBinding(row.statement);
  if (!statement) return null;
  if (row.state === 'granted' && row.revision === 1) {
    return Object.freeze({ decisionId: row.decisionId, state: 'granted', revision: 1, statement });
  }
  if (row.state === 'revoked' && row.revision === 2) {
    return Object.freeze({ decisionId: row.decisionId, state: 'revoked', revision: 2, statement });
  }
  return null;
}

export function captureManualRetentionReceipt(value: unknown): ManualRetentionReceipt | null {
  const row = exactData(value, ['operation', 'decisionId', 'outcome', 'decisionRevision']);
  if (!row || !isManualRetentionDecisionId(row.decisionId)) return null;
  if (row.operation === 'grant' && row.outcome === 'granted' && row.decisionRevision === 1) {
    return Object.freeze({ operation: 'grant', decisionId: row.decisionId, outcome: 'granted', decisionRevision: 1 });
  }
  if (row.decisionRevision !== 1 && row.decisionRevision !== 2) return null;
  if (row.operation === 'grant' && row.outcome === 'blocked_by_revocation') {
    return Object.freeze({ operation: 'grant', decisionId: row.decisionId,
      outcome: 'blocked_by_revocation', decisionRevision: row.decisionRevision });
  }
  if (row.operation === 'revoke' && row.outcome === 'revoked') {
    return Object.freeze({ operation: 'revoke', decisionId: row.decisionId, outcome: 'revoked', decisionRevision: row.decisionRevision });
  }
  return null;
}

// A successful historical grant receipt may accompany revoked current state; it is never fresh permission.
export function captureManualRetentionCommandResult(value: unknown): ManualRetentionCommandResult | null {
  const row = exactData(value, ['schema', 'receipt', 'current']);
  if (!row || row.schema !== MANUAL_RETENTION_COMMAND_RESULT_SCHEMA) return null;
  const receipt = captureManualRetentionReceipt(row.receipt), current = captureManualRetentionCurrent(row.current);
  if (!receipt || !current || receipt.decisionId !== current.decisionId) return null;
  if (receipt.outcome === 'granted') {
    if (current.state === 'revoked' && current.revision !== 2) return null;
  } else if (current.state !== 'revoked' || current.revision !== receipt.decisionRevision) return null;
  return Object.freeze({ schema: MANUAL_RETENTION_COMMAND_RESULT_SCHEMA, receipt, current });
}

// A nullable status read carries neither a command receipt nor evidence of a new local choice.
export function captureManualRetentionCurrentResult(value: unknown): ManualRetentionCurrentResult | null {
  const row = exactData(value, ['schema', 'current']);
  if (!row || row.schema !== MANUAL_RETENTION_CURRENT_RESULT_SCHEMA) return null;
  const current = row.current === null ? null : captureManualRetentionCurrent(row.current);
  if (row.current !== null && current === null) return null;
  return Object.freeze({ schema: MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current });
}

const HEADER_PATTERN = /^v1;decision=([0-9a-fA-F-]{36});revision=1;statement=([0-9a-f]{64})$/;
export const MANUAL_RETENTION_HEADER_LENGTH = 134;

// The HTTP adapter must reject duplicate raw header fields before calling this single-value parser.
export function parseManualRetentionHeader(value: unknown): ManualRetentionAttemptAuthority | null {
  if (typeof value !== 'string' || value.length !== MANUAL_RETENTION_HEADER_LENGTH) return null;
  const match = HEADER_PATTERN.exec(value);
  if (!match) return null;
  return captureManualRetentionAttemptAuthority({ protocol: MANUAL_RETENTION_PROTOCOL,
    decisionId: match[1], revision: 1, statementSha256: match[2] });
}

export function formatManualRetentionHeader(value: unknown): string | null {
  const authority = captureManualRetentionAttemptAuthority(value);
  return authority ? `v1;decision=${authority.decisionId};revision=1;statement=${authority.statementSha256}` : null;
}

export const MANUAL_RETENTION_CAPABILITY_SCHEMA = 'form.manual-retention-capability/v1' as const;
export type ManualRetentionCapability = Readonly<{
  schema: typeof MANUAL_RETENTION_CAPABILITY_SCHEMA;
  protocol: ManualRetentionProtocol;
  status: 'available' | 'unavailable';
  statement: ManualRetentionStatementBinding;
  grant: 'available' | 'unavailable';
  revoke: 'available' | 'unavailable';
  current: 'available' | 'unavailable';
}>;
export function captureManualRetentionCapability(value: unknown): ManualRetentionCapability | null {
  const row = exactData(value, ['schema', 'protocol', 'status', 'statement', 'grant', 'revoke', 'current']);
  if (!row || row.schema !== MANUAL_RETENTION_CAPABILITY_SCHEMA || row.protocol !== MANUAL_RETENTION_PROTOCOL ||
    (row.status !== 'available' && row.status !== 'unavailable') || row.grant !== row.status ||
    row.revoke !== row.status || row.current !== row.status) return null;
  const statement = captureManualRetentionStatementBinding(row.statement);
  if (!statement) return null;
  return Object.freeze({ schema: MANUAL_RETENTION_CAPABILITY_SCHEMA, protocol: MANUAL_RETENTION_PROTOCOL,
    status: row.status, statement, grant: row.status, revoke: row.status, current: row.status });
}
