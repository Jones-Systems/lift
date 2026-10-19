/** Unnumbered additive SQL. WS01 owns registration, backup and runtime migration; import performs no DDL. */
export const applePurchaseReconciliationMigrationSql = `
  CREATE TABLE apple_purchase_reconciliations (
    handle TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    original_transaction_id TEXT NOT NULL,
    owner_binding TEXT NOT NULL CHECK(json_valid(owner_binding)),
    actor_binding TEXT NOT NULL CHECK(json_valid(actor_binding)),
    next_page INTEGER NOT NULL CHECK(next_page>=0),
    revision TEXT,
    outcome TEXT NOT NULL CHECK(json_valid(outcome)),
    FOREIGN KEY(original_transaction_id,account_id) REFERENCES apple_purchase_owners(original_transaction_id,account_id)
  );
  CREATE TABLE apple_purchase_reconciliation_pages (
    handle TEXT NOT NULL REFERENCES apple_purchase_reconciliations(handle),
    request_page INTEGER NOT NULL CHECK(request_page>=0),
    response_hash TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(json_valid(outcome)),
    PRIMARY KEY(handle,request_page)
  );
  CREATE TABLE apple_purchase_notifications (
    notification_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    exact_payload TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    original_transaction_id TEXT NOT NULL,
    renewal_jws TEXT,
    outcome TEXT NOT NULL CHECK(json_valid(outcome)),
    FOREIGN KEY(original_transaction_id,account_id) REFERENCES apple_purchase_owners(original_transaction_id,account_id)
  );
  CREATE TRIGGER immutable_apple_reconciliation_binding BEFORE UPDATE OF handle,account_id,original_transaction_id,owner_binding,actor_binding ON apple_purchase_reconciliations
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_reconciliation_binding'); END;
  CREATE TRIGGER immutable_apple_reconciliation_page BEFORE UPDATE ON apple_purchase_reconciliation_pages
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_reconciliation_page'); END;
  CREATE TRIGGER immutable_apple_notification BEFORE UPDATE ON apple_purchase_notifications
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_notification'); END;
`;
