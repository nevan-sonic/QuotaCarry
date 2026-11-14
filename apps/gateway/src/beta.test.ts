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
