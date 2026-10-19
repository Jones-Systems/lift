export const feedbackOwnedTables = [
  'feedback_state', 'feedback_events', 'feedback_receipts', 'feedback_keys', 'feedback_projections', 'feedback_dependencies',
] as const;
export const feedbackPurgeOrder = [
  'feedback_keys', 'feedback_receipts', 'feedback_dependencies', 'feedback_projections', 'feedback_events', 'feedback_state',
] as const;
// WS01 assigns and registers the global migration version; importing this component executes no SQL.
export const feedbackMigrationSql = `
CREATE TABLE feedback_state (
  account_id TEXT PRIMARY KEY REFERENCES form_accounts(id),
  ledger_revision INTEGER NOT NULL CHECK(ledger_revision>=0),
  projection_revision INTEGER NOT NULL CHECK(projection_revision>=0)
);
CREATE TABLE feedback_events (
  account_id TEXT NOT NULL REFERENCES feedback_state(account_id), sequence INTEGER NOT NULL CHECK(sequence>0),
  event_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(account_id,sequence), UNIQUE(account_id,event_id)
);
CREATE TABLE feedback_receipts (
  account_id TEXT NOT NULL REFERENCES feedback_state(account_id), event_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,event_id)
);
CREATE TABLE feedback_keys (
  account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, event_id TEXT NOT NULL,
  PRIMARY KEY(account_id,idempotency_key),
  FOREIGN KEY(account_id,event_id) REFERENCES feedback_receipts(account_id,event_id)
);
CREATE TABLE feedback_projections (
  account_id TEXT PRIMARY KEY REFERENCES feedback_state(account_id), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE feedback_dependencies (
  account_id TEXT NOT NULL REFERENCES feedback_state(account_id), record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('context','session','plan')), source_id TEXT NOT NULL,
  PRIMARY KEY(account_id,record_id,kind,source_id)
);
CREATE INDEX feedback_source_dependents ON feedback_dependencies(account_id,kind,source_id);
`;
