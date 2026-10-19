import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStaticServer} from '../serve.mjs';

test('generated-only server blocks private paths, traversal, symlinks and unsafe methods', async()=>{
  const fixture=await mkdtemp(join(tmpdir(),'form-web-static-'));
  let server;
  try {
    await writeFile(join(fixture,'index.html'),'PUBLIC');
    await writeFile(join(fixture,'404.html'),'NOT FOUND');
    await writeFile(join(fixture,'.secret'),'SECRET');
    await writeFile(join(fixture,'source.ts'),'PRIVATE SOURCE');
    await mkdir(join(fixture,'app','sample'),{recursive:true});
    await writeFile(join(fixture,'app','sample','index.html'),'FICTIONAL SAMPLE');
    await symlink(join(fixture,'.secret'),join(fixture,'leak.html'));
    server=await createStaticServer({root:fixture,host:'127.0.0.1',port:0});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const good=await fetch(base+'/');assert.equal(good.status,200);assert.equal(await good.text(),'PUBLIC');
    assert.match(good.headers.get('permissions-policy'),/camera=\(\)/);
    assert.match(good.headers.get('permissions-policy'),/microphone=\(\)/);
    for(const route of ['/app/sample/','/app/sample/index.html','/app/sample/?scenario=normal']){
      const sample=await fetch(base+route);assert.equal(sample.status,200);
      assert.equal(sample.headers.get('permissions-policy'),'camera=(), microphone=(self), geolocation=()');
    }
    for(const route of ['/app/','/app/sample-other/','/assets/member-coach/coach-screen.mjs']){
      assert.match((await fetch(base+route)).headers.get('permissions-policy'),/microphone=\(\)/);
    }
    await rm(join(fixture,'app','sample','index.html'));
    const missingSample=await fetch(base+'/app/sample/');assert.equal(missingSample.status,404);
    assert.match(missingSample.headers.get('permissions-policy'),/microphone=\(\)/);
    await writeFile(join(fixture,'app','sample','index.html'),'FICTIONAL SAMPLE');
    assert.match(good.headers.get('content-security-policy'),/script-src 'self'/);
    for(const route of ['/.secret','/source.ts','/leak.html','/unknown/','/%2e%2e/secret','/%252e%252e/secret','/%2f%2fsecret']){
      const r=await fetch(base+route);assert.equal(r.status,404,route);assert.equal(await r.text(),'NOT FOUND');
    }
    assert.equal((await fetch(base+'/',{method:'POST',body:'synthetic'})).status,400);
    const head=await fetch(base+'/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    await rm(fixture,{recursive:true,force:true});
  }
});
