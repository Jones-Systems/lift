import type { DomainReadPorts, ReadIdentity } from './domain-ports.mjs';
import type { AuthInfo } from '@modelcontextprotocol/server';
export interface FormMcpAuthorizationDenial {
  response: Response;
  authentication?: Readonly<{ code: 'invalid_token' | 'insufficient_scope'; challenge: string }>;
}
export interface FormMcpAuthorizationContext {
  identity: ReadIdentity;
  ports: DomainReadPorts;
  authInfo: AuthInfo;
  checkCurrent: () => Promise<FormMcpAuthorizationDenial | null>;
}
export interface FormMcpOptions {
  enabled?: boolean;
  verifyRequest?: (request: Request) => ReadIdentity | Promise<ReadIdentity>;
  authorizeRequest?: (request: Request) => Promise<FormMcpAuthorizationContext | Response>;
  admitRequest?: (request: Request) => boolean | Promise<boolean>;
  ports?: DomainReadPorts;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  now?: () => number;
}
export const mcpToolDescriptors: readonly Readonly<Record<string, unknown>>[];
export function createFormMcpHandler(options?: FormMcpOptions): Readonly<{
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}>;
