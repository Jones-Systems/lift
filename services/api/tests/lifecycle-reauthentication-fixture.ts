import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Domain } from '../src/domain.js';
import type { Sqlite } from '../src/storage.js';
import { bindSuppressionAuthority, subjectEligibility } from '../src/lifecycle/guards.js';
import { lifecyclePolicy } from '../src/lifecycle/service.js';
import { suppressionLedgerSchema } from '../src/lifecycle/ledger.js';
import { bindSourceLifecycleLocalAbsenceReader } from '../src/lifecycle/local-absence.js';
import { bindSourceLifecycleEvidenceWitnessReader, type SourceLifecycleEvidenceGeneration, type SourceLifecycleEvidenceWitnessReader } from '../src/lifecycle/evidence-store.js';
import { evidenceCanonical, evidenceDigest } from '../src/lifecycle/evidence-codec.js';
import { CurrentSuppressionAuthority, genesisHead, ledgerSchemaDigest, witnessSchema } from '../src/runtime-modules/currentness.js';
import { AuthorityLock, JsonFile, canonicalPath } from '../src/runtime-modules/files.js';
import { createCanonicalAccountWriter } from '../src/integration/account-modules/canonical-writer.js';
import { createSourceAccountModules, createSourceTrainingLifecycleAdapters } from '../src/integration/account-modules/index.js';
import { createSourceRequestFactories } from '../src/lifecycle/request-factories.js';
import { createManualMeasurements } from '../src/body/measurements.js';
import type { AccountContext, LifecycleAdapter, SourceActionDelivery, SourceActionDeliveryRequest, SourceActionDeliveryResult } from '../src/lifecycle/types.js';
import { install } from './integration/account-modules/fixture.js';
import { selectSourceActionReauthenticationMigrations } from '../src/lifecycle/reauthentication-source-migrations.js';
import { bindSourceActionContinuityWitness, createSourceActionReauthentication } from '../src/lifecycle/reauthentication-source.js';
import type { BoundedAppleTransport, MaterialCustodian, QualifiedToken } from '../src/lifecycle/providers/types.js';
import type { SourceActionContinuityWitness } from '../src/lifecycle/reauthentication-proof.js';
import { phoneEmail } from '../src/phone/challenges.js';

