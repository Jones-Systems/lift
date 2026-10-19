import { startListener } from './runtime-modules/composition.js';
import { RuntimeOwner } from './runtime-modules/admission.js';
import { parseRuntimeModules, strictJson } from './runtime-modules/configuration.js';
import { serve } from '@hono/node-server';
import { isAbsolute } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { z } from 'zod';
import { registration, promoDefinition } from './schemas.js';
import { browserOriginsConfiguration, socialProviderConfiguration } from './configuration.js';
import { phoneConfiguration } from './phone/index.js';
import { validateAppleConfiguration } from './purchases/index.js';
import { assertExternalRuntimeDatabase } from './runtime-path.js';

const dbPath = process.env.FORM_DATABASE_PATH;
const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.FORM_BASE_URL;
if (!dbPath || !isAbsolute(dbPath) || !secret || !baseURL) throw new Error('FORM_DATABASE_PATH, FORM_BASE_URL and BETTER_AUTH_SECRET are required');
if(secret.length<32) throw new Error('Auth secret must have at least32 characters');
const parsedBaseURL=new URL(baseURL);
if(!['http:','https:'].includes(parsedBaseURL.protocol)||parsedBaseURL.username||parsedBaseURL.password||parsedBaseURL.pathname!=='/'||parsedBaseURL.search||parsedBaseURL.hash) throw new Error('Exact base origin required');
assertExternalRuntimeDatabase(dbPath, resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const hostname = process.env.FORM_HOST ?? '127.0.0.1';
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.FORM_PORT ?? '8766');
function jsonConfiguration(name: string, fallback: unknown): unknown {
  const value = process.env[name]; if (value === undefined) return fallback;
  if (value.length > 64 * 1024) throw new Error(`Oversized ${name} configuration`);
  try { return strictJson(value); } catch { throw new Error(`Invalid ${name} configuration`); }
}
const registrationConfig = registration.parse(jsonConfiguration('FORM_REGISTRATION', { mode: 'closed' }));
const promos = z.array(promoDefinition).max(100).parse(jsonConfiguration('FORM_PROMOS', []));
const socialProviders = socialProviderConfiguration.parse(jsonConfiguration('FORM_SOCIAL_PROVIDERS', {}));
const grok = process.env.FORM_GROK_STT_ENABLED === 'true' ? {
  apiKey: z.string().min(1).max(8192).parse(process.env.FORM_GROK_STT_KEY), allowCloudRequests: true as const,
} : undefined;
const trustedOrigins = browserOriginsConfiguration.parse(jsonConfiguration('FORM_BROWSER_ORIGINS', []));
const phoneInput = jsonConfiguration('FORM_PHONE', undefined);
const phone = phoneInput === undefined ? undefined : phoneConfiguration.parse(phoneInput);
const appleInput = jsonConfiguration('FORM_APPLE_PURCHASES', undefined);
const applePurchases = appleInput === undefined ? undefined : validateAppleConfiguration(appleInput);
const modules = parseRuntimeModules(jsonConfiguration('FORM_RUNTIME_MODULES', undefined), true);
if (modules && (modules.authorityDirectory === resolve(dirname(fileURLToPath(import.meta.url)), '../..') ||
  modules.authorityDirectory.startsWith(resolve(dirname(fileURLToPath(import.meta.url)), '../..') + '/'))) throw new Error('Authority must be outside deployment source');
const owner = modules ? new RuntimeOwner(modules, dbPath) : undefined;
let server: Awaited<ReturnType<typeof createServer>>;
try { server = await createServer({ dbPath, secret, baseURL, ...(owner ? {runtimeOwner:owner} : {}), registration: registrationConfig, promos, trustedOrigins, socialProviders: {
  ...(socialProviders.google ? { google: socialProviders.google } : {}),
  ...(socialProviders.apple ? { apple: socialProviders.apple } : {}),
}, ...(grok ? { grok } : {}), ...(phone ? { phone } : {}), ...(applePurchases ? { applePurchases } : {}) });
 } catch(error) { owner?.close(false); throw error; }
let listener: ReturnType<typeof serve>;
try { listener = await startListener(server,()=>serve({ hostname, port, fetch: (request, env) => {
  return server.handleRequest(request, env.incoming.socket.remoteAddress ?? 'unknown');
} })); } catch(error) { throw error; }
listener.on('error', () => { try { server.close(false); } finally { process.exitCode=1; console.error('Form listener failed'); } });
let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  listener.close(() => { void Promise.resolve().then(()=>server.close()).catch(() => { process.exitCode=1; console.error('Form clean shutdown failed'); }); });
  if ('closeIdleConnections' in listener) listener.closeIdleConnections();
  setTimeout(() => { if ('closeAllConnections' in listener) listener.closeAllConnections(); }, 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
