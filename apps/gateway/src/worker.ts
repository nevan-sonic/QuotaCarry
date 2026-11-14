import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {D1Database,ExecutionContext} from '@cloudflare/workers-types';
import {authorizedKey,createChain,finalized,listEntitlements,readEntitlement,readIssuer,type Intent} from './chain.js';
import {createChallenge,verifyNearMessage} from './near-message.js';
import {createGroqProvider,ProviderError} from './groq.js';
import {mintDeveloperToken,revokeDeveloperToken,readDeveloperToken,matchesEntitlement,rotateDeveloperToken} from './developer-tokens.js';
import {adapterRoute,configuredAdapter,dispatchAdapter,verifyAdapter,type AdapterRegistryEnv} from './issuer-routing.js';
import {claimStatus,enqueueClaim,recoverClaim} from './claims.js';
import {canManageAdapter,canManageTeam,type TeamRole} from './teams.js';

interface Env extends AdapterRegistryEnv {
  DB:D1Database;
  QC_ORIGIN?:string;
  QC_POLICY_ID?:string;
  QC_V2_TOKENS_ENABLED?:string;
  QC_V2_ROUTING_ENABLED?:string;
  QC_CLAIMS_ENABLED?:string;
  QC_ISSUER_KEY?:string;
  GROQ_MODEL?:string;
  GROQ_API_KEY?:string;
  QC_RELAYER_KEY?:string;
  QC_SETTLER_KEY?:string;
  QC_INFERENCE_ENABLED?:string;
}
type Job={developer_token_id?:string;issuer?:string;adapter_revision?:string;id:string;account:string;token:string;state:string;prompt:string|null;digest:string;intent:string|null;output:string|null;reserve_hash:string|null;settle_hash:string|null;lease:number;created:number};
const leaseMs=300000;
const hash=(input:string)=>createHash('sha256').update(input).digest('hex');
const account=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ready=(env:Env)=>Boolean(env.QC_INFERENCE_ENABLED==='1'&&env.DB&&env.QC_ORIGIN&&env.GROQ_MODEL&&env.GROQ_API_KEY&&env.QC_RELAYER_KEY&&env.QC_SETTLER_KEY&&betaPolicy(env));
const publicJob=(j:Job)=>({id:j.id,token:j.token,state:j.state,reservation:j.reserve_hash,settlement:j.settle_hash,
  output:j.state==='completed'?(j.issuer&&j.output?JSON.parse(j.output):j.output):null});
