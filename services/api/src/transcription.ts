import { assertAccountActive, assertActive } from './lifecycle/guards.js';
import type { AccountContext } from './lifecycle/types.js';
import { randomUUID } from 'node:crypto';
import { DomainError, notFound } from './errors.js';
import { hash, type Sqlite } from './storage.js';

export type GrokConfig = { apiKey: string; allowCloudRequests: true; fetch?: typeof fetch };
type Attempt = { id: string; status: 'pending' | 'succeeded' | 'failed' | 'unknown'; text: string | null; error_code: string | null; intent_hash: string };
export const maxWavBytes = 2 * 1024 * 1024;

export function validateWav(audio: Uint8Array): void {
  if (audio.length > maxWavBytes || audio.length < 44) throw new DomainError(422, 'invalid_wav');
  const b = Buffer.from(audio);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE' || b.readUInt32LE(4) !== b.length - 8) throw new DomainError(422, 'invalid_wav');
  let position = 12, rate = 0, blockAlign = 0, dataBytes = 0, formatFound = false, dataFound = false;
  while (position + 8 <= b.length) {
    const chunk = b.toString('ascii', position, position + 4), size = b.readUInt32LE(position + 4), start = position + 8;
    if (start + size > b.length) throw new DomainError(422, 'invalid_wav');
    if (chunk === 'fmt ') {
      if (formatFound || size < 16 || b.readUInt16LE(start) !== 1 || b.readUInt16LE(start + 2) !== 1 || b.readUInt16LE(start + 14) !== 16) throw new DomainError(422, 'invalid_wav');
      formatFound = true; rate = b.readUInt32LE(start + 4); blockAlign = b.readUInt16LE(start + 12);
      if (![16000, 22050, 24000, 44100, 48000].includes(rate) || blockAlign !== 2 || b.readUInt32LE(start + 8) !== rate * 2) throw new DomainError(422, 'invalid_wav');
    }
    if (chunk === 'data') { if (dataFound) throw new DomainError(422, 'invalid_wav'); dataFound = true; dataBytes = size; }
    position = start + size + (size % 2);
  }
  if (position !== b.length || !formatFound || !dataFound || !dataBytes || dataBytes % blockAlign !== 0 || dataBytes / (rate * blockAlign) > 60)
    throw new DomainError(422, 'invalid_wav');
}
export class Transcription {
  constructor(private readonly db: Sqlite, private readonly config?: GrokConfig) {}
  get(accountId: string, id: string) {
    assertAccountActive(this.db, accountId);
    const row = this.db.prepare('SELECT id,status,text,error_code,intent_hash FROM transcription_attempts WHERE account_id=? AND id=?').get(accountId, id) as Attempt | undefined;
    if (!row) notFound();
    return { id: row.id, status: row.status === 'pending' ? 'unknown' : row.status, text: row.text, errorCode: row.error_code };
  }
  async transcribe(accountId: string, key: string | undefined, audio: Uint8Array, context?: AccountContext) {
    const guard = () => context ? assertActive(this.db, context) : assertAccountActive(this.db, accountId);
    guard();
    if (!this.config) throw new DomainError(501, 'transcription_unconfigured');
    if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new DomainError(400, 'idempotency_key_required');
    validateWav(audio);
    const fingerprint = hash(`${hash(Buffer.from(audio).toString('base64'))}:en:grok-voice-transcribe-2.0`);
    const attempt = this.db.transaction(() => {
      guard();
      const prior = this.db.prepare('SELECT id,status,text,error_code,intent_hash FROM transcription_attempts WHERE account_id=? AND key=?').get(accountId, key) as Attempt | undefined;
      if (prior) {
        if (prior.intent_hash !== fingerprint) throw new DomainError(409, 'idempotency_mismatch');
        return { row: prior, fresh: false };
      }
      const row: Attempt = { id: randomUUID(), status: 'pending', text: null, error_code: null, intent_hash: fingerprint }, date = new Date().toISOString();
      this.db.prepare('INSERT INTO transcription_attempts VALUES (?,?,?,?,\'pending\',NULL,NULL,?,?)').run(accountId, row.id, key, fingerprint, date, date);
      return { row, fresh: true };
    }).immediate();
    if (!attempt.fresh) {
      if (attempt.row.status === 'succeeded') return this.get(accountId, attempt.row.id);
      throw new DomainError(409, attempt.row.status === 'failed' ? 'transcription_failed' : 'transcription_outcome_unknown',
        'This attempt must not be uploaded again.', { attemptId: attempt.row.id });
    }
    const finish = (status: Attempt['status'], text: string | null, error: string | null) => {
      this.db.transaction(() => {
      guard();
      this.db.prepare('UPDATE transcription_attempts SET status=?,text=?,error_code=?,updated_at=? WHERE account_id=? AND id=? AND status=\'pending\'')
        .run(status, text, error, new Date().toISOString(), accountId, attempt.row.id);
      }).immediate();
    };
    try {
      const multipart = new FormData();
      multipart.append('model', 'grok-voice-transcribe-2.0'); multipart.append('language', 'en');
      multipart.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'recording.wav');
      const response = await (this.config.fetch ?? fetch)('https://api.x.ai/v1/stt', {
        method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${this.config.apiKey}` }, body: multipart, signal: AbortSignal.timeout(30000),
      });
      guard();
      if (!response.ok) {
        await response.body?.cancel(); guard();
        finish('failed', null, 'provider_rejected');
        throw new DomainError(503, 'transcription_failed', 'The provider rejected this attempt.', { attemptId: attempt.row.id });
      }
      let bytes = 0; const chunks: Uint8Array[] = [];
      if (!response.body) throw new Error('empty_provider_body');
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read(); guard(); if (done) break;
          bytes += value.byteLength; if (bytes > 64 * 1024) throw new Error('provider_body_too_large'); chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); guard(); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || typeof payload !== 'object' || !('text' in payload) || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 12000)
        throw new Error('invalid_provider_body');
      finish('succeeded', payload.text.trim(), null); return this.get(accountId, attempt.row.id);
    } catch (error) {
      guard();
      if (error instanceof DomainError) throw error;
      finish('unknown', null, 'ambiguous_send');
      throw new DomainError(409, 'transcription_outcome_unknown', 'The upload outcome is unknown; do not automatically send it again.', { attemptId: attempt.row.id });
    }
  }
}
