import type { Measure } from '../types.js';
import { fail, object, text } from '../validation.js';
import { disabledAdmission, perform } from './http.js';
import type { AuthorizedHttp, ExternalAdmission } from './http.js';
export interface ApprovedGarminHealthContract {
  revision:string;
  // Exact enrolled transport+decoder is supplied by root after private specification qualification.
  readPage(cursor:string|null):Promise<unknown>;
  decode(input:unknown):{records:Measure[];nextToken:string|null};
}
export function createGarminPort(input:{http:AuthorizedHttp;accessSecretRef:string;admission?:ExternalAdmission;now:()=>number;
  healthContract?:ApprovedGarminHealthContract;decodePermissions?:(body:unknown)=>string[]}) {
  const admission=input.admission??disabledAdmission;
  const read=async(path:string)=>perform(input.http,admission,'garmin','registration',{method:'GET',url:'https://apis.garmin.com/wellness-api/rest/user/'+path,
    headers:{Accept:'application/json'},bearerSecretRef:input.accessSecretRef},input.now());
  return {
    async userId(){const r=await read('id');return {userId:text(object(r.body).userId)};},
    async permissions(){
      // Public PDF's example is not valid JSON; don't invent a production response shape.
      if(!input.decodePermissions)fail('garmin_permissions_decoder_required',503);
      const r=await read('permissions');const permissions=input.decodePermissions!(r.body);
      if(!Array.isArray(permissions)||permissions.length>100)fail('garmin_invalid_permissions');return permissions.map(p=>text(p));
    },
    async deregister(){await perform(input.http,admission,'garmin','deregister',{method:'DELETE',url:'https://apis.garmin.com/wellness-api/rest/user/registration',
      headers:{Accept:'application/json'},bearerSecretRef:input.accessSecretRef},input.now());return {remoteDeregistration:'confirmed'} as const;},
    async readHealth(cursor:string|null){
      admission.assertAllowed('garmin','read_only_import');admission.assertCurrent();
      if(!input.healthContract)fail('garmin_approved_payload_contract_required',503);
      const response=await input.healthContract!.readPage(cursor);admission.assertCurrent();return input.healthContract!.decode(response);
    },
  };
}
