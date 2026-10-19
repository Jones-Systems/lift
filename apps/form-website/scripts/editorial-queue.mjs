import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryQueue, importQueue } from '../src/editorial-queue.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Local editorial queue (JSON output; no network or automatic approval)
  inventory
  import <site-id> <YYYY-MM-DD> <local-export.json> [local-export.json ...]
At most 20 exports per batch; 100 queue entries; 64 KiB per JSON file.
Guide: docs/website-acquisition/editorial-queue.md`;

export async function main(args) {
  const [command, ...values] = args;
  if (!command || command === 'help' || command === '--help') { console.log(usage); return; }
  let result;
  if (command === 'inventory' && values.length === 0) result = await inventoryQueue({ root });
  else if (command === 'import' && values.length >= 3) {
    const [siteId, created, ...files] = values;
    result = await importQueue({ root, siteId, created, files });
  } else throw new Error(usage);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, outcome: 'no-writes', error: error.message }));
    process.exitCode = 1;
  });
}
