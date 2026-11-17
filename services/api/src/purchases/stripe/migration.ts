// Named, explicitly applied schema. It joins no numbered migration list; the registering composition owns
// application and backup, and defaults never apply it. Every table is keyed by namespace and partitioned by account_id.
export const stripeWebSchemaVersion = 'stripe-web-subscriptions-v1';
const sql = `
CREATE TABLE stripe_web_customers (
 namespace TEXT NOT NULL, customer_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES form_accounts(id),
 checkout_session_id TEXT NOT NULL,
 PRIMARY KEY(namespace,customer_id), UNIQUE(namespace,customer_id,account_id));
CREATE TABLE stripe_web_subscriptions (
 namespace TEXT NOT NULL, subscription_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES form_accounts(id), customer_id TEXT NOT NULL,
 price_id TEXT NOT NULL, product_id TEXT, status TEXT NOT NULL, cancel_at_period_end INTEGER NOT NULL CHECK(cancel_at_period_end IN(0,1)),
 period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, created_at INTEGER NOT NULL, event_high_water INTEGER,
 revision INTEGER NOT NULL CHECK(revision>=1),
 revoked INTEGER NOT NULL CHECK(revoked IN(0,1)), suspended INTEGER NOT NULL CHECK(suspended IN(0,1)),
 suppressed INTEGER NOT NULL CHECK(suppressed IN(0,1)),
 PRIMARY KEY(namespace,subscription_id), UNIQUE(namespace,subscription_id,account_id),
 FOREIGN KEY(namespace,customer_id,account_id) REFERENCES stripe_web_customers(namespace,customer_id,account_id));
CREATE TABLE stripe_web_events (
 namespace TEXT NOT NULL, event_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES form_accounts(id), subscription_id TEXT,
 event_type TEXT NOT NULL, created INTEGER NOT NULL, digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('processed','rejected','held')), code TEXT NOT NULL,
 PRIMARY KEY(namespace,event_id));
CREATE TABLE stripe_web_disputes (
 namespace TEXT NOT NULL, dispute_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES form_accounts(id),
 subscription_id TEXT NOT NULL, charge_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('open','won','lost')),
 PRIMARY KEY(namespace,dispute_id),
 FOREIGN KEY(namespace,subscription_id,account_id) REFERENCES stripe_web_subscriptions(namespace,subscription_id,account_id));
CREATE TABLE stripe_web_cancellations (
 namespace TEXT NOT NULL, subscription_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES form_accounts(id), customer_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN('revoked','suppressed')),
 state TEXT NOT NULL CHECK(state IN('pending_external','unknown','canceled')), request TEXT NOT NULL CHECK(json_valid(request)),
 PRIMARY KEY(namespace,subscription_id),
 FOREIGN KEY(namespace,subscription_id,account_id) REFERENCES stripe_web_subscriptions(namespace,subscription_id,account_id));
CREATE TABLE stripe_web_conflicts (
 namespace TEXT NOT NULL, conflict_key TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES form_accounts(id),
 kind TEXT NOT NULL CHECK(kind IN('binding','linkage','event_variant','dispute_variant','dual_channel_conflict')),
 subscription_id TEXT, customer_id TEXT, event_id TEXT, detected_at_ms INTEGER NOT NULL, state TEXT NOT NULL CHECK(state='held'),
 PRIMARY KEY(namespace,conflict_key));
CREATE TRIGGER stripe_web_owner_immutable BEFORE UPDATE ON stripe_web_customers
 BEGIN SELECT RAISE(ABORT,'stripe_owner_immutable'); END;
CREATE TRIGGER stripe_web_subscription_identity BEFORE UPDATE OF namespace,subscription_id,customer_id,account_id,created_at ON stripe_web_subscriptions
 BEGIN SELECT RAISE(ABORT,'stripe_subscription_identity'); END;
CREATE TRIGGER stripe_web_sticky_denial BEFORE UPDATE ON stripe_web_subscriptions
 WHEN NEW.revoked<OLD.revoked OR NEW.suppressed<OLD.suppressed OR NEW.revision<=OLD.revision
  OR coalesce(NEW.event_high_water,-1)<coalesce(OLD.event_high_water,-1)
 BEGIN SELECT RAISE(ABORT,'stripe_sticky_denial'); END;
CREATE TRIGGER stripe_web_event_receipt BEFORE UPDATE ON stripe_web_events
 WHEN NEW.namespace<>OLD.namespace OR NEW.event_id<>OLD.event_id OR NEW.account_id<>OLD.account_id OR NEW.digest<>OLD.digest
  OR OLD.state='held' OR NEW.state<>'held'
 BEGIN SELECT RAISE(ABORT,'stripe_event_receipt_immutable'); END;
CREATE TRIGGER stripe_web_dispute_terminal BEFORE UPDATE ON stripe_web_disputes
 WHEN NEW.namespace<>OLD.namespace OR NEW.dispute_id<>OLD.dispute_id OR NEW.account_id<>OLD.account_id
  OR NEW.subscription_id<>OLD.subscription_id OR NEW.charge_id<>OLD.charge_id OR OLD.status<>'open'
 BEGIN SELECT RAISE(ABORT,'stripe_dispute_terminal'); END;
CREATE TRIGGER stripe_web_cancellation_progress BEFORE UPDATE ON stripe_web_cancellations
 WHEN NEW.namespace<>OLD.namespace OR NEW.subscription_id<>OLD.subscription_id OR NEW.account_id<>OLD.account_id
  OR NEW.customer_id<>OLD.customer_id OR NEW.reason<>OLD.reason OR NEW.request<>OLD.request
  OR OLD.state='canceled' OR NEW.state='pending_external'
 BEGIN SELECT RAISE(ABORT,'stripe_cancellation_progress'); END;
CREATE TRIGGER stripe_web_conflict_held_update BEFORE UPDATE ON stripe_web_conflicts
 BEGIN SELECT RAISE(ABORT,'stripe_conflict_held'); END;
CREATE TRIGGER stripe_web_conflict_held_delete BEFORE DELETE ON stripe_web_conflicts
 BEGIN SELECT RAISE(ABORT,'stripe_conflict_held'); END;
CREATE INDEX stripe_web_subscription_account ON stripe_web_subscriptions(namespace,account_id);
CREATE INDEX stripe_web_event_account ON stripe_web_events(namespace,account_id);
CREATE INDEX stripe_web_dispute_subscription ON stripe_web_disputes(namespace,subscription_id);
CREATE INDEX stripe_web_cancellation_account ON stripe_web_cancellations(namespace,account_id);
CREATE INDEX stripe_web_conflict_account ON stripe_web_conflicts(namespace,account_id);
`;
export const stripeWebTables = Object.freeze(['stripe_web_customers', 'stripe_web_subscriptions', 'stripe_web_events',
  'stripe_web_disputes', 'stripe_web_cancellations', 'stripe_web_conflicts'] as const);
export const stripeWebMigration = Object.freeze({ name: stripeWebSchemaVersion, sql });
