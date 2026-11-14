import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import type {Reservation} from './inference.js';
import {base58} from './near-message.js';

const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const contract='quotacarry-fund-7b29e1.testnet';
const endpoints=['https://test.rpc.fastnear.com','https://near-testnet.drpc.org'];
const sha=(value:Buffer)=>createHash('sha256').update(value).digest();
function encode(value:Buffer) {
  let n=BigInt('0x'+value.toString('hex')), result='';
  while(n){result=alphabet[Number(n%58n)]+result;n/=58n;}
  for(const byte of value){if(byte)break;result='1'+result;}
  return result;
}
function integer(value:bigint,size:number){
  const bytes=Buffer.alloc(size);
  for(let i=0;i<size;i++){bytes[i]=Number(value&255n);value>>=8n;}
  if(value)throw Error('Invalid transaction integer');
  return bytes;
}
function string(value:string){
  const bytes=Buffer.from(value);
  return Buffer.concat([integer(BigInt(bytes.length),4),bytes]);
}
async function rpc(method:string,params:object,write=false){
  for(const endpoint of write?endpoints.slice(0,1):endpoints){
    try {
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'qc',method,params}),signal:AbortSignal.timeout(8000)});
      const data=await response.json();
      if(response.ok && data.result)return data.result;
    }catch{ /* A write never falls back. */ }
  }
  throw Error('Testnet RPC unavailable');
}
async function block(){
  const status=await rpc('status',[]);
  if(status.chain_id!=='testnet')throw Error('Unexpected RPC network');
  return (await rpc('block',{finality:'final'})).header as {hash:string;height:number;gas_price:string};
}
type Block=Awaited<ReturnType<typeof block>>;
async function view(method_name:string,args:object,b:Block){
  const result=await rpc('query',{request_type:'call_function',account_id:contract,block_id:b.hash,method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
  return JSON.parse(Buffer.from(result.result).toString());
}
async function access(account_id:string,public_key:string,b:Block){
  return rpc('query',{request_type:'view_access_key',account_id,public_key,block_id:b.hash});
}
export async function authorizedKey(account:string,key:string){
  return (await access(account,key,await block())).permission==='FullAccess';
}
export type Intent={hash:string;signer:string;kind:'reserve'|'consume'|'release';reservation:Reservation};
export async function finalized(intent:Intent){
  const value=await rpc('tx',{tx_hash:intent.hash,sender_account_id:intent.signer,wait_until:'FINAL'});
  if(value.final_execution_status!=='FINAL'||value.transaction.hash!==intent.hash||value.transaction.signer_id!==intent.signer||value.transaction.receiver_id!==contract)throw Error('Finality unavailable');
  if(!Object.hasOwn(value.status,'SuccessValue'))return {success:false};
  const b=await block();
  const actual=await view('get_reservation',{token_id:intent.reservation.tokenId,seq:intent.reservation.sequence},b);
  if(intent.kind==='reserve'){
    if(actual?.commitment!==intent.reservation.commitment)throw Error('Reservation commitment mismatch');
  }else{
    const result=JSON.parse(Buffer.from(value.status.SuccessValue,'base64').toString());
    if(actual!==null||!['applied','duplicate'].includes(result))throw Error('Settlement not applied');
  }
  return {success:true};
}
export function createChain(relayerSecret:string,settlerSecret:string,policyId:string){
  function signer(role:string,secret:string){
    if(!secret.startsWith('ed25519:'))throw Error('Invalid signer configuration');
    const bytes=base58(secret.slice(8),90);
    if(![32,64].includes(bytes.length))throw Error('Invalid signer configuration');
    const der=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),bytes.subarray(0,32)]);
    const key=createPrivateKey({key:der,format:'der',type:'pkcs8'});
    bytes.fill(0);der.fill(0);
    const publicBytes=createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32);
    return {id:role+'.'+contract,key,publicBytes,publicKey:'ed25519:'+encode(publicBytes)};
  }
  const relayer=signer('relayer',relayerSecret),settler=signer('settler',settlerSecret);
  async function send(s:typeof relayer,method:string,args:object,kind:Intent['kind'],reservation:Reservation,b:Block,save:(intent:Intent)=>void|Promise<void>){
    if(BigInt(b.gas_price)>(policyId==='1'?100000000n:400000000n))throw Error('Testnet gas price above configured limit');
    const deployed=await rpc('query',{request_type:'view_account',account_id:contract,block_id:b.hash});
    if(deployed.code_hash!=='2s4ERzW1uRcMksDrDsXVpC9utdH1ytHzRXHCWECoCjrb')throw Error('Unexpected deployed contract code');
    const k=await access(s.id,s.publicKey,b);
    if(k.permission!=='FullAccess')throw Error('Signer key mismatch');
    const tx=Buffer.concat([string(s.id),Buffer.from([0]),s.publicBytes,integer(BigInt(k.nonce)+1n,8),string(contract),base58(b.hash),integer(1n,4),Buffer.from([2]),string(method),string(JSON.stringify(args)),integer(30000000000000n,8),integer(0n,16)]);
    const digest=sha(tx),hash=encode(digest);
    if(kind==='reserve')reservation.transactionHash=hash;
    const intent={hash,signer:s.id,kind,reservation};
    await save(intent);
    const signed=Buffer.concat([tx,Buffer.from([0]),sign(null,digest,s.key)]);
    try{await rpc('send_tx',{signed_tx_base64:signed.toString('base64'),wait_until:'INCLUDED'},true);}catch{/* Reconcile by hash. */}
    for(let i=0;i<3;i++){
      let result;
      try{result=await finalized(intent);}catch{/* Read again without rebroadcast. */}
      if(result){if(!result.success)throw Error('Finalized transaction failed');return hash;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw Error('Transaction outcome requires reconciliation');
  }
  return {
    async reserve(account:string,tokenId:string,commitment:string,save:(i:Intent)=>void|Promise<void>){
      const b=await block();
      const pass=await view('get_allowance',{token_id:tokenId},b);
      if(!pass||pass.owner_id!==account||pass.policy_id!==policyId||BigInt(pass.available)<1n||pass.pending!==0)throw Error('NFT unavailable for this inference policy');
      const issuer=await view('get_issuer',{issuer_id:pass.issuer_id},b);
      if(issuer.authorizer!==relayer.id||issuer.settler!==settler.id||issuer.paused)throw Error('Issuer configuration mismatch');
      const reservation={tokenId,sequence:pass.next_reservation_seq,commitment,transactionHash:''};
      await send(relayer,'reserve',{token_id:tokenId,holder_id:account,expected_epoch:pass.epoch,seq:reservation.sequence,request_commitment:commitment,valid_through_height:String(b.height+100)},'reserve',reservation,b,save);
      return reservation;
    },
    async settle(reservation:Reservation,kind:'consume'|'release',save:(i:Intent)=>void|Promise<void>){
      const b=await block();
      return send(settler,'settle',{token_id:reservation.tokenId,seq:reservation.sequence,disposition:kind},kind,reservation,b,save);
    },
  };
}
