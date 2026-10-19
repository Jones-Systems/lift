import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Test-only resolution: source uses compiler-compatible .js specifiers; Node 24 strips .ts in memory.
registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const candidate = new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
    if (candidate.protocol === 'file:' && candidate.pathname.includes('/wearables/') && existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href,context);
  }
  return nextResolve(specifier, context);
}});
