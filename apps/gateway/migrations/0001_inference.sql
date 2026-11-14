CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, public_key TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, account TEXT NOT NULL, dedupe TEXT NOT NULL, digest TEXT NOT NULL,
 token TEXT NOT NULL, prompt TEXT, state TEXT NOT NULL, intent TEXT, output TEXT, reserve_hash TEXT,
 settle_hash TEXT, created INTEGER NOT NULL, lease INTEGER NOT NULL,
 UNIQUE(account,dedupe)
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active ON jobs((1))
 WHERE state NOT IN ('completed','released','rejected');
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created);
CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges(expires);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS limits_expiry ON limits(expires);
