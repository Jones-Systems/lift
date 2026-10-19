import { z } from 'zod';

const clientId = z.string().trim().min(1).max(512);
const clientSecret = z.string().min(1).max(8192);
export const socialProviderConfiguration = z.object({
  google: z.object({ clientId, clientSecret, disableSignUp: z.boolean().optional() }).strict().optional(),
  apple: z.object({ clientId, clientSecret, appBundleIdentifier: clientId.optional(), disableSignUp: z.boolean().optional() }).strict().optional(),
}).strict();

export const browserOrigin = z.string().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return !value.includes('*') && url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash && url.origin === value;
  } catch { return false; }
}, { message: 'Supply one exact HTTPS browser origin without a path, credentials, query, fragment or wildcard.' });
export const browserOriginsConfiguration = z.array(browserOrigin).max(20).refine(origins => new Set(origins).size === origins.length,
  { message: 'Browser origins must be unique.' });

export { runtimeModulesConfiguration, parseRuntimeModules } from './runtime-modules/configuration.js';
