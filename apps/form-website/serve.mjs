import {createServer} from 'node:http';
import {readFile, lstat, realpath} from 'node:fs/promises';
import {resolve, join, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.ttf':'font/ttf'};
export async function createStaticServer({root,host,port}) {
  const directory = await realpath(root);
  const server = createServer(async (request,response) => {
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Frame-Options','DENY');
    const sampleDocument = ['/app/sample/', '/app/sample/index.html'].includes((request.url ?? '').split('?')[0]);
    response.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    response.setHeader('X-Robots-Tag','noindex, nofollow');
    response.setHeader('Cache-Control','no-store');
    let status = 404, bytes = Buffer.from('Page not found'), type = types['.html'];
    try {
      const boundPort = server.address()?.port ?? port;
      if (request.headers.host !== `${host}:${boundPort}` || !['GET','HEAD'].includes(request.method)) {
        response.writeHead(400);response.end('Unsupported request');return;
      }
      const raw = (request.url ?? '').split('?')[0];
      const path = decodeURIComponent(raw);
      if (!path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').some(x=>x.startsWith('.')) || path.includes('//')) throw new Error('Unsafe path');
      const relative = path.slice(1) + (path.endsWith('/') ? 'index.html' : '');
      let cursor=directory;
      for(const piece of relative.split('/')) {
        cursor=join(cursor,piece);
        if((await lstat(cursor)).isSymbolicLink()) throw new Error('Symlink');
      }
      if (!(await lstat(cursor)).isFile() || !types[extname(cursor)]) throw new Error('Not static');
      bytes=await readFile(cursor); type=types[extname(cursor)]; status=200;
    } catch {
      try {bytes=await readFile(join(directory,'404.html'));} catch {}
    }
    if (status === 200 && sampleDocument) response.setHeader('Permissions-Policy','camera=(), microphone=(self), geolocation=()');
    response.writeHead(status,{'Content-Type':type,'Content-Length':bytes.length});
    response.end(request.method==='HEAD'?undefined:bytes);
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory,host,portText]=process.argv.slice(2);
  const port=Number(portText);
  if (!directory || !/^100\.\d+\.\d+\.\d+$/.test(host) || !Number.isInteger(port) || port<1024 || port>65535) throw new Error('Require exact Tailscale IPv4 and high port');
  const server=await createStaticServer({root:directory,host,port});
  server.listen(port,host,()=>console.log(JSON.stringify({status:'listening',host,port})));
  for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>server.close(()=>process.exit(0)));
}
