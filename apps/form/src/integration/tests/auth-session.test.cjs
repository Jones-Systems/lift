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

function recoveryFixture(){
 const calls=[],responses=[],subscriptions=new Set(),events=[];
 const storage={async load(){return null},async save(){events.push('save')},async clear(){events.push('clear')}};
 const api=new FormTransport('https://auth-session.synthetic.invalid',storage,async(url,init)=>{
  calls.push({path:new URL(url).pathname,body:JSON.parse(init.body)});
  const response=deferred();responses.push(response);return response.promise;
 });
 const subscribe=api.subscribeAuthChanges.bind(api);
 api.subscribeAuthChanges=listener=>{const original=subscribe(listener);const remove=()=>{original.remove();subscriptions.delete(remove)};subscriptions.add(remove);return{remove}};
 return{api,calls,responses,subscriptions,events,finish(){responses.shift().resolve(new Response(JSON.stringify({success:true})))}};
}
test('recovery is lazy under the activated original epoch and confirmed reset never stores or authenticates',async()=>{
 const f=recoveryFixture(),auth=createAuthSession(f.api),notices=[];
 assert.throws(()=>auth.openPasswordRecovery(()=>{}),{code:'session_changed'});
 assert.equal(f.calls.length,0);assert.equal(f.subscriptions.size,0);
 auth.activate();assert.equal(f.subscriptions.size,0);
 const recovery=auth.openPasswordRecovery(notice=>notices.push(notice));
 assert.equal(f.calls.length,0);assert.ok(f.subscriptions.size>0);
 const request=recovery.controller.requestCode(' Person@Example.test ');f.finish();await request;
 const reset=recovery.controller.submit('12345678','synthetic-new-password');f.finish();await reset;
 assert.deepEqual(f.calls,[
  {path:'/api/auth/email-otp/request-password-reset',body:{email:'person@example.test'}},
  {path:'/api/auth/email-otp/reset-password',body:{email:'person@example.test',otp:'12345678',password:'synthetic-new-password'}}
 ]);
 assert.deepEqual(recovery.controller.transition(),{destination:'sign-in',reason:'password-reset',emailPrefill:'person@example.test'});
 assert.deepEqual(f.events,[]);auth.invalidate();
 assert.equal(recovery.isCurrent(),false);assert.equal(f.subscriptions.size,0);
 assert.deepEqual(notices,['Password reset was confirmed. Sign in with your new password.']);
});
for(const phase of ['request','reset'])test(`original recovery ${phase} is disposed on restart and never revived by activation`,async()=>{
 const f=recoveryFixture(),auth=createAuthSession(f.api),notices=[];auth.activate();
 const original=auth.openPasswordRecovery(notice=>notices.push(notice));
 let pending=original.controller.requestCode('person@example.test');
 if(phase==='reset'){f.finish();await pending;pending=original.controller.submit('12345678','synthetic-new-password')}
 auth.deactivate();assert.equal(f.subscriptions.size,0);auth.activate();
 const next=auth.openPasswordRecovery(()=>{}),count=f.calls.length;
 await original.controller.requestCode('old@example.test');await original.controller.submit('12345678','synthetic-old-password');
 assert.equal(f.calls.length,count);f.finish();await pending;
 assert.equal(original.controller.snapshot().status,'disposed');assert.equal(original.controller.transition(),null);
 assert.equal(next.controller.snapshot().status,'idle');assert.equal(next.controller.snapshot().step,'email');
 assert.equal(notices.length,1);assert.match(notices[0],/couldn't confirm/);assert.deepEqual(f.events,[]);
 auth.deactivate();assert.equal(f.subscriptions.size,0);
});
test('transport auth intent removes recovery subscriptions synchronously and fences retained commands',async()=>{
 const f=recoveryFixture(),auth=createAuthSession(f.api),notices=[];auth.activate();
 const recovery=auth.openPasswordRecovery(notice=>notices.push(notice));
 const pending=recovery.controller.requestCode('person@example.test');
 // restore advances the real transport auth intent before its storage await.
 const replacement=f.api.restore();
 assert.equal(f.subscriptions.size,0);assert.equal(recovery.controller.snapshot().status,'disposed');
 await recovery.controller.requestCode('old@example.test');assert.equal(f.calls.length,1);
 f.finish();await pending;assert.equal(await replacement,false);
 assert.equal(recovery.controller.transition(),null);assert.match(notices[0],/couldn't confirm/);
});
