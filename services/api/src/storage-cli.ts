import Database from 'better-sqlite3';
import { operateClosedStorage, type ClosedStorageInput } from './runtime-modules/storage-operations.js';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { initializeAuthority, prepareAdmission, type InitializeAuthorityInput, type PrepareAdmissionInput } from './runtime-modules/admission.js';
import { parseRuntimeModules, strictJson } from './runtime-modules/configuration.js';
import { backupAndVerify, integrity } from './storage.js';

const [action, source, destination, ...extra] = process.argv.slice(2);
if (action === 'authority-init' || action === 'prepare-admission' || action === 'runtime-storage') {
  if (!source || destination || extra.length) throw new Error('One strict JSON input is required');
  const input = strictJson(source) as InitializeAuthorityInput | PrepareAdmissionInput | ClosedStorageInput;
  if (!input || typeof input !== 'object') throw new Error('Object input required');
  parseRuntimeModules(input.configuration, true);
  if (action === 'authority-init') initializeAuthority(input as InitializeAuthorityInput);
  else if(action==='prepare-admission') prepareAdmission(input as PrepareAdmissionInput);
  else await operateClosedStorage(input as ClosedStorageInput);
  process.stdout.write(JSON.stringify({action, prepared:true, listener:false})+'\n');
} else {
if(extra.length) throw new Error('Unexpected arguments');
if (!source || !isAbsolute(source) || !existsSync(source) || !statSync(source).isFile() || realpathSync(source) !== resolve(source))
  throw new Error('An existing absolute regular non-symlink database is required');
if (!['check', 'backup'].includes(action ?? '') || (action === 'backup' && (!destination || !isAbsolute(destination))))
  throw new Error('Usage: storage-cli.js check DATABASE | backup DATABASE NEW_BACKUP');
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
  const version=db.prepare('SELECT MAX(version) version FROM form_migrations').get() as {version:number};
  if(version.version>7) throw new Error('Module storage requires exclusive runtime-storage custody');
  integrity(db);
  if (action === 'backup') await backupAndVerify(db, destination!);
  process.stdout.write(JSON.stringify({ action, verified: true }) + '\n');
} finally { db.close(); }

}
