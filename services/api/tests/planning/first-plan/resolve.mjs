import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const sourceRoot = new URL('../../../src/', import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (candidate.href.startsWith(sourceRoot.href) && existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  if (specifier === 'zod' && process.env.FORM_API_NODE_MODULES) {
    return nextResolve(pathToFileURL(resolve(process.env.FORM_API_NODE_MODULES, 'zod/index.js')).href, context);
  }
  return nextResolve(specifier, context);
} });
