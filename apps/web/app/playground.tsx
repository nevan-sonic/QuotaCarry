'use client';
import {useState,useRef,type FormEvent} from 'react';
import type {NearConnector} from '@hot-labs/near-connect';
import {DeveloperConsole} from './developer-console';

type ClaimStatus={enabled:boolean;eligible:boolean;remaining:number;claim?:{state:string;tx_hash?:string;token?:string}};
type Job={id:string;state:string;reservation?:string;settlement?:string;output?:string};
const explorer='https://explorer.testnet.near.org/transactions/';
const gateway=process.env.NEXT_PUBLIC_QC_GATEWAY;

export function Playground({account,tokens,connector,onSettled}:{account:string;tokens:string[];connector:NearConnector|null;onSettled:()=>void}){
  const [claim,setClaim]=useState<ClaimStatus>();
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
      setSession(result.token);
      setClaim(await request('/v1/claim',undefined,result.token));
      setMessage('Wallet authenticated for five minutes.');
    }catch(error){setMessage(error instanceof Error?error.message:'Wallet authentication failed');}
    finally{setBusy(false);}
  }
  async function checkClaim(create:boolean){
    setBusy(true);
    try{
      const result:ClaimStatus=await request('/v1/claim',create?{}:undefined);
      setClaim(result);
      if(result.claim?.state==='completed')onSettled();
    }catch(error){setMessage(error instanceof Error?error.message:'Could not check claim');}
    finally{setBusy(false);}
  }
  async function signIssuerAction(input:object){
    if(!connector)throw Error('Connect a wallet first');
    const intent=await request('/v2/issuer-actions',input) as {method:string;args:object};
    if(!['create_policy','issue'].includes(intent.method))throw Error('Unexpected issuer action');
    const {wallet,accounts}=await connector.getConnectedWallet();
    if(connector.network!=='testnet'||!accounts.some(item=>item.accountId===account))throw Error('Wallet account changed');
    const result=await wallet.signAndSendTransaction({network:'testnet',signerId:account,receiverId:'quotacarry-fund-7b29e1.testnet',actions:[
      {type:'FunctionCall',params:{methodName:intent.method,args:intent.args,gas:'30000000000000',deposit:'0'}},
    ]});
    const hash=result.transaction.hash;
    for(let attempt=0;attempt<8;attempt++){
      const response=await fetch('/api/chain?transaction='+encodeURIComponent(hash)+'&signer='+encodeURIComponent(account));
      const receipt=await response.json();
      if(receipt.final){
        if(!receipt.success)throw Error('Transaction failed. Receipt '+hash);
        onSettled();
        return {hash,value:receipt.value as string};
      }
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    throw Error('Finality not confirmed. Check receipt '+hash+' before retrying.');
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
    setMessage('Request is queued or processing. The Worker checks the queue every five minutes. Check status again.');
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
    <h2 id="playground-title">AI playground</h2><p>One credit per successfully settled response. Prompts are limited to 768 UTF-8 bytes.</p>
    {!gateway?<p>Inference gateway · Not configured</p>:!account?<p>Connect a testnet wallet to authenticate.</p>:<>
      <button type="button" disabled={busy} onClick={()=>void authenticate()}>{session?'Renew wallet authentication':'Authenticate wallet'}</button>
      {session&&claim&&<section aria-label="Claim trial NFT">
        <h3>Claim a trial NFT</h3>
        <p>Two testnet credits. One claim per wallet. {claim.remaining} unallocated slots.</p>
        {!claim.enabled&&<p>Claims are closed.</p>}
        {claim.eligible&&<button type="button" disabled={busy} onClick={()=>void checkClaim(true)}>Claim trial NFT</button>}
        {claim.claim&&<p>Claim {claim.claim.state}{claim.claim.token?' · NFT '+claim.claim.token:''}
          {claim.claim.tx_hash&&<> · <a href={explorer+claim.claim.tx_hash}>Mint receipt</a></>}</p>}
        <button type="button" disabled={busy} onClick={()=>void checkClaim(false)}>Refresh claim status</button>
      </section>}
      {session&&tokens.length>0&&<form onSubmit={event=>void submit(event)}>
        <label htmlFor="infer-token">QuotaCarry NFT</label>{' '}
        <select id="infer-token" name="token">{tokens.map(token=><option key={token} value={token}>{token}</option>)}</select>
        <label htmlFor="infer-prompt" style={{display:'block'}}>Prompt</label>
        <textarea id="infer-prompt" name="prompt" required maxLength={768} rows={4} style={{width:'100%'}}/>
        <button disabled={busy||Boolean(pending.current)}>Run inference</button>
      </form>}
      {session&&tokens.length===0&&<p>No owned NFT is available for inference.</p>}
      {pending.current&&<button type="button" disabled={busy} onClick={()=>void resume()}>Check request status</button>}
      {session&&<DeveloperConsole key={session} request={request} signIssuerAction={signIssuerAction}/>}
      {!session&&<div><p id="developer-console">Authenticate your wallet to open Developer Console.</p><p id="issuer-studio">Authenticate your wallet to open Issuer Studio.</p></div>}
    </>}
    <p role="status">{message}{job?' '+job.state.replaceAll('_',' '):''}</p>
    {job?.reservation&&<p><a href={explorer+job.reservation}>Reservation receipt</a></p>}
    {job?.settlement&&<p><a href={explorer+job.settlement}>Settlement receipt</a></p>}
    {job?.output&&<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{job.output}</pre>}
  </section>;
}
