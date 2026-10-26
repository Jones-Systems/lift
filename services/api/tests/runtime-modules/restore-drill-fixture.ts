import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { join } from 'node:path';
import { createServer, type FormServer } from '../../src/server.js';
import { RuntimeOwner } from '../../src/runtime-modules/admission.js';
import { CommunityLimiter } from '../../src/runtime-modules/limiter.js';
import { moduleMigrations } from '../../src/runtime-modules/migrations.js';
import type { FaultPoint } from '../../src/runtime-modules/files.js';
import { createManualMeasurements } from '../../src/body/measurements.js';
import { suppressionLedger } from '../integration/account-modules/fixture.js';
import { deployment, origin, secret, type Deployment } from './fixture.js';

export const drillEmails = ['restore-a@synthetic.invalid', 'restore-b@synthetic.invalid', 'restore-c@synthetic.invalid'] as const;

// The ordinary runtime config remains closed. This fixture alone supplies the
// existing source-only positive policy, then runs the real RuntimeOwner barrier.
export async function withRestoreDrill(t: TestContext, run: (fixture: {
  d: Deployment;
  runtime(fault?: (point: string, owner: RuntimeOwner) => void): Promise<{ server: FormServer; owner: RuntimeOwner }>;
  source23(): Promise<FormServer>;
}) => Promise<void>): Promise<void> {
  const d = await deployment(t);
  const handles = new Set<FormServer>();
  const signalFailures: unknown[] = [];
  const closeOnSignal = () => {
    for (const server of handles) if (server.db.open) {
      try {
        const result = server.close(false);
        if (result) void result.catch(error => { signalFailures.push(error); });
      } catch (error) { signalFailures.push(error); }
    }
  };
  // Close these extra handles before deployment() removes its exact owned root.
  process.prependOnceListener('SIGINT', closeOnSignal);
  process.prependOnceListener('SIGTERM', closeOnSignal);
  let primary: unknown;
  let failed = false;
  try {
    await run({
      d,
      async runtime(fault) {
        let owner!: RuntimeOwner;
        const injected: FaultPoint = point => fault?.(point, owner);
        owner = new RuntimeOwner(d.configuration, d.path, injected);
        let server: FormServer | undefined;
        try {
          owner.beforeOpen(d.path);
          let limiter: CommunityLimiter | undefined, monotonic = 0;
          const limited = (actor: Parameters<CommunityLimiter['consume']>[0], action: Parameters<CommunityLimiter['consume']>[1]) => {
            assert.ok(limiter); limiter.consume(actor, action);
          };
          server = await createServer({
            dbPath: d.path, baseURL: origin, secret,
            registration: { mode: 'allowlist', emails: [...drillEmails] },
            publicStagedLifecycleEnabled: true,
            moduleMigrations,
            lifecycle: { ledger: owner.ledger, createAdapters: (_db, lifecycle) => {
              limiter = new CommunityLimiter(lifecycle, () => monotonic);
              return [];
            } },
            sourceRequestFactories: {
              mode: 'source-only', activityCommands: 'owner-input', activityProjection: 'read-only',
              communityModules: 'b2-b4-b5',
              assertCommunityRateLimit: limited,
              communityExtension: { assertRateLimit: limited,
                textModeration: { policyVersion: 'community-v1', checkText: input => input.text.length <= 1000 ? 'allowed' : 'rejected' } },
            },
          });
          handles.add(server);
          owner.attachMain(server.db);
          assert.ok(server.lifecycle); assert.ok(server.reconcileModulesRestore);
          const active = server;
          owner.admit(() => { active.lifecycle!.reconcileRestore(); return active.lifecycle!; }, server.reconcileModulesRestore);
          const originalClose = server.close;
          server.close = (clean = true) => { owner.close(clean); return originalClose(false); };
          monotonic = 60000;
          return { server, owner };
        } catch (error) {
          owner.close(false);
          if (server?.db.open) await server.close(false);
          throw error;
        }
      },
      async source23() {
        const authority = suppressionLedger();
        const server = await createServer({
          dbPath: join(d.root, 'source23.sqlite'), baseURL: origin, secret,
          registration: { mode: 'allowlist', emails: [...drillEmails] },
          publicStagedLifecycleEnabled: true,
          moduleMigrations, lifecycle: { ledger: authority.ledger },
          sourceRequestFactories: { mode: 'source-only', communityModules: 'b2-b4-b5' },
          sourceAccountModules: { mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' },
          sourceBodyMeasurements: createManualMeasurements,
          sourceReportedLoad: 'selected-migration-22', sourceManualRetention: 'selected-migration-23',
        });
        handles.add(server);
        return server;
      },
    });
  } catch (error) { primary = error; failed = true; }
  finally {
    process.off('SIGINT', closeOnSignal); process.off('SIGTERM', closeOnSignal);
    const cleanup: unknown[] = [...signalFailures];
    for (const server of handles) if (server.db.open) {
      try { await server.close(false); } catch (error) { cleanup.push(error); }
    }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Synthetic drill handle cleanup failed');
  }
  if (failed) throw primary;
}
