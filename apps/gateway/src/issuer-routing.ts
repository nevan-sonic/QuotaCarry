import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {D1Database,Fetcher,AbortSignal as WorkerAbortSignal,Response as WorkerResponse} from '@cloudflare/workers-types';
import {adapterSignature} from './adapter-protocol.js';
import {ProviderError} from './groq.js';

export type AdapterRegistryEnv = {DB:D1Database; QC_ADAPTER_KEYS?:string; QC_ADAPTER_A?:Fetcher; QC_ADAPTER_B?:Fetcher};
type AdapterConfig = {binding:Fetcher; key:string; revision:string};
type AdapterRow = {issuer:string; controller:string; revision:string; model:string; daily_limit:number};

export function configuredAdapter(env:AdapterRegistryEnv,issuer:string):AdapterConfig|null {
  if (!env.QC_ADAPTER_KEYS || !/^[0-9]+$/.test(issuer) || ['0','1','2'].includes(issuer)) return null;
  const config:unknown=JSON.parse(env.QC_ADAPTER_KEYS);
  if(!Array.isArray(config)) return null;
  const entries=config.filter(entry=>entry&&entry.issuer===issuer);
  if(entries.length!==1)return null;
  const {slot,key}=entries[0];
  if((slot!=='A'&&slot!=='B')||typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))return null;
  if(config.some(entry=>entry&&entry.issuer!==issuer&&(entry.slot===slot||entry.key===key)))return null;
  const binding=slot==='A'?env.QC_ADAPTER_A:env.QC_ADAPTER_B;
  if(!binding)return null;
  const revision=createHash('sha256').update(JSON.stringify([issuer,slot,key])).digest('hex');
  return {binding,key,revision};
}

async function callAdapter(config:AdapterConfig,path:string,body:string){
  const time=String(Date.now()),nonce=randomBytes(16).toString('hex');
  const response=await config.binding.fetch('https://adapter.internal'+path,{
    method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000) as unknown as WorkerAbortSignal,
    headers:{'Content-Type':'application/json','X-QC-Timestamp':time,'X-QC-Nonce':nonce,
      'X-QC-Signature':adapterSignature(config.key,time,nonce,path+'\n'+body)},body,
  });
  return {response,time,nonce};
}

export async function verifyAdapter(config:AdapterConfig,issuer:string,model:string){
  const body=JSON.stringify({issuer,challenge:randomBytes(32).toString('hex')});
  const {response,time,nonce}=await callAdapter(config,'/v1/verify',body);
  if(response.status!==200)return false;
  const proof=await adapterJSON(response);
  if(proof?.model!==model||typeof proof.signature!=='string'||!/^[a-f0-9]{64}$/.test(proof.signature))return false;
  const expected=adapterSignature(config.key,time,nonce,'verify-response\n'+JSON.stringify([body,model]));
  return timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(proof.signature,'hex'));
}

async function adapterJSON(response:WorkerResponse){
  const reader=response.body?.getReader();
  if(!reader)throw Error('Missing adapter response');
  let size=0;
  const chunks:Uint8Array[]=[];
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>16384){await reader.cancel();throw Error('Oversized adapter response');}
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function adapterRoute(env:AdapterRegistryEnv,issuer:string,model:string){
  const config=configuredAdapter(env,issuer);
  if(!config)return null;
  const row=await env.DB.prepare('SELECT * FROM qc_issuer_adapters WHERE issuer=? AND revision=? AND model=?')
    .bind(issuer,config.revision,model).first<AdapterRow>();
  return row?{config,row}:null;
}

export async function dispatchAdapter(config:AdapterConfig,model:string,prompt:string,job:string){
  try {
    const {response}=await callAdapter(config,'/v1/inference',JSON.stringify({model,prompt,job}));
    if(response.status===422)throw new ProviderError('rejected','Issuer adapter rejected request');
    if(response.status!==200)throw Error('Unexpected adapter status');
    const output=await adapterJSON(response);
    const usage=output?.usage;
    if(output?.model!==model||typeof output.content!=='string'||!output.content.trim()||
      !['stop','length'].includes(output.finish_reason)||
      !Number.isSafeInteger(usage?.prompt_tokens)||usage.prompt_tokens<0||usage.prompt_tokens>8192||
      !Number.isSafeInteger(usage?.completion_tokens)||usage.completion_tokens<0||usage.completion_tokens>256||
      usage.total_tokens!==usage.prompt_tokens+usage.completion_tokens)throw Error('Invalid adapter output');
    return {content:output.content as string,finish_reason:output.finish_reason as 'stop'|'length',
      usage:{prompt_tokens:usage.prompt_tokens as number,completion_tokens:usage.completion_tokens as number,total_tokens:usage.total_tokens as number}};
  } catch(error) {
    if(error instanceof ProviderError)throw error;
    throw new ProviderError('ambiguous','Issuer adapter outcome unknown');
  }
}
