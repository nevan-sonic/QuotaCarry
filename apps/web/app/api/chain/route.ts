const contract = 'quotacarry-fund-7b29e1.testnet';
const providers = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'];

async function rpc(endpoint: string, method: string, params: unknown) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:'quotacarry',method,params}),
    cache:'no-store', signal:AbortSignal.timeout(5000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.result) throw Error('Testnet RPC unavailable');
  return payload.result;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const hash = params.get('transaction');
  const signer = params.get('signer');
  if (hash || signer) {
    if (!hash || !/^[1-9A-HJ-NP-Za-km-z]{43,45}$/.test(hash) || !signer ||
        signer.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(signer)) {
      return Response.json({error:'Invalid transaction reference'},{status:400});
    }
    for (const endpoint of providers) {
      try {
        const outcome = await rpc(endpoint,'tx',{tx_hash:hash,sender_account_id:signer,wait_until:'FINAL'});
        if (outcome.final_execution_status !== 'FINAL') continue;
        if (outcome.transaction.receiver_id !== contract || outcome.transaction.signer_id !== signer) {
          return Response.json({error:'Transaction does not target QuotaCarry'},{status:400});
        }
        const success = Object.hasOwn(outcome.status,'SuccessValue') &&
          !outcome.receipts_outcome.some((receipt:{outcome:{status:object}})=>Object.hasOwn(receipt.outcome.status,'Failure'));
        return Response.json({final:true,success});
      } catch {
        // A pending or unavailable read can be checked again without resending.
      }
    }
    return Response.json({final:false},{status:202});
  }

  const owner = params.get('owner');
  if (owner && (owner.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(owner))) {
    return Response.json({error:'Invalid account ID'}, {status:400});
  }
  for (const endpoint of providers) {
    try {
      const [status,block] = await Promise.all([rpc(endpoint,'status',[]),rpc(endpoint,'block',{finality:'final'})]);
      if (status.chain_id !== 'testnet') continue;
      async function view(method_name: string,args: object) {
        const value = await rpc(endpoint,'query',{
          request_type:'call_function',account_id:contract,block_id:block.header.hash,
          method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64'),
        });
        return JSON.parse(Buffer.from(value.result).toString());
      }
      const tokens = owner ? await view('nft_tokens_for_owner',{account_id:owner,from_index:'0',limit:10}) : [await view('nft_token',{token_id:'0'})];
      const passes = await Promise.all(tokens.filter(Boolean).map(async (token:{token_id:string}) => {
        const allowance = await view('get_allowance',{token_id:token.token_id});
        const [policy,issuer] = await Promise.all([
          view('get_policy',{policy_id:allowance.policy_id}),
          view('get_issuer',{issuer_id:allowance.issuer_id}),
        ]);
        return {token,allowance,policy,issuer};
      }));
      return Response.json({network:'testnet',block:block.header.height,passes},{headers:{'Cache-Control':'no-store'}});
    } catch {
      // Retry read-only requests against the next testnet provider.
    }
  }
  return Response.json({error:'Finalized testnet state is temporarily unavailable'},{status:503});
}
