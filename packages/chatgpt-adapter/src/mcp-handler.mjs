import { createMcpHandler, McpServer, fromJsonSchema, readRequestBody, validateHostHeader, requireScopes } from '@modelcontextprotocol/server';
import { createFormAdapter, toolDescriptors } from './index.mjs';
import { identitySnapshot } from './identity.mjs';
import { definitions } from './schemas.mjs';

export const mcpToolDescriptors = Object.freeze(toolDescriptors.map((descriptor, index) => {
  const scopes = Object.freeze(definitions[index].scope ? [definitions[index].scope] : []);
  const securitySchemes = Object.freeze([Object.freeze({ type: 'oauth2', scopes })]);
  return Object.freeze({ ...descriptor, securitySchemes, _meta: Object.freeze({ securitySchemes }) });
}));

const response = (status, message) => Response.json({ error: message }, {
  status, headers: { 'Cache-Control': 'no-store' },
});

function authenticationDenial(denial) {
  const auth = denial?.authentication;
  if (!(denial?.response instanceof Response) || !auth ||
      !['invalid_token', 'insufficient_scope'].includes(auth.code) ||
      denial.response.status !== (auth.code === 'invalid_token' ? 401 : 403) ||
      typeof auth.challenge !== 'string' || auth.challenge.length > 4096 ||
      auth.challenge !== denial.response.headers.get('www-authenticate')) return null;
  return Object.freeze({ code: auth.code, challenge: auth.challenge });
}

function suppressedToolResult(authentication) {
  const code = !authentication ? 'unavailable' : authentication.code === 'invalid_token' ? 'authentication_required' : 'permission_denied';
  const message = !authentication ? 'Form read is unavailable.' : 'Current Form authorization is required.';
  return { isError: true, content: [{ type: 'text', text: message }],
    structuredContent: { ok: false, error: { code, message } },
    ...(authentication ? { _meta: { 'mcp/www_authenticate': [authentication.challenge] } } : {}) };
}

async function boundedResponse(result) {
  if (!result.body) return result;
  const reader = result.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024) throw new Error('Response too large');
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally { reader.releaseLock(); }
  return new Response(new Blob(chunks), { status: result.status, headers: result.headers });
}

/**
 * Source-only fetch seam; does not listen or register OAuth. verifyRequest must
 * verify issuer, audience, expiry and granted scopes, map the subject to an
 * existing Form account, and return server-owned identity. MCP metadata is never
 * identity. Alternatively, authorizeRequest supplies a trusted request-local
 * authorization context, including a final disclosure guard. Never populate
 * either callback from model input. admitRequest supplies host admission policy.
 */