export const configuration = { mode: 'source-only', cohort: 'action-reauthentication-v1' } as const;
export const selected = selectSourceActionReauthenticationMigrations();
export const requestId = '33333333-3333-4333-8333-333333333333';
export const A: AccountContext = { accountId: '11111111-1111-4111-8111-111111111111', authUserId: 'action-auth-a', sessionId: 'action-session-a', epoch: 0 };
export const B: AccountContext = { accountId: '22222222-2222-4222-8222-222222222222', authUserId: 'action-auth-b', sessionId: 'action-session-b', epoch: 0 };
export const statusSecret = 's'.repeat(43);
export type DeliveryMode = 'accepted' | 'rejected' | 'unknown' | 'pending' | 'throw' | 'malformed' | 'settlement_rejected' | 'cancel_pending' | 'cancel_rejected' | 'late';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: () => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = () => no(new Error('synthetic delivery outcome unavailable')); });
  return { promise, resolve, reject };
}
type ActionSource = ReturnType<typeof createSourceActionReauthentication>;
type Composition = { source: ActionSource; witness: SourceLifecycleEvidenceWitnessReader; continuity: SourceActionContinuityWitness; adapters: readonly LifecycleAdapter[] };
export type Source26Fixture = {
  root: string; main: string; independent: string; path: string; recordPath: string; journalPath: string;
  db: Sqlite; source: ActionSource; authority: CurrentSuppressionAuthority;
  witnessFile: JsonFile<ReturnType<typeof witnessSchema.parse>>;
  compose: (store?: Sqlite) => Composition; adapters: (store: Sqlite) => readonly LifecycleAdapter[];
  keys: { currentKeyId: () => string; lookup: (id: string) => Uint8Array | null };
  keyState: { current: string; missing: boolean; length: number }; custodian: MaterialCustodian; transport: BoundedAppleTransport;
  now: () => number; advance: (ms: number) => void; mode: (value: DeliveryMode) => void;
  code: () => string; sends: () => number; providerCaptures: () => number; providerPosts: () => number;
  settle: () => void; barrier: () => void; loseCustody: () => void; closeMain: () => void; openOther: () => Sqlite;
  reopen: () => ActionSource; publish: () => void; unavailable: () => void; adopt: (handle: Sqlite) => void;
  snapshot: () => Promise<string>; restore: (snapshot: string, failAfterCopy?: boolean) => void; interruptedUnprovedCopy: (snapshot: string) => void;
  phone: (actor?: AccountContext) => void; initiate: () => ReturnType<ActionSource['lifecycle']['initiate']>;
  budget: (actor?: AccountContext) => Record<string, number>; challenge: () => Record<string, unknown>; bBytes: () => string; cleanup: () => void;
};
export function source26Fixture(t: TestContext, prefix = 26, fault: (point: string) => void = () => {}, setup: (db: Sqlite) => void = () => {}): Source26Fixture {
  const root = mkdtempSync(join(homedir(), '.form-action-source26-')); chmodSync(root, 0o700);
  const main = join(root, 'main'), independent = join(root, 'independent');
  mkdirSync(main, { mode: 0o700 }); mkdirSync(independent, { mode: 0o700 });
  const path = join(main, 'main.sqlite'), recordPath = join(independent, 'continuity.json'), journalPath = join(independent, 'producer-custody.json');
  const handles: Sqlite[] = [], closers: (() => void)[] = [];
  let now = Date.now(), db: Sqlite, generation = 'generation-one', witnessRevision = 1, revision = 1, boundary: number | null = null, closed = false;
  const producers: { request: SourceActionDeliveryRequest; settlement: ReturnType<typeof deferred<SourceActionDeliveryResult>>;
    cancellation: ReturnType<typeof deferred<void>>; completed: boolean; cancellationRequested: boolean; cancelCompleted: boolean;
    unclassified: boolean; mode: DeliveryMode }[] = [];
  let custodyLost = false, continuityHeld = false;
  const journal = () => writeFileSync(journalPath, evidenceCanonical({ started: producers.length, custodyLost,
    producers: producers.map(p => ({ id: p.request.challengeId, completed: p.completed, cancellationRequested: p.cancellationRequested,
      cancelCompleted: p.cancelCompleted, unclassified: p.unclassified })) }), { mode: 0o600 });
  journal();
  const publish = () => writeFileSync(recordPath, evidenceCanonical({ schema: 'source-action-continuity/v1', mainStoreId: 'synthetic-action-main',
    databaseGeneration: generation, witnessRevision, revision, observedAtMs: now, restoreBoundaryMs: boundary }), { mode: 0o600 });
  publish();
  for (const id of ['active-key', 'retained-key']) writeFileSync(join(independent, id), randomBytes(32), { mode: 0o600 });
  const keyState = { current: 'active-key', missing: false, length: 32 };
  const keys = { currentKeyId: () => keyState.current, lookup: (id: string) => keyState.missing || !['active-key', 'retained-key'].includes(id)
    ? null : new Uint8Array(readFileSync(join(independent, id)).subarray(0, keyState.length)) };
  const open = (): Sqlite => {
    assert.ok(handles.filter(h => h.open).length < 2, 'fixture permits at most two main handles');
    const handle: Sqlite = new Database(path); chmodSync(path, 0o600); handle.pragma('foreign_keys=ON'); handles.push(handle); return handle;
  };
  db = open(); install(db, selected.slice(0, prefix));
  const ledgerPath = join(independent, 'ledger.sqlite'), authorityId = randomUUID(), uid = process.getuid!();
  const ledger = new Database(ledgerPath); chmodSync(ledgerPath, 0o600);
  try { ledger.exec(suppressionLedgerSchema); ledger.prepare('INSERT INTO suppression_authority VALUES(?,0)').run(authorityId); } finally { ledger.close(); }
  const lock = new AuthorityLock(independent, uid, randomUUID()); closers.push(() => lock.release());
  const witnessFile = JsonFile.create(join(independent, 'currentness.json'), uid, witnessSchema, { version: 1, authorityId, ledgerSchemaDigest,
    revision: 0, directory: lock.directoryIdentity, ledger: canonicalPath(ledgerPath, uid), committedSequence: 0,
    committedHeadDigest: genesisHead(authorityId), pending: null });
  const authority = new CurrentSuppressionAuthority(lock, witnessFile, ledgerPath, authorityId, fault); closers.push(() => authority.close());
  for (const actor of [A, B]) {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)')
      .run(actor.authUserId, 'Synthetic action account', `${actor.authUserId}@synthetic.invalid`, now, now);
    db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(actor.accountId, actor.authUserId, 'synthetic');
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)')
      .run(actor.sessionId, now + 86400000, `synthetic-${actor.sessionId}`, now, now, actor.authUserId);
    db.prepare('INSERT INTO documents VALUES(?,?,1,?)').run(actor.accountId, 'profile', '{"age":30}');
  }
  const material: QualifiedToken = { rowId: 'action-apple-a', authUserId: A.authUserId, provider: 'apple', immutableSubject: 'synthetic-apple-action-a',
    clientBindingId: 'synthetic-action-issuer', clientId: 'synthetic.form.action', tokenKind: 'refresh_token', token: 'synthetic-action-refresh',
    provenance: 'issuer-client-subject-token-v1' };
  db.prepare("INSERT INTO account(id,accountId,providerId,userId,refreshToken,createdAt,updatedAt) VALUES(?,?,'apple',?,?,1,1)")
    .run(material.rowId, material.immutableSubject, A.authUserId, material.token);
  let mode: DeliveryMode = 'accepted', providerCaptures = 0, providerPosts = 0;
  const result = (p: typeof producers[number]): SourceActionDeliveryResult => ({ challengeId: p.request.challengeId, method: p.request.method,
    subjectDigest: p.request.subjectDigest, disposition: p.mode === 'rejected' ? 'rejected' : p.mode === 'unknown' ? 'unknown' : 'accepted' });
  const settle = (p = producers.at(-1)!) => { p.completed = true; p.settlement.resolve(result(p)); journal(); };
  const delivery: SourceActionDelivery = { start: request => {
    assert.equal(handles.some(h => h.open && h.inTransaction), false);
    assert.ok(producers.every(p => p.completed && (!p.cancellationRequested || p.cancelCompleted)), 'one pending dedicated operation');
    const p = { request, settlement: deferred<SourceActionDeliveryResult>(), cancellation: deferred<void>(), completed: false,
      cancellationRequested: false, cancelCompleted: false, unclassified: false, mode };
    producers.push(p); journal();
    if (mode === 'throw') { p.unclassified = true; journal(); throw new Error('synthetic start effect unknown'); }
    if (mode === 'malformed') { p.unclassified = true; journal(); return {} as ReturnType<SourceActionDelivery['start']>; }
    if (['late', 'cancel_pending', 'cancel_rejected', 'settlement_rejected'].includes(mode)) { now += 10001; revision++; publish(); }
    if (mode === 'settlement_rejected') { p.unclassified = true; p.settlement.reject(); journal(); }
    else if (['accepted', 'rejected', 'unknown', 'late'].includes(mode)) settle(p);
    return { settled: p.settlement.promise, cancel: () => {
      assert.equal(handles.some(h => h.open && h.inTransaction), false);
      p.cancellationRequested = true;
      if (mode === 'cancel_rejected') p.cancellation.reject();
      else if (mode !== 'cancel_pending') { p.cancelCompleted = true; p.cancellation.resolve(); }
      journal(); return p.cancellation.promise;
    } };
  } };
  const custodian: MaterialCustodian = { contract: 'bounded-provider-material-v1', capture: row => {
    providerCaptures++; assert.equal(handles.some(h => h.open && h.inTransaction), true);
    assert.equal(authority.lookup(A.accountId), null, 'provider capture precedes independent suppression');
    return row.rowId === material.rowId ? { status: 'qualified', material } : { status: 'unavailable', reason: 'token_provenance_unavailable' };
  }, resolve: () => ({ settled: Promise.resolve({ status: 'qualified', value: { material, clientSecret: 'synthetic-action-client-secret' } }), cancel: async () => {} }) };
  const transport: BoundedAppleTransport = { contract: 'bounded-apple-revoke-v1', post: () => {
    providerPosts++; return { settled: Promise.resolve({ status: 200, body: new Uint8Array(), truncated: false }), cancel: async () => {} };
  } };
  const adapterCache = new WeakMap<Sqlite, readonly LifecycleAdapter[]>();
  const adapters = (store: Sqlite): readonly LifecycleAdapter[] => {
    const cached = adapterCache.get(store); if (cached) return cached;
    bindSuppressionAuthority(store, authority);
    const writer = createCanonicalAccountWriter(store);
    const factories = createSourceRequestFactories({ db: store, lifecycle: writer.lifecycle, purgeReadiness: writer.purgeReadiness,
      configuration: { mode: 'source-only', communityModules: 'b2-b4-b5' }, subjectEligibilityFor: actor => accountId => subjectEligibility(store, actor, accountId) });
    const result = [...factories.adapters, ...createSourceAccountModules(store, writer.lifecycle).adapters,
      ...createSourceTrainingLifecycleAdapters(store, new Domain(store), writer), createManualMeasurements(store, writer.lifecycle).lifecycleAdapter];
    adapterCache.set(store, result); return result;
  };
  const compose = (store = db): { source: ReturnType<typeof createSourceActionReauthentication>; witness: SourceLifecycleEvidenceWitnessReader; continuity: SourceActionContinuityWitness; adapters: readonly LifecycleAdapter[] } => {
    const values = adapters(store);
    const witness = bindSourceLifecycleEvidenceWitnessReader(store, authority, () => {
      const r = JSON.parse(readFileSync(recordPath, 'utf8')) as SourceLifecycleEvidenceGeneration;
      return { databaseGeneration: r.databaseGeneration, mainStoreId: r.mainStoreId, witnessRevision: r.witnessRevision };
    });
    const continuity = bindSourceActionContinuityWitness(store, witness, { recordPath });
    const localAbsence = ([['activity', 'activity-owned-v1'], ['progressComparison', 'progress-comparison-owned-v1'], ['trainingFeedback', 'training-feedback-owned-v1']] as const)
      .map(([category, owner]) => bindSourceLifecycleLocalAbsenceReader(store, values.find(a => a.category === category)!, owner));
    return { source: createSourceActionReauthentication({ configuration, db: store, authority, witness, continuity, adapters: values,
      localAbsence, keys, delivery, custodian, transport, clock: () => now }), witness, continuity, adapters: values };
  };
  setup(db);
  const source = prefix === 26 ? compose().source : undefined;
  const barrier = () => {
    const j = JSON.parse(readFileSync(journalPath, 'utf8')) as { started: number; custodyLost: boolean; producers: unknown[] };
    if (custodyLost || j.custodyLost || j.started !== producers.length || j.producers.length !== producers.length ||
      producers.some(p => !p.completed || p.unclassified || (p.cancellationRequested && !p.cancelCompleted))) throw new Error('synthetic restore producer barrier held');
  };
  const unavailable = () => { continuityHeld = true; writeFileSync(recordPath, '{"held":true}', { mode: 0o600 }); };
  const closeMain = () => { for (const handle of handles) if (handle.open) handle.close(); };
  const copyMain = (snapshot: string) => {
    closeMain(); copyFileSync(snapshot, path); db = open();
    const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.ok(digest(path) === digest(snapshot), 'exact main-copy readback');
  };
  const restore = (snapshot: string, failAfterCopy = false) => {
    unavailable(); barrier(); copyMain(snapshot);
    if (failAfterCopy) throw new Error('synthetic restore interrupted after copy');
    generation = `generation-${++witnessRevision}`; revision++; boundary = now; continuityHeld = false; publish();
  };
  const footprint = (directory: string): number => readdirSync(directory).reduce((n, name) => {
    const p = join(directory, name), stat = lstatSync(p); return n + (stat.isDirectory() ? footprint(p) : stat.size);
  }, 0);
  const cleanup = () => {
    if (closed) return; closed = true;
    for (const p of producers) { p.completed = true; p.settlement.resolve(result(p)); p.cancelCompleted = true; p.cancellation.resolve(); }
    closeMain(); for (const close of closers.reverse()) close();
    const bytes = footprint(root); assert.ok(bytes < 64 * 1024 * 1024, 'fixture below 64 MiB');
    assert.equal(readFileSync(join(independent, 'active-key')).length, 32); assert.equal(readFileSync(join(independent, 'retained-key')).length, 32);
    t.diagnostic(`synthetic26 measured readback: ${bytes} bytes before exact cleanup; main handles closed; independent authority count=1; two keys exactly32 bytes; root-only producer custody retained`);
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  };
  t.after(cleanup);
  const interrupt = () => { cleanup(); process.exitCode = 130; }, terminate = () => { cleanup(); process.exitCode = 143; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  t.after(() => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); });
  t.diagnostic('synthetic26 custody: separate main/snapshot and independent authority/continuity/two32-byte keys; <=2 main handles/1 authority/1 pending operation/<64MiB; exact cleanup owned');
  const fixture = { root, main, independent, path, recordPath, journalPath, authority, witnessFile, source: source!, compose, adapters, keys, keyState, custodian, transport,
    cleanup, get db(): Sqlite { return db; }, now: () => now, advance: (ms: number) => { now += ms; revision++; if (!continuityHeld) publish(); }, mode: (value: DeliveryMode) => { mode = value; },
    code: () => producers.at(-1)!.request.code, sends: () => producers.length, providerCaptures: () => providerCaptures, providerPosts: () => providerPosts,
    settle, producers, barrier, loseCustody: () => { custodyLost = true; journal(); }, closeMain, openOther: open,
    reopen: () => { closeMain(); db = open(); return compose().source; }, publish, unavailable,
    adopt: (handle: Sqlite) => { assert.ok(handles.filter(h => h.open).length < 2); handles.push(handle); db = handle; },
    snapshot: async () => { const snapshot = join(main, `snapshot-${randomUUID()}.sqlite`); await db.backup(snapshot); chmodSync(snapshot, 0o600); return snapshot; },
    restore, interruptedUnprovedCopy: (snapshot: string) => { unavailable(); copyMain(snapshot); },
    phone: (actor = A) => {
      const phone = actor === A ? '+15555550126' : '+15555550127';
      db.prepare('UPDATE "user" SET phoneNumber=?,phoneNumberVerified=1,email=? WHERE id=?').run(phone, phoneEmail(phone), actor.authUserId);
      db.prepare(`INSERT INTO phone_challenges VALUES(?,?,?,?,'consumed',?,?,?,?,1,0,?,?)`).run(`provenance-${actor.authUserId}`, phone,
        'synthetic-binding', `synthetic-start-${actor.authUserId}`, 'synthetic-provider-sid', now - 1, now + 300000, now - 1, now - 1, actor.authUserId);
    },
    initiate: () => source!.lifecycle.initiate(A, 'action-delete', { requestId, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account', statusSecret }),
    budget: (actor = A) => db.prepare('SELECT * FROM account_action_challenge_budgets WHERE account_id=?').get(actor.accountId) as Record<string, number>,
    challenge: () => db.prepare('SELECT * FROM account_action_challenges ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown>,
    bBytes: () => {
      const rows: unknown[] = [];
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string }[]) {
        assert.ok(/^[A-Za-z0-9_]+$/.test(name));
        const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(c => c.name);
        const user = columns.filter(c => ['auth_user_id', 'userId'].includes(c));
        const account = columns.filter(c => /^(?:account_id|owner_account_id|author_account_id|actor_account_id|issuer_account_id|redeemed_account_id|subject_account_id)$/.test(c));
        if (name === 'user') user.push('id'); if (name === 'form_accounts') account.push('id');
        const keys = [...user, ...account];
        if (keys.length) {
          const values = db.prepare(`SELECT * FROM "${name}" WHERE ${keys.map(c => `"${c}"=?`).join(' OR ')}`).all(...user.map(() => B.authUserId), ...account.map(() => B.accountId));
          if (values.length) rows.push([name, values]);
        }
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_action_proof_consumptions'").get()) {
        const proofs = db.prepare('SELECT p.* FROM account_action_proof_consumptions p JOIN account_action_challenges c ON c.id=p.challenge_id WHERE c.account_id=?').all(B.accountId);
        if (proofs.length) rows.push(['proofs', proofs]);
      }
      return createHash('sha256').update(evidenceCanonical(rows)).digest('hex');
    },
  };
  return fixture;
}
