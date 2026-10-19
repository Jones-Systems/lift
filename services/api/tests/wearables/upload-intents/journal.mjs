export function journalFake(){
  let revision=0,fenced=false,record=null;
  const history=[];
  const snapshot=()=>structuredClone({revision:String(revision),fenced,record});
  const journal={
    async load(){history.push({operation:'load'});return snapshot();},
    async compareAndSwap(expected,next,assertCurrent){
      history.push({operation:'cas',expected,next:structuredClone(next)});
      if(fenced||expected!==String(revision))return {status:'conflict',snapshot:snapshot()};
      assertCurrent();
      if(fenced)return {status:'conflict',snapshot:snapshot()};
      record=structuredClone(next);revision++;
      return {status:'committed',snapshot:snapshot()};
    },
    fenceAndScrub(metadata){
      fenced=true;
      const original=record?{binding:record.binding,key:record.key,pageId:record.pageId}:metadata;
      record=original?{...structuredClone(original),phase:'scrubbed'}:null;revision++;
      history.push({operation:'scrub',metadata:structuredClone(original)});
      return Promise.resolve({status:'scrubbed',snapshot:snapshot()});
    },
  };
  return {journal,history,snapshot};
}
