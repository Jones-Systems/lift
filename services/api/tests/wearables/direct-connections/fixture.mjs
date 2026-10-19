import { fixture as persistenceFixture,a } from '../persistence/fixture.mjs';
import { createWearablesService } from '../../../src/wearables/service.ts';

export { a,b,page } from '../persistence/fixture.mjs';
export const prepareInput=()=>({provider:'oura',connectionId:'direct',expectedGeneration:null,types:['steps'],consentVersion:'synthetic',retentionConsent:true});
export const proof={operationId:'code-operation',version:1};
export const binding={provider:'oura',connectionId:'direct',generation:1};
export function fixture(t){
  const h=persistenceFixture(t);
  // Synthetic token-commit metadata shares the real SQLite rollback boundary; no vault or credentials are instantiated.
  h.db.exec(`CREATE TABLE synthetic_committed_auth(account_id TEXT NOT NULL,operation_id TEXT NOT NULL,
    session_id TEXT NOT NULL,epoch INTEGER NOT NULL,provider TEXT NOT NULL,connection_id TEXT NOT NULL,generation INTEGER NOT NULL,
    kind TEXT NOT NULL,committed INTEGER NOT NULL,receipt_version INTEGER NOT NULL,live_version INTEGER NOT NULL,suppressed INTEGER NOT NULL,
    PRIMARY KEY(account_id,operation_id));`);
  const root={store:h.store,enabled:()=>true,now:()=> '2026-10-11T00:00:00Z',assertActive:h.deps.lifecycle.assertActive,
    withActiveWrite:h.write,assertImportAllowed:h.deps.assertImportAllowed,
    assertProviderCommittedWithinWrite(ctx,bound,receipt){
      if(!h.db.inTransaction)throw Error('writer_required');h.deps.control.assertWithinWrite(ctx);h.deps.lifecycle.assertActive(ctx);
      const row=h.db.prepare('SELECT * FROM synthetic_committed_auth WHERE account_id=? AND operation_id=?').get(ctx.accountId,receipt.operationId);
      if(!row||row.session_id!==ctx.sessionId||row.epoch!==ctx.epoch||row.provider!==bound.provider||row.connection_id!==bound.connectionId||
        row.generation!==bound.generation||row.kind!=='code'||row.committed!==1||row.suppressed!==0||row.receipt_version!==receipt.version||row.live_version<receipt.version)
        throw Error('committed_code_proof_required');
    }};
  const service=createWearablesService(root);
  function commit(ctx=a,bound=binding,p=proof){
    h.deps.control.assertWithinWrite(ctx);
    h.db.prepare('INSERT INTO synthetic_committed_auth VALUES(?,?,?,?,?,?,?,\'code\',1,?,?,0)')
      .run(ctx.accountId,p.operationId,ctx.sessionId,ctx.epoch,bound.provider,bound.connectionId,bound.generation,p.version,p.version);
  }
  return {...h,root,service,commit,prepare:(input=prepareInput(),key='prepare',ctx=a)=>service.prepareDirectProviderConnection(ctx,key,input),
    activate:(key='activate',bound=binding,p=proof,ctx=a)=>service.activateDirectProviderConnectionWithinWrite(ctx,key,bound,p),
    authCount:()=>h.db.prepare('SELECT count(*) AS n FROM synthetic_committed_auth').get().n};
}
