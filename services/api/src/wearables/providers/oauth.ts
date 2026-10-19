import { createHash } from 'node:crypto';
import { fail, text } from '../validation.js';
import { disabledAdmission, perform, ProviderFailure, tokenResponse } from './http.js';
import type { AuthorizedHttp, ExternalAdmission, TokenResponse } from './http.js';
export type OAuthProvider='oura'|'garmin';
export interface OAuthVault {
  // Lease is durable and exclusive across workers; owner validates account/session/connection generation.
  begin(kind:'code'|'refresh',operationId:string):{id:string;secretRef:string;redirectUri:string|null};
  commit(leaseId:string,tokens:TokenResponse):{accessSecretRef:string;version:number};
  unknown(leaseId:string):void;
  rejected(leaseId:string):void;
}
const urls={oura:{authorize:'https://cloud.ouraring.com/oauth/authorize',token:'https://api.ouraring.com/oauth/token'},
  garmin:{authorize:'https://connect.garmin.com/oauth2Confirm',token:'https://connectapi.garmin.com/di-oauth2-service/oauth/token'}};
export function authorizationUrl(provider:OAuthProvider,input:{clientId:string;redirectUri:string;state:string;verifier:string;scopes:string[]}):string {
  if(!/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)||input.state.length<32)fail('provider_pkce_invalid');
  if(!input.redirectUri.startsWith('https://'))fail('provider_redirect_invalid');
  if(provider==='oura'&&(!input.scopes.length||input.scopes.some(s=>!['daily','workout'].includes(s))))fail('provider_scope_invalid');
  if(provider==='garmin'&&input.scopes.length)fail('provider_scopes_fixed');
  const u=new URL(urls[provider].authorize);u.search=new URLSearchParams({response_type:'code',client_id:text(input.clientId),redirect_uri:input.redirectUri,
    state:input.state,code_challenge:createHash('sha256').update(input.verifier).digest('base64url'),code_challenge_method:'S256',
    ...(provider==='oura'?{scope:input.scopes.join(' ')}:{})}).toString();return u.href;
}
export function createProviderOAuth(input:{provider:OAuthProvider;clientId:string;clientSecretRef:string;http:AuthorizedHttp;vault:OAuthVault;
  admission?:ExternalAdmission;now:()=>number;consumeCallback:(state:string,code:string)=>{operationId:string;verifierRef:string;redirectUri:string}}) {
  const admission=input.admission??disabledAdmission;
  async function exchange(kind:'code'|'refresh',operationId:string,code?:string,verifierRef?:string,redirectUri?:string) {
    admission.assertAllowed(input.provider,'oauth');admission.assertCurrent();
    const lease=input.vault.begin(kind,operationId);
    try {
      const response=await perform(input.http,admission,input.provider,'oauth',{method:'POST',url:urls[input.provider].token,
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        form:{grant_type:kind==='code'?'authorization_code':'refresh_token',client_id:input.clientId,
          ...(kind==='code'?{code:code!,redirect_uri:redirectUri!}:{})},
        secretFormFields:{client_secret:input.clientSecretRef,...(kind==='code'?{code_verifier:verifierRef!}:{refresh_token:lease.secretRef})}},input.now());
      const tokens=tokenResponse(response.body);
      // CAS, encrypted token replacement and lease completion are one root-owned effect.
      return input.vault.commit(lease.id,tokens);
    } catch(e) {
      if(e instanceof ProviderFailure&&e.effect==='none')input.vault.rejected(lease.id);else input.vault.unknown(lease.id);
      throw e;
    }
  }
  return {
    completeCode(state:string,code:string){admission.assertAllowed(input.provider,'oauth');admission.assertCurrent();
      const bound=input.consumeCallback(text(state),text(code,2048));return exchange('code',bound.operationId,code,bound.verifierRef,bound.redirectUri);},
    refresh(operationId:string){return exchange('refresh',text(operationId));},
  };
}
