import type { AccountContext } from '../lifecycle/types.js';

export type CoachingRequestScope = Readonly<{
  actor: AccountContext;
  signal: AbortSignal;
  assertCurrent(): void;
}>;

export type ProviderOutcome<T> =
  | Readonly<{ kind: 'succeeded'; value: T }>
  | Readonly<{ kind: 'not_dispatched'; reason: string }>
  | Readonly<{ kind: 'rejected'; reason: string }>
  | Readonly<{ kind: 'unknown'; reason: string }>;
