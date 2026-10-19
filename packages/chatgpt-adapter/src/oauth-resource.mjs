import { requireBearerAuth, bearerAuthChallengeResponse, OAuthError, OAuthErrorCode,
  buildOAuthProtectedResourceMetadata, getOAuthProtectedResourceMetadataUrl, validateHostHeader } from '@modelcontextprotocol/server';
import { createFormMcpHandler } from './mcp-handler.mjs';
import { createDomainReadPorts } from './domain-ports.mjs';
import { identitySnapshot } from './identity.mjs';

const resourceScopes = Object.freeze(['form:workouts:read', 'form:plans:read']);
const json = (status, error) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
const unavailable = () => json(503, 'Form MCP is unavailable.');
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const scopesValid = value => Array.isArray(value) && value.length <= 20 && new Set(value).size === value.length &&
  value.every(scope => text(scope, 100) && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope));
const sync = value => {
  if (value && typeof value.then === 'function') {
    if (value instanceof Promise) value.catch(() => {});
    throw new FormAuthorizationError('unavailable');
  }
  return value;
};

export class FormAuthorizationError extends Error {
  constructor(code) {
    super('Form authorization failed.');
    this.code = ['invalid_token', 'insufficient_scope', 'account_unavailable', 'unavailable'].includes(code) ? code : 'unavailable';
  }
}

function httpsUrl(value) {
  if (!text(value, 1024)) throw new Error('Configuration');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.href !== value) {
    throw new Error('Configuration');
  }
  return parsed;
}

/**
 * Trusted resource-server composition only; no verifier, grant store, network or
 * listener is created here. OAuth issuer/subject is distinct from Form user ID.
 * The authority owner decides session versus connection-grant lifetime and must
 * enforce it on each binding, around each synchronous read and before disclosure.
 */
