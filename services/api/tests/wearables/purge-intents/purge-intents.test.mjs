import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,deferred } from './fixture.mjs';

test('every required port fails closed before cleanup or journal access',async()=>{
  for(const missing of ['assertAuthorized','validateCommand','quiesceImports','captureNativeTarget','journal','confirmOriginalIntent','forgetQueryContext']){
    const h=fixture();delete h.options[missing];
    assert.deepEqual(await h.create().run(),{status:'unavailable',reason:'health_purge_ports_required'});
    assert.deepEqual(h.events,[]);
  }
});
test('quiesce, capture, durable prepare, backend proof, durable confirmation, native forget and completion are ordered',async()=>{
  const h=fixture();assert.deepEqual(await h.create().run(),{status:'complete',receipt:h.receipt});
  assert.deepEqual(h.events,['load','quiesce','capture','save:prepared','backend','save:backend_confirmed','forget','save:complete']);
  const completed=h.snapshot().record;
  assert.deepEqual(Object.keys(completed).sort(),['identity','phase','receipt']);
  assert.deepEqual(Object.keys(completed.identity).sort(),['accountId','commandIdentity','connectionId','deviceGeneration','generation','key','sessionGeneration']);
  assert.equal('command' in completed,false);assert.equal('context' in completed,false);assert.equal('journalId' in completed,false);
  assert.equal(JSON.stringify(completed).includes('synthetic-purge'),false);assert.equal(JSON.stringify(completed).includes('2026-10-09'),false);
});
test('construction captures immutable context and command before any await or caller mutation',async()=>{
  const h=fixture(),entered=deferred(),release=deferred(),quiesce=h.options.quiesceImports;
  const original=structuredClone({context:h.options.context,command:h.options.command});
  h.options.quiesceImports=async()=>{await quiesce();entered.resolve();await release.promise;};
  const consumer=h.create(),pending=consumer.run();await entered.promise;
  h.options.context.generation=999;h.options.context.to='changed';h.options.command.scope.connectionId='changed';release.resolve();
  assert.equal((await pending).status,'complete');
  assert.deepEqual(h.backend[0].context,original.context);assert.deepEqual(h.backend[0].command,original.command);
});
test('backend and native callbacks cannot mutate the saved intent or receipt',async()=>{
  const h=fixture(),confirm=h.options.confirmOriginalIntent,forget=h.options.forgetQueryContext;
  h.options.confirmOriginalIntent=async saved=>{const result=await confirm(saved);saved.context.generation=999;saved.command.scope.connectionId='changed';return result;};
  h.options.forgetQueryContext=async(...args)=>{await forget(...args);args[0].generation=999;};
  assert.equal((await h.create().run()).status,'complete');assert.equal(h.native[0][0].generation,7);assert.equal(h.snapshot().record.receipt.generation,7);
});
test('only an exact account connection generation device receipt can authorize native forget',async()=>{
  for(const patch of [{accountId:'other'},{connectionId:'other'},{generation:8},{deviceGeneration:'other'},{receiptId:''}]){
    const h=fixture(),confirm=h.options.confirmOriginalIntent;
    h.options.confirmOriginalIntent=async saved=>{const result=await confirm(saved);return {...result,receipt:{...result.receipt,...patch}};};
    assert.equal((await h.create().run()).status,'unknown');assert.equal(h.snapshot().record.phase,'prepared');assert.equal(h.native.length,0);
  }
});
test('unresolved backend result preserves the original prepared command and target on retry',async()=>{
  const h=fixture(),confirm=h.options.confirmOriginalIntent;let unresolved=true;
  h.options.confirmOriginalIntent=async saved=>{const result=await confirm(saved);return unresolved?{status:'unresolved'}:result;};
  const consumer=h.create();assert.equal((await consumer.run()).status,'unknown');const saved=h.snapshot().record;
  assert.equal(saved.phase,'prepared');assert.equal(h.native.length,0);unresolved=false;
  assert.equal((await consumer.run()).status,'complete');assert.deepEqual(h.backend,[saved.intent,saved.intent]);
  assert.equal(h.events.filter(e=>e==='capture').length,1);assert.equal(h.events.filter(e=>e==='quiesce').length,1);
});
test('unknown prepare CAS reconciles both applied and known no effect without recapture',async()=>{
  for(const applied of [true,false]){
    const h=fixture(),cas=h.options.journal.compareAndSwap;let first=true;
    h.options.journal.compareAndSwap=async(...args)=>{if(first&&args[1].phase==='prepared'){first=false;if(applied)await cas(...args);return {status:'unknown'};}return cas(...args);};
    const consumer=h.create();assert.equal((await consumer.run()).status,'unknown');assert.equal(h.backend.length,0);
    assert.equal((await consumer.run()).status,'complete');assert.equal(h.backend.length,1);assert.equal(h.native.length,1);
    assert.equal(h.events.filter(e=>e==='capture').length,1);assert.equal(h.events.filter(e=>e==='quiesce').length,1);
  }
});
test('unknown confirmation CAS readback preserves the authoritative receipt without backend retry',async()=>{
  for(const applied of [true,false]){
    const h=fixture(),cas=h.options.journal.compareAndSwap;let first=true;
    h.options.journal.compareAndSwap=async(...args)=>{if(first&&args[1].phase==='backend_confirmed'){first=false;if(applied)await cas(...args);return {status:'unknown'};}return cas(...args);};
    const consumer=h.create();assert.equal((await consumer.run()).status,'unknown');assert.equal(h.native.length,0);
    assert.equal((await consumer.run()).status,'complete');assert.equal(h.backend.length,1);assert.equal(h.native.length,1);
  }
});
test('thrown journal response is reconciled by authoritative readback before subsequent effects',async()=>{
  const h=fixture(),cas=h.options.journal.compareAndSwap;let first=true;
  h.options.journal.compareAndSwap=async(...args)=>{const result=await cas(...args);if(first){first=false;throw Error('response_lost');}return result;};
  const consumer=h.create();assert.equal((await consumer.run()).status,'unknown');assert.equal(h.backend.length,0);
  assert.equal((await consumer.run()).status,'complete');assert.equal(h.events.filter(e=>e==='capture').length,1);assert.equal(h.backend.length,1);
});
test('unreadable unknown journal blocks effects until readback becomes authoritative',async()=>{
  const h=fixture(),cas=h.options.journal.compareAndSwap,load=h.options.journal.load;let first=true,unreadable=false;
  h.options.journal.compareAndSwap=async(...args)=>{const result=await cas(...args);if(first){first=false;unreadable=true;return {status:'unknown'};}return result;};
  h.options.journal.load=async()=>{if(unreadable)throw Error('journal_unreadable');return load();};
  const consumer=h.create();assert.equal((await consumer.run()).status,'unknown');assert.equal((await consumer.run()).status,'unknown');
  assert.equal(h.backend.length,0);unreadable=false;assert.equal((await consumer.run()).status,'complete');assert.equal(h.events.filter(e=>e==='capture').length,1);
});
test('unknown readback with a different intent is held without replacement writes or dispatch',async()=>{
  const h=fixture(),cas=h.options.journal.compareAndSwap,load=h.options.journal.load;let first=true;
  h.options.journal.compareAndSwap=async(...args)=>{const result=await cas(...args);if(first){first=false;return {status:'unknown'};}return result;};
  const consumer=h.create();assert.equal((await consumer.run()).status,'unknown');
  h.options.journal.load=async()=>{const value=await load();value.record.intent.serial++;return value;};
  assert.deepEqual(await consumer.run(),{status:'unknown',reason:'health_purge_reconciliation_required'});assert.equal(h.backend.length,0);assert.equal(h.native.length,0);
});
test('confirmed restart retries native with exactly the saved namespace fence and no backend or recapture',async()=>{
  const h=fixture(),forget=h.options.forgetQueryContext;let fail=true;
  h.options.forgetQueryContext=async(...args)=>{await forget(...args);if(fail)throw Error('native_receipt_unknown');};
  assert.equal((await h.create().run()).status,'unknown');assert.equal(h.snapshot().record.phase,'backend_confirmed');fail=false;
  const before=h.events.length;assert.equal((await h.create().run()).status,'complete');
  assert.deepEqual(h.events.slice(before),['load','forget','save:complete']);assert.equal(h.backend.length,1);assert.deepEqual(h.native[0],h.native[1]);
});
test('native serial mismatch never refreshes the saved serial or journal identity',async()=>{
  const h=fixture(),forget=h.options.forgetQueryContext;
  h.options.forgetQueryContext=async(...args)=>{await forget(...args);throw Error('native_serial_mismatch');};
  assert.equal((await h.create().run()).status,'unknown');
  h.options.captureNativeTarget=async()=>{throw Error('must_not_recapture');};
  assert.equal((await h.create().run()).status,'unknown');assert.deepEqual(h.native[0],h.native[1]);assert.equal(h.native[1][2],12);assert.equal(h.backend.length,1);
});
test('unknown complete CAS readback avoids a second native effect in the live consumer',async()=>{
  for(const applied of [true,false]){
    const h=fixture(),cas=h.options.journal.compareAndSwap;let first=true;
    h.options.journal.compareAndSwap=async(...args)=>{if(first&&args[1].phase==='complete'){first=false;if(applied)await cas(...args);return {status:'unknown'};}return cas(...args);};
    const consumer=h.create();assert.equal((await consumer.run()).status,'unknown');assert.equal((await consumer.run()).status,'complete');assert.equal(h.native.length,1);
  }
});
test('completed restart returns the original receipt without native setup backend dispatch or writes',async()=>{
  const h=fixture();await h.create().run();const saved=h.snapshot(),before=h.events.length;
  assert.deepEqual(await h.create().run(),{status:'complete',receipt:h.receipt});
  assert.deepEqual(h.events.slice(before),['load']);assert.deepEqual(h.snapshot(),saved);
});
test('CAS conflict is held and cannot trigger a replacement target or backend request',async()=>{
  const h=fixture();h.options.journal.compareAndSwap=async()=>({status:'conflict',snapshot:h.snapshot()});
  const consumer=h.create();assert.equal((await consumer.run()).status,'unknown');const before=h.events.length;
  assert.deepEqual(await consumer.run(),{status:'unknown',reason:'health_purge_reconciliation_required'});
  assert.equal(h.events.length,before);assert.equal(h.backend.length,0);assert.equal(h.native.length,0);
});
test('restored intent rejects changed context key or command even after completion removes payload',async()=>{
  for(const complete of [true,false])for(const field of ['accountId','sessionGeneration','connectionId','generation','deviceGeneration','type','from','to','timeZone','key','command']){
    const h=fixture();if(!complete)h.options.confirmOriginalIntent=async()=>({status:'unresolved'});
    await h.create().run();h.options.assertAuthorized=()=>{};
    if(field==='key')h.options.key='other-key';
    else if(field==='command')h.options.command={operation:'different'};
    else if(field==='generation')h.options.context.generation++;
    else if(field==='type')h.options.context.type='sleep';
    else if(field==='from')h.options.context.from='2026-10-08T00:00:00Z';
    else if(field==='to')h.options.context.to='2026-10-11T00:00:00Z';
    else h.options.context[field]='other';
    const before=h.events.length;assert.equal((await h.create().run()).status,'unknown');assert.deepEqual(h.events.slice(before),['load']);
  }
});
test('cleanup has its own lifetime and does not require the original active import session',async()=>{
  const h=fixture();let importSessionActive=false;
  h.options.assertAuthorized=(context,key)=>{assert.equal(importSessionActive,false);assert.equal(context.sessionGeneration,'original-session');assert.equal(key,'purge-key-a');};
  assert.equal((await h.create().run()).status,'complete');
});
test('revoked cleanup authority stops before reads and after every awaited effect',async()=>{
  for(const boundary of ['initial','load','quiesceImports','captureNativeTarget','confirmOriginalIntent','forgetQueryContext']){
    const h=fixture();
    if(boundary==='initial')h.authorize(false);
    else {const owner=boundary==='load'?h.options.journal:h.options,original=owner[boundary];owner[boundary]=async(...args)=>{const result=await original(...args);h.authorize(false);return result;};}
    assert.equal((await h.create().run()).status,'unknown');
    if(boundary==='initial')assert.deepEqual(h.events,[]);
    if(['initial','load','quiesceImports','captureNativeTarget'].includes(boundary)){assert.equal(h.snapshot().record,null);assert.equal(h.backend.length,0);}
    if(boundary==='confirmOriginalIntent'){assert.equal(h.snapshot().record.phase,'prepared');assert.equal(h.native.length,0);}
    if(boundary==='forgetQueryContext')assert.equal(h.snapshot().record.phase,'backend_confirmed');
  }
});
test('atomic journal guard rejects a late write after cleanup lifetime ends',async()=>{
  const h=fixture(),cas=h.options.journal.compareAndSwap,entered=deferred(),release=deferred();
  h.options.journal.compareAndSwap=async(...args)=>{entered.resolve();await release.promise;return cas(...args);};
  const pending=h.create().run();await entered.promise;h.authorize(false);release.resolve();
  assert.equal((await pending).status,'unknown');assert.equal(h.snapshot().record,null);assert.equal(h.backend.length,0);
});
test('concurrent run cannot capture a second target or dispatch another backend intent',async()=>{
  const h=fixture(),entered=deferred(),release=deferred(),quiesce=h.options.quiesceImports;
  h.options.quiesceImports=async()=>{await quiesce();entered.resolve();await release.promise;};
  const consumer=h.create(),pending=consumer.run();await entered.promise;
  assert.equal((await consumer.run()).status,'unknown');release.resolve();assert.equal((await pending).status,'complete');assert.equal(h.backend.length,1);
});
test('invalid context command serial or command authority cannot reach backend or native',async()=>{
  for(const invalid of ['context','command','serial','authority','identity']){
    const h=fixture();h.options.assertAuthorized=()=>{};
    if(invalid==='context')h.options.context.normalizationVersion=2;
    if(invalid==='command')h.options.command={bad:NaN};
    if(invalid==='serial')h.options.captureNativeTarget=async()=>({journalId:'native-journal-a',serial:1.5});
    if(invalid==='authority')h.options.validateCommand=()=>{throw Error('unqualified');};
    if(invalid==='identity')h.options.validateCommand=()=>'';
    assert.equal((await h.create().run()).status,'unknown');assert.equal(h.snapshot().record,null);assert.equal(h.backend.length,0);assert.equal(h.native.length,0);
  }
});
