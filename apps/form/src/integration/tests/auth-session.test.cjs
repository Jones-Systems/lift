const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'../..'),cache=new Map();
function load(file){
 file=path.resolve(root,file);assert.ok(file.startsWith(root+path.sep));
 if(cache.has(file))return cache.get(file).exports;
 const m={exports:{}};cache.set(file,m);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(name=>{assert.ok(name.startsWith('.'));return load(path.relative(root,path.resolve(path.dirname(file),name+'.ts')))},m,m.exports);return m.exports;
}
const {createAuthSession}=load('integration/authSession.ts');
const {FormTransport}=load('api/transport.ts');
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}};
function fixture(){
 const response=deferred(),calls=[],storage={value:null,async save(v){this.value=v},async clear(){this.value=null},async load(){return this.value}};
 const api=new FormTransport('http://127.0.0.1:8766',storage,async(url,init)=>{calls.push({url,init});if(url.endsWith('/sign-out'))return new Response(JSON.stringify({success:true}));return response.promise});
 return{api,response,calls,storage};
}
test('inert auth scope does not dispatch until activated',async()=>{
 const f=fixture(),auth=createAuthSession(f.api);
 await assert.rejects(auth.signIn('owner@example.invalid','password'),{code:'session_changed'});
 assert.equal(f.calls.length,0);
});
test('route departure rejects late email session before storage and revokes only issued token',async()=>{
 const f=fixture(),auth=createAuthSession(f.api);auth.activate();
 const pending=auth.signIn('owner@example.invalid','password');
 auth.invalidate();
 f.response.resolve(new Response(JSON.stringify({user:{id:'synthetic'}}),{headers:{'set-auth-token':'synthetic-issued-old'}}));
 await assert.rejects(pending,{code:'session_changed'});
 assert.equal(f.storage.value,null);
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[1].init.headers.Authorization,'Bearer synthetic-issued-old');
 assert.equal(f.calls[1].url.endsWith('/sign-out'),true);
});
test('mount cleanup/setup never revives old signup guard',async()=>{
 const seen=[],wait=deferred(),api={signUp:(_n,_e,_p,g)=>{seen.push(g);return wait.promise}};
 const auth=createAuthSession(api);auth.activate();
 const pending=auth.signUp('Owner','owner@example.invalid','password');
 auth.deactivate();auth.activate();
 assert.equal(seen[0].isCurrent(),false);
 wait.resolve({status:true});await assert.rejects(pending,{code:'session_changed',originalEffectUnknown:true});
 assert.equal(auth.isActive(),true);
});
test('native provider receives lifecycle fence and cannot dispatch auth after background',async()=>{
 const f=fixture(),credential=deferred();
 const auth=createAuthSession(f.api,{apple:async guard=>{await credential.promise;return f.api.signInIdentity('apple',{token:'synthetic'},guard)}});
 auth.activate();const pending=auth.identity('apple');auth.deactivate();credential.resolve();
 await assert.rejects(pending,{code:'session_changed'});assert.equal(f.calls.length,0);
});
test('phone factory is lazy and disposed on navigation and background; next action uses fresh guard',async()=>{
 const fences=[],disposed=[],calls=[];
 const auth=createAuthSession({}, {phoneFactory:guard=>{
  const id=fences.length;fences.push(guard);
  return{async challenge(){calls.push(id);return{challengeId:String(id)}},async resend(){},async verify(){},dispose(){disposed.push(id)}};
 }});
 assert.equal(fences.length,0);auth.activate();
 await auth.phone.challenge('+12025550123','caller-key');
 auth.invalidate();assert.equal(fences[0].isCurrent(),false);assert.deepEqual(disposed,[0]);
 await auth.phone.challenge('+12025550123','new-key');assert.deepEqual(calls,[0,1]);
 auth.deactivate();assert.equal(fences[1].isCurrent(),false);assert.deepEqual(disposed,[0,1]);
});
test('unknown remote effects are preserved on stale phone callbacks and never auto-replayed',async()=>{
 const wait=deferred();let count=0;
 const auth=createAuthSession({}, {phoneFactory:()=>({challenge:()=>{count++;return wait.promise},async resend(){},async verify(){},dispose(){}})});
 auth.activate();const pending=auth.phone.challenge('+12025550123','caller-key');auth.deactivate();
 wait.resolve({challengeId:'old'});await assert.rejects(pending,{code:'session_changed',originalEffectUnknown:true});assert.equal(count,1);
});
