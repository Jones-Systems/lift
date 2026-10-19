import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {root} from '../build.mjs';

test('local editorial CLI creates draft, requires rights/review, approves and invalidates edited content',async()=>{
 const fixture=await mkdtemp(join(root,'tests','.cli-'));
 try{
  for(const dir of ['src','scripts','content/articles'])await mkdir(join(fixture,dir),{recursive:true});
  for(const file of ['src/editorial.mjs','src/shell.mjs','scripts/editorial.mjs','content/editorial-sites.json'])await copyFile(join(root,file),join(fixture,file));
  const invoke=(...args)=>execFileSync(process.execPath,[join(fixture,'scripts/editorial.mjs'),...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const day='2026-10-09',slug='synthetic-cli-guide';
  assert.match(invoke('draft','everyday-longevity',slug,'Synthetic draft','Synthetic author',day),/Draft created/);
  assert.equal(JSON.parse(invoke('status',slug)).publishable,false);
  assert.throws(()=>invoke('approve',slug,'Synthetic approver',day,'source-author-editorial'));
  assert.throws(()=>invoke('review',slug,'Synthetic reviewer',day,'source-author-editorial'));
  const path=join(fixture,'content/articles',slug+'.json');
  const article=JSON.parse(await readFile(path,'utf8'));article.rights={status:'original',statement:'Synthetic fixture owns its original words.'};
  await writeFile(path,JSON.stringify(article));
  assert.match(invoke('review',slug,'Synthetic reviewer',day,'source-author-editorial'),/reviewed/);
  assert.match(invoke('approve',slug,'Synthetic approver',day,'source-author-editorial'),/approved/);
  assert.equal(JSON.parse(invoke('status',slug)).publishable,true);
  const edited=JSON.parse(await readFile(path,'utf8'));edited.sections[0].paragraphs[0]+=' Synthetic edit.';await writeFile(path,JSON.stringify(edited));
  assert.equal(JSON.parse(invoke('status',slug)).publishable,false);
  assert.throws(()=>invoke('draft','unknown-site','other','Synthetic','Synthetic',day));
  assert.ok(!(await readdir(join(fixture,'content/articles'))).some(x=>x.startsWith('.editorial-')));
 }finally{await rm(fixture,{recursive:true,force:true});}
});

test('local editorial preview CLI emits only HTML, binds script root and leaves all fixture files unchanged',async t=>{
 const fixture=await mkdtemp(join(root,'tests','.cli-preview-'));
 t.after(async()=>{
  await rm(fixture,{recursive:true,force:true});
  await assert.rejects(readdir(fixture),{code:'ENOENT'});
 });
 for(const dir of ['src','scripts','content/articles','elsewhere'])await mkdir(join(fixture,dir),{recursive:true});
 for(const file of ['src/editorial.mjs','src/shell.mjs','scripts/editorial.mjs','content/editorial-sites.json'])await copyFile(join(root,file),join(fixture,file));
 const invoke=(...args)=>spawnSync(process.execPath,[join(fixture,'scripts/editorial.mjs'),...args],{cwd:join(fixture,'elsewhere'),encoding:'utf8'});
 assert.equal(invoke('draft','everyday-longevity','preview-draft','<b>Synthetic</b>','Fixture author','2026-10-09').status,0);
 const snapshot=async()=>{
  const files=(await readdir(fixture,{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile());
  const result=[];
  for(const file of files){const path=join(file.parentPath,file.name);result.push([path,await readFile(path,'utf8')]);}
  return result.sort(([a],[b])=>a.localeCompare(b));
 };
 const before=await snapshot();
 const preview=invoke('preview','preview-draft');
 assert.equal(preview.status,0,preview.stderr);
 assert.equal(preview.stderr,'');
 assert.match(preview.stdout,/^<!DOCTYPE html>/);
 assert.match(preview.stdout,/LOCAL EDITORIAL PREVIEW \/ NOT PUBLISHED/);
 assert.match(preview.stdout,/&lt;b&gt;Synthetic&lt;\/b&gt;/);
 assert.match(preview.stdout,/Lifecycle: draft · Rights: pending/);
 assert.deepEqual(await snapshot(),before);
 assert.deepEqual(await readdir(join(fixture,'elsewhere')),[]);
 const articles=join(fixture,'content/articles');
 for(const args of [['preview','../../outside'],['preview','missing'],['preview','preview-draft','--output=preview.html']]){
  const result=invoke(...args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.ok(result.stderr);
 }
 const path=join(articles,'preview-draft.json');
 const draft=JSON.parse(await readFile(path,'utf8'));draft.siteId='unknown-site';await writeFile(path,JSON.stringify(draft));
 const invalid=invoke('preview','preview-draft');assert.equal(invalid.status,1);assert.equal(invalid.stdout,'');assert.match(invalid.stderr,/mismatch/);
 assert.deepEqual(await readdir(articles),['preview-draft.json']);
});
