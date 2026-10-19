import test from 'node:test';
import assert from 'node:assert/strict';
import {createCapturePreview} from '../public/body-preview.mjs';
test('fictional capture abstains, retake and discard clear sample and derivatives',()=>{
 const demo=createCapturePreview();
 for(const scenario of ['missing','scale','rotation','supported']){
  assert.equal(demo.check(scenario).stage,'unable');
  assert.equal(demo.state.measurements,undefined);
  assert.equal(demo.retake().sample,null);
 }
 demo.check('missing');assert.deepEqual(demo.discard(),{stage:'discarded',sample:null,result:null});
 assert.throws(()=>demo.check('unknown'));
 const fresh=createCapturePreview();assert.deepEqual(fresh.state,{stage:'empty',sample:null,result:null});
});
