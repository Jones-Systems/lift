export interface ReadIdentity {
  readonly accountId: string;
  readonly subject: string;
  readonly expiresAtMs: number;
  readonly scopes: readonly string[];
}
export interface DomainReadDependencies {
  domain?: {
    history?: (accountId: string, limit: number, before?: string) => unknown;
    session?: (accountId: string, id: string) => unknown;
    plan?: (accountId: string, id: string) => unknown;
  };
  resolveAccount?: (subject: string) => string | null;
  withActiveAccountRead?: <T>(context: { accountId: string; subject: string }, read: () => T) => T;
  plansPage?: (accountId: string, limit: number) => unknown;
  now?: () => number;
}
export interface DomainReadPorts {
  listWorkouts?: (request: { identity: ReadIdentity; limit: number; before?: string }) => unknown;
  getWorkout?: (request: { identity: ReadIdentity; workoutId: string }) => unknown;
  listPlans?: (request: { identity: ReadIdentity; limit: number }) => unknown;
  getPlan?: (request: { identity: ReadIdentity; planId: string }) => unknown;
}
export function createDomainReadPorts(dependencies?: DomainReadDependencies): Readonly<DomainReadPorts>;
