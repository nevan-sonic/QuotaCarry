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
