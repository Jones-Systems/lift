import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {lifecyclePolicy} from '../../src/lifecycle/service.js';
import {start,users,request,password} from './fixture.js';
export async function disable(server:Awaited<ReturnType<typeof start>>['server'],a:Awaited<ReturnType<typeof users>>[0]) {
 const requestId=randomUUID(),statusSecret=randomBytes(32).toString('base64url');
 assert.equal((await request(server,'/v1/me/deletion-requests',a,'POST',{requestId,statusSecret,policyVersion:lifecyclePolicy,confirmation:'delete_whole_account'},'deletion')).status,201);
 const granted=await request(server,'/v1/me/account-action-grants',a,'POST',{purpose:'account_delete',password});assert.equal(granted.status,201);const grant=await granted.json() as {grant:string};
 const response=await request(server,`/v1/me/deletion-requests/${requestId}/confirm`,a,'POST',{grant:grant.grant,policyVersion:lifecyclePolicy,confirmation:'delete_whole_account'});
 return {response,requestId,statusSecret};
}
