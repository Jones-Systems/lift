import { createHash } from 'node:crypto';
import { createGroundingRetriever, GroundingInputError, type GroundingRetriever } from './index.js';

const projectionSha256 = '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10';
const projectionBytes = 80588;
const binding = Object.freeze({
  repository: 'Jones-Systems/Form',
  revision: '0c68e72727f04a7307407a4a6b73d43b7dca61a6',
  corpusRoot: 'docs/knowledge/research-followups',
  corpusInputSha256: 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971',
});

// This exact-byte pin authenticates the accepted Form export; a supplied declaration is not a trust anchor.
export function createFormFollowupGroundingRetriever(bytes: Uint8Array): GroundingRetriever {
  if (!(bytes instanceof Uint8Array)) {
    throw new GroundingInputError('invalid_projection', 'expected Form follow-up projection bytes');
  }
  const owned = new Uint8Array(bytes);
  if (owned.byteLength !== projectionBytes || createHash('sha256').update(owned).digest('hex') !== projectionSha256) {
    throw new GroundingInputError('invalid_projection', 'Form follow-up projection digest mismatch');
  }
  let projection: unknown;
  try {
    projection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(owned));
  } catch {
    throw new GroundingInputError('invalid_projection', 'invalid Form follow-up projection encoding');
  }
  return createGroundingRetriever(projection, binding);
}
