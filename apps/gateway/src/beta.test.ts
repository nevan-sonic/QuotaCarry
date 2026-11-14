import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

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
