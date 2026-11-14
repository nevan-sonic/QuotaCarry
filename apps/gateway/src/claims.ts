import type {D1Database} from '@cloudflare/workers-types';
import {createChain,finalized,type Intent} from './chain.js';

type Claim={account:string;state:string;lease:number;intent:string|null;tx_hash:string|null;token:string|null};
type Chain=ReturnType<typeof createChain>;
export const claimCap=10;
export async function claimStatus(db:D1Database,account:string,enabled:boolean){
  const claim=await db.prepare('SELECT state,tx_hash,token FROM beta_claims WHERE account=?').bind(account).first<Pick<Claim,'state'|'tx_hash'|'token'>>();
  const usage=await db.prepare('SELECT count(*) AS total FROM beta_claims').first<{total:number}>();
  return {enabled,eligible:enabled&&!claim&&(usage?.total??claimCap)<claimCap,remaining:Math.max(0,claimCap-(usage?.total??claimCap)),claim};
}
export async function enqueueClaim(db:D1Database,account:string){
  await db.prepare("INSERT OR IGNORE INTO beta_claims(account,state) SELECT ?,'queued' WHERE (SELECT count(*) FROM beta_claims) < ?")
    .bind(account,claimCap).run();
}
export async function recoverClaim(db:D1Database,chain:()=>Chain,enabled:boolean,now:number){
  const pending=await db.prepare("SELECT * FROM beta_claims WHERE state='minting' LIMIT 1").first<Claim>();
  const job=pending??(enabled?await db.prepare("SELECT * FROM beta_claims WHERE state='queued' ORDER BY rowid LIMIT 1").first<Claim>():null);
  if(!job||job.lease>now)return;
  const claimed=await db.prepare("UPDATE OR IGNORE beta_claims SET state='minting',lease=? WHERE account=? AND state=? AND lease=?")
    .bind(now+300000,job.account,job.state,job.lease).run();
  if(claimed.meta.changes!==1)return;
  if(!job.intent){
    if(!enabled){
      await db.prepare("UPDATE beta_claims SET state='queued',lease=0 WHERE account=?").bind(job.account).run();
      return;
    }
    await chain().issue(job.account,async intent=>{
      const saved=await db.prepare("UPDATE beta_claims SET intent=?,tx_hash=? WHERE account=? AND state='minting' AND lease=? AND intent IS NULL")
        .bind(JSON.stringify(intent),intent.hash,job.account,now+300000).run();
      if(saved.meta.changes!==1)throw Error('Claim lease lost');
    });
  }
  const stored=await db.prepare('SELECT intent FROM beta_claims WHERE account=?').bind(job.account).first<{intent:string|null}>();
  if(!stored?.intent)return;
  const outcome=await finalized(JSON.parse(stored.intent) as Intent);
  if(outcome.success&&!outcome.tokenId)throw Error('Mint token ID unavailable');
  await db.prepare('UPDATE beta_claims SET state=?,token=? WHERE account=? AND lease=?')
    .bind(outcome.success?'completed':'failed',outcome.tokenId??null,job.account,now+300000).run();
}
