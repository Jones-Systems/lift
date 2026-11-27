import { parseRuntimeModules, strictJson } from './runtime-modules/configuration.js';
import { assertSeparate } from './runtime-modules/files.js';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registration, promoDefinition } from './schemas.js';
import { browserOriginsConfiguration, socialProviderConfiguration } from './configuration.js';
import { phoneConfiguration } from './phone/provider.js';
import { validateAppleConfiguration } from './purchases/configuration.js';
import { assertExternalRuntimeDatabase } from './runtime-path.js';

function jsonConfiguration(name: string, fallback: unknown): unknown {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value.length > 64 * 1024) throw new Error(`Oversized ${name} configuration`);
  try { return strictJson(value); } catch { throw new Error(`Invalid ${name} configuration`); }
}

function readStartupConfiguration() {
  const dbPath = process.env.FORM_DATABASE_PATH;
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.FORM_BASE_URL;
  if (!dbPath || !isAbsolute(dbPath) || !secret || !baseURL) throw new Error('FORM_DATABASE_PATH, FORM_BASE_URL and BETTER_AUTH_SECRET are required');
  if (secret.length < 32) throw new Error('Auth secret must have at least32 characters');
  const parsedBaseURL = new URL(baseURL);
  if (!['http:', 'https:'].includes(parsedBaseURL.protocol) || parsedBaseURL.username || parsedBaseURL.password ||
    parsedBaseURL.pathname !== '/' || parsedBaseURL.search || parsedBaseURL.hash) throw new Error('Exact base origin required');
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  assertExternalRuntimeDatabase(dbPath, sourceRoot);
  const hostname = process.env.FORM_HOST ?? '127.0.0.1';
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.FORM_PORT ?? '8766');
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
  if (modules) {
    if (modules.authorityDirectory === sourceRoot || modules.authorityDirectory.startsWith(sourceRoot + '/'))
      throw new Error('Authority must be outside deployment source');
    assertSeparate(modules.authorityDirectory, dbPath);
  }
  return { dbPath, secret, baseURL, hostname, port, registrationConfig, promos, socialProviders, grok, trustedOrigins, phone, applePurchases, modules };
}

async function start(): Promise<void> {
  const { startListener } = await import('./runtime-modules/composition.js');
  const { RuntimeOwner } = await import('./runtime-modules/admission.js');
  const { serve } = await import('@hono/node-server');
  const { createServer } = await import('./server.js');
  const { dbPath, secret, baseURL, hostname, port, registrationConfig, promos, socialProviders,
    grok, trustedOrigins, phone, applePurchases, modules } = readStartupConfiguration();

  const owner = modules ? new RuntimeOwner(modules, dbPath) : undefined;
  let server: Awaited<ReturnType<typeof createServer>>;
  try {
    server = await createServer({ dbPath, secret, baseURL, ...(owner ? { runtimeOwner: owner } : {}),
      registration: registrationConfig, promos, trustedOrigins, socialProviders: {
        ...(socialProviders.google ? { google: socialProviders.google } : {}),
        ...(socialProviders.apple ? { apple: socialProviders.apple } : {}),
      }, ...(grok ? { grok } : {}), ...(phone ? { phone } : {}), ...(applePurchases ? { applePurchases } : {}) });
  } catch (error) {
    owner?.close(false);
    throw error;
  }
  const listener = await startListener(server, () => serve({ hostname, port, fetch: (request, env) => {
    return server.handleRequest(request, env.incoming.socket.remoteAddress ?? 'unknown');
  } }));
  listener.on('error', () => { try { server.close(false); } finally { process.exitCode = 1; console.error('Form listener failed'); } });
  let stopping = false;
  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    listener.close(() => { void Promise.resolve().then(() => server.close()).catch(() => { process.exitCode = 1; console.error('Form clean shutdown failed'); }); });
    if ('closeIdleConnections' in listener) listener.closeIdleConnections();
    setTimeout(() => { if ('closeAllConnections' in listener) listener.closeAllConnections(); }, 5000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  await start();
} else if (args.length === 1 && args[0] === '--check-config') {
  try {
    const config = readStartupConfiguration();
    process.stdout.write(JSON.stringify({
      check: 'startup-config-preflight',
      valid: true,
      registration: config.registrationConfig.mode,
      runtimeModulesConfigured: config.modules !== undefined,
      promosConfigured: config.promos.length > 0,
      browserOriginsConfigured: config.trustedOrigins.length > 0,
      googleConfigured: config.socialProviders.google !== undefined,
      appleSignInConfigured: config.socialProviders.apple !== undefined,
      grokTranscriptionConfigured: config.grok !== undefined,
      phoneConfigured: config.phone !== undefined,
      applePurchasesConfigured: config.applePurchases !== undefined,
    }) + '\n');
  } catch {
    process.stderr.write('Form startup config preflight failed\n');
    process.exitCode = 1;
  }
} else {
  process.stderr.write('Usage: cli.js [--check-config]\n');
  process.exitCode = 1;
}
