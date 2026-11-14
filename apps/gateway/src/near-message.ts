import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(text: string) {
  if (!text || text.length > 44) throw Error('Invalid public key');
  let number = 0n;
  for (const char of text) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw Error('Invalid public key');
    number = number * 58n + BigInt(digit);
  }
  const hex = number.toString(16);
  return Buffer.concat([
    Buffer.alloc(text.match(/^1*/)?.[0].length ?? 0),
    number === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? '0'+hex : hex, 'hex'),
  ]);
}

function string(value: string) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length,bytes]);
}

export function createChallenge(accountId: string, audience: string, now = Date.now()) {
  const nonce = randomBytes(32);
  const expiresAt = now + 120_000;
  return {
    accountId, audience, expiresAt, nonce: nonce.toString('base64'),
    message: JSON.stringify({purpose:'QuotaCarry inference authentication',accountId,audience,expiresAt,nonce:nonce.toString('base64')}),
  };
}

export function verifyNearMessage(
  challenge: ReturnType<typeof createChallenge>,
  publicKey: string,
  signature: string,
  now = Date.now(),
) {
  try {
    if (now >= challenge.expiresAt || !publicKey.startsWith('ed25519:') || signature.length > 88) return false;
    const key = base58(publicKey.slice(8));
    const proof = Buffer.from(signature,'base64');
    const nonce = Buffer.from(challenge.nonce,'base64');
    if (key.length !== 32 || proof.length !== 64 || nonce.length !== 32) return false;
    const tag = Buffer.alloc(4);
    tag.writeUInt32LE(2**31+413);
    const bytes = Buffer.concat([tag,string(challenge.message),nonce,string(challenge.audience),Buffer.from([0])]);
    const digest = createHash('sha256').update(bytes).digest();
    const verifier = createPublicKey({
      key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key]),
      type:'spki',format:'der',
    });
    return verify(null,digest,verifier,proof);
  } catch { return false; }
}
