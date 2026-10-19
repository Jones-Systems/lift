import { registerHooks } from 'node:module';

const api = new URL('../../', import.meta.url);
const sourcePrefix = new URL('src/', api).href;
const testPrefix = new URL('tests/training-feedback/', api).href;
const donorAnchor = 'file:///path/to/Form';

if (process.versions.node !== '24.19.0' || typeof registerHooks !== 'function')
  throw new Error('Feedback donor qualification requires verified Node 24.19.0 registerHooks');

registerHooks({ resolve(specifier, context, nextResolve) {
  if ((context.parentURL?.startsWith(sourcePrefix) || context.parentURL?.startsWith(testPrefix)) &&
      (specifier === 'better-sqlite3' || specifier === 'zod')) return nextResolve(specifier, { ...context, parentURL: donorAnchor });
  return nextResolve(specifier, context);
} });
