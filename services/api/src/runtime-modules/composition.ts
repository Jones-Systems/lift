import type { FormServer } from '../server.js';
export async function startListener<T>(server:FormServer,open:(server:FormServer)=>T):Promise<T> {
  try { return open(server); }
  catch(error) {
    try { await server.close(false); }
    catch(closeError) { throw new AggregateError([error,closeError],'Listener activation and closure failed'); }
    throw error;
  }
}
