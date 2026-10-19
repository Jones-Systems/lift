import type { AccountContext, Connection, ImportChannel, ImportResult, Measure, ReceiptScope, RootPorts, StoredMeasure } from './types.js';
import { day, digest, fail, integer, metric, object, page, stable, text } from './validation.js';
import { suggestionCommand } from './suggestions.js';

export function createWearablesService(root: RootPorts) {
  function active(ctx:AccountContext) { root.assertActive(ctx); if(!root.enabled?.()) fail('health_not_configured',503); }
  function connection(ctx:AccountContext,id:string,generation?:number):Connection {
    const c=root.store.connection(ctx,id); if(!c) return fail('health_not_found',404);
    if(generation!==undefined && c.generation!==generation) fail('health_connection_changed',409);
    return c;
  }
  function receipt<T>(ctx:AccountContext,key:string,intent:unknown,effect:()=>T,scope:ReceiptScope|null=null):T {
    const ledgerKey=stable(['wearables-command',text(key)]);
    const fingerprint=digest(intent), prior=root.store.receipt(ctx,ledgerKey);
    if(prior) { if(prior.fingerprint!==fingerprint) fail('health_key_reuse',409); if(prior.purged) fail('health_receipt_purged',409); return structuredClone(prior.result) as T; }
    const result=effect(); root.store.putReceipt(ctx,ledgerKey,{fingerprint,scope,result:structuredClone(result)}); return result;
  }
  function compare(previous:Measure['revision'], next:Measure['revision'], equal:boolean):'duplicate'|'older'|'new' {
    if(previous.token===next.token) { if(!equal) fail('health_source_conflict',409); return 'duplicate'; }
    if(previous.order===null||next.order===null) fail('health_revision_order_unknown',409);
    if(next.order<previous.order) return 'older';
    if(next.order===previous.order) { if(!equal) fail('health_source_conflict',409); return 'duplicate'; }
    return 'new';
  }
  return {
    capabilities() { return {status:root.enabled?.()?'configured_unverified':'not_configured', aiUse:'excluded',
      google:{status:'unavailable',reason:'iphone_route_and_new_cloud_project_unavailable'}, suggestions:root.plans&&root.assertSuggestionAllowed?root.plans.capability:'unavailable'} as const; },
    connectHealthKit(ctx:AccountContext,key:string,input:unknown) {
      active(ctx); root.assertImportAllowed(ctx,'healthkit');
      const v=object(input,['connectionId','types','consentVersion','retentionConsent']);
      if(v.retentionConsent!==true || !Array.isArray(v.types)||!v.types.length||v.types.length>12) fail('health_consent_required',403);
      const id=text(v.connectionId), types=[...new Set(v.types.map(metric))],consentVersion=text(v.consentVersion);
      return root.withActiveWrite(ctx,()=>{ active(ctx); root.assertImportAllowed(ctx,'healthkit');
        return receipt(ctx,key,{op:'connect',id,types,consentVersion},()=>{
          const old=root.store.connection(ctx,id); if(old && old.provider!=='healthkit') fail('health_not_found',404);
          if(old?.connected) fail('health_already_connected',409);
          const c:Connection={id,provider:'healthkit',generation:(old?.generation??0)+1,connected:true,types,consentVersion,retentionConsent:true,lastImportAt:null};
          root.store.putConnection(ctx,c); return c;
        },{connectionId:id,generation:(root.store.connection(ctx,id)?.generation??0)+1});
      });
    },
    ingest(ctx:AccountContext,key:string,input:unknown,channel:ImportChannel={provider:'healthkit'}):ImportResult {
      active(ctx); root.assertImportAllowed(ctx,channel.provider);
      // Privacy gate precedes normalization, fingerprints, receipts and any retained payload.
      const p=page(input);
      return root.withActiveWrite(ctx,()=>{
        active(ctx); root.assertImportAllowed(ctx,channel.provider);
        const c=connection(ctx,p.connectionId,p.generation);
        if(c.provider!==channel.provider) fail('health_route_mismatch',403);
        if(!c.connected||!c.retentionConsent) fail('health_consent_required',403);
        if(p.batch.some(v=>!c.types.includes(v.metric))) fail('health_type_not_consented',403);
        return receipt(ctx,key,{op:'import',page:p,provider:channel.provider},()=>{
          const pageKey=stable(['wearables-page',c.id,c.generation,p.stream,p.pageId]);
          const pageDigest=digest(p), previousPage=root.store.receipt(ctx,pageKey);
          if(previousPage){if(previousPage.fingerprint!==pageDigest)fail('health_key_reuse',409);if(previousPage.purged)fail('health_receipt_purged',409);return structuredClone(previousPage.result) as ImportResult;}
          if(root.store.cursor(ctx,c.id,c.generation,p.stream)!==p.fromCursor) fail('health_cursor_conflict',409);
          let accepted=0,duplicates=0;
          for(const value of p.batch) {
            const fingerprint=digest(value),old=root.store.measure(ctx,c.id,c.generation,value.id);
            if(old) {
              if(old.deleted) { duplicates++; continue; } // Restoration needs a new source incarnation/id.
              if(compare(old.revision,value.revision,old.digest===fingerprint)!=='new') {duplicates++;continue;}
            }
            root.store.putMeasure(ctx,{...value,connectionId:c.id,generation:c.generation,provider:c.provider,
              importedAt:root.now(),digest:fingerprint,aiEligible:false,provenance:'unqualified_import',deleted:false}); accepted++;
          }
          for(const tombstone of p.tombstones) {
            const old=root.store.measure(ctx,c.id,c.generation,tombstone.id);
            if(old && compare(old.revision,tombstone.revision,old.deleted)!=='new') {duplicates++;continue;}
            const tomb:StoredMeasure={id:tombstone.id,metric:old?.metric??'steps',value:0,unit:old?.unit??'count',
              start:null,end:null,day:old?.day??root.now().slice(0,10),zone:null,aggregation:old?.aggregation??'sum',
              source:{bundleId:'deleted',name:'deleted',device:null,algorithm:null,originalId:null},revision:tombstone.revision,
              quality:'unknown',connectionId:c.id,generation:c.generation,provider:c.provider,importedAt:root.now(),
              digest:digest(tombstone),aiEligible:false,provenance:'unqualified_import',deleted:true};
            root.store.putMeasure(ctx,tomb); accepted++;
          }
          if(accepted) for(const s of root.store.suggestions(ctx)) {
            if(s.state==='pending' && s.evidenceRefs.some(ref=>ref.connectionId===c.id &&
              root.store.measure(ctx,c.id,ref.generation,ref.id)?.digest!==ref.digest)) root.store.putSuggestion(ctx,{...s,state:'invalidated'});
          }
          root.store.putCursor(ctx,c.id,c.generation,p.stream,p.nextCursor);
          root.store.putConnection(ctx,{...c,lastImportAt:root.now()});
          const result={accepted,duplicates,cursor:p.nextCursor,pageId:p.pageId};
          root.store.putReceipt(ctx,pageKey,{fingerprint:pageDigest,scope:{connectionId:c.id,generation:c.generation},result});return result;
        },{connectionId:p.connectionId,generation:p.generation});
      });
    },
    authorizeImport(ctx:AccountContext,provider:ImportChannel['provider'],id:string,generation:number) {
      active(ctx);root.assertImportAllowed(ctx,provider);const c=connection(ctx,id,generation);
      if(c.provider!==provider)fail('health_route_mismatch',403);
      if(!c.connected||!c.retentionConsent)fail('health_consent_required',403);
    },
    connections(ctx:AccountContext) { active(ctx); return root.store.connections(ctx); },
    summary(ctx:AccountContext,from:string,to:string) {
      active(ctx); day(from);day(to);if(from>to) fail('health_invalid_window');
      const rows=root.store.measures(ctx,from,to,1001);if(rows.length>1000) fail('health_summary_limit',413);
      const candidates=rows.filter(v=>!v.deleted && root.store.connection(ctx,v.connectionId)?.connected && root.store.connection(ctx,v.connectionId)?.generation===v.generation);
      const groups=new Map<string,StoredMeasure[]>();
      for(const v of candidates) {
        const group=stable([v.day,v.metric,v.aggregation,v.source.algorithm]);
        groups.set(group,[...(groups.get(group)??[]),v]);
      }
      return {items:[...groups.values()].map(values=>{
        values.sort((a,b)=>a.connectionId.localeCompare(b.connectionId)||a.id.localeCompare(b.id));
        const first=values[0]!;
        const proof=values.length>1 && values.every(v=>!!root.alias?.(ctx,v)&&root.alias?.(ctx,v)===root.alias?.(ctx,first));
        const equivalent=values.every(v=>v.value===first.value&&v.unit===first.unit&&v.start===first.start&&v.end===first.end);
        return {selected:first,alternatives:values.slice(1),status:values.length===1?'selected':proof&&equivalent?'proven_duplicate':'conflict',
          reason:values.length===1?'only_candidate':proof&&equivalent?'trusted_original_identity':'overlap_is_not_identity',
          aiEligible:false as const,freshness:first.end===null||Date.parse(first.end)>Date.parse(root.now())?'unknown':Date.parse(root.now())-Date.parse(first.end)>36*3600000?'stale':'recent',
          freshnessPolicy:'display_age_36h_not_physiology'};
      }),aiEligible:false as const};
    },
    coachInputs(ctx:AccountContext):never[] { active(ctx); return []; },
    disconnect(ctx:AccountContext,key:string,input:unknown) {
      active(ctx);const v=object(input,['connectionId','generation']);const id=text(v.connectionId),gen=integer(v.generation);
      return root.withActiveWrite(ctx,()=>{active(ctx);
        return receipt(ctx,key,{op:'disconnect',id,gen},()=>{
          const c=connection(ctx,id,gen);
          root.store.putConnection(ctx,{...c,generation:c.generation+1,connected:false,retentionConsent:false});
          root.store.purgeConnection(ctx,id);
          for(const s of root.store.suggestions(ctx)) if(s.state==='pending'&&s.evidenceRefs.some(r=>r.connectionId===id)) root.store.putSuggestion(ctx,{...s,state:'invalidated'});
          return {disconnected:true,purged:true,remoteRevocation:c.provider==='healthkit'?'not_applicable':'pending'};
        },{connectionId:id,generation:gen});
      });
    },
    suggestions(ctx:AccountContext) {active(ctx);return root.store.suggestions(ctx);},
    suggestion(ctx:AccountContext,key:string,id:string,kind:'accept'|'reject'|'undo',input:unknown) {
      active(ctx);return root.withActiveWrite(ctx,()=>{active(ctx);return suggestionCommand(root,ctx,key,id,kind,input,receipt);});
    },
    expireProposalRetention(ctx:AccountContext,approvedDays:120) {
      active(ctx); if(approvedDays!==120) fail('health_retention_policy_unqualified',403);
      return root.withActiveWrite(ctx,()=>{active(ctx);const removed=root.store.purgeBefore(ctx,new Date(Date.parse(root.now())-120*86400000).toISOString());
        for(const s of root.store.suggestions(ctx))if(s.state==='pending'&&s.evidenceRefs.some(r=>!root.store.measure(ctx,r.connectionId,r.generation,r.id)))root.store.putSuggestion(ctx,{...s,state:'invalidated'});return removed;});
    },
  };
}
export type WearablesService = ReturnType<typeof createWearablesService>;
