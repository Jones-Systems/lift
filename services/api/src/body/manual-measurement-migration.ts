export const manualMeasurementMigrationSql = `
CREATE TABLE body_manual_measurements (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES form_accounts(id), kind TEXT NOT NULL,
 value REAL NOT NULL CHECK(value>0), unit TEXT NOT NULL CHECK(unit IN('cm','kg')), original_unit TEXT NOT NULL,
 measured_on TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
CREATE INDEX body_manual_account_date ON body_manual_measurements(account_id,measured_on,id);
CREATE TABLE body_manual_receipts(account_id TEXT NOT NULL REFERENCES form_accounts(id), key TEXT NOT NULL,
 intent_hash TEXT NOT NULL, measurement_id TEXT NOT NULL, operation TEXT NOT NULL, PRIMARY KEY(account_id,key));`;
