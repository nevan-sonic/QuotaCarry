import assert from 'node:assert/strict';
import test from 'node:test';
import { JobStore } from './jobs.js';
import { createGroqProvider, ProviderError } from './groq.js';
import { createChallenge, verifyNearMessage } from './near-message.js';

test('durable job state rejects duplicate execution and concurrent token jobs', () => {
  const store = new JobStore(':memory:');
  try {
    assert.equal(store.enqueue('first','alice','0','request')?.id,'first');
    assert.equal(store.enqueue('second','alice','0','request')?.id,'first');
    assert.throws(()=>store.enqueue('other','bob','0','another'));
    assert.equal(store.transition('first','queued','reserving'),true);
    assert.equal(store.transition('first','queued','reserving'),false);
    assert.equal(store.consumeNonce('nonce',100,50),true);
    assert.equal(store.consumeNonce('nonce',100,50),false);
    assert.equal(store.consumeNonce('expired',40,50),false);
  } finally {store.close();}
});

test('Groq adapter distinguishes rejected and ambiguous requests without leaking response bodies', async () => {
  const rejected = createGroqProvider('test','model',async()=>new Response('private',{status:429}));
  await assert.rejects(()=>rejected('hello'),(error:unknown)=>error instanceof ProviderError&&error.outcome==='rejected'&&!error.message.includes('private'));
  const ambiguous = createGroqProvider('test','model',async()=>{throw Error('private');});
  await assert.rejects(()=>ambiguous('hello'),(error:unknown)=>error instanceof ProviderError&&error.outcome==='ambiguous'&&!error.message.includes('private'));
});

test('expired challenges and malformed keys fail closed', () => {
  const challenge = createChallenge('alice.testnet','quotacarry.test',0);
  assert.equal(verifyNearMessage(challenge,'ed25519:invalid','invalid',0),false);
  assert.equal(verifyNearMessage(challenge,'ed25519:invalid','invalid',challenge.expiresAt),false);
});
