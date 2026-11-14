import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {D1Database} from '@cloudflare/workers-types';

const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
export type Entitlement = {owner_id:string; issuer_id:string; policy_id:string; epoch:string; available:string};
type Credential = {
  id:string; account:string; nft:string; issuer:string; policy:string; epoch:string;
  name:string; model:string; expires:number; revoked:number|null;
};

export function matchesEntitlement(token: Credential, pass: Entitlement | null, now = Date.now()) {
  return token.revoked === null && token.expires > now && pass !== null &&
    pass.owner_id === token.account && pass.issuer_id === token.issuer &&
    pass.policy_id === token.policy && pass.epoch === token.epoch;
}

export async function mintDeveloperToken(db:D1Database, account:string, nft:string, name:string, model:string, pass:Entitlement, ttlMinutes=1440) {
  if (pass.owner_id !== account || BigInt(pass.available) < 1n) throw Error('Entitlement unavailable');
  const token = 'qc_'+randomBytes(32).toString('base64url');
  const id = randomUUID(), now = Date.now(), expires = now+ttlMinutes*60000;
  const result = await db.prepare(`INSERT INTO qc_developer_tokens(digest,id,account,nft,issuer,policy,epoch,name,model,expires,revoked)
    SELECT ?,?,?,?,?,?,?,?,?,?,NULL WHERE
    (SELECT count(*) FROM qc_developer_tokens WHERE account=? AND expires>?) < 10`)
    .bind(digest(token),id,account,nft,pass.issuer_id,pass.policy_id,pass.epoch,name,model,expires,account,now).run();
  return result.meta.changes === 1 ? {id,token,expires,scope:'chat:write',nft,model} : null;
}

export function readDeveloperToken(db:D1Database, authorization:string|null) {
  const token = authorization?.match(/^Bearer (qc_[A-Za-z0-9_-]{43})$/)?.[1];
  return token ? db.prepare('SELECT * FROM qc_developer_tokens WHERE digest=?').bind(digest(token)).first<Credential>() : Promise.resolve(null);
}

export async function rotateDeveloperToken(db:D1Database,account:string,previous:string,pass:Entitlement){
  const token='qc_'+randomBytes(32).toString('base64url'), id=randomUUID(), now=Date.now();
  const result=await db.prepare(`INSERT INTO qc_developer_tokens(digest,id,account,nft,issuer,policy,epoch,name,model,expires,revoked,rotated_from)
    SELECT ?,?,account,nft,issuer,policy,epoch,name,model,expires,NULL,id FROM qc_developer_tokens
    WHERE id=? AND account=? AND issuer=? AND policy=? AND epoch=? AND revoked IS NULL AND expires>?
    RETURNING id,nft,model,expires`).bind(digest(token),id,previous,account,pass.issuer_id,pass.policy_id,pass.epoch,now)
    .first<{id:string;nft:string;model:string;expires:number}>();
  return result?{...result,token}:null;
}

export function revokeDeveloperToken(db:D1Database, account:string, id:string) {
  return db.prepare('UPDATE qc_developer_tokens SET revoked=? WHERE account=? AND id=? AND revoked IS NULL')
    .bind(Date.now(),account,id).run();
}
