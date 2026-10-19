import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function canonicalPath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('Runtime path has no existing ancestor');
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function assertExternalRuntimeDatabase(dbPath: string, apiPackageRoot: string): void {
  if (!isAbsolute(dbPath)) throw new Error('Runtime database path must be absolute');
  const source = canonicalPath(apiPackageRoot);
  const database = canonicalPath(dbPath);
  if (contains(source, database)) throw new Error('Runtime database must be outside the API source');

  // Form's repository owns services/api. An unrelated HOME dotfiles repository is not the application checkout.
  const parent = dirname(source);
  if (basename(source) === 'api' && basename(parent) === 'services') {
    const checkout = dirname(parent);
    if (existsSync(resolve(checkout, '.git')) && contains(checkout, database)) {
      throw new Error('Runtime database must be outside the Git checkout');
    }
  }
}
