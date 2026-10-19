import {readFile, mkdir, writeFile, readdir, lstat} from 'node:fs/promises';
import {resolve, join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {page} from './src/shell.mjs';
import {marketingPages} from './src/marketing.mjs';
import {editorialPages} from './src/editorial.mjs';
import {accountPages} from './src/account-page.mjs';
import {applicationPages} from './src/application-page.mjs';
import {memberPages} from './src/member-page.mjs';
import {journalPages} from './src/member-ecosystem/journal.mjs';
import {bodyPages} from './src/body-page.mjs';
import {variationPages} from './src/variations.mjs';
import {chooserPage} from './src/variation-kit.mjs';

export const root = dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const memberAssets = {
  'member-sample': ['sample-transport.mjs', 'sample-session.mjs', 'sample-entry.mjs', 'member-shell.mjs', 'member.css', 'privacy-flow.mjs'],
  'member-coach': ['coach-screen.mjs', 'coach.css'],
  'member-ecosystem': ['connections.mjs', 'connections.css', 'journal.mjs', 'journal.css'],
};
export function validateOutputPath(path) {
  if (typeof path !== 'string' || !/^[a-zA-Z0-9_/-]+\.(html|css|mjs|json|svg)$/.test(path) || path.split('/').some(x => !x || x.startsWith('.'))) throw new Error('Invalid output path');
  return path;
}
export function validateRuntime(config) {
  const keys = ['apiBase','verifiedBrowserOrigin','trackingEnabled','checkout','download'];
  if (!config || Object.keys(config).some(k => !keys.includes(k)) || keys.some(k => !(k in config)) || typeof config.trackingEnabled !== 'boolean') throw new Error('Malformed runtime configuration');
  // No provider has been accepted for this release. Config cannot activate a purchase route.
  if (config.checkout !== null || config.download !== null || config.apiBase !== null || config.verifiedBrowserOrigin !== null || config.trackingEnabled !== false) throw new Error('Integration requires a newly accepted runtime contract');
  return config;
}
export async function buildSite({output, sourceRoot = root} = {}) {
  const target = resolve(output ?? join(sourceRoot, 'build', `site-${Date.now()}-${randomUUID()}`));
  const config = validateRuntime(JSON.parse(await readFile(join(sourceRoot, 'config.json'), 'utf8')));
  const campaigns = JSON.parse(await readFile(join(sourceRoot, 'content/campaigns.json'), 'utf8'));
  const editorialRecords=await editorialPages({root: sourceRoot});
  const memberJournalRecords=await journalPages({root: sourceRoot});
  const marketingRecords=marketingPages(campaigns);
  const original=marketingRecords.find(record=>record.path==='index.html');
  const records = [
    ...marketingRecords.filter(record=>record.path!=='index.html'),
    {path:'original/index.html',html:original.html},
    {path:'index.html',html:chooserPage()},
    ...editorialRecords,
    ...variationPages({editorialRecords}),
    ...accountPages(),
    ...applicationPages(),
    ...memberPages(),
    ...memberJournalRecords,
    ...bodyPages(),
    {path: '404.html', html: page('Page not found', '<section class="container page-intro"><p class="eyebrow">404</p><h1>This path is not here.</h1><p>Choose a useful next step.</p><a class="button" href="/">Explore Form</a></section>')}
  ];
  const files = new Map();
  for (const record of records) {
    validateOutputPath(record.path);
    if (files.has(record.path) || typeof record.html !== 'string' || !/^<!doctype html>/i.test(record.html)) throw new Error(`Invalid or duplicate generated page: ${record.path}`);
    files.set(record.path, Buffer.from(record.html));
  }
  const publicNames = await readdir(join(sourceRoot, 'public'));
  if (Object.keys(memberAssets).some(name => !publicNames.includes(name))) throw new Error('Unsafe public asset');
  for (const name of publicNames) {
    const path = join(sourceRoot, 'public', name);
    if (Object.hasOwn(memberAssets, name)) {
      if (!(await lstat(path)).isDirectory()) throw new Error('Unsafe public asset');
      const names = await readdir(path), allowed = memberAssets[name];
      if (names.length !== allowed.length || names.some(asset => !allowed.includes(asset))) throw new Error('Unsafe public asset');
      for (const asset of names) {
        const assetPath = join(path, asset);
        if (!(await lstat(assetPath)).isFile()) throw new Error('Unsafe public asset');
        files.set(`assets/${name}/${asset}`, await readFile(assetPath));
      }
      continue;
    }
    if (name === 'voice') {
      if (!(await lstat(path)).isDirectory()) throw new Error('Unsafe public asset');
      const required = ['browser-voice-controller.mjs', 'mic-owner.mjs'];
      const allowed = [...required, 'browser-audio.mjs'];
      const names = (await readdir(path)).sort();
      if (required.some(asset => !names.includes(asset)) || names.some(asset => !allowed.includes(asset))) throw new Error('Unsafe public asset');
      for (const asset of names) {
        const assetPath = join(path, asset);
        if (!(await lstat(assetPath)).isFile()) throw new Error('Unsafe public asset');
        files.set(`assets/voice/${asset}`, await readFile(assetPath));
      }
      continue;
    }
    if (!(await lstat(path)).isFile() || !/^[a-zA-Z0-9_-]+\.(css|mjs|svg|ttf|txt)$/.test(name)) throw new Error('Unsafe public asset');
    files.set(`assets/${name}`, await readFile(path));
  }
  files.set('assets/runtime-config.json', Buffer.from(JSON.stringify(config)));
  files.set('robots.txt', Buffer.from('User-agent: *\nDisallow: /\n'));
  // A private review site is not a public acquisition rollout.
  await mkdir(dirname(target), {recursive:true});
  await mkdir(target, {recursive:false});
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(target,path)), {recursive:true});
    await writeFile(join(target,path), bytes, {flag:'wx'});
  }
  const manifest = Object.fromEntries([...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,bytes])=>[path,{bytes:bytes.length,sha256:digest(bytes)}]));
  const receipt = {schema:'form.website-build/v1', generatedAt:new Date().toISOString(), output:target, pages:records.length, files:manifest};
  await writeFile(`${target}.receipt.json`, JSON.stringify(receipt,null,2), {flag:'wx'});
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = await buildSite({output:process.argv[2]});
  console.log(JSON.stringify(receipt));
}
