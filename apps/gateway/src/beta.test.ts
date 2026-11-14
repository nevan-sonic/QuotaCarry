import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('team roles do not grant owner or administrator escalation', async () => {
  const {canManageTeam,canManageAdapter}=await import('./teams.js');
  for(const role of [null,'viewer','developer'] as const){
    assert(!canManageAdapter(role));
    assert(!canManageTeam(role,'viewer'));
  }
  assert(canManageTeam('administrator','developer'));
  assert(!canManageTeam('administrator','administrator'));
  assert(!canManageTeam('owner','owner'));
  assert(canManageTeam('owner','administrator'));
});

test('credential rotation is atomic, tenant scoped, and preserves model and epoch', async () => {
  const {rotateDeveloperToken,readDeveloperToken}=await import('./developer-tokens.js');
  const db=new DatabaseSync(':memory:');
  try {
    for(const name of ['0001_inference.sql','0002_beta.sql','0003_developer_tokens.sql','0004_issuer_adapters.sql','0005_credential_rotation.sql']){
      db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    }
    const binding={prepare:(sql:string)=>({bind:(...params:string[])=>({first:async()=>db.prepare(sql).get(...params)??null})})} as unknown as import('@cloudflare/workers-types').D1Database;
    db.prepare('INSERT INTO qc_developer_tokens(digest,id,account,nft,issuer,policy,epoch,name,model,expires) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('old-digest','old','alice.testnet','5','3','4','1','integration','demo',Date.now()+60000);
    const pass={owner_id:'alice.testnet',issuer_id:'3',policy_id:'4',epoch:'1',available:'1'};
    assert.equal(await rotateDeveloperToken(binding,'bob.testnet','old',pass),null);
    assert.equal(await rotateDeveloperToken(binding,'alice.testnet','old',{...pass,epoch:'3'}),null);
    const results=await Promise.all([rotateDeveloperToken(binding,'alice.testnet','old',pass),rotateDeveloperToken(binding,'alice.testnet','old',pass)]);
    assert.equal(results.filter(Boolean).length,1);
    const replacement=results.find(Boolean)!;
    assert.equal((await readDeveloperToken(binding,'Bearer '+replacement.token))?.epoch,'1');
    assert.equal(replacement.model,'demo');
    assert(db.prepare("SELECT revoked FROM qc_developer_tokens WHERE id='old'").get()?.revoked);
    assert.equal(db.prepare("SELECT count(*) AS count FROM qc_credential_audit WHERE action='rotated'").get()?.count,1);
  } finally {db.close();}
});

test('beta allocations enforce account uniqueness, bounded supply and one active mint', () => {
  const db=new DatabaseSync(':memory:');
  try {
    for(const name of ['0001_inference.sql','0002_beta.sql'])db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    const claim=db.prepare("INSERT OR IGNORE INTO beta_claims(account,state) SELECT ?,'queued' WHERE (SELECT count(*) FROM beta_claims)<10");
    assert.equal(claim.run('wallet0.testnet').changes,1);
    assert.equal(claim.run('wallet0.testnet').changes,0);
    for(let i=1;i<10;i++)assert.equal(claim.run('wallet'+i+'.testnet').changes,1);
    assert.equal(claim.run('overflow.testnet').changes,0);
    const lease=db.prepare("UPDATE OR IGNORE beta_claims SET state='minting',lease=300000 WHERE account=? AND state='queued' AND lease=0");
    assert.equal(lease.run('wallet0.testnet').changes,1);
    assert.equal(lease.run('wallet0.testnet').changes,0);
    assert.equal(lease.run('wallet1.testnet').changes,0);
  }finally{db.close();}
});

test('scheduled recovery preserves an interrupted provider reservation without replaying work', async () => {
  const {recover}=await import('./worker.js');
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../migrations/0001_inference.sql',import.meta.url),'utf8'));
    db.prepare("INSERT INTO jobs(id,account,dedupe,digest,token,state,intent,reserve_hash,created,lease) VALUES (?,?,?,?,?,'calling_provider',?,?,?,?)")
      .run('job','wallet.testnet','request','digest','2','{"kind":"reserve"}','known-reserve-hash',1,0);
    const prepare=(sql:string,values:(string|number|null)[]=[])=>({
      bind:(...args:(string|number|null)[])=>prepare(sql,args),
      first:async()=>db.prepare(sql).get(...values)??null,
      run:async()=>({meta:{changes:Number(db.prepare(sql).run(...values).changes)}}),
    });
    const binding={prepare,batch:async(statements:ReturnType<typeof prepare>[])=>Promise.all(statements.map(statement=>statement.run()))};
    const env={DB:binding as unknown as import('@cloudflare/workers-types').D1Database,QC_POLICY_ID:'2',QC_RELAYER_KEY:'unused',QC_SETTLER_KEY:'unused'};
    await recover(env,1000);
    await recover(env,400000);
    const row=db.prepare("SELECT state,reserve_hash,settle_hash FROM jobs WHERE id='job'").get();
    assert.equal(row?.state,'manual_review');
    assert.equal(row?.reserve_hash,'known-reserve-hash');
    assert.equal(row?.settle_hash,null);
  } finally {db.close();}
});

