import type { FormResources } from '../api/resources';
import type { AuthAttemptGuard } from '../api/transport';
import { commandCustodyLimits, createCommandCustody, type CommandCustodyDependencies } from './commandCustody';

export type CommandOwner = ReturnType<typeof createCommandCustody>;
export type CommandOwnerSession = Readonly<{
  accountId: string;
  sessionGeneration: string;
  resources: FormResources;
  originalAuth: AuthAttemptGuard;
  isCurrentSession(): boolean;
}>;
export type CommandConfirmationValidator = CommandCustodyDependencies['validateConfirmation'];
type CleanupSelection = Pick<CommandOwnerSession, 'accountId' | 'sessionGeneration' | 'resources'>;
type RetainedOwner = {
  session: CommandOwnerSession;
  api: FormResources['api'];
  owner: CommandOwner;
  expired: boolean;
};

export function createCommandOwnerRegistry(validateConfirmation?: CommandConfirmationValidator) {
  const retained = new Map<string, RetainedOwner>();
  const current = (entry: RetainedOwner) => {
    try {
      if (entry.session.resources.api !== entry.api || !entry.session.originalAuth.isCurrent() ||
        !entry.session.isCurrentSession()) entry.expired = true;
    } catch { entry.expired = true; }
    return !entry.expired;
  };
  const matches = (entry: RetainedOwner, selection: CleanupSelection) =>
    entry.session.accountId === selection.accountId && entry.session.resources === selection.resources &&
    entry.api === selection.resources.api;
  return Object.freeze({
    forSession(input: CommandOwnerSession): CommandOwner | null {
      const session = Object.freeze({ ...input });
      const existing = retained.get(session.sessionGeneration);
      if (existing) {
        if (!matches(existing, session) || existing.session.originalAuth !== session.originalAuth ||
          existing.session.isCurrentSession !== session.isCurrentSession) existing.expired = true;
        if (!current(existing)) return null;
        try {
          existing.owner.snapshot({ accountId: session.accountId, sessionGeneration: session.sessionGeneration });
          return existing.owner;
        } catch { existing.expired = true; return null; }
      }
      if (!session.accountId || !session.sessionGeneration || retained.size >= commandCustodyLimits.records) return null;
      try { if (!session.originalAuth.isCurrent() || !session.isCurrentSession()) return null; } catch { return null; }
      const entry: RetainedOwner = { session, api: session.resources.api, expired: false,
        owner: createCommandCustody({ accountId: session.accountId, sessionGeneration: session.sessionGeneration,
          transport: { captureAuthContext: () => session.originalAuth },
          isCurrentSession: () => current(entry), validateConfirmation }) };
      retained.set(session.sessionGeneration, entry);
      return entry.owner;
    },
    captureCleanup(selection: CleanupSelection, disposals: readonly (() => Promise<void>)[]): () => Promise<void> {
      const capturedDisposals = [...disposals];
      const entry = retained.get(selection.sessionGeneration);
      let incomplete = false;
      if (entry) {
        try {
          if (!matches(entry, selection)) entry.expired = true;
          if (!current(entry)) throw new Error('Original command owner is unavailable.');
          incomplete = entry.owner.snapshot({ accountId: selection.accountId,
            sessionGeneration: selection.sessionGeneration }).length > 0;
        } catch { incomplete = true; }
      }
      return async () => {
        const results = await Promise.allSettled(capturedDisposals.map(dispose => Promise.resolve().then(dispose)));
        if (incomplete || results.some(result => result.status === 'rejected')) {
          throw new Error('Account resource cleanup is incomplete.');
        }
      };
    },
  });
}
