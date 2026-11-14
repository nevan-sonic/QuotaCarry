'use client';
import {useState,useRef,type FormEvent} from 'react';
import type {NearConnector} from '@hot-labs/near-connect';

type Job={id:string;state:string;reservation?:string;settlement?:string;output?:string};
const explorer='https://explorer.testnet.near.org/transactions/';
const gateway=process.env.NEXT_PUBLIC_QC_GATEWAY;

export function Playground({account,tokens,connector,onSettled}:{account:string;tokens:string[];connector:NearConnector|null;onSettled:()=>void}){
  const [session,setSession]=useState('');
  const [job,setJob]=useState<Job>();
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const pending=useRef<{tokenId:string;prompt:string;idempotencyKey:string}|null>(null);

  async function request(path:string,data?:object,auth=session){
    const response=await fetch(gateway+path,{method:data?'POST':'GET',headers:{
      ...(data?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:'Bearer '+auth}:{}),
    },body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok)throw Error(result.error??'Gateway unavailable');
    return result;
  }
  async function authenticate(){
    if(!connector)return;
    setBusy(true);
    try{
      const challenge=await request('/v1/challenge',{account},'');
      const {wallet,accounts}=await connector.getConnectedWallet();
      if(connector.network!=='testnet'||!accounts.some(a=>a.accountId===account))throw Error('Wallet account changed');
      const proof=await wallet.signMessage({network:'testnet',signerId:account,message:challenge.message,recipient:challenge.audience,nonce:Uint8Array.from(atob(challenge.nonce),c=>c.charCodeAt(0))});
      if(proof.accountId!==account)throw Error('Wallet proof account mismatch');
      const result=await request('/v1/session',{...proof,nonce:challenge.nonce},'');
      setSession(result.token);setMessage('Wallet authenticated for five minutes.');
    }catch(error){setMessage(error instanceof Error?error.message:'Wallet authentication failed');}
    finally{setBusy(false);}
  }
  async function track(id:string){
    for(let i=0;i<20;i++){
      const result:Job=await request('/v1/jobs/'+id);
      setJob(result);
      if(['completed','released','rejected','manual_review'].includes(result.state)){
        if(result.state!=='manual_review')pending.current=null;
        onSettled();return;
      }
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    setMessage('Request is still processing. Check status again.');
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(pending.current)return;
    const form=new FormData(event.currentTarget);
    pending.current={tokenId:String(form.get('token')),prompt:String(form.get('prompt')),idempotencyKey:crypto.randomUUID()};
    setJob(undefined);
    await resume();
  }
  async function resume(){
    setBusy(true);setMessage('');
    try{
      const id=job?.id??(await request('/v1/inference',pending.current??undefined)).id;
      await track(id);
    }catch(error){setMessage(error instanceof Error?error.message:'Gateway request failed');}
    finally{setBusy(false);}
  }
  return <section className="card" aria-labelledby="playground-title">
    <h2 id="playground-title">AI playground</h2><p>One credit per successfully settled response.</p>
    {!gateway?<p>Inference gateway · Not configured</p>:!account?<p>Connect a testnet wallet to authenticate.</p>:<>
      <button type="button" disabled={busy} onClick={()=>void authenticate()}>{session?'Renew wallet authentication':'Authenticate wallet'}</button>
      {session&&tokens.length>0&&<form onSubmit={event=>void submit(event)}>
        <label htmlFor="infer-token">QuotaCarry NFT</label>{' '}
        <select id="infer-token" name="token">{tokens.map(token=><option key={token} value={token}>{token}</option>)}</select>
        <label htmlFor="infer-prompt" style={{display:'block'}}>Prompt</label>
        <textarea id="infer-prompt" name="prompt" required maxLength={4000} rows={4} style={{width:'100%'}}/>
        <button disabled={busy||Boolean(pending.current)}>Run inference</button>
      </form>}
      {session&&tokens.length===0&&<p>No owned NFT is available for inference.</p>}
      {pending.current&&<button type="button" disabled={busy} onClick={()=>void resume()}>Check request status</button>}
    </>}
    <p role="status">{message}{job?' '+job.state.replaceAll('_',' '):''}</p>
    {job?.reservation&&<p><a href={explorer+job.reservation}>Reservation receipt</a></p>}
    {job?.settlement&&<p><a href={explorer+job.settlement}>Settlement receipt</a></p>}
    {job?.output&&<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{job.output}</pre>}
  </section>;
}
