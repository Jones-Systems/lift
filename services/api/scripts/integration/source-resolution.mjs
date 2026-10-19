import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sourceRoots = [
  fileURLToPath(new URL('../../src/', import.meta.url)),
  fileURLToPath(new URL('../../../../apps/form/src/', import.meta.url)),
];

function contains(root, path) {
  const suffix = relative(root, path);
  return suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

function regularSource(root, path) {
  if (realpathSync(root) !== root) throw new Error('Test source resolver refuses symlink roots');
  const parts = relative(root, path).split(sep);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Test source resolver refuses symlinks');
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
  }
  return true;
}

export function createSourceResolver(roots = sourceRoots) {
  const allowed = roots.map(root => resolve(root));
  return function resolveSource(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (original) {
      if (original.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL ||
          !/^(?:\.\/|\.\.\/).+\.js$/.test(specifier) || /[\\%?#]/.test(specifier)) throw original;
      const parent = new URL(context.parentURL);
      if (parent.protocol !== 'file:' || !parent.pathname.endsWith('.ts') || parent.search || parent.hash) throw original;
      const parentPath = fileURLToPath(parent);
      const root = allowed.find(candidate => contains(candidate, parentPath));
      if (!root || !regularSource(root, parentPath)) throw original;
      const target = fileURLToPath(new URL(specifier.slice(0, -3) + '.ts', parent));
      if (!contains(root, target) || !regularSource(root, target)) throw original;
      return nextResolve(pathToFileURL(target).href, context);
    }
  };
}
