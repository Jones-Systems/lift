import test from 'node:test';
import assert from 'node:assert/strict';
import { harness,ctxA,ctxB,batch,record } from './support.mjs';
import { createHealthRouter } from '../../src/wearables/router.ts';
test('late revoked session and cross-account context cannot ingest or read',()=>{
 const h=harness();h.valid.delete(ctxA.sessionId);
 assert.throws(()=>h.service.ingest(ctxA,'k',batch()),/invalid/);
 assert.throws(()=>h.service.summary({...ctxA,accountId:ctxB.accountId},'2026-10-09','2026-10-10'),/invalid/);
 assert.equal(h.store.measures(ctxB,'2026-10-09','2026-10-10',100).length,0);
});
test('page, receipt and cursor roll back together then replay only once',()=>{
 const h=harness();h.setFailure('cursor');assert.throws(()=>h.service.ingest(ctxA,'k',batch()));
 assert.equal(h.store.measure(ctxA,'hk',1,'steps:day'),null);assert.equal(h.store.cursor(ctxA,'hk',1,'steps'),null);
 h.setFailure(null);const first=h.service.ingest(ctxA,'k',batch());assert.deepEqual(h.service.ingest(ctxA,'k',batch()),first);
 assert.deepEqual(h.service.ingest(ctxA,'different-command-same-page',batch()),first);
 assert.throws(()=>h.service.ingest(ctxA,'k',batch({batch:[record({value:999})]})),/health_key_reuse/);
 assert.throws(()=>h.service.ingest(ctxA,'another',batch({batch:[record({value:999})]})),/health_key_reuse/);
});
test('account-scoped identical keys and IDs remain isolated',()=>{
 const h=harness();h.service.ingest(ctxA,'k',batch());h.service.ingest(ctxB,'k',batch({batch:[record({value:4})]}));
 assert.equal(h.service.summary(ctxA,'2026-10-09','2026-10-10').items[0].selected.value,120);
 assert.equal(h.service.summary(ctxB,'2026-10-09','2026-10-10').items[0].selected.value,4);
});
test('forged AI labels, no-save fields and missing consent create no import receipts',()=>{
 const h=harness(),before=h.bucket(ctxA).receipts.size;
 for(const extra of [{aiEligible:true},{retention:'no_save'},{body:{weight:42}}])assert.throws(()=>h.service.ingest(ctxA,'k',batch({batch:[{...record(),...extra}]})));
 assert.equal(h.bucket(ctxA).receipts.size,before);h.setPermitted(false);assert.throws(()=>h.service.ingest(ctxA,'k',batch()));
 assert.equal(h.bucket(ctxA).receipts.size,before);
});
test('Apple-looking source never grants coach or AI eligibility',()=>{
 const h=harness();h.service.ingest(ctxA,'k',batch({batch:[record({source:{bundleId:'com.apple.health',name:'Apple',device:'Apple Watch',algorithm:null,originalId:null}})]}));
 assert.equal(h.service.summary(ctxA,'2026-10-09','2026-10-10').items[0].selected.aiEligible,false);assert.deepEqual(h.service.coachInputs(ctxA),[]);
});
test('newer revision wins, equal revision conflict rolls back, tombstone cannot resurrect',()=>{
 const h=harness();h.service.ingest(ctxA,'a',batch());
 h.service.ingest(ctxA,'b',batch({pageId:'p2',fromCursor:'anchor1',nextCursor:'anchor2',batch:[record({value:130,revision:{token:'r2',order:2}})]}));
 assert.throws(()=>h.service.ingest(ctxA,'c',batch({pageId:'p3',fromCursor:'anchor2',nextCursor:'bad',batch:[record({value:140,revision:{token:'r2',order:2}})]})),/health_source_conflict/);
 assert.equal(h.store.cursor(ctxA,'hk',1,'steps'),'anchor2');
 h.service.ingest(ctxA,'d',batch({pageId:'p4',fromCursor:'anchor2',nextCursor:'anchor3',batch:[],tombstones:[{id:'steps:day',revision:{token:'r3',order:3}}]}));
 h.service.ingest(ctxA,'e',batch({pageId:'p5',fromCursor:'anchor3',nextCursor:'anchor4'}));assert.equal(h.store.measure(ctxA,'hk',1,'steps:day').deleted,true);
});
test('unknown revision ordering and wrong cursor are explicit conflicts',()=>{
 const h=harness();h.service.ingest(ctxA,'a',batch({batch:[record({revision:{token:'opaque',order:null}})]}));
 assert.throws(()=>h.service.ingest(ctxA,'b',batch({pageId:'p2',fromCursor:'anchor1',batch:[record({value:1,revision:{token:'changed',order:null}})]})),/health_revision_order_unknown/);
 assert.throws(()=>h.service.ingest(ctxA,'c',batch({pageId:'p3'})),/health_cursor_conflict/);
});
test('disconnect purges, fences late page and rejects purged receipt replay while reconnect gets new generation',()=>{
 const h=harness();h.service.ingest(ctxA,'a',batch());const result=h.service.disconnect(ctxA,'d',{connectionId:'hk',generation:1});
 assert.equal(result.purged,true);assert.throws(()=>h.service.disconnect(ctxA,'d',{connectionId:'hk',generation:1}),/health_receipt_purged/);
 assert.equal(h.store.measures(ctxA,'2026-10-09','2026-10-10',100).length,0);
 assert.throws(()=>h.service.ingest(ctxA,'a',batch()),/health_connection_changed/);
 const next=h.service.connectHealthKit(ctxA,'new',{connectionId:'hk',types:['steps'],retentionConsent:true,consentVersion:'new'});assert.equal(next.generation,3);
});
test('only trusted alias deduplicates; overlap/conflicts and HRV constructs remain distinct',()=>{
 const h=harness();h.service.ingest(ctxA,'a',batch({batch:[record(),record({id:'copy',source:{bundleId:'different',name:'Different',device:null,algorithm:null,originalId:null}}),
 record({id:'sdnn',metric:'hrv_sdnn',unit:'ms',value:40,aggregation:'mean'}),record({id:'rmssd',metric:'hrv_rmssd',unit:'ms',value:40,aggregation:'mean'})]}));
 assert.equal(h.service.summary(ctxA,'2026-10-09','2026-10-10').items.find(x=>x.selected.metric==='steps').status,'conflict');
 h.setAlias(v=>v.metric==='steps'?'trusted-original':null);
 const summary=h.service.summary(ctxA,'2026-10-09','2026-10-10');assert.equal(summary.items.find(x=>x.selected.metric==='steps').status,'proven_duplicate');assert.equal(summary.items.length,3);
});
test('empty query is no data, unavailable Google and disabled route stay explicit',()=>{
 const h=harness();assert.deepEqual(h.service.summary(ctxA,'2026-10-09','2026-10-10').items,[]);
 assert.equal(h.service.capabilities().google.status,'unavailable');h.setEnabled(false);
 const r=createHealthRouter(h.service)(ctxA,{method:'GET',path:'/v1/health/connections',query:new URLSearchParams()});assert.equal(r.status,503);
});
test('proposed 120 day purge is callable source policy only',()=>{
 const h=harness();h.service.ingest(ctxA,'a',batch({batch:[record({day:'2025-01-01',start:'2025-01-01T00:00:00Z',end:'2025-01-02T00:00:00Z'})]}));
 assert.equal(h.service.expireProposalRetention(ctxA,120),1);
});
