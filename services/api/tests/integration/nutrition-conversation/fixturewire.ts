import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import type { Sqlite } from '../../../src/storage.js';
import type { AccountContext, DisableRecord } from '../../../src/lifecycle/types.js';
import { assertActive, bindSuppressionAuthority } from '../../../src/lifecycle/guards.js';
import { createGroundingRetriever, type GroundingRetriever } from '../../../src/grounding/index.js';
import { createNutritionController, type NutritionController } from '../../../src/integration/nutrition-conversation/host.js';
import { nutritionWireSchema, type NutritionConversationInput, type NutritionWireRequest, type NutritionWireResponse,
  type NutritionWireOperation, type NutritionSubmitRequest, type NutritionSelectionRequest } from '../../../src/integration/nutrition-conversation/wire.js';
import { syntheticFixture, syntheticRecord } from '../../grounding/fixture.js';

export const envelope = (): NutritionWireRequest => ({ schema: nutritionWireSchema, requestId: randomUUID() });
export const input = (): NutritionConversationInput => ({ choice: 'ask', previousTurnId: null, job: 'protein',
  question: 'strength', userContext: ['Synthetic context.'], correction: null });
export function source(): GroundingRetriever {
  const fixture = syntheticFixture([syntheticRecord('SYN-S01', { topic_ids: ['NUT-I3'] })]);
  fixture.projection.coverage.units[0]!.unit_id = 'NUT-I3';
  fixture.projection.corpus_status.units_without_observations = fixture.projection.coverage.units.map(unit => unit.unit_id).filter(id => id !== 'NUT-I3');
  return createGroundingRetriever(fixture.projection, fixture.binding);
}
type Options = NonNullable<Parameters<typeof createNutritionController>[0]['limits']>;
export type WireFixture = {
  db: Sqlite; actor: AccountContext; other: AccountContext; second: AccountContext; third: AccountContext;
  controller: NutritionController; lifecycle: { assertActive: (actor: AccountContext) => void };
  hooks: { retrieve?: () => void }; calls: () => number; advance: (ms: number) => void;
  suppress: () => void; request: (operation: NutritionWireOperation, id?: string,
    raw?: NutritionWireRequest | NutritionSubmitRequest | NutritionSelectionRequest, actor?: AccountContext) => Promise<NutritionWireResponse>;
};
export function fixture(t: TestContext, limits: Options = {}): WireFixture {
  const db: Sqlite = new Database(':memory:');
  db.exec(`CREATE TABLE form_accounts(id TEXT PRIMARY KEY,auth_user_id TEXT NOT NULL);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE account_lifecycle(account_id TEXT PRIMARY KEY,state TEXT NOT NULL,epoch INTEGER NOT NULL);
    INSERT INTO form_accounts VALUES('a','user-a'),('b','user-b');
    INSERT INTO account_lifecycle VALUES('a','active',0),('b','active',0);`);
  for (const [id, user] of [['s1', 'user-a'], ['s2', 'user-a'], ['s3', 'user-a'], ['s4', 'user-b']])
    db.prepare('INSERT INTO session VALUES(?,?,?)').run(id, user, Date.now() + 3600000);
  const records = new Map<string, DisableRecord>();
  bindSuppressionAuthority(db, { currentSequence: () => records.size, lookup: id => records.get(id) ?? null,
    reconcileRestore: apply => { for (const record of records.values()) apply(record); return records.size; },
    recordDisable: value => { const record = { ...value, sequence: records.size + 1 }; records.set(value.accountId, record); return record; } });
  const actor: AccountContext = { accountId: 'a', authUserId: 'user-a', sessionId: 's1', epoch: 0 };
  const other: AccountContext = { accountId: 'b', authUserId: 'user-b', sessionId: 's4', epoch: 0 };
  const second = { ...actor, sessionId: 's2' }, third = { ...actor, sessionId: 's3' };
  let time = Date.now(), calls = 0;
  const hooks: { retrieve?: () => void } = {};
  const native = source();
  const lifecycle = { assertActive: (value: AccountContext) => { if (db.inTransaction) throw Error('async-host-inside-transaction'); assertActive(db, value); } };
  const controller = createNutritionController({ lifecycle, now: () => time, limits,
    retriever: { retrieve(value) { calls++; hooks.retrieve?.(); return native.retrieve(value); } } });
  t.after(() => { controller.close(); db.close(); });
  return { db, actor, other, second, third, controller, lifecycle, hooks, calls: () => calls, advance: ms => { time += ms; },
    suppress: () => records.set('a', { accountId: 'a', authUserId: 'user-a', epoch: 1, requestId: 'synthetic', disabledAtMs: 0, sequence: 1 }),
    request: async (operation, id, raw = envelope(), who = actor) => {
      const result = await controller.dispatch(who, operation, raw, new AbortController().signal, id);
      return JSON.parse(result.serialize().json) as NutritionWireResponse;
    },
  };
}
