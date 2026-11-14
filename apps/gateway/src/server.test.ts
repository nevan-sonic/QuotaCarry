import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { readConfig } from './config.js';
import { createGateway } from './server.js';

test('configuration validates without returning the offending value', () => {
  assert.equal(readConfig({}).port, 3001);
  assert.throws(() => readConfig({ GATEWAY_PORT: '65536' }), /GATEWAY_PORT/);
});

test('serves local readiness and safe correlated errors', async (context) => {
  const entries: Record<string, unknown>[] = [];
  const gateway = createGateway((entry) => entries.push(entry));
  context.after(() => gateway.drain());
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const address = gateway.server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await fetch(origin + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ready: true });
  const missing = await fetch(origin + '/missing?secret=private-canary', {
    headers: { authorization: 'Bearer private-canary' },
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { code: 'NOT_FOUND', requestId: missing.headers.get('x-request-id') });
  assert.equal(entries.length, 2);
  assert(!JSON.stringify(entries).includes('private-canary'));
});

test('reports unavailable on an established connection during shutdown', async (context) => {
  const gateway = createGateway();
  context.after(() => gateway.drain());
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const address = gateway.server.address();
  assert(address && typeof address !== 'string');

  // Trigger draining after Node accepts this request but before the route runs.
  gateway.server.prependOnceListener('request', () => gateway.drain());
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ready: false });
});

test('unconfigured inference returns an explicit readiness failure', async (context) => {
  const gateway = createGateway();
  context.after(() => gateway.drain());
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const address = gateway.server.address();
  assert(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{inference:'not_configured'});
});

test('configured API binds a challenge to the app origin and rejects invalid proofs', async (context) => {
  const { createInferenceApi } = await import('./api.js');
  const origin='http://127.0.0.1:3010';
  const api=createInferenceApi({
    QC_DB:':memory:',QC_ORIGIN:origin,QC_POLICY_ID:'0',GROQ_MODEL:'test-model',GROQ_API_KEY:'test-only',
    QC_RELAYER_KEY:'ed25519:'+'1'.repeat(32),QC_SETTLER_KEY:'ed25519:'+'1'.repeat(32),
  });
  assert(api);
  const gateway=createGateway(undefined,api);
  context.after(()=>gateway.drain());
  gateway.server.listen(0,'127.0.0.1');
  await once(gateway.server,'listening');
  const address=gateway.server.address();
  assert(address&&typeof address!=='string');
  const endpoint='http://127.0.0.1:'+address.port;
  const submit=(path:string,value:object,from=origin)=>fetch(endpoint+path,{
    method:'POST',headers:{origin:from,'Content-Type':'application/json'},body:JSON.stringify(value),
  });
  assert.equal((await submit('/v1/challenge',{account:'alice.testnet'},'https://untrusted.example')).status,403);
  const response=await submit('/v1/challenge',{account:'alice.testnet'});
  assert.equal(response.status,201);
  const challenge=await response.json();
  assert.equal(challenge.audience,'127.0.0.1');
  assert.equal(JSON.parse(challenge.message).network,'testnet');
  assert.equal(JSON.parse(challenge.message).action,'inference');
  assert.equal((await submit('/v1/session',{accountId:'alice.testnet',nonce:challenge.nonce,publicKey:'invalid',signature:'invalid'})).status,401);
  assert.equal((await submit('/v1/inference',{tokenId:'0',prompt:'hello'})).status,401);
});