export function createFormOAuthResourceHandler({ enabled = false, resourceUrl, issuer, authorizationServerMetadata,
  verifyAccessToken, bindAuthorization, dependencies, admitRequest, allowedHosts = [], allowedOrigins = [], now = Date.now } = {}) {
  let resource, metadataUrl, metadata;
  const hosts = Array.isArray(allowedHosts) ? [...allowedHosts] : [], origins = Array.isArray(allowedOrigins) ? [...allowedOrigins] : [];
  let configured = false, closed = false;
  try {
    resource = httpsUrl(resourceUrl);
    httpsUrl(issuer);
    configured = enabled === true && typeof verifyAccessToken === 'function' && typeof bindAuthorization === 'function' &&
      typeof admitRequest === 'function' && typeof now === 'function' &&
      authorizationServerMetadata?.issuer === issuer &&
      Array.isArray(authorizationServerMetadata.response_types_supported) &&
      authorizationServerMetadata.response_types_supported.includes('code') &&
      Array.isArray(authorizationServerMetadata.code_challenge_methods_supported) &&
      authorizationServerMetadata.code_challenge_methods_supported.includes('S256') &&
      hosts.length > 0 && hosts.length <= 10 && hosts.includes(resource.hostname) && origins.length <= 10 &&
      hosts.every(host => text(host, 253) && !host.includes('*')) &&
      origins.every(origin => text(origin, 512) && !origin.includes('*')) &&
      ['history', 'session', 'plan'].every(name => typeof dependencies?.domain?.[name] === 'function') &&
      ['resolveAccount', 'withActiveAccountRead', 'plansPage'].every(name => typeof dependencies?.[name] === 'function');
    if (configured) {
      httpsUrl(authorizationServerMetadata.authorization_endpoint);
      httpsUrl(authorizationServerMetadata.token_endpoint);
      metadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
      metadata = buildOAuthProtectedResourceMetadata({ resourceServerUrl: resource,
        oauthMetadata: authorizationServerMetadata, scopesSupported: [...resourceScopes] });
    }
  } catch { configured = false; }

  function denial(error, scopes = []) {
    const code = error instanceof FormAuthorizationError ? error.code : 'unavailable';
    if (code === 'account_unavailable') return json(403, 'Form account access is unavailable.');
    if (code === 'unavailable') return unavailable();
    return bearerAuthChallengeResponse(new OAuthError(code === 'insufficient_scope' ?
      OAuthErrorCode.InsufficientScope : OAuthErrorCode.InvalidToken,
    code === 'insufficient_scope' ? 'Required Form permission is missing.' : 'Current Form authorization is required.'),
    { resourceMetadataUrl: metadataUrl, requiredScopes: scopes });
  }

  async function authorizeRequest(request) {
    let verified, binding, identity, readFailure;
    const header = request.headers.get('authorization');
    if (header !== null && !/^Bearer [A-Za-z0-9\-._~+/]+=*$/i.test(header)) return denial(new FormAuthorizationError('invalid_token'));
    const gate = requireBearerAuth({ expectedResource: resource, resourceMetadataUrl: metadataUrl,
      verifier: { verifyAccessToken: async token => {
        try {
          const value = await verifyAccessToken(token, Object.freeze({ issuer, resource: resource.href, signal: request.signal }));
          const time = now();
          if (!value || value.issuer !== issuer || value.resource !== resource.href || !text(value.subject, 255) ||
              !text(value.clientId, 255) || !scopesValid(value.scopes) || !Number.isSafeInteger(time) ||
              !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= time) throw new FormAuthorizationError('invalid_token');
          verified = Object.freeze({ issuer, subject: value.subject, clientId: value.clientId,
            resource: resource.href, scopes: Object.freeze([...value.scopes]), expiresAtMs: value.expiresAtMs, evidence: value.evidence });
          return { token, clientId: verified.clientId, scopes: [...verified.scopes],
            expiresAt: verified.expiresAtMs / 1000, resource };
        } catch (error) {
          if (error instanceof FormAuthorizationError && error.code === 'invalid_token') {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'Current Form authorization is required.');
          }
          throw new OAuthError(OAuthErrorCode.ServerError, 'Form authorization is unavailable.');
        }
      } } });
    const authInfo = await gate(request);
    if (authInfo instanceof Response) return authInfo;
    try {
      const supplied = await bindAuthorization(verified, Object.freeze({ signal: request.signal }));
      if (!supplied || typeof supplied.assertCurrent !== 'function' || typeof supplied.withCurrentRead !== 'function' ||
          !Number.isSafeInteger(supplied.expiresAtMs) ||
          !scopesValid(supplied.scopes) || supplied.scopes.some(scope => !verified.scopes.includes(scope))) {
        throw new FormAuthorizationError('unavailable');
      }
      binding = Object.freeze({ assertCurrent: supplied.assertCurrent.bind(supplied),
        withCurrentRead: supplied.withCurrentRead.bind(supplied) });
      identity = identitySnapshot({ subject: supplied.formAuthUserId, accountId: supplied.accountId,
        scopes: supplied.scopes, expiresAtMs: Math.min(verified.expiresAtMs, supplied.expiresAtMs) }, now());
    } catch (error) { return denial(error); }
    const usedScopes = new Set();
    const checkCurrent = async () => {
      try {
        if (closed || request.signal.aborted) throw new FormAuthorizationError('unavailable');
        const time = now();
        if (!Number.isSafeInteger(time) || identity.expiresAtMs <= time) throw new FormAuthorizationError('invalid_token');
        if (await binding.assertCurrent(Object.freeze({ scopes: Object.freeze([...usedScopes]) })) !== true) {
          throw new FormAuthorizationError('invalid_token');
        }
        if (closed || request.signal.aborted) throw new FormAuthorizationError('unavailable');
        const after = now();
        if (!Number.isSafeInteger(after) || identity.expiresAtMs <= after) throw new FormAuthorizationError('invalid_token');
        if (readFailure) throw readFailure;
        return null;
      } catch (error) {
        if (readFailure && error instanceof FormAuthorizationError && ['invalid_token', 'insufficient_scope'].includes(error.code) &&
            !(readFailure instanceof FormAuthorizationError && ['invalid_token', 'insufficient_scope'].includes(readFailure.code))) {
          error = readFailure;
        }
        const response = denial(error, [...usedScopes]);
        const authentication = error instanceof FormAuthorizationError && ['invalid_token', 'insufficient_scope'].includes(error.code) ?
          Object.freeze({ code: error.code, challenge: response.headers.get('www-authenticate') }) : undefined;
        return Object.freeze({ response, ...(authentication ? { authentication } : {}) });
      }
    };
    const initialDenial = await checkCurrent();
    if (initialDenial) return initialDenial.response;
    const basePorts = createDomainReadPorts({ ...dependencies, now });
    const ports = {};
    for (const [name, scope] of [['listWorkouts', resourceScopes[0]], ['getWorkout', resourceScopes[0]],
      ['listPlans', resourceScopes[1]], ['getPlan', resourceScopes[1]]]) {
      ports[name] = args => {
        usedScopes.add(scope);
        try {
          if (args.identity.accountId !== identity.accountId || args.identity.subject !== identity.subject ||
              !identity.scopes.includes(scope)) throw new FormAuthorizationError('insufficient_scope');
          const time = now();
          if (!Number.isSafeInteger(time) || identity.expiresAtMs <= time) throw new FormAuthorizationError('invalid_token');
          let called = false, active = true, answer, result;
          try {
            result = sync(binding.withCurrentRead(Object.freeze({ scope }), () => {
              if (called || !active) throw new FormAuthorizationError('unavailable');
              called = true;
              answer = sync(basePorts[name](args));
              return answer;
            }));
          } finally { active = false; }
          if (!called || result !== answer) throw new FormAuthorizationError('unavailable');
          return answer;
        } catch (error) { readFailure = error; throw error; }
      };
    }
    return { identity, ports: Object.freeze(ports), authInfo: { ...authInfo, scopes: [...identity.scopes] }, checkCurrent };
  }

  const transport = createFormMcpHandler({ enabled: configured, authorizeRequest, admitRequest,
    allowedHosts: hosts, allowedOrigins: origins, now });
  return Object.freeze({
    async fetch(request) {
      if (!configured || closed) return unavailable();
      if (!(request instanceof Request) || request.url.length > 2048) return json(400, 'Invalid request.');
      if (!validateHostHeader(request.headers.get('host'), hosts).ok ||
          new URL(request.url).origin !== resource.origin ||
          (request.headers.has('origin') && !origins.includes(request.headers.get('origin')))) {
        return json(403, 'Request origin is not allowed.');
      }
      if (request.url === metadataUrl) {
        if (request.method !== 'GET') return json(405, 'Method not allowed.');
        return Response.json(metadata, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (request.url !== resource.href) return json(404, 'Resource not found.');
      return transport.fetch(request);
    },
    async close() { closed = true; await transport.close(); },
  });
}
