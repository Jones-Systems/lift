import type { Sqlite } from '../storage.js';
import { assertNotificationInboxSchema, validateInboxPolicy } from './notification-inbox-schema.js';
import type { InboxCapability, InboxNamespace, InboxOperation, InboxPolicy } from './notification-inbox.types.js';

export type InboxScope = Readonly<{ ingress: string; namespaces: readonly InboxNamespace[]; receiptId: string | null }>;
type Store = { store_id: string; generation: string; policy_json: string; ingress: string; fixture_kind: string; history_floor: number };
type Binding = { db: Sqlite; store: Store; operation: InboxOperation; scope: InboxScope; active: () => boolean };
const capabilities = new WeakMap<object, Binding>();
export function namespaceKey(namespace: InboxNamespace): string {
  if (!namespace || JSON.stringify(Object.keys(namespace).sort()) !== JSON.stringify(['appAppleId','bundleId','environment','provider']) || namespace.provider !== 'Apple' || !/^[a-zA-Z0-9.-]{1,255}$/.test(namespace.bundleId) ||
      !['Sandbox','Production'].includes(namespace.environment) ||
      (namespace.environment === 'Production' ? !Number.isSafeInteger(namespace.appAppleId) || namespace.appAppleId! <= 0 : namespace.appAppleId !== null)) {
    throw new Error('inbox_namespace_rejected');
  }
  // Verification configuration is bound separately; it cannot fork the durable identity tuple.
  return JSON.stringify({ provider: 'Apple', bundleId: namespace.bundleId, environment: namespace.environment });
}
export function inboxStore(db: Sqlite): Store {
  const row = db.prepare('SELECT * FROM notification_inbox_store WHERE singleton=1').get() as Store | undefined;
  if (!row || row.fixture_kind !== 'isolated-synthetic') throw new Error('inbox_store_unavailable');
  return row;
}
export function checkInboxCapability(db: Sqlite, capability: InboxCapability, operation: InboxOperation,
  ingress: string, namespace: InboxNamespace | null = null, receiptId: string | null = null): InboxPolicy {
  const binding = capability && capabilities.get(capability);
  const store = inboxStore(db);
  if (!binding || binding.db !== db || !binding.active() || binding.operation !== operation ||
      binding.store.store_id !== store.store_id || binding.store.generation !== store.generation ||
      binding.store.policy_json !== store.policy_json || binding.store.ingress !== store.ingress || store.ingress !== ingress || binding.scope.ingress !== ingress ||
      (binding.scope.receiptId !== null && binding.scope.receiptId !== receiptId) ||
      (namespace !== null && !binding.scope.namespaces.some(item => namespaceKey(item) === namespaceKey(namespace) && item.appAppleId === namespace.appAppleId))) {
    throw new Error('inbox_capability_unavailable');
  }
  return JSON.parse(store.policy_json) as InboxPolicy;
}

// Fixture issuer only. A real composition must supply separately qualified authority and retention values.
export function createSyntheticInboxAuthority(db: Sqlite, input: Readonly<{ use: 'isolated-synthetic'; ingress: string }>) {
  assertNotificationInboxSchema(db);
  if (input.use !== 'isolated-synthetic' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.ingress)) throw new Error('inbox_authority_required');
  const store = inboxStore(db);
  if (store.ingress !== input.ingress) throw new Error('inbox_ingress_scope_unavailable');
  validateInboxPolicy(JSON.parse(store.policy_json) as InboxPolicy);
  let active = true;
  const revoked = new WeakSet<object>();
  return Object.freeze({
    issue(operation: InboxOperation, scope: InboxScope): InboxCapability {
      if (!active || scope.ingress !== input.ingress || !['capture','verify','promote','claim','complete','metadata','proof','replay','dispose'].includes(operation)) {
        throw new Error('inbox_authority_unavailable');
      }
      scope.namespaces.forEach(namespaceKey);
      const capability = Object.freeze({}) as InboxCapability;
      const copied = JSON.parse(JSON.stringify(scope)) as InboxScope;
      capabilities.set(capability, { db, store, operation, scope: copied, active: () => active && !revoked.has(capability) });
      return capability;
    },
    revoke(capability: InboxCapability) { revoked.add(capability); },
    close() { active = false; },
  });
}
