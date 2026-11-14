export interface QuotaCarryClientOptions {
  baseUrl: URL;
}

export type CompletionRequest={model:string;messages:[{role:'user';content:string}];max_completion_tokens?:256};
export type Completion={id:string;model:string;choices:{message:{role:'assistant';content:string};finish_reason:string}[];
  usage:{prompt_tokens:number;completion_tokens:number;total_tokens:number}};

export async function complete(
  baseUrl:URL,token:string,input:CompletionRequest,idempotencyKey:string,signal?:AbortSignal,
):Promise<Completion>{
  const url=new URL('/v1/chat/completions',baseUrl);
  if(url.protocol!=='https:'&&url.hostname!=='localhost')throw Error('Gateway requires HTTPS');
  const body=JSON.stringify(input);
  for(let attempt=0;attempt<60;attempt++){
    const result=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,
      'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body,redirect:'error',
      signal:AbortSignal.any(signal?[signal,AbortSignal.timeout(15000)]:[AbortSignal.timeout(15000)])});
    if(result.status===200)return await result.json() as Completion;
    if(result.status!==202)throw Error('QuotaCarry request failed with HTTP '+result.status);
    await result.body?.cancel();
    await new Promise(resolve=>setTimeout(resolve,10000));
  }
  throw Error('QuotaCarry job pending. Resume using the same idempotency key.');
}
