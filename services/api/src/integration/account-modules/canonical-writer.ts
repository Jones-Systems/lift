import type { Sqlite } from '../../storage.js';
import { DomainError } from '../../errors.js';
import { assertActive, withActiveWrite, adultEligibility, suppressionAuthority } from '../../lifecycle/guards.js';
import type { AccountContext, ExportSnapshot, LifecycleAdapter, LifecycleBindings } from '../../lifecycle/types.js';
import type { SqliteAuthStoreOptions } from '../../wearables/direct-provider-transport/sqlite-auth-store.js';

export type CanonicalPurgeUnavailable = Readonly<{
  status: 'unavailable'; reason: 'exact_purge_executor_binding_required';
}>;
export type CanonicalAccountWriter = Readonly<{
  lifecycle: LifecycleBindings;
  assertWithinWrite: (context: AccountContext) => void;
  authStoreOptionsFor: (originalAccountContext: AccountContext) => SqliteAuthStoreOptions;
  lifecycleStoreOptions: SqliteAuthStoreOptions;
  assertAccountCurrent: (context: AccountContext) => void;
  assertSuppression: (accountId: string, epoch: number) => void;
  purgeReadiness: (requestId: string, accountId: string) => CanonicalPurgeUnavailable;
  guardLifecycleAdapter: (adapter: LifecycleAdapter) => LifecycleAdapter;
}>;
type Frame = { live: boolean; db: Sqlite } & (
  { kind: 'active'; actor: AccountContext } |
  { kind: 'suppression'; accountId: string; epoch: number; sequence: number }
);
const sameActor = (a: AccountContext, b: AccountContext): boolean => a.accountId === b.accountId &&
  a.authUserId === b.authUserId && a.sessionId === b.sessionId && a.epoch === b.epoch;
const denied = (): never => { throw new DomainError(503, 'canonical_writer_unproved'); };
function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function') throw new DomainError(503, 'canonical_writer_requires_synchronous_effect');
  return value;
}

export function createCanonicalAccountWriter(db: Sqlite): CanonicalAccountWriter {
  let frame: Frame | undefined;
  const transaction = () => { if (!db.open || !db.inTransaction) denied(); };
  const suppressionProof = (accountId: string, epoch: number): number => {
    transaction();
    if (!Number.isSafeInteger(epoch) || epoch < 1) denied();
    const record = suppressionAuthority(db).lookup(accountId);
    const row = db.prepare('SELECT state,epoch,suppression_seq FROM account_lifecycle WHERE account_id=?')
      .get(accountId) as { state: string; epoch: number; suppression_seq: number } | undefined;
    if (!record || record.accountId !== accountId || record.epoch !== epoch || !Number.isSafeInteger(record.sequence) ||
      record.sequence < 1 || row?.state !== 'disabled' || row.epoch !== epoch || row.suppression_seq !== record.sequence) return denied();
    return record.sequence;
  };
  const currentFrame = (): Frame => {
    transaction();
    const admitted = frame;
    if (!admitted?.live || admitted.db !== db) return denied();
    if (admitted.kind === 'active') assertActive(db, admitted.actor);
    else if (suppressionProof(admitted.accountId, admitted.epoch) !== admitted.sequence) denied();
    if (frame !== admitted || !admitted.live) denied();
    return admitted;
  };
  const assertWithinWrite = (context: AccountContext): void => {
    const admitted = currentFrame();
    if (admitted.kind !== 'active' || !sameActor(admitted.actor, context)) denied();
  };
  const assertSuppression = (accountId: string, epoch: number): void => {
    const admitted = currentFrame();
    if (admitted.kind !== 'suppression' || admitted.accountId !== accountId || admitted.epoch !== epoch) denied();
  };
  function admit<T>(next: Frame, effect: () => T): T {
    transaction();
    const previous = frame;
    if (previous) {
      currentFrame();
      if (previous.kind !== next.kind || (previous.kind === 'active' && next.kind === 'active' && !sameActor(previous.actor, next.actor)) ||
        (previous.kind === 'suppression' && next.kind === 'suppression' &&
          (previous.accountId !== next.accountId || previous.epoch !== next.epoch || previous.sequence !== next.sequence))) denied();
    }
    frame = next;
    try { currentFrame(); const result = synchronous(effect()); currentFrame(); return result; }
    finally { next.live = false; frame = previous; }
  }
  const lifecycle: LifecycleBindings = Object.freeze({
    assertActive: (context: AccountContext) => assertActive(db, context),
    adultEligibility: (context: AccountContext) => adultEligibility(db, context),
    withActiveWrite: <T>(context: AccountContext, effect: () => T): T => {
      const actor = Object.freeze({ ...context });
      return withActiveWrite(db, actor, () => admit({ live: true, db, kind: 'active', actor }, effect));
    },
  });
  const lifecycleStoreOptions: SqliteAuthStoreOptions = Object.freeze({ db,
    runRootWrite: <T>(effect: () => T): T => {
      currentFrame();
      const result = synchronous(effect()); currentFrame(); return result;
    },
    assertRootWriter: (candidate: Sqlite): void => { if (candidate !== db) denied(); currentFrame(); },
  });
  const purgeReadiness = (_requestId: string, _accountId: string): CanonicalPurgeUnavailable =>
    ({ status: 'unavailable', reason: 'exact_purge_executor_binding_required' });
  const guardLifecycleAdapter = (adapter: LifecycleAdapter): LifecycleAdapter => {
    const active = <T>(context: AccountContext, effect: (actor: AccountContext) => T): T => {
      const actor = Object.freeze({ ...context });
      const read = () => admit({ live: true, db, kind: 'active', actor }, () => effect(actor));
      return db.inTransaction ? read() : withActiveWrite(db, actor, read);
    };
    const suppressed = <T>(accountId: string, epoch: number, effect: () => T): T => {
      transaction();
      return admit({ live: true, db, kind: 'suppression', accountId, epoch,
        sequence: suppressionProof(accountId, epoch) }, effect);
    };
    return Object.freeze({ category: adapter.category,
      inventory: (context: AccountContext) => active(context, actor => adapter.inventory(actor)),
      export: (context: AccountContext, snapshot: ExportSnapshot) => active(context, actor => adapter.export(actor, snapshot)),
      suppress: (accountId: string, epoch: number) => suppressed(accountId, epoch, () => adapter.suppress(accountId, epoch)),
      verifySuppressed: (accountId: string, epoch: number) => suppressed(accountId, epoch, () => adapter.verifySuppressed(accountId, epoch)),
      purge: purgeReadiness,
    });
  };
  return Object.freeze({ lifecycle, assertWithinWrite, lifecycleStoreOptions, assertAccountCurrent: assertWithinWrite,
    assertSuppression, purgeReadiness, guardLifecycleAdapter,
    authStoreOptionsFor: (context: AccountContext): SqliteAuthStoreOptions => {
      const actor = Object.freeze({ ...context });
      return Object.freeze({ db,
        runRootWrite: <T>(effect: () => T): T => lifecycle.withActiveWrite(actor, effect),
        assertRootWriter: (candidate: Sqlite): void => { if (candidate !== db) denied(); assertWithinWrite(actor); },
      });
    },
  });
}
