/** Parent assigns the next migration version and runs its existing backup/integrity workflow. */
export const applePurchaseMigrationSql = `
  CREATE TABLE apple_purchase_owners (
    original_transaction_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    bundle_id TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment='Sandbox'),
    created_at_ms INTEGER NOT NULL,
    UNIQUE(original_transaction_id,account_id)
  );
  CREATE TABLE apple_purchase_transactions (
    transaction_id TEXT PRIMARY KEY,
    original_transaction_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    product_id TEXT NOT NULL,
    product_type TEXT NOT NULL,
    app_account_token TEXT NOT NULL CHECK(app_account_token=account_id),
    purchase_date_ms INTEGER NOT NULL,
    signed_date_ms INTEGER NOT NULL,
    expires_date_ms INTEGER,
    revocation_date_ms INTEGER,
    is_upgraded INTEGER NOT NULL CHECK(is_upgraded IN(0,1)),
    proof_hash TEXT NOT NULL,
    exact_jws TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY(original_transaction_id,account_id) REFERENCES apple_purchase_owners(original_transaction_id,account_id),
    UNIQUE(transaction_id,account_id,product_id),
    UNIQUE(transaction_id,account_id)
  );
  CREATE TABLE apple_purchase_grants (
    transaction_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    id TEXT NOT NULL UNIQUE,
    entitlement TEXT NOT NULL CHECK(entitlement='form_plus'),
    granted_at_ms INTEGER NOT NULL,
    FOREIGN KEY(transaction_id,account_id) REFERENCES apple_purchase_transactions(transaction_id,account_id)
  );
  CREATE TABLE apple_purchase_observations (
    transaction_id TEXT NOT NULL REFERENCES apple_purchase_transactions(transaction_id),
    proof_hash TEXT NOT NULL,
    claims TEXT NOT NULL CHECK(json_valid(claims)),
    exact_jws TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    PRIMARY KEY(transaction_id,proof_hash)
  );
  CREATE TABLE apple_purchase_commands (
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    idempotency_key TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    PRIMARY KEY(account_id,idempotency_key),
    FOREIGN KEY(transaction_id,account_id,product_id) REFERENCES apple_purchase_transactions(transaction_id,account_id,product_id)
  );
  CREATE TABLE apple_purchase_deliveries (
    transaction_id TEXT NOT NULL,
    proof_hash TEXT NOT NULL,
    server_delivery_id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    product_id TEXT NOT NULL,
    exact_jws TEXT NOT NULL,
    delivered_at_ms INTEGER NOT NULL,
    PRIMARY KEY(transaction_id,proof_hash),
    FOREIGN KEY(transaction_id,account_id,product_id) REFERENCES apple_purchase_transactions(transaction_id,account_id,product_id)
  );
  CREATE INDEX apple_purchase_account_grants ON apple_purchase_grants(account_id);
  CREATE TRIGGER immutable_apple_purchase_owner BEFORE UPDATE ON apple_purchase_owners
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_purchase_owner'); END;
  CREATE TRIGGER retained_apple_purchase_owner BEFORE DELETE ON apple_purchase_owners
    BEGIN SELECT RAISE(ABORT, 'retained_apple_purchase_owner'); END;
  CREATE TRIGGER immutable_apple_purchase_identity BEFORE UPDATE OF transaction_id,original_transaction_id,account_id,product_id,product_type,app_account_token,purchase_date_ms ON apple_purchase_transactions
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_purchase_identity'); END;
  CREATE TRIGGER permanent_apple_purchase_revocation BEFORE UPDATE ON apple_purchase_transactions
    WHEN (OLD.revocation_date_ms IS NOT NULL AND NEW.revocation_date_ms IS NULL) OR NEW.is_upgraded < OLD.is_upgraded OR NEW.signed_date_ms < OLD.signed_date_ms
    BEGIN SELECT RAISE(ABORT, 'permanent_apple_purchase_revocation'); END;
  CREATE TRIGGER immutable_apple_purchase_delivery BEFORE UPDATE ON apple_purchase_deliveries
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_purchase_delivery'); END;
  CREATE TRIGGER retained_apple_purchase_delivery BEFORE DELETE ON apple_purchase_deliveries
    BEGIN SELECT RAISE(ABORT, 'retained_apple_purchase_delivery'); END;
  CREATE TRIGGER immutable_apple_purchase_grant BEFORE UPDATE ON apple_purchase_grants
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_purchase_grant'); END;
  CREATE TRIGGER immutable_apple_purchase_command BEFORE UPDATE ON apple_purchase_commands
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_purchase_command'); END;
  CREATE TRIGGER immutable_apple_purchase_observation BEFORE UPDATE ON apple_purchase_observations
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_purchase_observation'); END;
  CREATE TRIGGER retained_apple_purchase_observation BEFORE DELETE ON apple_purchase_observations
    BEGIN SELECT RAISE(ABORT, 'retained_apple_purchase_observation'); END;
`;
