import { z } from 'zod';
import type { Sqlite } from '../../storage.js';
import { evidenceDigest, evidenceIdSchema } from '../evidence-codec.js';
import type { CaptureMaterial, MaterialCustodian, ProviderAccount, QualifiedToken, RestrictedReference, ResolvedMaterial } from './types.js';

const text = (value: unknown, bytes: number): value is string => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= bytes && !/[\u0000-\u001f\u007f]/.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const accountSchema = z.object({ rowId: evidenceIdSchema, authUserId: evidenceIdSchema,
  provider: evidenceIdSchema.max(64), immutableSubject: z.string().min(1).max(16384) }).strict();
export function providerAccounts(db: Sqlite, authUserId: string): readonly ProviderAccount[] {
  return (db.prepare(`SELECT id rowId,userId authUserId,providerId provider,accountId immutableSubject
    FROM account WHERE userId=? AND providerId<>'credential' ORDER BY id`).all(authUserId) as unknown[]).map(row => accountSchema.parse(row));
}
function row(db: Sqlite, id: string): (ProviderAccount & { accessToken: string | null; refreshToken: string | null }) | undefined {
  return db.prepare('SELECT id rowId,userId authUserId,providerId provider,accountId immutableSubject,accessToken,refreshToken FROM account WHERE id=?')
    .get(id) as ReturnType<typeof row>;
}
function tokenMatches(db: Sqlite, expected: ProviderAccount, material: QualifiedToken): boolean {
  const actual = row(db, expected.rowId);
  return !!actual && ['rowId', 'authUserId', 'provider', 'immutableSubject'].every(key =>
    actual[key as keyof ProviderAccount] === expected[key as keyof ProviderAccount] && material[key as keyof ProviderAccount] === expected[key as keyof ProviderAccount]) &&
    material.provenance === 'issuer-client-subject-token-v1' && evidenceIdSchema.safeParse(material.clientBindingId).success &&
    text(material.clientId, 255) && text(material.token, 16384) &&
    (material.tokenKind === 'refresh_token' || material.tokenKind === 'access_token') &&
    actual[material.tokenKind === 'refresh_token' ? 'refreshToken' : 'accessToken'] === material.token;
}
export const tokenReferenceVersion = (material: QualifiedToken): string => evidenceDigest(['provider-reference-v1',
  material.rowId, material.authUserId, material.provider, material.immutableSubject, material.clientBindingId,
  evidenceDigest(['provider-client-v1', material.clientId]), material.tokenKind, material.token]);
export function captureReference(db: Sqlite, account: ProviderAccount, custodian: MaterialCustodian): RestrictedReference {
  const base = { sourceAccountRowId: account.rowId, authUserId: account.authUserId, provider: account.provider,
    subjectDigest: evidenceDigest(['provider-subject-v1', account.provider, account.immutableSubject]),
    clientBindingId: null, clientDigest: null, tokenKind: null, referenceVersion: null } as const;
  const unavailable = (residualCode: RestrictedReference['residualCode']): RestrictedReference => Object.freeze({ ...base, materialState: 'unavailable', residualCode });
  if (account.provider !== 'apple') return unavailable('unsupported_provider');
  let captured: CaptureMaterial;
  try { captured = custodian.capture(Object.freeze({ ...account })); } catch { return unavailable('material_invalid'); }
  if (captured?.status === 'unavailable') {
    return unavailable(['material_missing', 'client_binding_unavailable', 'token_provenance_unavailable', 'material_invalid'].includes(captured.reason)
      ? captured.reason : 'material_invalid');
  }
  if (captured?.status !== 'qualified' || !captured.material || !tokenMatches(db, account, captured.material)) return unavailable('material_invalid');
  const m = captured.material;
  return Object.freeze({ ...base, materialState: 'captured', residualCode: null, clientBindingId: m.clientBindingId,
    clientDigest: evidenceDigest(['provider-client-v1', m.clientId]), tokenKind: m.tokenKind, referenceVersion: tokenReferenceVersion(m) });
}
export function referenceStillPresent(db: Sqlite, reference: RestrictedReference): boolean {
  const actual = row(db, reference.sourceAccountRowId);
  return !!actual && actual.authUserId === reference.authUserId && actual.provider === reference.provider &&
    evidenceDigest(['provider-subject-v1', actual.provider, actual.immutableSubject]) === reference.subjectDigest;
}
export function validateResolvedReference(db: Sqlite, reference: RestrictedReference, resolved: ResolvedMaterial): boolean {
  const m = resolved?.material, actual = row(db, reference.sourceAccountRowId);
  return !!m && !!actual && reference.materialState === 'captured' && referenceStillPresent(db, reference) &&
    tokenMatches(db, actual, m) && m.clientBindingId === reference.clientBindingId && m.tokenKind === reference.tokenKind &&
    evidenceDigest(['provider-client-v1', m.clientId]) === reference.clientDigest && tokenReferenceVersion(m) === reference.referenceVersion &&
    text(resolved.clientSecret, 16384);
}
