export const usageMigrationVersion = 14;
export const usageOwnedTables = [
  'usage_accounts', 'usage_periods', 'usage_counters', 'usage_reservations',
  'usage_charges', 'usage_dispatches', 'usage_economics', 'usage_suppressions',
] as const;
export const usagePurgeOrder = [
  'usage_economics', 'usage_dispatches', 'usage_charges', 'usage_reservations',
  'usage_counters', 'usage_periods', 'usage_accounts', 'usage_suppressions',
] as const;
export const usageMigrationSql = `
  CREATE TABLE usage_accounts (
    account_id TEXT PRIMARY KEY REFERENCES form_accounts(id),
    period_policy_id TEXT NOT NULL
  );
  CREATE TABLE usage_periods (
    account_id TEXT NOT NULL REFERENCES usage_accounts(account_id),
    period_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
    CHECK(start_ms >= 0 AND end_ms > start_ms),
    PRIMARY KEY(account_id,period_id), UNIQUE(account_id,start_ms)
  );
  CREATE TABLE usage_counters (
    account_id TEXT NOT NULL, period_id TEXT NOT NULL,
    metric TEXT NOT NULL CHECK(metric IN ('live_voice_ms','coach_messages','workout_generations')),
    settled INTEGER NOT NULL DEFAULT 0 CHECK(settled BETWEEN 0 AND 9007199254740991),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved BETWEEN 0 AND 9007199254740991),
    unknown INTEGER NOT NULL DEFAULT 0 CHECK(unknown BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(account_id,period_id,metric),
    FOREIGN KEY(account_id,period_id) REFERENCES usage_periods(account_id,period_id)
  );
  CREATE TABLE usage_reservations (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, period_id TEXT NOT NULL,
    auth_user_id TEXT NOT NULL, auth_session_id TEXT NOT NULL, account_epoch INTEGER NOT NULL,
    operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, intent_hash TEXT NOT NULL,
    subject_id TEXT NOT NULL, fingerprint TEXT NOT NULL, policy_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','dispatching','unknown','settled','released')),
    created_at_ms INTEGER NOT NULL, resolution_hash TEXT, evidence_id TEXT,
    UNIQUE(account_id,operation,idempotency_key),
    FOREIGN KEY(account_id,period_id) REFERENCES usage_periods(account_id,period_id)
  );
  CREATE TRIGGER usage_immutable_intent BEFORE UPDATE OF
    id,account_id,period_id,auth_user_id,auth_session_id,account_epoch,operation,
    idempotency_key,intent_hash,subject_id,fingerprint,policy_id,created_at_ms ON usage_reservations
    BEGIN SELECT RAISE(ABORT, 'usage_immutable_intent'); END;
  CREATE TABLE usage_charges (
    reservation_id TEXT NOT NULL REFERENCES usage_reservations(id),
    metric TEXT NOT NULL CHECK(metric IN ('live_voice_ms','coach_messages','workout_generations')),
    amount INTEGER NOT NULL CHECK(amount BETWEEN 1 AND 9007199254740991),
    settled_amount INTEGER CHECK(settled_amount BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(reservation_id,metric)
  );
  CREATE TRIGGER usage_immutable_charge BEFORE UPDATE OF reservation_id,metric,amount ON usage_charges
    BEGIN SELECT RAISE(ABORT, 'usage_immutable_charge'); END;
  CREATE TABLE usage_dispatches (
    reservation_id TEXT NOT NULL REFERENCES usage_reservations(id),
    stage TEXT NOT NULL, ordinal INTEGER NOT NULL, dispatched_at_ms INTEGER,
    PRIMARY KEY(reservation_id,stage), UNIQUE(reservation_id,ordinal)
  );
  CREATE TABLE usage_economics (
    reservation_id TEXT NOT NULL REFERENCES usage_reservations(id),
    ordinal INTEGER NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
    source_id TEXT NOT NULL, telemetry TEXT NOT NULL CHECK(telemetry IN ('missing','partial','complete')),
    quantities TEXT NOT NULL CHECK(json_valid(quantities)),
    pricing_state TEXT NOT NULL DEFAULT 'unconfigured' CHECK(pricing_state='unconfigured'),
    PRIMARY KEY(reservation_id,ordinal)
  );
  CREATE TABLE usage_suppressions (
    account_id TEXT PRIMARY KEY REFERENCES form_accounts(id), epoch INTEGER NOT NULL
  );
`;
