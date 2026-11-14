CREATE TABLE beta_claims (
 account TEXT PRIMARY KEY, state TEXT NOT NULL, lease INTEGER NOT NULL DEFAULT 0,
 intent TEXT, tx_hash TEXT, token TEXT UNIQUE
);
CREATE UNIQUE INDEX beta_one_claim_running ON beta_claims((1)) WHERE state='minting';
CREATE INDEX beta_claim_queue ON beta_claims(state,lease);
CREATE INDEX beta_job_token ON jobs(token);
CREATE INDEX beta_job_account_time ON jobs(account,created);
