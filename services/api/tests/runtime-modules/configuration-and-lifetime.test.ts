import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuntimeModules, strictJson } from '../../src/runtime-modules/configuration.js';
import { RuntimeOwner, initializeAuthority, admissionSchema } from '../../src/runtime-modules/admission.js';
import { ledgerSchemaDigest } from '../../src/runtime-modules/currentness.js';
import { canonicalPath, fileDigest } from '../../src/runtime-modules/files.js';
import { runtimeMigrations } from '../../src/runtime-modules/migrations.js';
import { migrations } from '../../src/storage.js';
import { createServer } from '../../src/server.js';
import { deployment, provision, start, readAdmission, origin, secret } from './fixture.js';

test('startup config preflight reports sanitized config and rejects invalid inputs without runtime effects', t => {
  const root = mkdtempSync(join(tmpdir(), 'form-startup-config-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = new URL('../../src/cli.js', import.meta.url);
  const noRuntime = `
    import net from 'node:net';
    import { registerHooks } from 'node:module';
    const unexpected = () => process.exit(97);
    net.Server.prototype.listen = unexpected;
    net.Socket.prototype.connect = unexpected;
    globalThis.fetch = unexpected;
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (['./server.js', './runtime-modules/admission.js', '@hono/node-server', 'better-sqlite3'].includes(specifier))
        unexpected();
      return nextResolve(specifier, context);
    } });
  `;
  const guard = 'data:text/javascript,' + encodeURIComponent(noRuntime);
  const dbPath = join(root, 'data', 'main.sqlite');
  function check(overrides: Record<string, string> = {}, args = ['--check-config']) {
    const child = spawnSync(process.execPath, ['--import', guard, fileURLToPath(cli), ...args], {
      env: { FORM_DATABASE_PATH: dbPath, BETTER_AUTH_SECRET: secret, FORM_BASE_URL: origin, ...overrides },
      encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.notEqual(child.status, 97, 'preflight attempted to load or use runtime resources');
    assert.deepEqual(readdirSync(root), [], 'preflight created database or authority files');
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  }

  const defaults = {
    check: 'startup-config-preflight', valid: true, registration: 'closed', runtimeModulesConfigured: false,
    promosConfigured: false, browserOriginsConfigured: false, googleConfigured: false, appleSignInConfigured: false,
    grokTranscriptionConfigured: false, phoneConfigured: false, applePurchasesConfigured: false,
  };
  function assertSuccess(result: ReturnType<typeof check>, expected: typeof defaults) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  assertSuccess(check(), defaults);

  const modules = {
    version: 1, mode: 'private-modules', authorityDirectory: join(root, 'authority'), authorityId: randomUUID(),
    ownerUid: 1000, publicLifecycle: 'disabled', communityLimiter: 'bounded-single-process-v1',
  };
  assertSuccess(check({
    FORM_HOST: 'preflight-host.invalid',
    FORM_REGISTRATION: JSON.stringify({ mode: 'allowlist', emails: ['preflight@synthetic.invalid'] }),
    FORM_PROMOS: JSON.stringify([{ code: 'TEST_PROMO', entitlement: 'form_plus', days: 7, maxRedemptions: 1, expiresAt: '2099-01-01T00:00:00Z' }]),
    FORM_BROWSER_ORIGINS: JSON.stringify(['https://preflight.synthetic.invalid']),
    FORM_SOCIAL_PROVIDERS: JSON.stringify({ google: { clientId: 'synthetic-client', clientSecret: secret },
      apple: { clientId: 'synthetic-apple-client', clientSecret: secret } }),
    FORM_GROK_STT_ENABLED: 'true',
    FORM_GROK_STT_KEY: secret,
    FORM_PHONE: JSON.stringify({ allowCloudRequests: true, accountSid: 'AC' + 'a'.repeat(32), serviceSid: 'VA' + 'a'.repeat(32),
      apiKeySid: 'SK' + 'a'.repeat(32), apiKeySecret: secret, allowedPhones: ['+12025550100'] }),
    FORM_APPLE_PURCHASES: JSON.stringify({ bundleId: 'invalid.synthetic.form',
      products: [{ productId: 'synthetic.product', type: 'Non-Consumable', entitlement: 'form_plus' }] }),
    FORM_RUNTIME_MODULES: JSON.stringify(modules),
  }), {
    ...defaults, registration: 'allowlist', runtimeModulesConfigured: true, promosConfigured: true,
    browserOriginsConfigured: true, googleConfigured: true, appleSignInConfigured: true,
    grokTranscriptionConfigured: true, phoneConfigured: true, applePurchasesConfigured: true,
  });

  const failure = { status: 1, stdout: '', stderr: 'Form startup config preflight failed\n' };
  assert.deepEqual(check({ FORM_SOCIAL_PROVIDERS: `{"google":{"clientSecret":"${secret}"` }), failure, 'malformed secret-bearing JSON');
  assert.deepEqual(check({ FORM_SOCIAL_PROVIDERS: JSON.stringify({ [secret]: secret }) }), failure, 'schema errors can contain input keys');
  assert.deepEqual(check({ FORM_DATABASE_PATH: fileURLToPath(new URL('./preflight.sqlite', cli)) }), failure, 'database inside source');
  assert.deepEqual(check({ FORM_RUNTIME_MODULES: JSON.stringify({ ...modules, authorityDirectory: fileURLToPath(new URL('./authority', cli)) }) }),
    failure, 'authority inside source');
  assert.deepEqual(check({ FORM_RUNTIME_MODULES: JSON.stringify({ ...modules, authorityDirectory: root }) }), failure, 'authority overlaps database');
  assert.deepEqual(check({}, ['--check-config', 'unexpected']), { status: 1, stdout: '', stderr: 'Usage: cli.js [--check-config]\n' });
});

test('omission keeps ordinary7; strict explicit selects actual contiguous16',()=>{
 assert.equal(parseRuntimeModules(undefined),undefined);assert.equal(migrations.length,7);assert.deepEqual(runtimeMigrations.map(m=>m.version),Array.from({length:16},(_,i)=>i+1));
 for(const value of [null,true,'private-modules',{}, {version:1}]) assert.throws(()=>parseRuntimeModules(value));
});
test('duplicate keys, unknown/trailing/oversized JSON and unsafe identities deny',()=>{
 for(const input of ['{"a":1,"a":2}','{"a":{"x":1,"x":2}}','{}x','[1,]','{"a":01}', ' '.repeat(65537)])assert.throws(()=>strictJson(input));
 assert.deepEqual(strictJson('{"a":[1,{"b":true}]}'),{a:[1,{b:true}]});
 const value={version:1,mode:'private-modules',authorityDirectory:'/safe/authority',authorityId:randomUUID(),ownerUid:1000,publicLifecycle:'disabled',communityLimiter:'bounded-single-process-v1'};
 for(const changes of [{unknown:true},{ownerUid:Number.MAX_SAFE_INTEGER+1},{ownerUid:999},{authorityDirectory:'/safe/../authority'},{authorityDirectory:'relative'},{publicLifecycle:'enabled'}])assert.throws(()=>parseRuntimeModules({...value,...changes},true));
});
test('canonical existing paths reject link aliases, mode and UID mismatch',async t=>{
 const d=await deployment(t);await d.seed.close();const alias=join(d.root,'alias.sqlite');symlinkSync(d.path,alias);assert.throws(()=>canonicalPath(alias,d.configuration.ownerUid));unlinkSync(alias);
 linkSync(d.path,alias);assert.throws(()=>canonicalPath(d.path,d.configuration.ownerUid));unlinkSync(alias);
 chmodSync(d.path,0o644);assert.throws(()=>canonicalPath(d.path,d.configuration.ownerUid));chmodSync(d.path,0o600);
 assert.throws(()=>canonicalPath(d.path,d.configuration.ownerUid+1));
});
test('missing main is never recreated; repeated init is exclusive and partial init held',async t=>{
 const d=await deployment(t);await provision(d);assert.throws(()=>initializeAuthority({configuration:d.configuration,mainPath:d.path,expectedMainDigest:fileDigest(d.path,d.configuration.ownerUid),operationId:randomUUID(),expectedAbsence:true,expectedSchemaDigest:ledgerSchemaDigest}));
 unlinkSync(d.path);assert.throws(()=>new RuntimeOwner(d.configuration,d.path));assert.equal(existsSync(d.path),false);
});
test('runtime and raw source injection cannot be mixed; acquired owner is closed as failed',async t=>{
 const d=await deployment(t);await provision(d);const owner=new RuntimeOwner(d.configuration,d.path);
 await assert.rejects(()=>createServer({dbPath:d.path,baseURL:origin,secret,runtimeOwner:owner,publicStagedLifecycleEnabled:true}));
 assert.throws(()=>owner.assert());assert.equal(readAdmission(d).state,'opening');
});
for(const point of ['server:before-open','server:factories','server:auth-schema','server:lifecycle','owner:opening','owner:main','barrier:canonical','barrier:community','barrier:before-commit','barrier:after-commit','running-admission:before-fsync','running-admission:after-rename'])test(`startup acquisition failure ${point} stays nonclean and closes handles`,async t=>{
 const d=await deployment(t);await provision(d);await assert.rejects(()=>start(d,{fault:p=>{if(p===point)throw new Error('synthetic crash seam');}}));
 assert.notEqual(readAdmission(d).state,'closed_clean');assert.ok(existsSync(join(d.configuration.authorityDirectory,'owner.lock')));
});
test('normal close checkpoints exact closed bytes and repeat close is harmless; app cannot serve afterward',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d);await server.close();await server.close();
 assert.equal(readAdmission(d).state,'closed_clean');assert.equal(readAdmission(d).closedDigest,fileDigest(d.path,d.configuration.ownerUid));
 assert.equal((await server.app.request('/health')).status,503);assert.equal((await server.handleRequest(new Request(origin+'/health'),'synthetic')).status,503);
});
test('unknown sidecar and independently changed candidate hold before writable opening',async t=>{
 const d=await deployment(t);await provision(d);writeFileSync(d.path+'-wal','synthetic-unknown');assert.throws(()=>new RuntimeOwner(d.configuration,d.path));
});

test('synthetic listener activation failure closes the actual owner and never records clean admission',async t=>{
 const d=await deployment(t);await provision(d);const {server,owner}=await start(d);
 const {startListener}=await import('../../src/runtime-modules/composition.js');
 await assert.rejects(()=>startListener(server,()=>{throw new Error('synthetic no listener acquired');}));
 assert.equal(server.db.open,false);assert.throws(()=>owner.assertServing());assert.equal(readAdmission(d).state,'running');
});

for(const point of ['init:directory','init:ledger','init:witness','init:admission'])test(`partial exclusive init at ${point} is retained and never resumed as first use`,async t=>{
 const d=await deployment(t);await d.seed.close();const input={configuration:d.configuration,mainPath:d.path,expectedMainDigest:fileDigest(d.path,d.configuration.ownerUid),operationId:randomUUID(),expectedAbsence:true as const,expectedSchemaDigest:ledgerSchemaDigest};
 assert.throws(()=>initializeAuthority(input,p=>{if(p===point)throw new Error('synthetic provisioning failure');}));
 assert.ok(existsSync(join(d.configuration.authorityDirectory,'owner.lock')));assert.throws(()=>initializeAuthority(input));assert.throws(()=>new RuntimeOwner(d.configuration,d.path));
});

test('qualified offline storage uses the same exclusive current authority and preserves clean main provenance',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d);const {operateClosedStorage}=await import('../../src/runtime-modules/storage-operations.js');
 await assert.rejects(()=>operateClosedStorage({configuration:d.configuration,mainPath:d.path,expectedClosedDigest:readAdmission(d).closedDigest as string,action:'check'}));
 await server.close();const before=readAdmission(d);await operateClosedStorage({configuration:d.configuration,mainPath:d.path,expectedClosedDigest:before.closedDigest as string,action:'backup',destination:join(d.root,'backups','qualified-backup.sqlite')});
 assert.equal(existsSync(join(d.root,'backups','qualified-backup.sqlite')),true);assert.deepEqual(readAdmission(d),before);assert.equal(fileDigest(d.path,d.configuration.ownerUid),before.closedDigest);
});

test('historical13 admission cannot authorize current16 or rewrite authority; overflow17 is rejected',async t=>{
 const d=await deployment(t);await provision(d);
 const current=readAdmission(d), path=join(d.configuration.authorityDirectory,'admission.json');
 const digests=current.migrationDigests as string[];
 assert.equal(digests.length,16);
 assert.equal(admissionSchema.safeParse({...current,migrationDigests:[...digests,'a'.repeat(64)]}).success,false);
 assert.equal(admissionSchema.safeParse({...current,appliedDigests:[...digests,'a'.repeat(64)]}).success,false);
 const historical={...current,migrationDigests:digests.slice(0,13)};
 assert.equal(admissionSchema.safeParse(historical).success,false);
 writeFileSync(path,JSON.stringify(historical));
 const before=readFileSync(path),main=fileDigest(d.path,d.configuration.ownerUid);
 assert.throws(()=>new RuntimeOwner(d.configuration,d.path));
 assert.deepEqual(readFileSync(path),before);assert.equal(fileDigest(d.path,d.configuration.ownerUid),main);
});
