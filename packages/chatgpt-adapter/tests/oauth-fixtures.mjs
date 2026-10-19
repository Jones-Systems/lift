import { FormAuthorizationError } from '../src/oauth-resource.mjs';
import { workout, plan } from './fixtures.mjs';

export const resourceUrl = 'https://form.example/mcp';
export const issuer = 'https://issuer.example/';
export const scopes = ['form:workouts:read', 'form:plans:read'];
export const expiresAtMs = 4102444800000;
export const listRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
export const callRequest = (name = 'form_get_workout', args = { workoutId: 'workout_1' }) =>
  ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
export function oauthRequest(body = listRequest, headers = {}, url = resourceUrl, method = 'POST') {
  return new Request(url, { method, headers: { host: 'form.example', authorization: 'Bearer synthetic-a',
    'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}
export async function wire(response) {
  const body = await response.text();
  return response.headers.get('content-type')?.includes('text/event-stream') ?
    body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).at(-1) : JSON.parse(body);
}

// Synthetic authority proves composition only; it is neither an OAuth provider nor a chosen lifetime policy.
export function oauthFixture(overrides = {}) {
  const state = { current: true, verifies: 0, binds: 0, admissions: 0, reads: 0, checks: 0, guards: [], seen: [] };
  const dependencies = {
    domain: {
      history(accountId) { state.reads++; return { items: [], nextCursor: null }; },
      session(accountId) { state.reads++; state.seen.push(accountId); state.afterRead?.(); return { ...workout(), privateHealth: 'SYNTHETIC_PRIVATE' }; },
      plan(accountId) { state.reads++; state.seen.push(accountId); return plan(); },
    },
    plansPage() { state.reads++; return { items: [plan()], hasMore: false }; },
    resolveAccount(subject) { return ({ 'form-auth-a': 'account_a', 'form-auth-b': 'account_b' })[subject] ?? null; },
    withActiveAccountRead(context, read) {
      state.guards.push('account-before');
      if (dependencies.resolveAccount(context.subject) !== context.accountId) throw new FormAuthorizationError('account_unavailable');
      const result = read(); state.guards.push('account-after'); return result;
    },
  };
  const options = { enabled: true, resourceUrl, issuer,
    authorizationServerMetadata: { issuer, authorization_endpoint: 'https://issuer.example/authorize',
      token_endpoint: 'https://issuer.example/token', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] },
    allowedHosts: ['form.example'], allowedOrigins: ['https://form.example'], dependencies,
    admitRequest() { state.admissions++; return true; },
    verifyAccessToken(token, expected) {
      state.verifies++;
      if (expected.issuer !== issuer || expected.resource !== resourceUrl || !['synthetic-a', 'synthetic-b'].includes(token)) {
        throw new FormAuthorizationError('invalid_token');
      }
      return { issuer, resource: resourceUrl, subject: `external|${token.at(-1)}`, clientId: 'synthetic-client',
        scopes: [...scopes], expiresAtMs, evidence: { synthetic: true } };
    },
    bindAuthorization(verified) {
      state.binds++;
      const key = verified.subject === 'external|a' ? 'a' : verified.subject === 'external|b' ? 'b' : null;
      if (!key) throw new FormAuthorizationError('invalid_token');
      return { formAuthUserId: `form-auth-${key}`, accountId: `account_${key}`, scopes: [...verified.scopes], expiresAtMs,
        assertCurrent() { state.checks++; return state.current; },
        withCurrentRead({ scope }, read) {
          state.guards.push('authority-before');
          if (!state.current) throw new FormAuthorizationError('invalid_token');
          if (!verified.scopes.includes(scope)) throw new FormAuthorizationError('insufficient_scope');
          const result = read();
          state.guards.push('authority-after');
          if (!state.current) throw new FormAuthorizationError('invalid_token');
          return result;
        },
      };
    }, ...overrides };
  return { state, options, dependencies };
}
