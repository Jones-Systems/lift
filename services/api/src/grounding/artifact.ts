import { createHash } from 'node:crypto';
import { createGroundingRetriever, GroundingInputError, type GroundingRetriever } from './index.js';

const projectionSha256 = '84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8';
const projectionBytes = 1488603;
const binding = Object.freeze({
  repository: 'Jones-Systems/BusinessLessons',
  revision: '7636efca55195b1dc6a5980864452575478116b7',
  corpusRoot: 'research/form-knowledge-campaign-2026-10-01',
  corpusInputSha256: '78ffb7674b95dfb946f9f30d318ba6dfa07332cad364298f6c7daf4c8055b824',
});

// This exact-byte pin authenticates the accepted export; a supplied receipt is not a trust anchor.
export function createRetainedGroundingRetriever(bytes: Uint8Array): GroundingRetriever {
  if (!(bytes instanceof Uint8Array)) {
    throw new GroundingInputError('invalid_projection', 'expected retained projection bytes');
  }
  const owned = new Uint8Array(bytes);
  if (owned.byteLength !== projectionBytes || createHash('sha256').update(owned).digest('hex') !== projectionSha256) {
    throw new GroundingInputError('invalid_projection', 'retained projection digest mismatch');
  }
  let projection: unknown;
  try {
    projection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(owned));
  } catch {
    throw new GroundingInputError('invalid_projection', 'invalid retained projection encoding');
  }
  return createGroundingRetriever(projection, binding);
}
