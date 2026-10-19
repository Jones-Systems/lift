import type { Sqlite } from '../storage.js';
import { assertPrincipalActive } from '../lifecycle/guards.js';
import { isPhoneEmail } from '../phone/index.js';

export type CredentialMailStatus = 'unconfigured' | 'configured_unverified' | 'verified';
export type CredentialMailInput = Readonly<{ email: string; otp: string; type: 'forget-password' | 'change-email' }>;
export type CredentialMailPort = Readonly<{ status(): CredentialMailStatus; dispatch(input: CredentialMailInput): void }>;
export const unconfiguredCredentialMail: CredentialMailPort = Object.freeze({ status: () => 'unconfigured', dispatch: () => {} });
const ports = new WeakMap<Sqlite, CredentialMailPort>();
export const credentialMailFor = (db: Sqlite): CredentialMailPort => ports.get(db) ?? unconfiguredCredentialMail;
export function eligibleCredential(db: Sqlite, email: string): boolean {
  if (isPhoneEmail(email)) return false;
  const user = db.prepare('SELECT u.id FROM "user" u JOIN account a ON a.userId=u.id WHERE u.email=? COLLATE NOCASE AND a.providerId=\'credential\' AND a.password IS NOT NULL').get(email) as { id: string } | undefined;
  if (!user) return false;
  try { assertPrincipalActive(db, user.id); return true; } catch { return false; }
}
export function bindCredentialMail(db: Sqlite, port: CredentialMailPort = unconfiguredCredentialMail, now = Date.now): CredentialMailPort {
  const sends = new Map<string, { start: number; count: number }>();
  const bound: CredentialMailPort = { status: () => port.status(), dispatch(input) {
    if (port.status() === 'unconfigured' || (input.type === 'forget-password' && !eligibleCredential(db, input.email))) return;
    const email = input.email.toLowerCase(), time = now();
    for (const [key, value] of sends) if (time - value.start >= 3600000) sends.delete(key);
    const budget = sends.get(email) ?? { start: time, count: 0 };
    if (budget.count >= 3 || (!sends.has(email) && sends.size >= 10000)) return;
    budget.count++; sends.set(email, budget);
    // Provider failures must never reveal eligibility or the code in the HTTP response.
    try { void Promise.resolve(port.dispatch({ ...input, email })).catch(() => {}); } catch { /* Delivery remains unconfirmed. */ }
  } };
  ports.set(db, bound); return bound;
}
