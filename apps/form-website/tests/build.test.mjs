import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,mkdir,writeFile,cp,symlink,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildSite,validateOutputPath,validateRuntime,root} from '../build.mjs';

test('runtime cannot accidentally activate providers, tracking or unaccepted account endpoints',()=>{
 const base={apiBase:null,verifiedBrowserOrigin:null,trackingEnabled:false,checkout:null,download:null};
 assert.deepEqual(validateRuntime(base),base);
 for(const change of [{apiBase:'https://api.example'},{trackingEnabled:true},{checkout:{url:'https://pay.example'}},{download:'https://app.example'},{extra:'unknown'}])assert.throws(()=>validateRuntime({...base,...change}));
 for(const path of ['../leak.html','/absolute.html','foo//index.html','.git/config','assets/source.ts','assets/private.json/../index.html'])assert.throws(()=>validateOutputPath(path));
 assert.equal(validateOutputPath('journal/first-steps/index.html'),'journal/first-steps/index.html');
});
test('required voice assets and only the approved optional audio asset can cross the public directory boundary',async t=>{
 const fixture=await mkdtemp(join(tmpdir(),'form-web-build-voice-'));
 try{
  const sourceRoot=join(fixture,'source'),voice=join(sourceRoot,'public','voice');
  await mkdir(sourceRoot);
  for(const name of ['config.json','content','public'])await cp(join(root,name),join(sourceRoot,name),{recursive:true});
  await rm(voice,{recursive:true,force:true});
  await mkdir(voice);
  const assets=['browser-voice-controller.mjs','mic-owner.mjs'];
  const payload='export const unavailable = true;\n';
  for(const name of assets)await writeFile(join(voice,name),payload);
  const receipt=await buildSite({sourceRoot,output:join(fixture,'accepted')});
  for(const name of assets){
   assert.equal(await readFile(join(receipt.output,'assets','voice',name),'utf8'),payload);
   assert.equal(receipt.files[`assets/voice/${name}`].bytes,Buffer.byteLength(payload));
  }
  assert.equal(receipt.files['assets/voice/browser-audio.mjs'],undefined);
  const audio='browser-audio.mjs',audioPayload="import './mic-owner.mjs';\nexport const audioUnavailable = true;\n";
  await writeFile(join(voice,audio),audioPayload);
  const withAudio=await buildSite({sourceRoot,output:join(fixture,'accepted-audio')});
  for(const name of [...assets,audio]){
   const expected=name===audio?audioPayload:payload;
   assert.equal(await readFile(join(withAudio.output,'assets','voice',name),'utf8'),expected);
   assert.equal(withAudio.files[`assets/voice/${name}`].bytes,Buffer.byteLength(expected));
  }
  const cases=[
   ['unexpected public directory',()=>mkdir(join(sourceRoot,'public','other')),()=>rm(join(sourceRoot,'public','other'),{recursive:true})],
   ['unexpected sample module',()=>writeFile(join(sourceRoot,'public','member-sample','extra.mjs'),payload),()=>rm(join(sourceRoot,'public','member-sample','extra.mjs'))],
   ['unexpected coach module',()=>writeFile(join(sourceRoot,'public','member-coach','extra.mjs'),payload),()=>rm(join(sourceRoot,'public','member-coach','extra.mjs'))],
   ['unexpected ecosystem module',()=>writeFile(join(sourceRoot,'public','member-ecosystem','extra.mjs'),payload),()=>rm(join(sourceRoot,'public','member-ecosystem','extra.mjs'))],
   ['missing sample asset',async()=>{await rm(join(sourceRoot,'public','member-sample','sample-entry.mjs'));},async()=>{await cp(join(root,'public','member-sample','sample-entry.mjs'),join(sourceRoot,'public','member-sample','sample-entry.mjs'));}],
   ['nested member asset',async()=>{await rm(join(sourceRoot,'public','member-sample','sample-entry.mjs'));await mkdir(join(sourceRoot,'public','member-sample','sample-entry.mjs'));},async()=>{await rm(join(sourceRoot,'public','member-sample','sample-entry.mjs'),{recursive:true});await cp(join(root,'public','member-sample','sample-entry.mjs'),join(sourceRoot,'public','member-sample','sample-entry.mjs'));}],
   ['symlink member asset',async()=>{await rm(join(sourceRoot,'public','member-sample','sample-entry.mjs'));await symlink(join(sourceRoot,'public','member-sample','sample-session.mjs'),join(sourceRoot,'public','member-sample','sample-entry.mjs'));},async()=>{await rm(join(sourceRoot,'public','member-sample','sample-entry.mjs'));await cp(join(root,'public','member-sample','sample-entry.mjs'),join(sourceRoot,'public','member-sample','sample-entry.mjs'));}],
   ['extra voice file',()=>writeFile(join(voice,'extra.mjs'),payload),()=>rm(join(voice,'extra.mjs'))],
   ['missing voice file',()=>rm(join(voice,assets[0])),()=>writeFile(join(voice,assets[0]),payload)],
   ['nested voice directory',async()=>{await rm(join(voice,assets[0]));await mkdir(join(voice,assets[0]));},async()=>{await rm(join(voice,assets[0]),{recursive:true});await writeFile(join(voice,assets[0]),payload);}],
   ['symlink voice file',async()=>{await rm(join(voice,assets[0]));await symlink(join(voice,assets[1]),join(voice,assets[0]));},async()=>{await rm(join(voice,assets[0]));await writeFile(join(voice,assets[0]),payload);}],
   ['nested optional audio asset',async()=>{await rm(join(voice,audio));await mkdir(join(voice,audio));},async()=>{await rm(join(voice,audio),{recursive:true});await writeFile(join(voice,audio),audioPayload);}],
   ['symlink optional audio asset',async()=>{await rm(join(voice,audio));await symlink(join(voice,assets[1]),join(voice,audio));},async()=>{await rm(join(voice,audio));await writeFile(join(voice,audio),audioPayload);}],
   ['symlink voice directory',async()=>{await rm(voice,{recursive:true});await symlink(join(fixture,'accepted','assets','voice'),voice);},()=>rm(voice)]
  ];
  for(const [name,prepare,restore] of cases)await t.test(name,async()=>{
   const output=join(fixture,'rejected');
   await prepare();
   try{
    await assert.rejects(()=>buildSite({sourceRoot,output}),/Unsafe public asset/);
    await assert.rejects(()=>access(output),{code:'ENOENT'});
    await assert.rejects(()=>access(`${output}.receipt.json`),{code:'ENOENT'});
   }finally{await restore();}
  });
 }finally{await rm(fixture,{recursive:true,force:true});}
});
test('generated route graph contains real content with no missing local links or unexpected private files',async()=>{
 const fixture=await mkdtemp(join(tmpdir(),'form-web-build-'));
 try{
  const receipt=await buildSite({output:join(fixture,'site')});
  assert.ok(receipt.pages>=20);
  const files=new Set(Object.keys(receipt.files));
  for(const route of ['app/index.html','assets/application-ui.mjs','assets/application-entry.mjs','assets/application.css',...['daily','session','guided','guide'].map(id=>`variations/${id}/index.html`)]) assert.ok(files.has(route),route);
  const application=await readFile(join(receipt.output,'app/index.html'),'utf8');
  assert.ok(application.includes('/assets/variant-session.css'));
  assert.ok(application.includes('/assets/application-entry.mjs'));
  assert.ok(!application.includes('type="password"'));
  for(const route of ['index.html','use-cases/index.html','account/index.html','privacy/index.html','body-preview/index.html','journal/index.html','editorial/index.html','campaigns/weight-loss/index.html','campaigns/after-illness/index.html','campaigns/clinician-cleared-injury/index.html','404.html'])assert.ok(files.has(route),route);
  assert.ok(![...files].some(x=>x.startsWith('.')||x.includes('sources/')||x.includes('tests/')||x.endsWith('.ts')));
  for(const file of [...files].filter(x=>x.endsWith('.html'))){
   const html=await readFile(join(receipt.output,file),'utf8');
   for(const [,href]of html.matchAll(/(?:href|src)="([^"#]*)"/g)){
    if(!href.startsWith('/'))continue;
    const clean=href.split(/[?#]/)[0];
    const target=clean.slice(1)+(clean.endsWith('/')?'index.html':'');
    assert.ok(files.has(target),`${file} links to missing ${href}`);
   }
   assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html),`${file} inline script`);
   assert.ok(!/<input[^>]*type="file"/i.test(html));
  }
  await assert.rejects(()=>buildSite({output:receipt.output}),/EEXIST/);
 }finally{await rm(fixture,{recursive:true,force:true});}
});
