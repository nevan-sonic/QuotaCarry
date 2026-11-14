'use client';
import {Playground} from './playground';

import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import type {NearConnector} from '@hot-labs/near-connect';

const contract = 'quotacarry-fund-7b29e1.testnet';
const explorer = 'https://explorer.testnet.near.org';
type Pass = {
  token: {token_id:string;owner_id:string};
  allowance:{available:string;open:number;epoch:string;policy_id:string;issuer_id:string};
  policy:{issued:string;consumed:string;lifetime_cap:string;policy_hash:string};
  issuer:{controller:string;authorizer:string;settler:string};
};
type Snapshot = {network:'testnet';block:number;passes:Pass[]};

export default function Home() {
  const connector = useRef<NearConnector | null>(null);
  const accountRef = useRef('');
  const [account,setAccount] = useState('');
  const [snapshot,setSnapshot] = useState<Snapshot>();
  const [error,setError] = useState('');
  const [walletStatus,setWalletStatus] = useState('');
  const [busy,setBusy] = useState(false);
  const [transaction,setTransaction] = useState('');
  const refresh = useCallback(async (owner:string) => {
    try {
      const response = await fetch('/api/chain'+(owner?'?owner='+encodeURIComponent(owner):''),{signal:AbortSignal.timeout(14000)});
      const data = await response.json();
      if (!response.ok || data.network!=='testnet') throw Error(data.error ?? 'Unexpected RPC network');
      if (accountRef.current===owner) {setSnapshot(data);setError('');}
    } catch {
      if (accountRef.current===owner) setError('Unable to refresh finalized testnet state.');
    }
  },[]);
  useEffect(() => {
    void refresh(account);
    const timer = setInterval(()=>void refresh(account),20000);
    return ()=>clearInterval(timer);
  },[account,refresh]);

  async function connect() {
    setBusy(true);
    try {
      if (!connector.current) {
        const {NearConnector} = await import('@hot-labs/near-connect');
        connector.current = new NearConnector({network:'testnet',autoConnect:false,features:{testnet:true,signInWithoutAddKey:true}});
      }
      const client = connector.current;
      const approved = await new Promise<string>((resolve,reject)=>{
        const handler = ({accounts,success}:{accounts:{accountId:string}[];success:boolean})=>{
          client.events.off('wallet:signIn',handler);
          if (success && accounts.length===1) resolve(accounts[0].accountId);
          else reject(Error('Select one testnet account in your wallet.'));
        };
        client.events.on('wallet:signIn',handler);
        void client.connect().catch(error=>{client.events.off('wallet:signIn',handler);reject(error);});
      });
      accountRef.current=approved;setSnapshot(undefined);setAccount(approved);
      setWalletStatus('Wallet connected for testnet requests.');
    } catch (e) {setWalletStatus(e instanceof Error ? e.message : 'Wallet connection failed.');}
    finally {setBusy(false);}
  }

  async function disconnect() {
    setBusy(true);
    try {
      await connector.current?.disconnect();
      accountRef.current='';setAccount('');setSnapshot(undefined);setWalletStatus('Wallet disconnected.');
    } catch {setWalletStatus('Wallet disconnect failed.');}
    finally {setBusy(false);}
  }

  async function transfer(event:FormEvent<HTMLFormElement>,pass:Pass) {
    event.preventDefault();
    const receiver = String(new FormData(event.currentTarget).get('receiver') ?? '').trim();
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(receiver) || receiver.length>64 || receiver===account) {
      setWalletStatus('Enter a different, valid NEAR account ID.');return;
    }
    setBusy(true);setTransaction('');
    try {
      if (!connector.current || connector.current.network!=='testnet' || pass.token.owner_id!==account) throw Error('Wallet or ownership mismatch.');
      const {wallet,accounts} = await connector.current.getConnectedWallet();
      if (!accounts.some(value=>value.accountId===account)) throw Error('The wallet account changed.');
      setWalletStatus('Review the transfer in your wallet.');
      const result = await wallet.signAndSendTransaction({network:'testnet',signerId:account,receiverId:contract,actions:[{
        type:'FunctionCall',params:{methodName:'nft_transfer',args:{receiver_id:receiver,token_id:pass.token.token_id,approval_id:null,memo:null},gas:'30000000000000',deposit:'1'},
      }]});
      setTransaction(result.transaction.hash);
      setWalletStatus('Waiting for finalized testnet receipts.');
      for (let attempt=0;attempt<5;attempt++) {
        const verification = await fetch('/api/chain?transaction='+encodeURIComponent(result.transaction.hash)+'&signer='+encodeURIComponent(account));
        const state = await verification.json();
        if (state.final) {
          setWalletStatus(state.success?'Transfer finalized.':'Transfer finalized with a failed receipt.');
          await refresh(account);
          return;
        }
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
      setWalletStatus('Finality could not be confirmed. Check the explorer before trying again.');
      await refresh(account);
    } catch (e) {setWalletStatus(e instanceof Error?e.message:'Transfer request failed.');}
    finally {setBusy(false);}
  }

  return <main className="shell">
    <header><a className="brand" href="/">QuotaCarry</a><nav><a href="#dashboard">Dashboard</a><a href="#history">Verified demo</a></nav><button disabled={busy} onClick={account?disconnect:connect}>{account?'Disconnect wallet':'Connect wallet'}</button></header>
    <section className="hero"><p className="eyebrow">NEAR TESTNET</p><h1>Transfer AI compute rights, <em>not API keys.</em></h1><p>QuotaCarry makes inference credits portable. A NEAR NFT carries its balance when ownership changes, and existing reservations remain settleable.</p><div className="links"><a className="primary" href="#dashboard">Open dashboard</a><a href={explorer+'/accounts/'+contract}>View contract ↗</a></div></section>
    <section id="dashboard"><div className="section-title"><h2>{account?'Your QuotaCarry NFTs':'Live testnet NFT'}</h2><span>{snapshot?'Finalized block '+snapshot.block:'NEAR testnet'}</span></div>
      {account&&<p className="mono">{account}</p>}
      {error&&<p role="alert">{error}{snapshot?' Showing the last successful read.':''}</p>}
      {!snapshot&&!error&&<p>Reading finalized testnet state…</p>}
      {snapshot?.passes.length===0&&<p>No QuotaCarry NFTs found for this account.</p>}
      {snapshot?.passes.map(pass=><article className="card" key={pass.token.token_id}>
        <p className="eyebrow">TOKEN {pass.token.token_id} · POLICY {pass.allowance.policy_id}</p>
        <h3>QuotaCarry Pass</h3><p className="mono">Owner · {pass.token.owner_id}</p>
        <dl className="metrics"><div><dt>Available</dt><dd>{pass.allowance.available}</dd></div><div><dt>Open reservations</dt><dd>{pass.allowance.open}</dd></div><div><dt>Policy consumed</dt><dd>{pass.policy.consumed}</dd></div><div><dt>Policy issued</dt><dd>{pass.policy.issued}</dd></div></dl>
        <details><summary>Policy and issuer</summary><p>Epoch {pass.allowance.epoch} · Issuer {pass.allowance.issuer_id} · Policy cap {pass.policy.lifetime_cap}</p><p className="mono">{pass.policy.policy_hash}</p><p className="mono">Controller · {pass.issuer.controller}</p><p className="mono">Authorizer · {pass.issuer.authorizer}</p><p className="mono">Settler · {pass.issuer.settler}</p></details>
        {account===pass.token.owner_id&&<form onSubmit={event=>void transfer(event,pass)}><label htmlFor={'receiver-'+pass.token.token_id}>Transfer recipient</label><div className="links"><input id={'receiver-'+pass.token.token_id} name="receiver" required placeholder="account.testnet"/><button disabled={busy||Boolean(error)}>Review transfer</button></div><small>30 Tgas prepaid and 1 yoctoNEAR attached.</small></form>}
      </article>)}
      <p role="status">{walletStatus} {transaction&&<a href={explorer+'/transactions/'+transaction}>View transaction ↗</a>}</p>
    </section>
    <Playground key={account} account={account} tokens={snapshot?.passes.filter(pass=>pass.token.owner_id===account).map(pass=>pass.token.token_id)??[]} connector={connector.current} onSettled={()=>void refresh(account)}/>
    <section id="history" className="card"><p className="eyebrow">HISTORICAL VERIFIED DEMO</p><h2>100 credits, one ownership handoff</h2><p>Alice reserved three credits before transferring token 0. The contract rejected a stale Alice request, accepted Bob’s request, and finalized with 98 available and two consumed.</p><div className="links"><a href={explorer+'/transactions/davp7Z7GTM4FBzRxKLyAFRhJSf6moJg49K5dN3PZxiQ'}>Transfer ↗</a><a href={explorer+'/transactions/2cUdDxFQT3cbAjexjxE6MgYNgkFPVFe3wy2MtnrADb8t'}>Stale request ↗</a><a href={explorer+'/transactions/J7TceTF9PqfMM1MREFnnVs59FLF6zNnjddJoBHwXgNRK'}>Final settlement ↗</a></div></section>
    <footer><a href="https://github.com/nevan-sonic/QuotaCarry">GitHub ↗</a></footer>
  </main>;
}
