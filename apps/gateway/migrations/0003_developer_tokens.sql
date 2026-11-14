CREATE TABLE qc_developer_tokens (
  digest TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL,
  nft TEXT NOT NULL,
  issuer TEXT NOT NULL,
  policy TEXT NOT NULL,
  epoch TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  expires INTEGER NOT NULL,
  revoked INTEGER
);
CREATE INDEX qc_developer_tokens_owner ON qc_developer_tokens(account, expires);
ALTER TABLE jobs ADD COLUMN developer_token_id TEXT;