export function createFormMcpHandler({ enabled = false, verifyRequest, authorizeRequest, admitRequest, ports = {},
  allowedHosts = [], allowedOrigins = [], now = Date.now } = {}) {
  const hosts = [...allowedHosts];
  const origins = [...allowedOrigins];
  const configured = enabled === true &&
    ((typeof verifyRequest === 'function' && authorizeRequest === undefined) ||
     (typeof authorizeRequest === 'function' && verifyRequest === undefined)) &&
    typeof admitRequest === 'function' && hosts.length > 0 && hosts.length <= 10 && origins.length <= 10 &&
    hosts.every(host => typeof host === 'string' && host.length <= 253 && !host.includes('*')) &&
    origins.every(origin => typeof origin === 'string' && origin.length <= 512 && !origin.includes('*'));
  let closed = false;
  let inFlight = 0;
  const active = new Set();

  async function fetch(request) {
    if (!configured || closed) return response(503, 'Form MCP is unavailable.');
    if (!(request instanceof Request) || request.url.length > 2048 ||
        (request.headers.get('authorization')?.length ?? 0) > 8192) return response(400, 'Invalid request.');
    if (!validateHostHeader(request.headers.get('host'), hosts).ok ||
        !hosts.includes(new URL(request.url).hostname)) return response(403, 'Request origin is not allowed.');
    const origin = request.headers.get('origin');
    if (origin !== null && !origins.includes(origin)) return response(403, 'Request origin is not allowed.');
    if (!['POST', 'GET', 'DELETE'].includes(request.method)) return response(405, 'Method not allowed.');
    if (request.headers.get('mcp-method') === 'subscriptions/listen') return response(405, 'Method not allowed.');
    if (inFlight >= 8) return response(429, 'Form MCP is busy.');
    inFlight++;
    let handler;
    let cleanup;
    try {
      if (await admitRequest(request) !== true) return response(429, 'Form MCP is busy.');
      let identity, context, suppressedAuthentication;
      try {
        if (authorizeRequest) {
          context = await authorizeRequest(request);
          if (context instanceof Response) { context.headers.set('Cache-Control', 'no-store'); return context; }
          if (!context || typeof context.checkCurrent !== 'function' || !context.ports || !context.authInfo) {
            return response(503, 'Form MCP is unavailable.');
          }
        }
        identity = identitySnapshot(context ? context.identity : await verifyRequest(request), now());
      }
      catch { return response(401, 'A current verified Form identity is required.'); }
      if (closed || request.signal.aborted) return response(503, 'Form MCP is unavailable.');
      let sdkRequest = request;
      if (request.method === 'POST') {
        const body = await readRequestBody(request, 16 * 1024);
        if (body.tooLarge) return response(413, 'Request body is too large.');
        let parsed;
        try { parsed = JSON.parse(body.text); } catch {}
        // One admitted HTTP request may dispatch at most one tool read. The
        // SDK's legacy batch fallback otherwise admits up to 100 messages.
        if (Array.isArray(parsed)) return Response.json({
          jsonrpc: '2.0', id: null,
          error: { code: -32600, message: 'Form requires one JSON-RPC message per POST.' },
        }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
        sdkRequest = new Request(request, { body: body.text, headers: request.headers, signal: request.signal });
      }
      if (closed || request.signal.aborted) return response(503, 'Form MCP is unavailable.');
      const adapter = createFormAdapter({ ports: context?.ports ?? ports, now, verifyIdentity: () => identity });
      handler = createMcpHandler(() => {
        const server = new McpServer({ name: 'form-read-tools', version: '0.2.0' }, { capabilities: { tools: { listChanged: false } } });
        for (const descriptor of mcpToolDescriptors) {
          server.registerTool(descriptor.name, {
            title: descriptor.title, description: descriptor.description,
            inputSchema: fromJsonSchema(descriptor.inputSchema),
            outputSchema: fromJsonSchema(descriptor.outputSchema),
            annotations: descriptor.annotations, _meta: descriptor._meta,
            ...(context && descriptor.securitySchemes[0].scopes.length ?
              { scopeChallenge: requireScopes(...descriptor.securitySchemes[0].scopes) } : {}),
          }, async args => {
            const result = await adapter.dispatch(descriptor.name, args);
            if (context) {
              const denial = await context.checkCurrent();
              if (denial !== null) {
                suppressedAuthentication = authenticationDenial(denial);
                return suppressedToolResult(suppressedAuthentication);
              }
            }
            return { ...result, content: [{ type: 'text', text: JSON.stringify(result.structuredContent) }] };
          });
        }
        // The public custom-handler seam preserves OpenAI's top-level extension;
        // registerTool's config accepts only the compatibility _meta mirror.
        server.server.setRequestHandler('tools/list', () => ({ tools: mcpToolDescriptors }));
        return server;
      }, { legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: 16 * 1024, maxSubscriptions: 0 });
      let closing;
      cleanup = () => closing ??= handler.close().catch(() => {});
      active.add(cleanup);
      // Legacy stateless replies can be finite SSE; retain admission until the
      // complete response is consumed, and never expose a long-lived stream.
      const result = await boundedResponse(await handler.fetch(sdkRequest, context ? { authInfo: context.authInfo } : undefined));
      if (closed || request.signal.aborted) return response(503, 'Form MCP is unavailable.');
      if (context) {
        const denial = await context.checkCurrent();
        if (denial !== null) {
          const current = authenticationDenial(denial);
          // Only the SDK-serialized, fixed auth error may survive a matching denial;
          // successful tool content always requires current authority at disclosure.
          if (!suppressedAuthentication || !current || current.code !== suppressedAuthentication.code ||
              current.challenge !== suppressedAuthentication.challenge) {
            if (!(denial?.response instanceof Response)) return response(503, 'Form MCP is unavailable.');
            denial.response.headers.set('Cache-Control', 'no-store'); return denial.response;
          }
        } else if (suppressedAuthentication) return response(503, 'Form MCP is unavailable.');
      }
      if (closed || request.signal.aborted) return response(503, 'Form MCP is unavailable.');
      result.headers.set('Cache-Control', 'no-store');
      return result;
    } catch { return response(503, 'Form MCP is unavailable.'); }
    finally {
      if (cleanup) {
        await cleanup();
        active.delete(cleanup);
      }
      inFlight--;
    }
  }
  async function close() {
    closed = true;
    await Promise.allSettled([...active].map(cleanup => cleanup()));
  }
  return Object.freeze({ fetch, close });
}
