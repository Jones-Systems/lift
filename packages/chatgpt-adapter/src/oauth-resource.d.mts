import type { OAuthMetadata } from '@modelcontextprotocol/server';
import type { DomainReadDependencies } from './domain-ports.mjs';
export type FormAuthorizationFailure = 'invalid_token' | 'insufficient_scope' | 'account_unavailable' | 'unavailable';
export class FormAuthorizationError extends Error {
  readonly code: FormAuthorizationFailure;
  constructor(code: FormAuthorizationFailure);
}
export interface VerifiedFormOAuthToken {
  readonly issuer: string;
  /** External OAuth subject, never interpreted as Form's auth user ID. */
  readonly subject: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAtMs: number;
  readonly evidence?: unknown;
}
export interface CurrentFormAuthorization {
  readonly formAuthUserId: string;
  readonly accountId: string;
  readonly scopes: readonly string[];
  readonly expiresAtMs: number;
  /** Check the selected session/grant policy and live consent; true alone admits. */
  assertCurrent(context: { readonly scopes: readonly string[] }): boolean | Promise<boolean>;
  /** Check current authority before/after exactly one synchronous read; reject thenables. */
  withCurrentRead<T>(context: { readonly scope: string }, read: () => T): T;
}
export interface FormOAuthResourceOptions {
  enabled?: boolean;
  resourceUrl?: string;
  issuer?: string;
  authorizationServerMetadata?: OAuthMetadata;
  verifyAccessToken?: (token: string, expected: Readonly<{ issuer: string; resource: string; signal: AbortSignal }>) =>
    VerifiedFormOAuthToken | Promise<VerifiedFormOAuthToken>;
  bindAuthorization?: (token: VerifiedFormOAuthToken, context: Readonly<{ signal: AbortSignal }>) =>
    CurrentFormAuthorization | Promise<CurrentFormAuthorization>;
  dependencies?: DomainReadDependencies;
  admitRequest?: (request: Request) => boolean | Promise<boolean>;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  now?: () => number;
}
export function createFormOAuthResourceHandler(options?: FormOAuthResourceOptions): Readonly<{
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}>;
