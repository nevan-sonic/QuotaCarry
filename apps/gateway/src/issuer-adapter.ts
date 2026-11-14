import {createHmac,timingSafeEqual} from 'node:crypto';
import type {D1Database} from '@cloudflare/workers-types';
import {createGroqProvider,ProviderError} from './groq.js';

export function adapterSignature(key:string, timestamp:string, nonce:string, body:string) {
  return createHmac('sha256',key).update(JSON.stringify(['qc-adapter-v1',timestamp,nonce,body])).digest('hex');
}

export async function verifyAdapterRequest(db:D1Database,key:string,timestamp:string,nonce:string,body:string,signature:string,now=Date.now()) {
  if(key.length<32||!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||
    !/^[a-f0-9]{32}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(signature))return false;
  if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(adapterSignature(key,timestamp,nonce,body),'hex')))return false;
  const result=await db.prepare('INSERT OR IGNORE INTO adapter_nonces VALUES (?,?)').bind(nonce,Number(timestamp)+60001).run();
  return result.meta.changes===1;
}

type Env={DB:D1Database;ADAPTER_SHARED_KEY?:string;GROQ_API_KEY?:string;ADAPTER_MODEL?:string;ADAPTER_ENABLED?:string};
export default {
  async fetch(req:Request,env:Env){
    const respond=(value:object,status:number)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
    const path=new URL(req.url).pathname;
    if(req.method==='GET'&&path==='/health')return respond({protocol:'qc-adapter-v1'},200);
    if(req.method!=='POST'||!['/v1/verify','/v1/inference'].includes(path))return respond({error:'Not found'},404);
    const reader=req.body?.getReader();
    if(!reader)return respond({error:'Request body required'},400);
    const parts:Uint8Array[]=[];
    let length=0;
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      length+=value.byteLength;
      if(length>2048){await reader.cancel();return respond({error:'Request too large'},413);}
      parts.push(value);
    }
    const body=Buffer.concat(parts).toString('utf8');
    const timestamp=req.headers.get('X-QC-Timestamp')??'',nonce=req.headers.get('X-QC-Nonce')??'',signature=req.headers.get('X-QC-Signature')??'';
    const key=env.ADAPTER_SHARED_KEY;
    if(!key||!await verifyAdapterRequest(env.DB,key,timestamp,nonce,path+'\n'+body,signature))return respond({error:'Request authentication rejected'},401);
    if(path==='/v1/verify')return respond({signature:adapterSignature(key,timestamp,nonce,'verify-response\n'+body)},200);
    if(env.ADAPTER_ENABLED!=='1'||!env.GROQ_API_KEY||!env.ADAPTER_MODEL)return respond({error:'Adapter unavailable'},503);
    let input;
    try{input=JSON.parse(body);}catch{return respond({error:'Invalid JSON'},400);}
    if(input?.model!==env.ADAPTER_MODEL||typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>768)return respond({error:'Model or prompt rejected'},400);
    const day=new Date().toISOString().slice(0,10);
    const quota=await env.DB.prepare('INSERT INTO adapter_budget VALUES (?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<4 RETURNING used').bind(day).first();
    if(!quota)return respond({error:'Adapter daily budget exhausted'},429);
    try {
      const content=await createGroqProvider(env.GROQ_API_KEY,env.ADAPTER_MODEL)(input.prompt);
      return respond({model:env.ADAPTER_MODEL,content},200);
    } catch(error) {
      const rejected=error instanceof ProviderError&&error.outcome==='rejected';
      return respond({error:rejected?'Provider rejected request':'Provider outcome uncertain'},rejected?422:502);
    }
  },
  async scheduled(_event:unknown,env:Env){
    await env.DB.prepare('DELETE FROM adapter_nonces WHERE expires<=?').bind(Date.now()).run();
  },
};
