import test from 'node:test';
import assert from 'node:assert/strict';
import { harness,ctxA,ctxB } from './support.mjs';
function proposed(h,id='suggestion') {const before=structuredClone(h.bucket(ctxA).plan.items),after=structuredClone(before);after[0].setTarget=2;
 const s={id,planId:'plan',baseRevision:1,appliedRevision:null,state:'pending',beforeItems:before,afterItems:after,reviewDigest:'reviewed',expiresAt:'2026-10-11T00:00:00Z',reason:'Invented user-requested example only',limits:['not a physiological policy'],policyVersion:'test-only',evidenceRefs:[]};h.store.putSuggestion(ctxA,s);return s;}
const review={expectedPlanRevision:1,reviewDigest:'reviewed'};
test('no automatic plan mutation; reject preserves plan; absent atomic port cannot fall back',()=>{
 const h=harness();proposed(h);assert.equal(h.bucket(ctxA).plan.revision,1);h.service.suggestion(ctxA,'r','suggestion','reject',{});assert.equal(h.bucket(ctxA).plan.revision,1);
 proposed(h,'next');delete h.root.plans;assert.throws(()=>h.service.suggestion(ctxA,'a','next','accept',review),/unavailable/);assert.equal(h.bucket(ctxA).plan.revision,1);
});
test('apply and undo are idempotent atomic revisions; later edits are not overwritten',()=>{
 const h=harness();proposed(h);const a=h.service.suggestion(ctxA,'a','suggestion','accept',review);assert.equal(a.revision,2);assert.deepEqual(h.service.suggestion(ctxA,'a','suggestion','accept',review),a);
 const u=h.service.suggestion(ctxA,'u','suggestion','undo',{...review,expectedPlanRevision:2});assert.equal(u.revision,3);assert.equal(h.bucket(ctxA).plan.items[0].setTarget,3);assert.deepEqual(h.service.suggestion(ctxA,'u','suggestion','undo',{...review,expectedPlanRevision:2}),u);
 assert.deepEqual(h.service.suggestion(ctxA,'a','suggestion','accept',review),a);
});
test('revision races, active workouts, wrong account and changed consent digest fail closed',()=>{
 const h=harness();proposed(h);proposed(h,'competitor');assert.throws(()=>h.service.suggestion(ctxB,'a','suggestion','accept',review),/not_found/);
 assert.throws(()=>h.service.suggestion(ctxA,'a','suggestion','accept',{...review,reviewDigest:'other'}),/review_changed/);
 h.bucket(ctxA).plan.activeWorkout=true;assert.throws(()=>h.service.suggestion(ctxA,'a','suggestion','accept',review),/workout_in_progress/);h.bucket(ctxA).plan.activeWorkout=false;
 h.service.suggestion(ctxA,'a','suggestion','accept',review);assert.throws(()=>h.service.suggestion(ctxA,'b','competitor','accept',review),/plan_changed/);
 h.bucket(ctxA).plan.revision++;assert.throws(()=>h.service.suggestion(ctxA,'u','suggestion','undo',{...review,expectedPlanRevision:3}),/plan_changed/);assert.equal(h.bucket(ctxA).plan.items[0].setTarget,2);
});
test('root plan port failure rolls back plan, suggestion and receipt together',()=>{
 const h=harness();proposed(h);const n=h.bucket(ctxA).receipts.size;h.root.plans.applyWithinWrite=(c)=>{h.bucket(c).plan.revision++;throw Error('injected');};
 assert.throws(()=>h.service.suggestion(ctxA,'a','suggestion','accept',review),/injected/);assert.equal(h.bucket(ctxA).plan.revision,1);assert.equal(h.store.suggestion(ctxA,'suggestion').state,'pending');assert.equal(h.bucket(ctxA).receipts.size,n);
});
