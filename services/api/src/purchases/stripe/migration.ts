// Explicit additive migration only. The registering composition owns numbering and backup; defaults never apply it.
export const stripePurchaseMigrationSql = `
CREATE TABLE stripe_web_configuration (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL);
CREATE TABLE stripe_web_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO stripe_web_state VALUES(1,0);
CREATE TABLE stripe_web_customers (
 customer_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES form_accounts(id), UNIQUE(customer_id,account_id));
CREATE TABLE stripe_web_subscriptions (
 subscription_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES form_accounts(id),
 product_id TEXT NOT NULL, status TEXT NOT NULL, period_end INTEGER NOT NULL, event_created INTEGER NOT NULL,
 revoked INTEGER NOT NULL CHECK(revoked IN(0,1)), suppressed INTEGER NOT NULL CHECK(suppressed IN(0,1)),
 FOREIGN KEY(customer_id,account_id) REFERENCES stripe_web_customers(customer_id,account_id));
CREATE TABLE stripe_web_events (
 event_id TEXT PRIMARY KEY, digest TEXT NOT NULL, event_type TEXT NOT NULL, created INTEGER NOT NULL,
 subscription_id TEXT REFERENCES stripe_web_subscriptions(subscription_id), state TEXT NOT NULL CHECK(state IN('pending','processed')));
CREATE TABLE stripe_web_cancellations (
 subscription_id TEXT PRIMARY KEY REFERENCES stripe_web_subscriptions(subscription_id), account_id TEXT NOT NULL,
 customer_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state='pending_external'));
CREATE TRIGGER stripe_web_owner_immutable BEFORE UPDATE ON stripe_web_customers
 BEGIN SELECT RAISE(ABORT,'stripe_owner_immutable'); END;
CREATE TRIGGER stripe_web_subscription_identity BEFORE UPDATE OF subscription_id,customer_id,account_id ON stripe_web_subscriptions
 BEGIN SELECT RAISE(ABORT,'stripe_subscription_identity'); END;
CREATE TRIGGER stripe_web_sticky_denial BEFORE UPDATE ON stripe_web_subscriptions
 WHEN NEW.revoked<OLD.revoked OR NEW.suppressed<OLD.suppressed OR NEW.event_created<OLD.event_created
 BEGIN SELECT RAISE(ABORT,'stripe_sticky_denial'); END;
CREATE INDEX stripe_web_account ON stripe_web_subscriptions(account_id);
`;
