export const wearableTables = [
  'wearable_connections', 'wearable_measures', 'wearable_cursors',
  'wearable_receipts', 'wearable_suggestions', 'wearable_provider_intents',
] as const;
export const wearablePurgeOrder = [
  'wearable_provider_intents', 'wearable_suggestions', 'wearable_receipts',
  'wearable_cursors', 'wearable_measures', 'wearable_connections',
] as const;

// Unnumbered source fragment; root owns migration selection and lifecycle registration.
export const wearablePersistenceSql = `
CREATE TABLE wearable_connections (
  account_id TEXT NOT NULL REFERENCES form_accounts(id), connection_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0), data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(account_id,connection_id)
);
CREATE TABLE wearable_measures (
  account_id TEXT NOT NULL, connection_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 0),
  record_id TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(account_id,connection_id,generation,record_id),
  FOREIGN KEY(account_id,connection_id) REFERENCES wearable_connections(account_id,connection_id),
  CHECK(json_type(data,'$.aiEligible') IS 'false'),
  CHECK(json_extract(data,'$.provenance') IS 'unqualified_import')
);
CREATE INDEX wearable_measure_day ON wearable_measures(account_id,day,connection_id,record_id);
CREATE TABLE wearable_cursors (
  account_id TEXT NOT NULL, connection_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 0),
  stream TEXT NOT NULL, cursor TEXT,
  PRIMARY KEY(account_id,connection_id,generation,stream),
  FOREIGN KEY(account_id,connection_id) REFERENCES wearable_connections(account_id,connection_id)
);
CREATE TABLE wearable_receipts (
  account_id TEXT NOT NULL REFERENCES form_accounts(id), key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  connection_id TEXT, generation INTEGER, purged INTEGER NOT NULL DEFAULT 0 CHECK(purged IN(0,1)),
  result TEXT CHECK(result IS NULL OR json_valid(result)), PRIMARY KEY(account_id,key),
  FOREIGN KEY(account_id,connection_id) REFERENCES wearable_connections(account_id,connection_id),
  CHECK((connection_id IS NULL AND generation IS NULL) OR (connection_id IS NOT NULL AND generation IS NOT NULL AND generation >= 0)),
  CHECK((purged=0 AND result IS NOT NULL) OR (purged=1 AND result IS NULL AND connection_id IS NULL AND generation IS NULL))
);
CREATE INDEX wearable_receipt_connection ON wearable_receipts(account_id,connection_id,generation);
CREATE TRIGGER wearable_receipt_immutable BEFORE UPDATE ON wearable_receipts
WHEN NOT (OLD.purged=0 AND NEW.purged=1 AND NEW.account_id=OLD.account_id AND NEW.key=OLD.key
  AND NEW.fingerprint=OLD.fingerprint AND NEW.result IS NULL AND NEW.connection_id IS NULL AND NEW.generation IS NULL)
BEGIN SELECT RAISE(ABORT,'health_receipt_immutable'); END;
CREATE TABLE wearable_suggestions (
  account_id TEXT NOT NULL REFERENCES form_accounts(id), suggestion_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id,suggestion_id)
);
CREATE TABLE wearable_provider_intents (
  account_id TEXT NOT NULL, connection_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 0),
  stream TEXT NOT NULL, session_id TEXT NOT NULL, epoch INTEGER NOT NULL, binding TEXT NOT NULL,
  key TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(account_id,connection_id,generation,stream), UNIQUE(account_id,key),
  FOREIGN KEY(account_id,connection_id) REFERENCES wearable_connections(account_id,connection_id)
);
CREATE TRIGGER wearable_intent_immutable BEFORE UPDATE ON wearable_provider_intents
BEGIN SELECT RAISE(ABORT,'health_provider_intent_immutable'); END;
`;
