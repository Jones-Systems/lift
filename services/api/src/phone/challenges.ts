import { assertPrincipalActive } from '../lifecycle/guards.js';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../errors.js';
import type { Sqlite } from '../storage.js';
import { normalizePhone, ProviderRejected, type ManagedPhoneProvider } from './provider.js';

export const phoneLifetimeMs = 10 * 60_000;
type Challenge = { id: string; phone: string; binding_hash: string; start_key: string; status: string;
  provider_sid: string | null; created_at: number; expires_at: number; last_send_at: number;
  send_count: number; attempt_count: number; approved_at: number | null; auth_user_id: string | null };
type Operation = { intent_hash: string; status: string };
export type ChallengeInput = { phoneNumber: string; binding: string };
export type BoundChallengeInput = ChallengeInput & { challengeId: string };
export type PhoneCheckInput = BoundChallengeInput & { code: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const phoneEmail = (phone: string) => `${digest(`twilio-verify:${normalizePhone(phone)}`)}@phone.form.invalid`;
export const isPhoneEmail = (email: string) => email.toLowerCase().endsWith('@phone.form.invalid');

export class PhoneChallenges {
  private readonly allowlist: ReadonlySet<string>;
  constructor(private readonly db: Sqlite, private readonly provider: ManagedPhoneProvider | undefined,
    allowedPhones: readonly string[], private readonly receiptSecret: string, private readonly now: () => number = Date.now) {
    if (receiptSecret.length < 32) throw new Error('Phone receipts need the stable server secret');
    this.allowlist = new Set(allowedPhones.map(normalizePhone));
  }
  capability(): { status: 'unconfigured' | 'configured_unverified' } {
    return { status: this.provider && this.allowlist.size ? 'configured_unverified' : 'unconfigured' };
  }
  private phone(value: string): string {
    let phone: string;
    try { phone = normalizePhone(value); } catch { throw new DomainError(422, 'invalid_phone'); }
    if (!this.provider || !this.allowlist.size) throw new DomainError(501, 'phone_verification_unconfigured');
    if (!this.allowlist.has(phone)) throw new DomainError(403, 'phone_login_unavailable');
    const subject = this.db.prepare('SELECT id FROM "user" WHERE phoneNumber=?').get(phone) as { id: string } | undefined;
    if (subject) assertPrincipalActive(this.db, subject.id);
    return phone;
  }
  private key(key: string): void {
    if (!/^[A-Za-z0-9_.:-]{16,128}$/.test(key)) throw new DomainError(400, 'idempotency_key_required');
  }
  private fingerprint(value: unknown): string {
    // Keyed receipts prevent a retained low-entropy OTP digest from becoming an offline oracle.
    return createHmac('sha256', this.receiptSecret).update(JSON.stringify(value)).digest('hex');
  }
  private bound(input: BoundChallengeInput): Challenge {
    if (typeof input.binding !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(input.binding)) throw new DomainError(422, 'invalid_phone_binding');
    const phone = this.phone(input.phoneNumber);
    const row = this.db.prepare('SELECT * FROM phone_challenges WHERE id=?').get(input.challengeId) as Challenge | undefined;
    const binding = Buffer.from(digest(input.binding), 'hex');
    if (!row || row.phone !== phone || !timingSafeEqual(Buffer.from(row.binding_hash, 'hex'), binding))
      throw new DomainError(404, 'phone_challenge_not_found');
    if (this.now() >= row.expires_at) throw new DomainError(409, 'phone_challenge_expired');
    return row;
  }
  private view(row: Challenge) {
    this.phone(row.phone);
    return { challengeId: row.id, phoneNumber: row.phone, expiresAt: new Date(row.expires_at).toISOString(),
      status: row.status, resendAfter: new Date(row.last_send_at + 30_000).toISOString() };
  }
  private claim(row: Challenge, operation: 'start' | 'resend' | 'check', key: string, input: unknown): boolean {
    this.key(key);
    const intent = this.fingerprint(input);
    const previous = this.db.prepare('SELECT intent_hash,status FROM phone_operations WHERE challenge_id=? AND operation=? AND key=?')
      .get(row.id, operation, key) as Operation | undefined;
    if (previous) {
      if (previous.intent_hash !== intent) throw new DomainError(409, 'idempotency_mismatch');
      if (previous.status === 'claimed' || previous.status === 'unknown') throw new DomainError(409, 'phone_outcome_unknown');
      if (previous.status === 'rejected') throw new DomainError(400, operation === 'check' ? 'invalid_phone_code' : 'phone_send_rejected');
      if (operation === 'check') throw new DomainError(409, 'phone_challenge_consumed');
      return false;
    }
    this.db.prepare('INSERT INTO phone_operations VALUES (?,?,?,?,?,?)').run(row.id, operation, key, intent, 'claimed', this.now());
    return true;
  }
  async start(input: ChallengeInput, key: string) {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.binding)) throw new DomainError(422, 'invalid_phone_binding');
    const phone = this.phone(input.phoneNumber); this.key(key);
    const claimed = this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM phone_challenges WHERE start_key=?').get(key) as Challenge | undefined;
      if (previous) {
        const row = this.bound({ ...input, challengeId: previous.id });
        return { row, send: this.claim(row, 'start', key, { phone, binding: input.binding }) };
      }
      // A new local challenge cannot silently reuse a still-live managed-provider OTP.
      if (this.db.prepare('SELECT id FROM phone_challenges WHERE phone=? AND last_send_at>? LIMIT 1')
        .get(phone, this.now() - phoneLifetimeMs)) throw new DomainError(429, 'phone_challenge_cooldown');
      this.sendBudget(phone);
      const timestamp = this.now();
      this.db.prepare(`INSERT INTO phone_challenges(id,phone,binding_hash,start_key,status,created_at,expires_at,last_send_at)
        VALUES (?,?,?,?,'sending',?,?,?)`).run(randomUUID(), phone, digest(input.binding), key, timestamp, timestamp + phoneLifetimeMs, timestamp);
      const row = this.db.prepare('SELECT * FROM phone_challenges WHERE start_key=?').get(key) as Challenge;
      return { row, send: this.claim(row, 'start', key, { phone, binding: input.binding }) };
    }).immediate();
    if (claimed.send) await this.send(claimed.row, 'start', key);
    return this.view(this.db.prepare('SELECT * FROM phone_challenges WHERE id=?').get(claimed.row.id) as Challenge);
  }
  private sendBudget(phone: string): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM phone_operations o JOIN phone_challenges c ON c.id=o.challenge_id
      WHERE c.phone=? AND o.operation IN('start','resend') AND o.created_at>?`).get(phone, this.now() - 60 * 60_000) as { count: number };
    if (count.count >= 5) throw new DomainError(429, 'phone_send_limit');
  }
  async resend(input: BoundChallengeInput, key: string) {
    const claimed = this.db.transaction(() => {
      const row = this.bound(input);
      const previous = this.db.prepare('SELECT key FROM phone_operations WHERE challenge_id=? AND operation=\'resend\' AND key=?').get(row.id, key);
      if (previous) return { row, send: this.claim(row, 'resend', key, input) };
      if (row.status !== 'pending') throw new DomainError(409, 'phone_challenge_unavailable');
      if (row.send_count >= 3 || row.attempt_count >= 3 || this.now() - row.last_send_at < 30_000)
        throw new DomainError(429, 'phone_resend_limit');
      this.sendBudget(row.phone);
      this.claim(row, 'resend', key, input);
      this.db.prepare("UPDATE phone_challenges SET status='sending',send_count=send_count+1,last_send_at=? WHERE id=?").run(this.now(), row.id);
      return { row, send: true };
    }).immediate();
    if (claimed.send) await this.send(claimed.row, 'resend', key);
    return this.view(this.db.prepare('SELECT * FROM phone_challenges WHERE id=?').get(claimed.row.id) as Challenge);
  }
  private async send(row: Challenge, operation: 'start' | 'resend', key: string): Promise<void> {
    try {
      const result = await this.provider!.start(row.phone);
      this.phone(row.phone);
      if (result.phone !== row.phone || result.status !== 'pending' || !/^VE[a-fA-F0-9]{32}$/.test(result.sid) ||
          (row.provider_sid && row.provider_sid !== result.sid)) throw new Error('provider_binding_unknown');
      this.db.transaction(() => {
        this.phone(row.phone);
        this.db.prepare("UPDATE phone_challenges SET status='pending',provider_sid=? WHERE id=?").run(result.sid, row.id);
        this.finish(row.id, operation, key, 'done');
      }).immediate();
    } catch (error) { this.fail(row.id, operation, key, error); }
  }
  async verify(input: PhoneCheckInput, key: string): Promise<boolean> {
    if (!/^[0-9]{4,10}$/.test(input.code)) throw new DomainError(422, 'invalid_phone_code');
    const row = this.db.transaction(() => {
      const challenge = this.bound(input);
      this.claim(challenge, 'check', key, input);
      if (challenge.status === 'consumed') throw new DomainError(409, 'phone_challenge_consumed');
      if (challenge.status !== 'pending' || !challenge.provider_sid) throw new DomainError(409, 'phone_challenge_unavailable');
      if (challenge.attempt_count >= 3) throw new DomainError(429, 'phone_attempt_limit');
      this.db.prepare("UPDATE phone_challenges SET status='checking',attempt_count=attempt_count+1 WHERE id=?").run(challenge.id);
      return challenge;
    }).immediate();
    try {
      const result = await this.provider!.check(row.phone, row.provider_sid!, input.code);
      this.phone(row.phone);
      if (result.sid !== row.provider_sid || result.phone !== row.phone) throw new Error('provider_binding_unknown');
      const approved = result.status === 'approved';
      this.db.transaction(() => {
        const current = this.bound(input);
        if (current.status !== 'checking') throw new Error('challenge_claim_lost');
        this.db.prepare('UPDATE phone_challenges SET status=?,approved_at=? WHERE id=?')
          .run(approved ? 'consumed' : result.status === 'pending' ? 'pending' : 'failed', approved ? this.now() : null, row.id);
        this.finish(row.id, 'check', key, approved ? 'done' : 'rejected');
      }).immediate();
      return approved;
    } catch (error) { return this.fail(row.id, 'check', key, error); }
  }
  private finish(id: string, operation: string, key: string, status: string): void {
    this.db.prepare('UPDATE phone_operations SET status=? WHERE challenge_id=? AND operation=? AND key=?').run(status, id, operation, key);
  }
  private fail(id: string, operation: string, key: string, error: unknown): never {
    const row = this.db.prepare('SELECT phone FROM phone_challenges WHERE id=?').get(id) as { phone: string } | undefined;
    if (row) this.phone(row.phone);
    const known = error instanceof ProviderRejected;
    this.db.transaction(() => {
      this.db.prepare('UPDATE phone_challenges SET status=? WHERE id=?').run(known && operation === 'check' ? 'pending' : known ? 'failed' : 'unknown', id);
      this.finish(id, operation, key, known ? 'rejected' : 'unknown');
    }).immediate();
    throw new DomainError(known ? 400 : 409, known ? operation === 'check' ? 'invalid_phone_code' : 'phone_send_rejected' : 'phone_outcome_unknown');
  }
  canCreateUser(user: { email: string; phoneNumber?: unknown; phoneNumberVerified?: unknown }, context?: { path?: string; body?: unknown } | null): boolean {
    if (context?.path !== '/phone-number/verify' || typeof user.phoneNumber !== 'string' || user.phoneNumberVerified !== true ||
        user.email !== phoneEmail(user.phoneNumber)) return false;
    try {
      const input = context.body as PhoneCheckInput;
      const row = this.bound(input);
      return row.status === 'consumed' && row.approved_at !== null && row.auth_user_id === null && row.phone === user.phoneNumber;
    } catch { return false; }
  }
  recordSubject(input: PhoneCheckInput, user: { id: string; phoneNumber: string; email: string }): void {
    this.db.transaction(() => {
      const row = this.bound(input);
      if (row.status !== 'consumed' || row.approved_at === null || user.phoneNumber !== row.phone || user.email !== phoneEmail(row.phone))
        throw new DomainError(409, 'phone_subject_mismatch');
      const subject = this.db.prepare('SELECT id FROM "user" WHERE phoneNumber=? AND phoneNumberVerified=1 AND email=?')
        .get(row.phone, phoneEmail(row.phone)) as { id: string } | undefined;
      if (subject?.id !== user.id || (row.auth_user_id !== null && row.auth_user_id !== user.id)) throw new DomainError(409, 'phone_subject_mismatch');
      this.db.prepare('UPDATE phone_challenges SET auth_user_id=? WHERE id=?').run(user.id, row.id);
    }).immediate();
  }
}
