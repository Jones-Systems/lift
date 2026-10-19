import { createHash, X509Certificate } from 'node:crypto';
import { Environment, SignedDataVerifier, VerificationException, VerificationStatus } from '@apple/app-store-server-library';
import { appleRoots } from './apple-roots.js';
import { validateAppleConfiguration } from './configuration.js';
import { AppleProofError, type AppleTransactionVerifier, type AppleSandboxConfiguration, type VerifiedAppleTransaction } from './types.js';
import type { AppleReconciliationVerifier } from './reconciliation.types.js';

export function pinnedAppleRoots(): Buffer[] {
  return appleRoots.map(root => {
    const bytes = Buffer.from(root.derBase64, 'base64');
    if (bytes.length !== root.bytes || createHash('sha256').update(bytes).digest('hex') !== root.sha256)
      throw new Error('Apple root certificate integrity mismatch');
    const certificate = new X509Certificate(bytes);
    if (!certificate.ca || !certificate.verify(certificate.publicKey)) throw new Error('Invalid pinned Apple root certificate');
    return bytes;
  });
}

/** Offline verifies Apple chain, certificate validity at signing, signature, bundle and Sandbox. No Server API calls. */
export function createAppleSandboxVerifier(configuration: AppleSandboxConfiguration): AppleTransactionVerifier {
  return createAppleSandboxReconciliationVerifier(configuration);
}

export function createAppleSandboxReconciliationVerifier(configuration: AppleSandboxConfiguration): AppleReconciliationVerifier {
  const config = validateAppleConfiguration(configuration);
  const verifier = new SignedDataVerifier(pinnedAppleRoots(), false, Environment.SANDBOX, config.bundleId);
  return {
    notification: jws => decode(jws, 240_000, () => verifier.verifyAndDecodeNotification(jws)),
    renewal: jws => decode(jws, 60_000, () => verifier.verifyAndDecodeRenewalInfo(jws)),
    async verify(jws) {
      return decode(jws, 60_000, async () => {
        const payload = await verifier.verifyAndDecodeTransaction(jws);
        // The library permits optional fields; Form requires them before any delivery.
        const requiredStrings = ['transactionId', 'originalTransactionId', 'bundleId', 'environment', 'productId', 'type', 'appAccountToken', 'inAppOwnershipType'] as const;
        for (const key of requiredStrings) if (typeof payload[key] !== 'string' || !payload[key]) throw new AppleProofError('apple_claims_missing');
        for (const key of ['purchaseDate', 'signedDate', 'quantity'] as const)
          if (!Number.isSafeInteger(payload[key])) throw new AppleProofError('apple_claims_missing');
        return payload as VerifiedAppleTransaction;
      });
    },
  };
}

async function decode<T>(jws: string, limit: number, verify: () => Promise<T>): Promise<T> {
  // Require Apple's ES256 certificate-bearing JWS before invoking the official verifier.
  try {
    const segments = jws.split('.');
    if (segments.length !== 3 || jws.length > limit || segments.some(x => !/^[A-Za-z0-9_-]+$/.test(x)))
      throw new AppleProofError('apple_jws_invalid');
    const header: unknown = JSON.parse(Buffer.from(segments[0]!, 'base64url').toString('utf8'));
    if (!header || typeof header !== 'object' || !('alg' in header) || header.alg !== 'ES256'
      || !('x5c' in header) || !Array.isArray(header.x5c) || header.x5c.length !== 3
      || header.x5c.some(x => typeof x !== 'string' || x.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(x)))
      throw new AppleProofError('apple_jws_invalid');
  } catch { throw new AppleProofError('apple_jws_invalid'); }
  try { return await verify(); }
  catch (error) {
    if (error instanceof AppleProofError) throw error;
    if (error instanceof VerificationException) {
      if (error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) throw new AppleProofError('apple_verification_unavailable', true);
      if (error.status === VerificationStatus.INVALID_APP_IDENTIFIER) throw new AppleProofError('apple_bundle_mismatch');
      if (error.status === VerificationStatus.INVALID_ENVIRONMENT) throw new AppleProofError('apple_environment_mismatch');
      throw new AppleProofError('apple_signature_invalid');
    }
    throw new AppleProofError('apple_verification_unknown', true);
  }
}
