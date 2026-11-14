CREATE TABLE qc_issuer_adapters (
 issuer TEXT PRIMARY KEY, controller TEXT NOT NULL, revision TEXT NOT NULL,
 model TEXT NOT NULL, daily_limit INTEGER NOT NULL CHECK (daily_limit BETWEEN 1 AND 4),
 updated INTEGER NOT NULL
);
CREATE TABLE qc_issuer_adapter_audit (
 id INTEGER PRIMARY KEY, issuer TEXT NOT NULL, actor TEXT NOT NULL,
 action TEXT NOT NULL, revision TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX qc_adapter_audit_issuer ON qc_issuer_adapter_audit(issuer,id);
ALTER TABLE jobs ADD COLUMN issuer TEXT;
ALTER TABLE jobs ADD COLUMN adapter_revision TEXT;
CREATE INDEX qc_job_issuer_created ON jobs(issuer,created);
CREATE INDEX qc_job_credential_created ON jobs(developer_token_id,created);
ALTER TABLE qc_developer_tokens ADD COLUMN last_used INTEGER;
CREATE TABLE qc_credential_audit (
 id INTEGER PRIMARY KEY, credential TEXT NOT NULL, account TEXT NOT NULL,
 issuer TEXT NOT NULL, action TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TRIGGER qc_credential_created AFTER INSERT ON qc_developer_tokens
BEGIN
 INSERT INTO qc_credential_audit(credential,account,issuer,action,created)
 VALUES (new.id,new.account,new.issuer,'created',unixepoch()*1000);
END;
CREATE TRIGGER qc_credential_revoked AFTER UPDATE OF revoked ON qc_developer_tokens
WHEN old.revoked IS NULL AND new.revoked IS NOT NULL
BEGIN
 INSERT INTO qc_credential_audit(credential,account,issuer,action,created)
 VALUES (new.id,new.account,new.issuer,'revoked',new.revoked);
END;
CREATE TRIGGER qc_credential_used AFTER INSERT ON jobs
WHEN new.developer_token_id IS NOT NULL
BEGIN
 UPDATE qc_developer_tokens SET last_used=new.created
 WHERE id=new.developer_token_id AND account=new.account AND issuer=new.issuer;
END;
