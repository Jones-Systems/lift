import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from 'node:crypto';
import type { AuthenticatedCipher } from './auth-state-types.js';

const plaintextLimit = 16384, aadLimit = 65536, envelopeLimit = 22000;
function invalid(): never { throw new Error('provider_auth_cipher_invalid'); }
function bytes(value: string, limit: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) invalid();
  const result = Buffer.from(value, 'utf8');
  if (result.byteLength > limit || result.toString('utf8') !== value) invalid();
  return result;
}
function decode(value: string, length?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value || (length !== undefined && result.length !== length)) invalid();
  return result;
}
export function createNodeAuthCipher(input: { key: Uint8Array }): AuthenticatedCipher {
  if (!(input?.key instanceof Uint8Array) || input.key.byteLength !== 32) invalid();
  const copy = Buffer.from(input.key);
  const key = createSecretKey(copy); copy.fill(0);
  return {
    seal(plaintext, associatedData) {
      let plain: Buffer | undefined;
      try {
        plain = bytes(plaintext, plaintextLimit);
        const aad = bytes(associatedData, aadLimit), nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        cipher.setAAD(aad);
        const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
        return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
      } catch { return invalid(); } finally { plain?.fill(0); }
    },
    open(envelope, associatedData) {
      let plain: Buffer | undefined, partial: Buffer | undefined;
      try {
        if (typeof envelope !== 'string' || envelope.length > envelopeLimit) invalid();
        const parts = envelope.split('.');
        if (parts.length !== 4 || parts[0] !== 'v1') invalid();
        const nonce = decode(parts[1]!, 12), tag = decode(parts[2]!, 16), encrypted = decode(parts[3]!);
        if (encrypted.length > plaintextLimit) invalid();
        const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        decipher.setAAD(bytes(associatedData, aadLimit)); decipher.setAuthTag(tag);
        // GCM update yields unauthenticated bytes; never expose them before final verifies the tag.
        partial = decipher.update(encrypted);
        plain = Buffer.concat([partial, decipher.final()]);
        const result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
        if (!result.length) invalid(); return result;
      } catch { return invalid(); } finally { partial?.fill(0); plain?.fill(0); }
    },
  };
}
