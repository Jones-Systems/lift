import type { AccountContext } from '../types.js';

export type ProviderRevocationConfiguration = Readonly<{ mode: 'source-only'; cohort: 'provider-revocation-v1' }>;
export type TokenKind = 'refresh_token' | 'access_token';
export type MaterialResidual = 'unsupported_provider' | 'material_missing' | 'client_binding_unavailable' |
  'token_provenance_unavailable' | 'material_invalid';
export type ProviderAccount = Readonly<{ rowId: string; authUserId: string; provider: string; immutableSubject: string }>;
// Custody must attest this exact historical token/client/subject tuple, not current configuration.
export type QualifiedToken = ProviderAccount & Readonly<{ clientBindingId: string; clientId: string;
  tokenKind: TokenKind; token: string; provenance: 'issuer-client-subject-token-v1' }>;
export type CaptureMaterial = Readonly<{ status: 'qualified'; material: QualifiedToken }> |
  Readonly<{ status: 'unavailable'; reason: Exclude<MaterialResidual, 'unsupported_provider'> }>;
export type RestrictedReference = Readonly<{ sourceAccountRowId: string; authUserId: string; provider: string;
  subjectDigest: string; clientBindingId: string | null; clientDigest: string | null; tokenKind: TokenKind | null;
  referenceVersion: string | null; materialState: 'captured' | 'unavailable'; residualCode: MaterialResidual | null }>;
export type ResolvedMaterial = Readonly<{ material: QualifiedToken; clientSecret: string }>;
export type ResolveMaterial = Readonly<{ status: 'qualified'; value: ResolvedMaterial }> |
  Readonly<{ status: 'unavailable' }>;
// Local termination requires both operation settlement and successful cancel cleanup, including body consumption.
// A rejected cleanup or unusable start handle leaves the durable attempt active; it grants no retry authority.
// The 10s total includes cancellation; abort starts with 500ms reserved for cleanup.
// capture prefers a qualified refresh token; an access token needs the same exact issuer/subject provenance.
// A real adapter needs separate qualification; this contract activates no network implementation.
export type BoundedProviderOperation<T> = Readonly<{ settled: Promise<T>; cancel: () => Promise<void> }>;
export class LocalTerminationUnconfirmed extends Error {
  readonly code = 'local_termination_unconfirmed';
  constructor() { super('local_termination_unconfirmed'); }
}
export type ProviderBudget = Readonly<{ deadlineAtMs: number; signal: AbortSignal; maxResponseBytes: 4096 }>;
export type MaterialCustodian = Readonly<{
  contract: 'bounded-provider-material-v1';
  capture: (account: ProviderAccount) => CaptureMaterial;
  resolve: (reference: RestrictedReference, budget: ProviderBudget) => BoundedProviderOperation<ResolveMaterial>;
}>;
export type AppleRequest = Readonly<{ url: 'https://appleid.apple.com/auth/revoke'; method: 'POST';
  contentType: 'application/x-www-form-urlencoded'; body: string; redirect: 'error'; credentials: 'omit'; retry: 0 }>;
export type AppleResponse = Readonly<{ status: number; body: Uint8Array; truncated: boolean }>;
export type BoundedAppleTransport = Readonly<{ contract: 'bounded-apple-revoke-v1';
  post: (request: AppleRequest, budget: ProviderBudget) => BoundedProviderOperation<AppleResponse> }>;
export type AppleOutcome = Readonly<{ code: 'apple_ack' | 'provider_error' | 'response_invalid' | 'transport_unknown'; status: number | null }>;
export type ConfirmationCapture = Readonly<{ context: AccountContext; requestId: string; now: number }>;
export type ProviderConfirmationHook = Readonly<{
  capture: (input: ConfirmationCapture) => unknown;
  persist: (capture: unknown, requestId: string) => void;
}>;
export type AttemptResult = Readonly<{ attemptId: string; intentId: string;
  state: 'preparing' | 'in_flight' | 'acknowledged' | 'unknown' | 'no_effect';
  outcomeCode: string | null; protocolStatus: number | null }>;