test('developer credentials fail closed after transfer, transfer back, expiry or revocation', async () => {
  const {matchesEntitlement}=await import('./developer-tokens.js');
  const credential={id:'test',account:'alice.testnet',nft:'5',issuer:'2',policy:'2',epoch:'1',name:'test',model:'model',expires:100,revoked:null};
  const pass={owner_id:'alice.testnet',issuer_id:'2',policy_id:'2',epoch:'1',available:'1'};
  assert(matchesEntitlement(credential,pass,50));
  assert(!matchesEntitlement(credential,{...pass,owner_id:'bob.testnet',epoch:'2'},50));
  assert(!matchesEntitlement(credential,{...pass,epoch:'3'},50));
  assert(!matchesEntitlement(credential,{...pass,issuer_id:'3'},50));
  assert(!matchesEntitlement(credential,pass,100));
  assert(!matchesEntitlement({...credential,revoked:49},pass,50));
});

test('adapter signatures bind the route and reject nonce replay', async () => {
  const {adapterSignature,verifyAdapterRequest}=await import('./issuer-adapter.js');
  const seen=new Set<string>();
  const db={prepare:()=>({bind:(nonce:string)=>({run:async()=>{
    const changes=seen.has(nonce)?0:1;
    seen.add(nonce);
    return {meta:{changes}};
  }})})} as unknown as import('@cloudflare/workers-types').D1Database;
  const key='a'.repeat(32), time='1700000000000', nonce='b'.repeat(32);
  const body='/v1/verify\n{}', signature=adapterSignature(key,time,nonce,body);
  assert(!await verifyAdapterRequest(db,key,time,nonce,'/v1/inference\n{}',signature,Number(time)));
  assert(await verifyAdapterRequest(db,key,time,nonce,body,signature,Number(time)));
  assert(!await verifyAdapterRequest(db,key,time,nonce,body,signature,Number(time)));
});

test('adapter routing pins the issuer to its own binding and rejects shared slots, keys and redirects', async () => {
  const {adapterRoute,configuredAdapter,dispatchAdapter,verifyAdapter}=await import('./issuer-routing.js');
  const {adapterSignature}=await import('./issuer-adapter.js');
  const calls:string[]=[];
  const binding=(label:string,key:string)=>({fetch:async(url:string,init:RequestInit)=>{
    calls.push(label);
    assert.equal(init.redirect,'manual');
    const headers=new Headers(init.headers);
    const path=new URL(url).pathname;
    assert.equal(new URL(url).hostname,'adapter.internal');
    const time=headers.get('X-QC-Timestamp')!,nonce=headers.get('X-QC-Nonce')!;
    assert.equal(headers.get('X-QC-Signature'),adapterSignature(key,time,nonce,path+'\n'+init.body));
    if(path==='/v1/verify')return Response.json({model:'demo',signature:adapterSignature(key,time,nonce,'verify-response\n'+JSON.stringify([init.body,'demo']))});
    return label==='A'?Response.json({model:'demo',content:'issuer A',finish_reason:'stop',usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}}):new Response(null,{status:302,headers:{Location:'http://169.254.169.254/'}});
  }});
  const A={issuer:'3',slot:'A',key:'a'.repeat(64)},B={issuer:'4',slot:'B',key:'b'.repeat(64)};
  type Env=import('./issuer-routing.js').AdapterRegistryEnv;
  const env={QC_ADAPTER_KEYS:JSON.stringify([A,B]),QC_ADAPTER_A:binding('A',A.key),QC_ADAPTER_B:binding('B',B.key)} as unknown as Env;
  const a=configuredAdapter(env,'3')!,b=configuredAdapter(env,'4')!;
  assert.equal(configuredAdapter(env,'2'),null);
  assert.equal(configuredAdapter({...env,QC_ADAPTER_KEYS:JSON.stringify([A,{...B,slot:A.slot}])},'3'),null);
  assert.equal(configuredAdapter({...env,QC_ADAPTER_KEYS:JSON.stringify([A,{...B,key:A.key}])},'3'),null);
  assert(await verifyAdapter(a,'3','demo'));
  assert(!await verifyAdapter(a,'3','wrong-model'));
  const db=new DatabaseSync(':memory:');
  try {
    for(const name of ['0001_inference.sql','0002_beta.sql','0003_developer_tokens.sql','0004_issuer_adapters.sql']){
      db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    }
    db.prepare('INSERT INTO qc_issuer_adapters VALUES (?,?,?,?,?,?)').run('3','a.testnet',a.revision,'demo',1,0);
    env.DB={prepare:(sql:string)=>({bind:(...params:string[])=>({first:async()=>db.prepare(sql).get(...params)??null})})} as unknown as Env['DB'];
    assert(await adapterRoute(env,'3','demo'));
    assert.equal(await adapterRoute(env,'4','demo'),null);
    assert.equal(await adapterRoute(env,'3','other-model'),null);
  }finally{db.close();}
  assert.equal((await dispatchAdapter(a,'demo','hello','job')).content,'issuer A');
  await assert.rejects(dispatchAdapter(b,'demo','hello','job'),{outcome:'ambiguous'});
  assert.deepEqual(calls,['A','A','A','B']);
});
