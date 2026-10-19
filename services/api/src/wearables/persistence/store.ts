import type { AccountContext, Connection, Receipt, StoredMeasure, Suggestion, WearableStore } from '../types.js';
import type { ProviderIntent, ProviderIntentPort } from '../providers/importer.js';
import { digest, fail, integer, measure, page, stable, text } from '../validation.js';
import type { HealthKitCheckpointBinding, ProviderIntentBinding, WearablePersistenceDependencies } from './types.js';
import { createHealthKitCheckpoint } from './checkpoint.js';

export function createWearablePersistence(deps: WearablePersistenceDependencies) {
  const { db, lifecycle, control } = deps;
  function read<T>(ctx: AccountContext, effect: () => T): T {
    lifecycle.assertActive(ctx); const result = effect(); lifecycle.assertActive(ctx); return result;
  }
  function write<T>(ctx: AccountContext, effect: () => T): T {
    if (!db.inTransaction) fail('health_writer_transaction_required',503);
    control.assertWithinWrite(ctx);
    return read(ctx, () => { const result = effect(); control.assertWithinWrite(ctx); return result; });
  }
  function encode(value: unknown): string {
    const data = stable(value);
    if (Buffer.byteLength(data) > 1024 * 1024) fail('health_storage_limit',413);
    return data;
  }
  const decode = <T>(row: unknown): T | null => row ? JSON.parse((row as { data: string }).data) as T : null;
  function owned(ctx: AccountContext, id: string, generation?: number): Connection {
    const value = decode<Connection>(db.prepare('SELECT data FROM wearable_connections WHERE account_id=? AND connection_id=?').get(ctx.accountId,id));
    if (!value) return fail('health_not_found',404);
    if (generation !== undefined && value.generation !== generation) fail('health_connection_changed',409);
    return value;
  }
  function receipt(ctx: AccountContext, key: string): Receipt | null {
    const row = db.prepare('SELECT fingerprint,connection_id,generation,purged,result FROM wearable_receipts WHERE account_id=? AND key=?')
      .get(ctx.accountId,key) as { fingerprint: string; connection_id: string | null; generation: number | null; purged: number; result: string | null } | undefined;
    if (!row) return null;
    if (row.purged) return {fingerprint:row.fingerprint,scope:null,purged:true};
    return { fingerprint:row.fingerprint,scope:row.connection_id===null?null:{connectionId:row.connection_id,generation:row.generation!},result:JSON.parse(row.result!) as unknown };
  }
  function invalidate(ctx: AccountContext, id: string) {
    for (const suggestion of store.suggestions(ctx)) {
      if (suggestion.state==='pending' && suggestion.evidenceRefs.some(ref=>ref.connectionId===id))
        store.putSuggestion(ctx,{...suggestion,state:'invalidated'});
    }
  }
  const store: WearableStore = {
    connection: (ctx,id) => read(ctx,()=>decode<Connection>(db.prepare('SELECT data FROM wearable_connections WHERE account_id=? AND connection_id=?').get(ctx.accountId,id))),
    connections: ctx => read(ctx,()=>(db.prepare('SELECT data FROM wearable_connections WHERE account_id=? ORDER BY connection_id').all(ctx.accountId) as {data:string}[]).map(row=>decode<Connection>(row)!)),
    putConnection(ctx,value) { write(ctx,()=>{
      text(value.id); integer(value.generation);
      if (!['healthkit','oura','garmin'].includes(value.provider)) fail('health_invalid_provider');
      const old=store.connection(ctx,value.id);
      if (old && (old.provider!==value.provider || value.generation<old.generation)) fail('health_connection_changed',409);
      db.prepare('INSERT INTO wearable_connections VALUES(?,?,?,?) ON CONFLICT(account_id,connection_id) DO UPDATE SET generation=excluded.generation,data=excluded.data')
        .run(ctx.accountId,value.id,value.generation,encode(value));
    }); },
    cursor: (ctx,id,generation,stream) => read(ctx,()=>{
      owned(ctx,id,generation);
      const row=db.prepare('SELECT cursor FROM wearable_cursors WHERE account_id=? AND connection_id=? AND generation=? AND stream=?')
        .get(ctx.accountId,id,generation,stream) as {cursor:string|null}|undefined;
      return row?.cursor??null;
    }),
    putCursor(ctx,id,generation,stream,cursor) { write(ctx,()=>{
      owned(ctx,id,generation);text(stream,512);if(cursor!==null)text(cursor,2048);
      db.prepare('INSERT INTO wearable_cursors VALUES(?,?,?,?,?) ON CONFLICT(account_id,connection_id,generation,stream) DO UPDATE SET cursor=excluded.cursor')
        .run(ctx.accountId,id,generation,stream,cursor);
    }); },
    measure: (ctx,id,generation,recordId) => read(ctx,()=>decode<StoredMeasure>(db.prepare('SELECT data FROM wearable_measures WHERE account_id=? AND connection_id=? AND generation=? AND record_id=?').get(ctx.accountId,id,generation,recordId))),
    putMeasure(ctx,value) { write(ctx,()=>{
      const connection=owned(ctx,value.connectionId,value.generation);
      if(value.aiEligible!==false || value.provenance!=='unqualified_import' || value.provider!==connection.provider || !connection.connected)
        fail('health_storage_provenance_invalid',403);
      const stored:StoredMeasure=value.deleted?{...value,value:0,start:null,end:null,zone:null,quality:'unknown',
        source:{bundleId:'deleted',name:'deleted',device:null,algorithm:value.metric==='vendor_score'?'deleted':null,originalId:null}}:value;
      const {connectionId,generation,provider,importedAt,digest,aiEligible,provenance,deleted,...canonical}=stored;
      measure(canonical);text(digest);text(importedAt);if(typeof deleted!=='boolean')fail('health_invalid_input');
      const old=store.measure(ctx,connectionId,generation,value.id);
      if(old?.deleted&&!deleted)fail('health_record_deleted',409);
      db.prepare('INSERT INTO wearable_measures VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,connection_id,generation,record_id) DO UPDATE SET day=excluded.day,data=excluded.data')
        .run(ctx.accountId,connectionId,generation,stored.id,stored.day,encode(stored));
    }); },
    measures: (ctx,from,to,limit) => read(ctx,()=>{
      integer(limit);if(limit>1001)fail('health_summary_limit',413);
      return (db.prepare('SELECT data FROM wearable_measures WHERE account_id=? AND day>=? AND day<=? ORDER BY day,connection_id,record_id LIMIT ?')
        .all(ctx.accountId,from,to,limit) as {data:string}[]).map(row=>decode<StoredMeasure>(row)!);
    }),
    receipt: (ctx,key) => read(ctx,()=>receipt(ctx,key)),
    putReceipt(ctx,key,value) { write(ctx,()=>{
      text(key,2048);text(value.fingerprint);
      let stored=value;
      if(!value.purged && value.scope) {
        const connection=owned(ctx,value.scope.connectionId);
        if(!connection.connected || connection.generation!==value.scope.generation)
          stored={fingerprint:value.fingerprint,scope:null,purged:true};
      }
      const prior=receipt(ctx,key);
      if(prior) { if(stable(prior)!==stable(stored))fail('health_receipt_immutable',409);return; }
      db.prepare('INSERT INTO wearable_receipts VALUES(?,?,?,?,?,?,?)').run(ctx.accountId,key,stored.fingerprint,
        stored.scope?.connectionId??null,stored.scope?.generation??null,stored.purged?1:0,stored.purged?null:encode(stored.result));
    }); },
    suggestions: ctx => read(ctx,()=>(db.prepare('SELECT data FROM wearable_suggestions WHERE account_id=? ORDER BY suggestion_id').all(ctx.accountId) as {data:string}[]).map(row=>decode<Suggestion>(row)!)),
    suggestion: (ctx,id) => read(ctx,()=>decode<Suggestion>(db.prepare('SELECT data FROM wearable_suggestions WHERE account_id=? AND suggestion_id=?').get(ctx.accountId,id))),
    putSuggestion(ctx,value) { write(ctx,()=>{
      const prior=store.suggestion(ctx,value.id);text(value.id);
      if(prior) {
        const {state:oldState,appliedRevision:oldRevision,...oldBody}=prior;
        const {state,appliedRevision,...body}=value;
        if(stable(oldBody)!==stable(body))fail('health_suggestion_immutable',409);
        const allowed:Record<Suggestion['state'],Suggestion['state'][]>={pending:['pending','applied','rejected','invalidated'],applied:['applied','undone'],rejected:['rejected'],undone:['undone'],invalidated:['invalidated']};
        if(!allowed[oldState].includes(state) || (oldState!=='pending' && appliedRevision!==oldRevision) ||
          (oldState==='pending' && (state==='applied'? !Number.isSafeInteger(appliedRevision) || appliedRevision!==value.baseRevision+1 : appliedRevision!==null)))
          fail('health_suggestion_changed',409);
      } else if(value.state!=='pending'||value.appliedRevision!==null)fail('health_suggestion_changed',409);
      for(const ref of value.evidenceRefs)owned(ctx,ref.connectionId);
      db.prepare('INSERT INTO wearable_suggestions VALUES(?,?,?) ON CONFLICT(account_id,suggestion_id) DO UPDATE SET data=excluded.data')
        .run(ctx.accountId,value.id,encode(value));
    }); },
    purgeConnection(ctx,id) { write(ctx,()=>{
      const connection=owned(ctx,id);
      if(!deps.externalConnectionPurge)fail('health_external_connection_purge_unavailable',503);
      let external;
      try { external=deps.externalConnectionPurge(ctx,{connectionId:id,generation:connection.generation}); }
      catch { return fail('health_external_connection_purge_unknown',503); }
      if(external.status==='unknown')fail('health_external_connection_purge_unknown',503);
      if(external.status!=='complete')fail('health_external_connection_purge_unavailable',503);
      for(const table of ['wearable_provider_intents','wearable_cursors','wearable_measures'])
        db.prepare(`DELETE FROM ${table} WHERE account_id=? AND connection_id=?`).run(ctx.accountId,id);
      db.prepare('UPDATE wearable_receipts SET connection_id=NULL,generation=NULL,result=NULL,purged=1 WHERE account_id=? AND connection_id=? AND purged=0').run(ctx.accountId,id);
      invalidate(ctx,id);
    }); },
    purgeBefore(ctx,_before) { return write(ctx,()=>fail('health_retention_policy_unqualified',403)); },
  };
  function providerIntent(input: ProviderIntentBinding): ProviderIntentPort {
    const bound=structuredClone(input), {ctx,provider,connectionId,generation,stream,cursor}=bound;
    const binding=stable([ctx.accountId,ctx.sessionId,ctx.epoch,provider,connectionId,generation,stream,cursor]);
    const parameters=[ctx.accountId,connectionId,generation,stream] as const;
    const intentWrite=<T>(effect:()=>T):T=>db.inTransaction?write(ctx,effect):lifecycle.withActiveWrite(ctx,()=>write(ctx,effect));
    function check() {
      deps.assertImportAllowed(ctx,provider);
      const connection=owned(ctx,connectionId,generation);
      if(connection.provider!==provider || !connection.connected || !connection.retentionConsent)fail('health_consent_required',403);
    }
    const load=()=>read(ctx,()=>{
      check();const row=db.prepare('SELECT binding,data FROM wearable_provider_intents WHERE account_id=? AND connection_id=? AND generation=? AND stream=?').get(...parameters) as {binding:string;data:string}|undefined;
      if(row&&row.binding!==binding)fail('provider_intent_changed',409);
      return row?JSON.parse(row.data) as ProviderIntent:null;
    });
    return {
      load,
      save(value) { intentWrite(()=>{
        check();const p=page(value.page);
        if(value.binding!==binding || p.connectionId!==connectionId || p.generation!==generation || p.stream!==stream || p.fromCursor!==cursor || p.pageId!==value.key)fail('provider_intent_changed',409);
        const normalized={key:text(value.key),binding,page:p};
        const prior=load();if(prior){if(stable(prior)!==stable(normalized))fail('provider_intent_changed',409);return;}
        db.prepare('INSERT INTO wearable_provider_intents VALUES(?,?,?,?,?,?,?,?,?)').run(...parameters,ctx.sessionId,ctx.epoch,binding,normalized.key,encode(normalized));
        check();
      }); },
      acknowledged(key) { intentWrite(()=>{
        check();const prior=load();if(!prior || prior.key!==key)fail('provider_intent_changed',409);
        const ack=store.receipt(ctx,stable(['wearables-command',key]));
        if(!ack || ack.purged || ack.scope?.connectionId!==connectionId || ack.scope.generation!==generation ||
          ack.fingerprint!==digest({op:'import',page:prior.page,provider}))fail('health_provider_ack_required',409);
        db.prepare('DELETE FROM wearable_provider_intents WHERE account_id=? AND connection_id=? AND generation=? AND stream=?').run(...parameters);
        check();
      }); },
    };
  }
  return {store,providerIntent,healthKitCheckpoint:(binding:HealthKitCheckpointBinding)=>createHealthKitCheckpoint(deps,store,binding)};
}
