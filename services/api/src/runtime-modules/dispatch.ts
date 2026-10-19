export type CommunityNamespace = 'board' | 'extension' | 'parent';
const extensions = [
  ['GET',/^\/me\/(?:matching|blocks|reports|safety-notices|appeals)$/],
  ['POST',/^\/me\/matching\/(?:enroll|cancel)$/], ['PATCH',/^\/me\/matching$/],
  ['GET',/^\/groups\/[^/]+\/(?:policy|profiles|posts|motions|rankings)$/],
  ['GET',/^\/groups\/[^/]+\/me\/profile-sharing$/], ['PATCH',/^\/groups\/[^/]+\/me\/profile-sharing$/],
  ['POST',/^\/groups\/[^/]+\/(?:posts|motions)$/],
  ['POST',/^\/groups\/[^/]+\/posts\/[^/]+\/(?:hide|react)$/],
  ['POST',/^\/groups\/[^/]+\/motions\/[^/]+\/ballot$/], ['POST',/^\/groups\/[^/]+\/members\/[^/]+\/block$/],
  ['POST',/^\/me\/blocks\/[^/]+\/unblock$/], ['POST',/^\/reports$/], ['POST',/^\/me\/safety-notices\/[^/]+\/appeal$/],
] as const;
const parents = [
 ['GET',/^\/me\/removed-memberships$/],
 ['GET',/^\/groups(?:\/[^/]+)?$/], ['POST',/^\/groups$/], ['PATCH',/^\/groups\/[^/]+$/],
 ['GET',/^\/groups\/[^/]+\/(?:invitations|summary)$/], ['POST',/^\/groups\/[^/]+\/invitations$/],
 ['POST',/^\/invitations\/(?:preview|join)$/], ['POST',/^\/groups\/[^/]+\/invitations\/[^/]+\/(?:revoke|replace)$/],
 ['GET',/^\/groups\/[^/]+\/me\/sharing$/], ['PATCH',/^\/groups\/[^/]+\/me\/sharing$/],
 ['POST',/^\/groups\/[^/]+\/me\/withdraw$/], ['PATCH',/^\/groups\/[^/]+\/me$/],
 ['POST',/^\/groups\/[^/]+\/(?:leave|close)$/], ['POST',/^\/groups\/[^/]+\/members\/[^/]+\/(?:remove|allow-reinvite)$/],
 ['PATCH',/^\/groups\/[^/]+\/members\/[^/]+\/role$/],
] as const;
export function communityNamespace(path:string,method:string):CommunityNamespace|null {
 if(path==='/board'||path.startsWith('/board/')) return 'board';
 if(extensions.some(([verb,pattern])=>verb===method&&pattern.test(path))) return 'extension';
 if(parents.some(([verb,pattern])=>verb===method&&pattern.test(path))) return 'parent';
 return null;
}
export function requiresTextPort(path:string,method:string):boolean {
 return (method==='POST' && (path==='/groups'||path==='/invitations/join'||path==='/me/matching/enroll')) ||
  (method==='PATCH' && (path==='/me/matching'||/^\/groups\/[^/]+(?:\/me)?$/.test(path)));
}
