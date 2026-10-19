import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Canonical lifecycle guards also use .js specifiers. Resolution stays inside this API source tree.
const root=new URL('../../../src/',import.meta.url);
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL){
    const candidate=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
    if(candidate.href.startsWith(root.href)&&existsSync(fileURLToPath(candidate)))return nextResolve(candidate.href,context);
  }
  return nextResolve(specifier,context);
}});
