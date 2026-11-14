CREATE TABLE adapter_nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE INDEX adapter_nonces_expiry ON adapter_nonces(expires);
CREATE TABLE adapter_budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL);