function betaPolicy(env:Env){return /^[0-9]{1,20}$/.test(env.QC_POLICY_ID??'')&&!['0','1'].includes(env.QC_POLICY_ID??'');}
function claimsEnabled(env:Env){return env.QC_CLAIMS_ENABLED==='1'&&betaPolicy(env)&&Boolean(env.QC_ISSUER_KEY&&env.QC_RELAYER_KEY&&env.QC_SETTLER_KEY);}
function chain(env:Env,policy=env.QC_POLICY_ID!){return createChain(env.QC_RELAYER_KEY!,env.QC_SETTLER_KEY!,policy,env.QC_ISSUER_KEY);}
const routingEnabled=(env:Env)=>env.QC_V2_TOKENS_ENABLED==='1'&&env.QC_V2_ROUTING_ENABLED==='1'&&Boolean(env.QC_RELAYER_KEY&&env.QC_SETTLER_KEY);
function row(env:Env,id:string){return env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<Job>();}
function state(env:Env,id:string,status:string,output:string|null=null){
  return env.DB.prepare("UPDATE jobs SET state=?,output=?,prompt=CASE WHEN ? IN ('completed','released','rejected','manual_review') THEN NULL ELSE prompt END WHERE id=?").bind(status,output,status,id).run();
}
function persist(env:Env,id:string,intent:Intent){
  const field=intent.kind==='reserve'?'reserve_hash':'settle_hash';
  return env.DB.prepare('UPDATE jobs SET intent=?,'+field+'=? WHERE id=?').bind(JSON.stringify(intent),intent.hash,id).run().then(()=>undefined);
}
async function run(env:Env,job:Job,prompt:string){
  const {id,account:owner,token,developer_token_id:developerTokenId}=job;
  try{
    let policy=env.QC_POLICY_ID!;
    let route:Awaited<ReturnType<typeof adapterRoute>>=null;
    let epoch:string|undefined;
    if(developerTokenId){
      const credential=await env.DB.prepare('SELECT * FROM qc_developer_tokens WHERE id=?').bind(developerTokenId).first<NonNullable<Awaited<ReturnType<typeof readDeveloperToken>>>>();
      if(!routingEnabled(env)||!credential||credential.account!==owner||credential.nft!==token||credential.issuer!==job.issuer||
        !matchesEntitlement(credential,await readEntitlement(token)))throw Error('Developer credential expired or entitlement changed');
      route=await adapterRoute(env,credential.issuer,credential.model);
      if(!route||route.row.revision!==job.adapter_revision)throw Error('Issuer adapter changed');
      epoch=credential.epoch;
      policy=credential.policy;
    }
    const service=chain(env,policy);
    const reservation=await service.reserve(owner,token,hash(id),intent=>persist(env,id,intent),epoch,job.issuer??undefined);
    await env.DB.prepare("UPDATE jobs SET state='calling_provider',prompt=NULL WHERE id=?").bind(id).run();
    let output:string|null=null;
    let disposition:'consume'|'release'='consume';
    try{
      if(route){
        const current=await adapterRoute(env,route.row.issuer,route.row.model);
        if(!current||current.row.revision!==route.row.revision)throw new ProviderError('rejected','Issuer adapter revoked before dispatch');
        output=JSON.stringify(await dispatchAdapter(route.config,route.row.model,prompt,id));
      }else output=await createGroqProvider(env.GROQ_API_KEY!,env.GROQ_MODEL!)(prompt);
    }
    catch(error){
      if(!(error instanceof ProviderError)||error.outcome!=='rejected'){
        await state(env,id,'manual_review');
        return;
      }
      disposition='release';
    }
    await state(env,id,disposition+'_pending',output);
    await service.settle(reservation,disposition,intent=>persist(env,id,intent));
    await state(env,id,disposition==='consume'?'completed':'released',output);
  }catch{
    const job=await row(env,id);
    if(job?.state==='reserving'&&!job.intent)await state(env,id,'rejected');
    else if(job?.state==='calling_provider')await state(env,id,'manual_review');
    console.warn(JSON.stringify({event:'inference_interrupted',job:id}));
  }
}
export async function recover(env:Env,now=Date.now()){
  await env.DB.batch([
    env.DB.prepare('DELETE FROM challenges WHERE expires<=?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires<=?').bind(now),
    env.DB.prepare('DELETE FROM limits WHERE expires<=?').bind(now),
  ]);
  if(betaPolicy(env)&&env.QC_ISSUER_KEY&&env.QC_RELAYER_KEY&&env.QC_SETTLER_KEY){
    try{await recoverClaim(env.DB,()=>chain(env),claimsEnabled(env),now);}
    catch{console.warn(JSON.stringify({event:'claim_reconciliation_pending'}));}
  }
  if(!betaPolicy(env)||!env.QC_RELAYER_KEY||!env.QC_SETTLER_KEY)return;
  const job=await env.DB.prepare("SELECT * FROM jobs WHERE lease<=? AND state IN ('queued','reserving','calling_provider','consume_pending','release_pending') LIMIT 1").bind(now).first<Job>();
  if(!job)return;
  const claimed=await env.DB.prepare('UPDATE jobs SET lease=? WHERE id=? AND lease=? AND state=?').bind(now+leaseMs,job.id,job.lease,job.state).run();
  if(claimed.meta.changes!==1)return;
  if(job.state==='queued'&&job.prompt!==null){
    if(job.developer_token_id?!routingEnabled(env):!ready(env))return;
    await state(env,job.id,'reserving');
    await run(env,job,job.prompt);
    return;
  }
  if(job.state==='calling_provider'||!job.intent){
    await state(env,job.id,job.state==='reserving'?'rejected':'manual_review');return;
  }
  const intent=JSON.parse(job.intent) as Intent;
  if(intent.kind==='reserve'&&['consume_pending','release_pending'].includes(job.state)){
    const disposition=job.state==='consume_pending'?'consume':'release';
    await chain(env).settle(intent.reservation,disposition,next=>persist(env,job.id,next));
    await state(env,job.id,disposition==='consume'?'completed':'released',job.output);return;
  }
  const outcome=await finalized(intent);
  const next=intent.kind==='reserve'?(outcome.success?'manual_review':'rejected'):
    outcome.success?(intent.kind==='consume'?'completed':'released'):'manual_review';
  await state(env,job.id,next,job.output);
}
async function read(req:Request){
  const reader=req.body?.getReader();
  if(!reader)throw Error('Missing JSON');
  const decoder=new TextDecoder();
  let size=0,json='';
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>16384){await reader.cancel();throw Error('Request too large');}
    json+=decoder.decode(value,{stream:true});
  }
  const value=JSON.parse(json+decoder.decode());
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid JSON');
  return value as Record<string,unknown>;
}
async function handle(req:Request,env:Env){
  const path=new URL(req.url).pathname;
  const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'});
  const respond=(data:object,status=200)=>Response.json(data,{status,headers});
  if(req.method==='GET'&&path==='/health')return respond({ready:true});
  if(req.method==='GET'&&path==='/ready'){
    await env.DB.prepare('SELECT nonce FROM challenges LIMIT 1').first();
    return respond({database:'available',model:env.GROQ_MODEL??null,inference:ready(env)?'configured':'not_configured'},ready(env)?200:503);
  }
  const developerPath=['/v1/chat/completions','/v1/models','/v1/entitlements','/v1/usage'].includes(path)||(/^\/v1\/jobs\//.test(path)&&Boolean(req.headers.get('Authorization')?.startsWith('Bearer qc_')));
  if(!env.QC_ORIGIN||(!developerPath||req.headers.has('Origin'))&&req.headers.get('Origin')!==env.QC_ORIGIN)return respond({error:'Origin rejected'},403);
  headers.set('Access-Control-Allow-Origin',env.QC_ORIGIN);
  headers.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers','Content-Type, Authorization, Idempotency-Key');
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(!path.startsWith('/v1/')&&!['/v2/tokens','/v2/issuer-adapter','/v2/nfts','/v2/team'].includes(path))return respond({error:'Route not found'},404);
  const now=Date.now(), minute=Math.floor(now/60000);
  const bucket=hash((req.headers.get('CF-Connecting-IP')??'local')+':'+minute);
  const limit=await env.DB.prepare('INSERT INTO limits VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count')
    .bind(bucket,(minute+1)*60000).first<{count:number}>();
  if(!limit||limit.count>60)return respond({error:'Rate limit exceeded'},429);
  let input:Record<string,unknown>={};
  if(req.method==='POST'){
    try{input=await read(req);}catch{return respond({error:'Invalid or oversized JSON'},400);}
  }
  if(req.method==='POST'&&path==='/v1/challenge'){
    if(typeof input.account!=='string'||input.account.length>64||!account.test(input.account))return respond({error:'Invalid account'},400);
    const c=createChallenge(input.account,new URL(env.QC_ORIGIN).hostname);
    await env.DB.prepare('INSERT INTO challenges VALUES (?,?,?)').bind(c.nonce,JSON.stringify(c),c.expiresAt).run();
    return respond(c,201);
  }
  if(req.method==='POST'&&path==='/v1/session'){
    const {nonce,publicKey,signature,accountId}=input;
    if(typeof nonce!=='string'||typeof publicKey!=='string'||typeof signature!=='string')return respond({error:'Invalid proof'},400);
    const saved=await env.DB.prepare('SELECT value FROM challenges WHERE nonce=? AND expires>?').bind(nonce,now).first<{value:string}>();
    if(!saved)return respond({error:'Challenge expired or consumed'},401);
    const c=JSON.parse(saved.value);
    if(accountId!==c.accountId||!verifyNearMessage(c,publicKey,signature)||!await authorizedKey(c.accountId,publicKey))return respond({error:'Wallet proof rejected'},401);
    const token=randomBytes(32).toString('base64url');
    const consumed=await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM challenges WHERE nonce=? AND expires>?)').bind(hash(token),c.accountId,publicKey,Date.now()+300000,nonce,Date.now()),
      env.DB.prepare('DELETE FROM challenges WHERE nonce=?').bind(nonce),
    ]);
    if(consumed[0].meta.changes!==1)return respond({error:'Challenge expired or consumed'},401);
    return respond({token,expiresIn:300},201);
  }
  const bearer=req.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const credential=developerPath&&routingEnabled(env)
    ?await readDeveloperToken(env.DB,req.headers.get('Authorization')):null;
  const entitlement=credential?await readEntitlement(credential.nft):null;
  if(developerPath&&(!credential||!matchesEntitlement(credential,entitlement)))return respond({error:{message:'Developer credential rejected',type:'invalid_request_error'}},401);
  if(credential&&req.method==='GET'){
    if(path==='/v1/models'){
      const route=await adapterRoute(env,credential.issuer,credential.model);
      return respond({object:'list',data:route?[{id:credential.model,object:'model',owned_by:credential.issuer}]:[]});
    }
    if(path==='/v1/entitlements')return respond({token:credential.nft,allowance:entitlement});
    if(path==='/v1/usage'){
      const records=await env.DB.prepare('SELECT id,state,created,reserve_hash,settle_hash FROM jobs WHERE issuer=? AND developer_token_id=? AND account=? ORDER BY created DESC LIMIT 50')
        .bind(credential.issuer,credential.id,credential.account).all();
      return respond({data:records.results});
    }
  }
  const walletSession=bearer&&await env.DB.prepare('SELECT account,public_key FROM sessions WHERE token=? AND expires>?').bind(hash(bearer),now).first<{account:string;public_key:string}>();
  const session=credential?{account:credential.account,public_key:''}:walletSession;
  if(!session)return respond({error:'Authenticate your wallet'},401);
  if(path==='/v2/nfts'&&req.method==='GET'){
    const from=new URL(req.url).searchParams.get('from')??'0';
    if(!/^\d{1,20}$/.test(from))return respond({error:'Invalid cursor'},400);
    const nfts=await listEntitlements(session.account,from);
    return respond({nfts,next:nfts.length===10?String(BigInt(from)+10n):null,routing:routingEnabled(env)});
  }
  if(path==='/v2/issuer-adapter'||path==='/v2/team'){
    if(!routingEnabled(env))return respond({error:'Issuer routing is disabled'},503);
    const issuerId=req.method==='GET'?new URL(req.url).searchParams.get('issuer'):input.issuer;
    if(typeof issuerId!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(issuerId)||['0','1','2'].includes(issuerId))return respond({error:'Invalid issuer'},400);
    if(!await authorizedKey(session.account,session.public_key))return respond({error:'Wallet key revoked'},401);
    const issuer=await readIssuer(issuerId);
    if(!issuer)return respond({error:'Issuer unavailable'},404);
    const actor=session.account, owner=issuer.controller===actor;
    const team=await env.DB.prepare('SELECT name FROM qc_issuer_teams WHERE issuer=? AND controller=?').bind(issuerId,issuer.controller).first<{name:string}>();
    const member=team?await env.DB.prepare('SELECT role,accepted FROM qc_team_members WHERE issuer=? AND account=?').bind(issuerId,actor)
      .first<{role:TeamRole;accepted:number}>():null;
    const role=owner?'owner':member?.accepted?member.role:null;
    if(path==='/v2/team'){
      const now=Date.now();
      if(req.method==='GET'){
        if(!role)return respond({error:'Team membership required'},403);
        const members=team?await env.DB.prepare('SELECT account,role,accepted FROM qc_team_members WHERE issuer=? ORDER BY account LIMIT 100').bind(issuerId).all():null;
        const audit=team?await env.DB.prepare('SELECT actor,target,action,created FROM qc_team_audit WHERE issuer=? ORDER BY id DESC LIMIT 50').bind(issuerId).all():null;
        return respond({team,role,controller:issuer.controller,members:members?.results??[],audit:audit?.results??[]});
      }
      if(req.method!=='POST')return respond({error:'Method rejected'},405);
      if(input.action==='create'&&owner&&typeof input.name==='string'&&input.name.trim()&&input.name.length<=64){
        await env.DB.prepare('INSERT OR IGNORE INTO qc_issuer_teams VALUES (?,?,?)').bind(issuerId,actor,input.name.trim()).run();
        return respond({created:true});
      }
      if(input.action==='accept'&&member&&!member.accepted){
        const result=await env.DB.batch([
          env.DB.prepare("INSERT INTO qc_team_audit(issuer,actor,target,action,created) SELECT issuer,account,account,'accepted',? FROM qc_team_members WHERE issuer=? AND account=? AND accepted=0").bind(now,issuerId,actor),
          env.DB.prepare('UPDATE qc_team_members SET accepted=1 WHERE issuer=? AND account=? AND accepted=0').bind(issuerId,actor),
        ]);
        return result[1].meta.changes===1?respond({accepted:true}):respond({error:'Invitation changed'},409);
      }
      const target=input.account;
      if(!team||!role||typeof target!=='string'||target.length>64||!account.test(target)||target===issuer.controller)return respond({error:'Team action rejected'},403);
      const existing=await env.DB.prepare('SELECT role FROM qc_team_members WHERE issuer=? AND account=?').bind(issuerId,target).first<{role:TeamRole}>();
      const targetRole=input.role as TeamRole;
      if(existing&&!canManageTeam(role,existing.role))return respond({error:'Target role protected'},403);
      const action=input.action;
      if(action!=='remove'&&action!=='invite'&&action!=='role')return respond({error:'Unknown team action'},400);
      if(action==='remove'&&(!existing||!canManageTeam(role,existing.role)))return respond({error:'Removal rejected'},403);
      if(action!=='remove'&&(!['administrator','developer','viewer'].includes(targetRole)||!canManageTeam(role,targetRole)))return respond({error:'Role assignment rejected'},403);
      const actorGuard="EXISTS (SELECT 1 FROM qc_issuer_teams WHERE issuer=? AND controller=?) AND (?='owner' OR EXISTS (SELECT 1 FROM qc_team_members WHERE issuer=? AND account=? AND role=? AND accepted=1))";
      const guard=[issuerId,issuer.controller,role,issuerId,actor,role];
      const statement=action==='invite'
        ?env.DB.prepare("INSERT OR IGNORE INTO qc_team_members SELECT ?,?,?,0 WHERE "+actorGuard+" AND (SELECT count(*) FROM qc_team_members WHERE issuer=?)<50").bind(issuerId,target,targetRole,...guard,issuerId)
        :action==='role'
          ?env.DB.prepare('UPDATE qc_team_members SET role=? WHERE issuer=? AND account=? AND role=? AND '+actorGuard).bind(targetRole,issuerId,target,existing?.role??'',...guard)
          :env.DB.prepare('DELETE FROM qc_team_members WHERE issuer=? AND account=? AND role=? AND '+actorGuard).bind(issuerId,target,existing?.role??'',...guard);
      const changes=await env.DB.batch([statement,env.DB.prepare('INSERT INTO qc_team_audit(issuer,actor,target,action,created) SELECT ?,?,?,?,? WHERE changes()=1').bind(issuerId,actor,target,action,now)]);
      return changes[0].meta.changes===1?respond({updated:true}):respond({error:'Membership changed or team limit reached'},409);
    }
    if(!role||(req.method!=='GET'&&!canManageAdapter(role)))return respond({error:'Issuer permission required'},403);
    if(req.method==='GET'){
      const config=await env.DB.prepare('SELECT issuer,model,daily_limit,updated FROM qc_issuer_adapters WHERE issuer=? AND controller=?').bind(issuerId,issuer.controller).first();
      const audit=await env.DB.prepare('SELECT action,actor,created FROM qc_issuer_adapter_audit WHERE issuer=? ORDER BY id DESC LIMIT 50').bind(issuerId).all();
      return respond({config,audit:audit.results});
    }
    if(req.method!=='POST')return respond({error:'Method rejected'},405);
    const now=Date.now();
    const writeGuard="(?=1 OR EXISTS (SELECT 1 FROM qc_team_members m JOIN qc_issuer_teams t ON m.issuer=t.issuer WHERE m.issuer=? AND t.controller=? AND m.account=? AND m.accepted=1 AND m.role='administrator'))";
    const guardArgs=[Number(owner),issuerId,issuer.controller,actor];
    if(input.action==='revoke'){
      const result=await env.DB.batch([
        env.DB.prepare("INSERT INTO qc_issuer_adapter_audit(issuer,actor,action,revision,created) SELECT issuer,?,'revoked',revision,? FROM qc_issuer_adapters WHERE issuer=? AND "+writeGuard).bind(actor,now,issuerId,...guardArgs),
        env.DB.prepare('DELETE FROM qc_issuer_adapters WHERE issuer=? AND '+writeGuard).bind(issuerId,...guardArgs),
      ]);
      return result[1].meta.changes===1?respond({revoked:true}):respond({error:'Adapter unavailable or permission changed'},409);
    }
    const {model,dailyLimit}=input;
    if(input.action!=='verify'||typeof model!=='string'||!/^[A-Za-z0-9/_-]{1,128}$/.test(model)||typeof dailyLimit!=='number'||!Number.isInteger(dailyLimit)||dailyLimit<1||dailyLimit>4)return respond({error:'Invalid adapter configuration'},400);
    const config=configuredAdapter(env,issuerId);
    if(!config||issuer.paused||issuer.authorizer!=='relayer.quotacarry-fund-7b29e1.testnet'||issuer.settler!=='settler.quotacarry-fund-7b29e1.testnet'||!await verifyAdapter(config,issuerId,model))return respond({error:'Adapter verification rejected'},409);
    if((await readIssuer(issuerId))?.controller!==issuer.controller)return respond({error:'Issuer controller changed'},403);
    const result=await env.DB.batch([
      env.DB.prepare('INSERT INTO qc_issuer_adapters SELECT ?,?,?,?,?,? WHERE '+writeGuard+' ON CONFLICT(issuer) DO UPDATE SET controller=excluded.controller,revision=excluded.revision,model=excluded.model,daily_limit=excluded.daily_limit,updated=excluded.updated').bind(issuerId,issuer.controller,config.revision,model,dailyLimit,now,...guardArgs),
      env.DB.prepare("INSERT INTO qc_issuer_adapter_audit(issuer,actor,action,revision,created) SELECT ?,?,'verified',?,? WHERE changes()=1").bind(issuerId,actor,config.revision,now),
    ]);
    return result[0].meta.changes===1?respond({verified:true,issuer:issuerId,model,dailyLimit}):respond({error:'Issuer permission changed'},403);
  }
  if(req.method==='GET'&&/^\/v1\/jobs\/[a-f0-9-]{36}$/.test(path)){
    const job=await row(env,path.split('/').at(-1)!);
    return job?.account===session.account&&(!credential||(job.issuer===credential.issuer&&job.developer_token_id===credential.id))?respond(publicJob(job)):respond({error:'Job not found'},404);
  }
  if(path==='/v2/tokens'){
    if(!routingEnabled(env))return respond({error:'Developer credentials are disabled'},503);
    if(!await authorizedKey(session.account,session.public_key))return respond({error:'Wallet key revoked'},401);
    if(req.method==='GET'){
      const results=await env.DB.prepare('SELECT id,nft,issuer,policy,epoch,name,model,expires,revoked,last_used FROM qc_developer_tokens WHERE account=? ORDER BY expires DESC LIMIT 50').bind(session.account).all();
      return respond({tokens:results.results});
    }
    if(req.method==='POST'){
      const {nft,name,revokeId}=input;
      if(typeof input.rotateId==='string'&&/^[a-f0-9-]{36}$/.test(input.rotateId)){
        const previous=await env.DB.prepare('SELECT * FROM qc_developer_tokens WHERE id=? AND account=?').bind(input.rotateId,session.account)
          .first<NonNullable<Awaited<ReturnType<typeof readDeveloperToken>>>>();
        const pass=previous?await readEntitlement(previous.nft):null;
        if(!previous||!pass||!matchesEntitlement(previous,pass)||!await adapterRoute(env,previous.issuer,previous.model))return respond({error:'Credential cannot be rotated'},409);
        const replacement=await rotateDeveloperToken(env.DB,session.account,previous.id,pass);
        return replacement?respond(replacement,201):respond({error:'Credential already changed'},409);
      }
      if(typeof revokeId==='string'&&/^[a-f0-9-]{36}$/.test(revokeId)){
        const result=await revokeDeveloperToken(env.DB,session.account,revokeId);
        return result.meta.changes===1?respond({revoked:true}):respond({error:'Token not found'},404);
      }
      if(typeof nft!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(nft)||typeof name!=='string'||!name.trim()||name.length>64)return respond({error:'Invalid token request'},400);
      const ttl=input.ttlMinutes??1440;
      if(typeof ttl!=='number'||!Number.isInteger(ttl)||ttl<5||ttl>1440)return respond({error:'Invalid credential expiration'},400);
      const pass=await readEntitlement(nft);
      const model=input.model;
      if(typeof model!=='string'||!pass||pass.owner_id!==session.account||BigInt(pass.available)<1n||!await adapterRoute(env,pass.issuer_id,model))return respond({error:'Entitlement or adapter unavailable'},403);
      const token=await mintDeveloperToken(env.DB,session.account,nft,name.trim(),model,pass,ttl);
      return token?respond(token,201):respond({error:'Token quota reached'},429);
    }
  }
  if(path==='/v1/claim'){
    if(req.method==='GET')return respond(await claimStatus(env.DB,session.account,claimsEnabled(env)));
    if(req.method==='POST'){
      if(!claimsEnabled(env))return respond({error:'Trial claims are disabled'},503);
      if(!await authorizedKey(session.account,session.public_key))return respond({error:'Wallet key revoked'},401);
      await enqueueClaim(env.DB,session.account);
      return respond(await claimStatus(env.DB,session.account,true),202);
    }
  }
  if(req.method!=='POST'||(path!=='/v1/inference'&&path!=='/v1/chat/completions'))return respond({error:'Route not found'},404);
  if(credential?!routingEnabled(env):!ready(env))return respond({error:'Inference is not configured'},503);
  if(credential){
    const allowed=new Set(['model','messages','stream','max_tokens','max_completion_tokens']);
    const messages=input.messages;
    const limit=input.max_completion_tokens??input.max_tokens??256;
    if(Object.keys(input).some(key=>!allowed.has(key))||input.model!==credential.model||
      (input.stream!==undefined&&input.stream!==false)||limit!==256||
      !Array.isArray(messages)||messages.length!==1||messages[0]?.role!=='user'){
      return respond({error:{message:'Use one user message, non-streaming, with a 256-token completion limit',type:'invalid_request_error'}},400);
    }
    input={tokenId:credential.nft,prompt:messages[0].content,idempotencyKey:req.headers.get('Idempotency-Key')};
  }
  const {tokenId,prompt,idempotencyKey}=input;
  if(typeof tokenId!=='string'||!/^\d{1,20}$/.test(tokenId)||typeof prompt!=='string'||!prompt.trim()||Buffer.byteLength(prompt)>768||typeof idempotencyKey!=='string'||!/^[-a-zA-Z0-9]{16,64}$/.test(idempotencyKey))return respond({error:'Invalid inference request'},400);
  const digest=hash(JSON.stringify(credential?[tokenId,prompt,credential.id]:[tokenId,prompt]));
  const existing=()=>env.DB.prepare('SELECT * FROM jobs WHERE account=? AND dedupe=?').bind(session.account,idempotencyKey).first<Job>();
  function priorResponse(job:Job){
    if(job.digest!==digest)return respond({error:'Idempotency key already used'},409);
    if(!credential)return respond(publicJob(job));
    if(['released','rejected','manual_review'].includes(job.state))return respond(publicJob(job),409);
    if(job.state!=='completed')return respond(publicJob(job),202);
    const result=JSON.parse(job.output!) as Awaited<ReturnType<typeof dispatchAdapter>>;
    return respond({id:job.id,object:'chat.completion',created:Math.floor(job.created/1000),model:credential.model,usage:result.usage,
      choices:[{index:0,message:{role:'assistant',content:result.content},finish_reason:result.finish_reason}]});
  }
  const prior=await existing();
  if(prior)return priorResponse(prior);
  const id=randomUUID();
  let insert;
  if(credential){
    const route=await adapterRoute(env,credential.issuer,credential.model);
    if(!route||!await chain(env,credential.policy).eligible(session.account,tokenId))return respond({error:'Entitlement or adapter unavailable'},403);
    insert=await env.DB.prepare(`INSERT OR IGNORE INTO jobs(id,account,dedupe,digest,token,prompt,state,created,lease,developer_token_id,issuer,adapter_revision)
      SELECT ?,?,?,?,?,?,'queued',?,0,?,?,revision FROM qc_issuer_adapters
      WHERE issuer=? AND revision=? AND model=?
      AND (SELECT count(*) FROM jobs WHERE issuer=? AND created>?)<daily_limit
      AND (SELECT count(*) FROM jobs WHERE issuer IS NOT NULL AND created>?)<4
      AND (SELECT count(*) FROM jobs WHERE issuer IS NOT NULL)<20
      AND (SELECT count(*) FROM jobs WHERE issuer=? AND token=?)<2
      AND EXISTS (SELECT 1 FROM qc_developer_tokens WHERE id=? AND revoked IS NULL AND expires>?)
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE developer_token_id=? AND created>?)`)
      .bind(id,session.account,idempotencyKey,digest,tokenId,prompt,now,credential.id,credential.issuer,
        credential.issuer,route.row.revision,credential.model,credential.issuer,now-86400000,now-86400000,
        credential.issuer,tokenId,credential.id,now,credential.id,now-60000).run();
  }else{
    if(!await authorizedKey(session.account,session.public_key))return respond({error:'Wallet key revoked'},401);
    if(!await chain(env).eligible(session.account,tokenId))return respond({error:'NFT unavailable for this account'},403);
    insert=await env.DB.prepare("INSERT OR IGNORE INTO jobs(id,account,dedupe,digest,token,prompt,state,created,lease) SELECT ?,?,?,?,?,?,'queued',?,? WHERE EXISTS (SELECT 1 FROM beta_claims WHERE token=? AND state='completed') AND (SELECT COUNT(*) FROM jobs WHERE issuer IS NULL AND created>?)*1536+1536 <= 6144 AND (SELECT COUNT(*) FROM jobs WHERE token=?) < 2 AND (SELECT COUNT(*) FROM jobs WHERE token IN (SELECT token FROM beta_claims WHERE token IS NOT NULL)) < 20 AND NOT EXISTS (SELECT 1 FROM jobs WHERE issuer IS NULL AND account=? AND created>?)")
      .bind(id,session.account,idempotencyKey,digest,tokenId,prompt,now,0,tokenId,now-86400000,tokenId,session.account,now-60000).run();
  }
  if(insert.meta.changes!==1){
    const concurrent=await existing();
    return concurrent?priorResponse(concurrent):respond({error:'Inference busy, daily limit reached, or reconciliation required'},409);
  }

  return respond({id,state:'queued'},202);
}
export default {
  async fetch(req:Request,env:Env){
    try{return await handle(req,env);}
    catch{
      const headers:Record<string,string>={'Cache-Control':'no-store'};
      if(env.QC_ORIGIN&&req.headers.get('Origin')===env.QC_ORIGIN)headers['Access-Control-Allow-Origin']=env.QC_ORIGIN;
      return Response.json({error:'Gateway temporarily unavailable'},{status:503,headers});
    }
  },
  scheduled(_event:unknown,env:Env,ctx:ExecutionContext){
    ctx.waitUntil(recover(env).catch(()=>console.warn(JSON.stringify({event:'recovery_pending'}))));
  },
};
