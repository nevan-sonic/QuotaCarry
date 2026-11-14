import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {D1Database,ExecutionContext} from '@cloudflare/workers-types';
import {authorizedKey,createChain,finalized,type Intent} from './chain.js';
import {createChallenge,verifyNearMessage} from './near-message.js';
import {createGroqProvider,ProviderError} from './groq.js';

interface Env {
  DB:D1Database;
  QC_ORIGIN?:string;
  QC_POLICY_ID?:string;
  GROQ_MODEL?:string;
  GROQ_API_KEY?:string;
  QC_RELAYER_KEY?:string;
  QC_SETTLER_KEY?:string;
  QC_INFERENCE_ENABLED?:string;
}
type Job={id:string;account:string;token:string;state:string;prompt:string|null;digest:string;intent:string|null;output:string|null;reserve_hash:string|null;settle_hash:string|null;lease:number};
const leaseMs=300000;
const hash=(input:string)=>createHash('sha256').update(input).digest('hex');
const account=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ready=(env:Env)=>Boolean(env.QC_INFERENCE_ENABLED==='1'&&env.DB&&env.QC_ORIGIN&&env.GROQ_MODEL&&env.GROQ_API_KEY&&env.QC_RELAYER_KEY&&env.QC_SETTLER_KEY&&/^\d{1,20}$/.test(env.QC_POLICY_ID??''));
const publicJob=(j:Job)=>({id:j.id,token:j.token,state:j.state,reservation:j.reserve_hash,settlement:j.settle_hash,output:j.state==='completed'?j.output:null});
function chain(env:Env){return createChain(env.QC_RELAYER_KEY!,env.QC_SETTLER_KEY!,env.QC_POLICY_ID!);}
function row(env:Env,id:string){return env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<Job>();}
function state(env:Env,id:string,status:string,output:string|null=null){
  return env.DB.prepare("UPDATE jobs SET state=?,output=?,prompt=CASE WHEN ? IN ('completed','released','rejected','manual_review') THEN NULL ELSE prompt END WHERE id=?").bind(status,output,status,id).run();
}
function persist(env:Env,id:string,intent:Intent){
  const field=intent.kind==='reserve'?'reserve_hash':'settle_hash';
  return env.DB.prepare('UPDATE jobs SET intent=?,'+field+'=? WHERE id=?').bind(JSON.stringify(intent),intent.hash,id).run().then(()=>undefined);
}
async function run(env:Env,id:string,owner:string,token:string,prompt:string){
  try{
    const service=chain(env);
    const reservation=await service.reserve(owner,token,hash(id),intent=>persist(env,id,intent));
    await env.DB.prepare("UPDATE jobs SET state='calling_provider',prompt=NULL WHERE id=?").bind(id).run();
    let output:string|null=null;
    let disposition:'consume'|'release'='consume';
    try{output=await createGroqProvider(env.GROQ_API_KEY!,env.GROQ_MODEL!)(prompt);}
    catch(error){
      if(!(error instanceof ProviderError)||error.outcome!=='rejected'){
        await state(env,id,'manual_review');
        return;
      }
      disposition='release';
    }
    await state(env,id,disposition+'_pending',output);
    await service.settle(reservation,disposition,intent=>persist(env,id,intent));
    await state(env,id,disposition==='consume'?'completed':'released',output);
  }catch{
    const job=await row(env,id);
    if(job?.state==='reserving'&&!job.intent)await state(env,id,'rejected');
    else if(job?.state==='calling_provider')await state(env,id,'manual_review');
    console.warn(JSON.stringify({event:'inference_interrupted',job:id}));
  }
}
export async function recover(env:Env,now=Date.now()){
  await env.DB.batch([
    env.DB.prepare('DELETE FROM challenges WHERE expires<=?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires<=?').bind(now),
    env.DB.prepare('DELETE FROM limits WHERE expires<=?').bind(now),
  ]);
  if(!ready(env))return;
  const job=await env.DB.prepare("SELECT * FROM jobs WHERE lease<=? AND state IN ('queued','reserving','calling_provider','consume_pending','release_pending') LIMIT 1").bind(now).first<Job>();
  if(!job)return;
  const claimed=await env.DB.prepare('UPDATE jobs SET lease=? WHERE id=? AND lease=? AND state=?').bind(now+leaseMs,job.id,job.lease,job.state).run();
  if(claimed.meta.changes!==1)return;
  if(job.state==='queued'&&job.prompt!==null){
    await state(env,job.id,'reserving');
    await run(env,job.id,job.account,job.token,job.prompt);
    return;
  }
  if(job.state==='calling_provider'||!job.intent){
    await state(env,job.id,job.state==='reserving'?'rejected':'manual_review');return;
  }
  const intent=JSON.parse(job.intent) as Intent;
  if(intent.kind==='reserve'&&['consume_pending','release_pending'].includes(job.state)){
    const disposition=job.state==='consume_pending'?'consume':'release';
    await chain(env).settle(intent.reservation,disposition,next=>persist(env,job.id,next));
    await state(env,job.id,disposition==='consume'?'completed':'released',job.output);return;
  }
  const outcome=await finalized(intent);
  const next=intent.kind==='reserve'?(outcome.success?'manual_review':'rejected'):
    outcome.success?(intent.kind==='consume'?'completed':'released'):'manual_review';
  await state(env,job.id,next,job.output);
}
async function read(req:Request){
  const reader=req.body?.getReader();
  if(!reader)throw Error('Missing JSON');
  const decoder=new TextDecoder();
  let size=0,json='';
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>16384){await reader.cancel();throw Error('Request too large');}
    json+=decoder.decode(value,{stream:true});
  }
  const value=JSON.parse(json+decoder.decode());
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid JSON');
  return value as Record<string,unknown>;
}
async function handle(req:Request,env:Env){
  const path=new URL(req.url).pathname;
  const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'});
  const respond=(data:object,status=200)=>Response.json(data,{status,headers});
  if(req.method==='GET'&&path==='/health')return respond({ready:true});
  if(req.method==='GET'&&path==='/ready'){
    await env.DB.prepare('SELECT nonce FROM challenges LIMIT 1').first();
    return respond({database:'available',model:env.GROQ_MODEL??null,inference:ready(env)?'configured':'not_configured'},ready(env)?200:503);
  }
  if(!env.QC_ORIGIN||req.headers.get('Origin')!==env.QC_ORIGIN)return respond({error:'Origin rejected'},403);
  headers.set('Access-Control-Allow-Origin',env.QC_ORIGIN);
  headers.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(!path.startsWith('/v1/'))return respond({error:'Route not found'},404);
  const now=Date.now(), minute=Math.floor(now/60000);
  const bucket=hash((req.headers.get('CF-Connecting-IP')??'local')+':'+minute);
  const limit=await env.DB.prepare('INSERT INTO limits VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count')
    .bind(bucket,(minute+1)*60000).first<{count:number}>();
  if(!limit||limit.count>60)return respond({error:'Rate limit exceeded'},429);
  let input:Record<string,unknown>={};
  if(req.method==='POST'){
    try{input=await read(req);}catch{return respond({error:'Invalid or oversized JSON'},400);}
  }
  if(req.method==='POST'&&path==='/v1/challenge'){
    if(typeof input.account!=='string'||input.account.length>64||!account.test(input.account))return respond({error:'Invalid account'},400);
    const c=createChallenge(input.account,new URL(env.QC_ORIGIN).hostname);
    await env.DB.prepare('INSERT INTO challenges VALUES (?,?,?)').bind(c.nonce,JSON.stringify(c),c.expiresAt).run();
    return respond(c,201);
  }
  if(req.method==='POST'&&path==='/v1/session'){
    const {nonce,publicKey,signature,accountId}=input;
    if(typeof nonce!=='string'||typeof publicKey!=='string'||typeof signature!=='string')return respond({error:'Invalid proof'},400);
    const saved=await env.DB.prepare('SELECT value FROM challenges WHERE nonce=? AND expires>?').bind(nonce,now).first<{value:string}>();
    if(!saved)return respond({error:'Challenge expired or consumed'},401);
    const c=JSON.parse(saved.value);
    if(accountId!==c.accountId||!verifyNearMessage(c,publicKey,signature)||!await authorizedKey(c.accountId,publicKey))return respond({error:'Wallet proof rejected'},401);
    const token=randomBytes(32).toString('base64url');
    const consumed=await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM challenges WHERE nonce=? AND expires>?)').bind(hash(token),c.accountId,publicKey,Date.now()+300000,nonce,Date.now()),
      env.DB.prepare('DELETE FROM challenges WHERE nonce=?').bind(nonce),
    ]);
    if(consumed[0].meta.changes!==1)return respond({error:'Challenge expired or consumed'},401);
    return respond({token,expiresIn:300},201);
  }
  const bearer=req.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const session=bearer&&await env.DB.prepare('SELECT account,public_key FROM sessions WHERE token=? AND expires>?').bind(hash(bearer),now).first<{account:string;public_key:string}>();
  if(!session)return respond({error:'Authenticate your wallet'},401);
  if(req.method==='GET'&&/^\/v1\/jobs\/[a-f0-9-]{36}$/.test(path)){
    const job=await row(env,path.split('/').at(-1)!);
    return job?.account===session.account?respond(publicJob(job)):respond({error:'Job not found'},404);
  }
  if(req.method!=='POST'||path!=='/v1/inference')return respond({error:'Route not found'},404);
  if(!ready(env))return respond({error:'Inference is not configured'},503);
  const {tokenId,prompt,idempotencyKey}=input;
  if(typeof tokenId!=='string'||!/^\d{1,20}$/.test(tokenId)||typeof prompt!=='string'||!prompt.trim()||prompt.length>4000||typeof idempotencyKey!=='string'||!/^[-a-zA-Z0-9]{16,64}$/.test(idempotencyKey))return respond({error:'Invalid inference request'},400);
  if(env.QC_POLICY_ID==='1'&&(session.account!=='bob.quotacarry-fund-7b29e1.testnet'||tokenId!=='1'))return respond({error:'Only the approved test NFT can run inference'},403);
  const digest=hash(JSON.stringify([tokenId,prompt]));
  const existing=()=>env.DB.prepare('SELECT * FROM jobs WHERE account=? AND dedupe=?').bind(session.account,idempotencyKey).first<Job>();
  const prior=await existing();
  if(prior)return prior.digest===digest?respond(publicJob(prior)):respond({error:'Idempotency key already used'},409);
  if(!await authorizedKey(session.account,session.public_key))return respond({error:'Wallet key revoked'},401);
  const id=randomUUID();
  const insert=await env.DB.prepare("INSERT OR IGNORE INTO jobs(id,account,dedupe,digest,token,prompt,state,created,lease) SELECT ?,?,?,?,?,?,'queued',?,? WHERE (SELECT COUNT(*) FROM jobs WHERE created>?) < 1")
    .bind(id,session.account,idempotencyKey,digest,tokenId,prompt,now,0,env.QC_POLICY_ID=== '1' ? 0 : now-86400000).run();
  if(insert.meta.changes!==1){
    const concurrent=await existing();
    return concurrent?.digest===digest?respond(publicJob(concurrent)):respond({error:'Inference busy, daily limit reached, or reconciliation required'},409);
  }

  return respond({id,state:'queued'},202);
}
export default {
  async fetch(req:Request,env:Env){
    try{return await handle(req,env);}
    catch{
      const headers:Record<string,string>={'Cache-Control':'no-store'};
      if(env.QC_ORIGIN&&req.headers.get('Origin')===env.QC_ORIGIN)headers['Access-Control-Allow-Origin']=env.QC_ORIGIN;
      return Response.json({error:'Gateway temporarily unavailable'},{status:503,headers});
    }
  },
  scheduled(_event:unknown,env:Env,ctx:ExecutionContext){
    ctx.waitUntil(recover(env).catch(()=>console.warn(JSON.stringify({event:'recovery_pending'}))));
  },
};
