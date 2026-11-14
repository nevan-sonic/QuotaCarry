'use client';
import {useState,type FormEvent} from 'react';

type Pass={token_id:string;issuer_id:string;policy_id:string;available:string;open:number};
type Credential={id:string;name:string;nft:string;model:string;expires:number;revoked:number|null;last_used:number|null};
type RequestGateway=(path:string,data?:object)=>Promise<unknown>;
type Adapter={config:{model:string;daily_limit:number}|null;audit:{action:string;created:number}[]};
type Team={team:{name:string}|null;role:string;members:{account:string;role:string;accepted:number}[];audit:{actor:string;target:string;action:string;created:number}[]};
type Job={id:string;token:string;state:string;reserve_hash?:string;settle_hash?:string};
type IssuerRequests={governance:boolean;requests:{account:string;name:string;state:string;issuer?:string}[]};
const explorer='https://explorer.testnet.near.org/transactions/';

export function DeveloperConsole({request,signIssuerAction}:{request:RequestGateway;signIssuerAction:(input:object)=>Promise<{hash:string;value:string}>}){
  const [passes,setPasses]=useState<Pass[]>([]);
  const [cursor,setCursor]=useState<string|null>(null);
  const [credentials,setCredentials]=useState<Credential[]>([]);
  const [routing,setRouting]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState('');
  const [secret,setSecret]=useState('');
  const [adapter,setAdapter]=useState<Adapter>();
  const [team,setTeam]=useState<Team>();
  const [jobs,setJobs]=useState<Job[]>([]);
  const [requests,setRequests]=useState<IssuerRequests>();
  const [issuerReceipt,setIssuerReceipt]=useState<{hash:string;value:string}>();
  function issuerAction(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    void run(async()=>{
      setIssuerReceipt(undefined);
      const input=Object.fromEntries(form);
      setIssuerReceipt(await signIssuerAction({...input,maxOpen:Number(input.maxOpen)}));
    });
  }
  async function loadRequests(){
    setRequests(await request('/v2/issuer-requests') as IssuerRequests);
  }
  async function run(action:()=>Promise<void>){
    setBusy(true);setStatus('');
    try{await action();}catch(error){setStatus(error instanceof Error?error.message:'Request failed');}
    finally{setBusy(false);}
  }
  async function loadCredentials(){
    setCredentials((await request('/v2/tokens') as {tokens:Credential[]}).tokens);
  }
  async function load(from='0'){
    const data=await request('/v2/nfts?from='+encodeURIComponent(from)) as {nfts:Pass[];next:string|null;routing:boolean};
    setPasses(current=>from==='0'?data.nfts:[...current,...data.nfts]);
    setCursor(data.next);setRouting(data.routing);setLoaded(true);
    if(from==='0')setJobs((await request('/v2/history') as {jobs:Job[]}).jobs);
    if(data.routing)await loadCredentials();
  }
  function manageTeam(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const issuer=String(form.get('issuer')), action=String(form.get('action'));
    void run(async()=>{
      setTeam(undefined);
      if(action!=='inspect')await request('/v2/team',{issuer,action,name:form.get('name'),account:form.get('account'),role:form.get('role')});
      setTeam(await request('/v2/team?issuer='+encodeURIComponent(issuer)) as Team);
    });
  }
  function updateIssuerRequest(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    void run(async()=>{
      await request('/v2/issuer-requests',{action:form.get('action'),name:form.get('name'),account:form.get('account'),issuer:form.get('issuer')});
      await loadRequests();
    });
  }
  async function changeCredential(data:object){
    setSecret('');
    const result=await request('/v2/tokens',data) as {token?:string};
    setSecret(result.token??'');
    setStatus(result.token?'Copy the credential now. It is displayed only once.':'Credential revoked.');
    await loadCredentials();
  }
  function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    void run(()=>changeCredential({nft:form.get('nft'),name:form.get('name'),model:form.get('model'),ttlMinutes:Number(form.get('ttl'))}));
  }
  function manageAdapter(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const issuer=String(form.get('issuer')),action=String(form.get('action'));
    void run(async()=>{
      setAdapter(undefined);
      if(action!=='inspect'){
        await request('/v2/issuer-adapter',{issuer,action,model:form.get('model'),dailyLimit:Number(form.get('limit'))});
      }
      setAdapter(await request('/v2/issuer-adapter?issuer='+encodeURIComponent(issuer)) as Adapter);
    });
  }
  return <>
    <section id="developer-console" aria-labelledby="console-title">
      <h3 id="console-title">Developer Console · NEAR testnet</h3>
      <button type="button" disabled={busy} onClick={()=>void run(()=>load())}>Load my NFTs and credentials</button>
      {loaded&&!passes.length&&<p>No QuotaCarry NFTs found for this wallet.</p>}
      {passes.map(pass=><p key={pass.token_id}>NFT {pass.token_id} · Issuer {pass.issuer_id} · Policy {pass.policy_id} · {pass.available} available · {pass.open} open reservations</p>)}
      {cursor&&<button type="button" disabled={busy} onClick={()=>void run(()=>load(cursor))}>Load more NFTs</button>}
      {loaded&&!routing&&<p>Developer credential issuance and issuer routing are closed.</p>}
      {routing&&passes.length>0&&<form onSubmit={create}>
        <label>NFT <select name="nft">{passes.map(pass=><option key={pass.token_id}>{pass.token_id}</option>)}</select></label>
        <label>Name <input name="name" required maxLength={64}/></label>
        <label>Model <input name="model" required defaultValue="openai/gpt-oss-20b"/></label>
        <label>Expiry in minutes <input name="ttl" type="number" min={5} max={1440} defaultValue={60} required/></label>
        <button disabled={busy}>Create credential</button>
      </form>}
      {secret&&<div><label>One-time credential <input readOnly value={secret} onFocus={event=>event.currentTarget.select()}/></label>
        <button type="button" onClick={()=>void run(async()=>{await navigator.clipboard.writeText(secret);setStatus('Credential copied.');})}>Copy credential</button>
        <button type="button" onClick={()=>setSecret('')}>Hide</button></div>}
      {credentials.map(credential=><div key={credential.id}>
        <p>{credential.name} · NFT {credential.nft} · {credential.model} · {credential.revoked?'Revoked':new Date(credential.expires).toLocaleString()}
          {credential.last_used?' · Last submitted '+new Date(credential.last_used).toLocaleString():''}</p>
        {!credential.revoked&&<><button type="button" disabled={busy} onClick={()=>void run(()=>changeCredential({rotateId:credential.id}))}>Rotate</button>
          <button type="button" disabled={busy} onClick={()=>void run(()=>changeCredential({revokeId:credential.id}))}>Revoke</button></>}
      </div>)}
      {loaded&&<section aria-label="Request history"><h4>Request history</h4>
        {!jobs.length&&<p>No requests recorded for this wallet.</p>}
        {jobs.map(job=><p key={job.id}>NFT {job.token} · {job.state.replaceAll('_',' ')}
          {job.reserve_hash&&<> · <a href={explorer+job.reserve_hash}>Reservation</a></>}
          {job.settle_hash&&<> · <a href={explorer+job.settle_hash}>Settlement</a></>}</p>)}
      </section>}
    </section>
    <section id="issuer-studio" aria-labelledby="studio-title">
      <h3 id="studio-title">Issuer Studio · NEAR testnet</h3>
      <button type="button" disabled={busy} onClick={()=>void run(loadRequests)}>Check issuer requests</button>
      <form onSubmit={updateIssuerRequest}>
        <input type="hidden" name="action" value="submit"/>
        <label>Issuer profile name <input name="name" required maxLength={64}/></label>
        <button disabled={busy}>Request issuer registration</button>
      </form>
      {requests?.requests.map(item=><p key={item.account}>{item.name} · {item.account} · {item.state}{item.issuer?' · Issuer '+item.issuer:''}</p>)}
      {requests?.governance&&<form onSubmit={updateIssuerRequest}>
        <label>Applicant <input name="account" required maxLength={64}/></label>
        <label>Decision <select name="action"><option value="approve">Approve request</option><option value="reject">Reject request</option><option value="finalize">Verify finalized issuer</option></select></label>
        <label>Finalized issuer ID <input name="issuer" pattern="[0-9]+"/></label>
        <button disabled={busy}>Record governance decision</button>
      </form>}
      <form onSubmit={issuerAction}>
        <input type="hidden" name="action" value="policy"/>
        <h4>Create request-credit policy</h4>
        <label>Issuer ID <input name="issuer" required pattern="[0-9]+"/></label>
        <label>Policy hash <input name="policyHash" required pattern="[a-f0-9]{64}"/></label>
        <label>Lifetime request cap <input name="cap" required pattern="[1-9][0-9]*"/></label>
        <label>Maximum open reservations <input name="maxOpen" required type="number" min={1}/></label>
        <button disabled={busy}>Review policy in wallet</button>
      </form>
      <form onSubmit={issuerAction}>
        <input type="hidden" name="action" value="mint"/>
        <h4>Mint request-credit NFT</h4>
        <label>Issuer ID <input name="issuer" required pattern="[0-9]+"/></label>
        <label>Policy ID <input name="policy" required pattern="[0-9]+"/></label>
        <label>Recipient <input name="receiver" required maxLength={64}/></label>
        <label>Request credits <input name="amount" required pattern="[1-9][0-9]*"/></label>
        <button disabled={busy}>Review mint in wallet</button>
      </form>
      {issuerReceipt&&<p><a href={explorer+issuerReceipt.hash}>Finalized issuer transaction</a>{issuerReceipt.value?' · ID '+issuerReceipt.value:''}</p>}
      {!routing?<p>Adapter management requires a verified staging deployment with issuer routing enabled.</p>:<form onSubmit={manageAdapter}>
        <label>On-chain issuer ID <input name="issuer" required pattern="[0-9]+"/></label>
        <label>Action <select name="action"><option value="inspect">Inspect</option><option value="verify">Verify bound adapter</option><option value="revoke">Revoke adapter</option></select></label>
        <label>Model <input name="model" defaultValue="openai/gpt-oss-20b"/></label>
        <label>Daily request cap <input name="limit" type="number" min={1} max={4} defaultValue={1}/></label>
        <button disabled={busy}>Apply</button>
      </form>}
      {adapter&&<p>{adapter.config?'Verified model '+adapter.config.model+' · Daily cap '+adapter.config.daily_limit:'No verified adapter'}</p>}
      {adapter?.audit.map((entry,index)=><p key={index}>{entry.action} · {new Date(entry.created).toLocaleString()}</p>)}
      {routing&&<form onSubmit={manageTeam}>
        <h4>Issuer team</h4>
        <label>Issuer ID <input name="issuer" required pattern="[0-9]+"/></label>
        <label>Action <select name="action"><option value="inspect">Inspect</option><option value="create">Create team</option><option value="invite">Invite</option><option value="accept">Accept invitation</option><option value="role">Change role</option><option value="remove">Remove member</option></select></label>
        <label>Team name <input name="name" maxLength={64}/></label>
        <label>Member account <input name="account" maxLength={64}/></label>
        <label>Member role <select name="role"><option value="viewer">Viewer</option><option value="developer">Developer</option><option value="administrator">Administrator</option></select></label>
        <button disabled={busy}>Apply team action</button>
      </form>}
      {team&&<section aria-label="Team membership"><h4>{team.team?.name??'Issuer team'} · {team.role}</h4>
        {team.members.map(member=><p key={member.account}>{member.account} · {member.role} · {member.accepted?'Accepted':'Invited'}</p>)}
        {team.audit.map((entry,index)=><p key={index}>{entry.actor} · {entry.action} · {entry.target}</p>)}
      </section>}
    </section>
    <p role="status">{busy?'Loading…':status}</p>
  </>;
}
