import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {authorizedKey,createChain,finalized,type Intent} from './chain.js';
import {createChallenge,verifyNearMessage} from './near-message.js';
import {createGroqProvider,ProviderError} from './groq.js';

type Job={id:string;account:string;token:string;state:string;intent:string|null;output:string|null;reserve_hash:string|null;settle_hash:string|null};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const accountPattern=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
class HttpError extends Error {
  constructor(readonly status:number,message:string){super(message);}
}
async function body(req:IncomingMessage){
  let size=0;
  const parts:Buffer[]=[];
  for await(const chunk of req){
    size+=chunk.length;
    if(size>16384)throw new HttpError(413,'Request too large');
    parts.push(chunk);
  }
  try{const value=JSON.parse(Buffer.concat(parts).toString()); if(!value||typeof value!=='object'||Array.isArray(value))throw Error(); return value as Record<string,unknown>;}
  catch{throw new HttpError(400,'Invalid JSON');}
}
export function createInferenceApi(env:NodeJS.ProcessEnv){
  const {QC_DB,QC_ORIGIN,GROQ_API_KEY,GROQ_MODEL,QC_RELAYER_KEY,QC_SETTLER_KEY,QC_POLICY_ID}=env;
  if(!QC_DB||!QC_ORIGIN||!GROQ_API_KEY||!GROQ_MODEL||!QC_RELAYER_KEY||!QC_SETTLER_KEY||!QC_POLICY_ID)return;
  const origin=new URL(QC_ORIGIN);
  if(origin.origin!==QC_ORIGIN||!(origin.protocol==='https:'||['localhost','127.0.0.1'].includes(origin.hostname)))throw Error('Invalid QC_ORIGIN');
  if(!/^\d{1,20}$/.test(QC_POLICY_ID))throw Error('Invalid QC_POLICY_ID');
  const chain=createChain(QC_RELAYER_KEY,QC_SETTLER_KEY,QC_POLICY_ID);
  const provider=createGroqProvider(GROQ_API_KEY,GROQ_MODEL);
  const db=new DatabaseSync(QC_DB);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS wallet_challenges(nonce TEXT PRIMARY KEY, challenge TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wallet_sessions(token TEXT PRIMARY KEY, account TEXT NOT NULL, public_key TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inference_jobs(id TEXT PRIMARY KEY, account TEXT NOT NULL, token TEXT NOT NULL, dedupe TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, intent TEXT, output TEXT, reserve_hash TEXT, settle_hash TEXT, created INTEGER NOT NULL, UNIQUE(account,dedupe));
    CREATE UNIQUE INDEX IF NOT EXISTS one_inference_per_token ON inference_jobs(token) WHERE state NOT IN ('completed','released','rejected');
  `);
  const lookup=db.prepare('SELECT * FROM inference_jobs WHERE id=?');
  const status=db.prepare('UPDATE inference_jobs SET state=? WHERE id=?');
  const save=db.prepare('UPDATE inference_jobs SET intent=?, reserve_hash=COALESCE(?,reserve_hash), settle_hash=COALESCE(?,settle_hash) WHERE id=?');
  const result=db.prepare('UPDATE inference_jobs SET state=?,output=?,intent=NULL WHERE id=?');
  const publicJob=(j:Job)=>({id:j.id,token:j.token,state:j.state,reservation:j.reserve_hash,settlement:j.settle_hash,output:j.state==='completed'?j.output:null});
  const lock=db.prepare("SELECT id FROM inference_jobs WHERE state IN ('reserving','calling_provider','consume_pending','release_pending','manual_review') LIMIT 1");
  let active=false;
  const requests=new Map<string,{count:number;expires:number}>();
  function limited(key:string,max:number){
    const now=Date.now();
    for(const [k,v] of requests)if(v.expires<=now)requests.delete(k);
    if(requests.size>=10000&&!requests.has(key))throw new HttpError(429,'Rate limit exceeded');
    const entry=requests.get(key)??{count:0,expires:now+60000};
    if(++entry.count>max)throw new HttpError(429,'Rate limit exceeded');
    requests.set(key,entry);
  }
  function persist(id:string,intent:Intent){
    save.run(JSON.stringify(intent),intent.kind==='reserve'?intent.hash:null,intent.kind==='reserve'?null:intent.hash,id);
  }
  async function recover(){
    if(active)return;
    active=true;
    try{
      const job=db.prepare("SELECT * FROM inference_jobs WHERE state IN ('reserving','calling_provider','consume_pending','release_pending') LIMIT 1").get() as Job|undefined;
      if(!job)return;
      if(job.state==='calling_provider'){status.run('manual_review',job.id);return;}
      if(!job.intent){
        if(job.state==='reserving')status.run('rejected',job.id);
        else status.run('manual_review',job.id);
        return;
      }
      const intent=JSON.parse(job.intent) as Intent;
      if(intent.kind==='reserve'&&(job.state==='consume_pending'||job.state==='release_pending')){
        const kind=job.state==='consume_pending'?'consume':'release';
        await chain.settle(intent.reservation,kind,next=>persist(job.id,next));
        result.run(kind==='consume'?'completed':'released',job.output,job.id);
        return;
      }
      const outcome=await finalized(intent);
      if(intent.kind==='reserve'){
        status.run(outcome.success?'manual_review':'rejected',job.id);
      }else if(outcome.success){
        result.run(intent.kind==='consume'?'completed':'released',job.output,job.id);
      }else status.run('manual_review',job.id);
    }catch{ /* Only repeat the finalized read on the next interval. */ }
    finally{active=false;}
  }
  const timer=setInterval(()=>void recover(),15000);
  timer.unref();
  void recover();

  async function handle(req:IncomingMessage,res:ServerResponse){
    const respond=(code:number,data:object)=>{res.statusCode=code;res.end(JSON.stringify(data));};
    try{
      if(req.headers.origin!==QC_ORIGIN)throw new HttpError(403,'Origin rejected');
      res.setHeader('Access-Control-Allow-Origin',origin.origin);
      res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
      if(req.method==='OPTIONS'){res.statusCode=204;res.end();return;}
      limited(req.socket.remoteAddress??'local',60);
      const path=new URL(req.url??'/',origin.origin).pathname;
      if(req.method==='POST'&&path==='/v1/challenge'){
        const input=await body(req);
        const id=input.account;
        if(typeof id!=='string'||id.length>64||!accountPattern.test(id))throw new HttpError(400,'Invalid account');
        const challenge=createChallenge(id,origin.hostname);
        db.prepare('DELETE FROM wallet_challenges WHERE expires<=?').run(Date.now());
        db.prepare('INSERT INTO wallet_challenges VALUES (?,?,?)').run(challenge.nonce,JSON.stringify(challenge),challenge.expiresAt);
        return respond(201,challenge);
      }
      if(req.method==='POST'&&path==='/v1/session'){
        const {nonce,publicKey,signature,accountId}=await body(req);
        if(typeof nonce!=='string'||typeof publicKey!=='string'||typeof signature!=='string')throw new HttpError(400,'Invalid wallet proof');
        const row=db.prepare('SELECT challenge FROM wallet_challenges WHERE nonce=? AND expires>?').get(nonce,Date.now());
        if(!row)throw new HttpError(401,'Challenge expired or consumed');
        const challenge=JSON.parse(String(row.challenge));
        if(accountId!==challenge.accountId||!verifyNearMessage(challenge,publicKey,signature)||!await authorizedKey(challenge.accountId,publicKey))throw new HttpError(401,'Wallet proof rejected');
        if(db.prepare('DELETE FROM wallet_challenges WHERE nonce=? AND expires>?').run(nonce,Date.now()).changes!==1)throw new HttpError(401,'Challenge expired or consumed');
        const token=randomBytes(32).toString('base64url');
        db.prepare('DELETE FROM wallet_sessions WHERE expires<=?').run(Date.now());
        db.prepare('INSERT INTO wallet_sessions VALUES (?,?,?,?)').run(hash(token),challenge.accountId,publicKey,Date.now()+300000);
        return respond(201,{token,expiresIn:300});
      }
      const token=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      const session=token&&db.prepare('SELECT account,public_key FROM wallet_sessions WHERE token=? AND expires>?').get(hash(token),Date.now());
      if(!session)throw new HttpError(401,'Connect and authenticate your wallet');
      const account=String(session.account);
      if(req.method==='GET'&&/^\/v1\/jobs\/[a-f0-9-]{36}$/.test(path)){
        const j=lookup.get(path.split('/').at(-1)!) as Job|undefined;
        if(!j||j.account!==account)throw new HttpError(404,'Job not found');
        return respond(200,publicJob(j));
      }
      if(req.method!=='POST'||path!=='/v1/inference')throw new HttpError(404,'Route not found');
      const input=await body(req);
      const {tokenId,prompt,idempotencyKey}=input;
      if(typeof tokenId!=='string'||!/^\d{1,20}$/.test(tokenId)||typeof prompt!=='string'||!prompt.trim()||prompt.length>4000||typeof idempotencyKey!=='string'||!/^[-a-zA-Z0-9]{16,64}$/.test(idempotencyKey))throw new HttpError(400,'Invalid inference request');
      const digest=hash(JSON.stringify([tokenId,prompt]));
      const existing=db.prepare('SELECT * FROM inference_jobs WHERE account=? AND dedupe=?').get(account,idempotencyKey) as (Job&{digest:string})|undefined;
      if(existing){
        if(existing.digest!==digest)throw new HttpError(409,'Idempotency key already used');
        return respond(200,publicJob(existing));
      }
      if(!await authorizedKey(account,String(session.public_key)))throw new HttpError(401,'Wallet key no longer authorized');
      if(active||lock.get())throw new HttpError(409,'Inference is busy or requires reconciliation');
      const daily=db.prepare('SELECT COUNT(*) AS count FROM inference_jobs WHERE created>? AND state<>?').get(Date.now()-86400000,'rejected');
      if(Number(daily?.count)>=10)throw new HttpError(429,'Daily inference limit reached');
      active=true;
      const id=randomUUID();
      try{
        db.prepare("INSERT INTO inference_jobs(id,account,token,dedupe,digest,state,created) VALUES (?,?,?,?,?,'reserving',?)").run(id,account,tokenId,idempotencyKey,digest,Date.now());
        respond(202,{id,state:'reserving'});
        const reservation=await chain.reserve(account,tokenId,hash(id),intent=>persist(id,intent));
        status.run('calling_provider',id);
        let output:string;
        try{output=await provider(prompt);}
        catch(error){
          if(!(error instanceof ProviderError)||error.outcome!=='rejected'){
            status.run('manual_review',id);return;
          }
          status.run('release_pending',id);
          const tx=await chain.settle(reservation,'release',intent=>persist(id,intent));
          result.run('released',null,id);
          save.run(null,null,tx,id);
          return;
        }
        db.prepare('UPDATE inference_jobs SET state=?,output=? WHERE id=?').run('consume_pending',output,id);
        const tx=await chain.settle(reservation,'consume',intent=>persist(id,intent));
        result.run('completed',output,id);
        save.run(null,null,tx,id);
      }catch{
        const job=lookup.get(id) as Job|undefined;
        if(job&&!job.intent)status.run(job.state==='reserving'?'rejected':'manual_review',id);
        if(!res.writableEnded)throw new HttpError(503,'Inference unavailable');
      }finally{active=false;}
    }catch(error){
      if(!res.writableEnded)respond(error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.message:'Gateway temporarily unavailable'});
    }
  }
  return {handle,close:()=>clearInterval(timer)};
}
