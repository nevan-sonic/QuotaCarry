ALTER TABLE qc_developer_tokens ADD COLUMN rotated_from TEXT;
CREATE UNIQUE INDEX qc_credential_rotation_once ON qc_developer_tokens(rotated_from)
 WHERE rotated_from IS NOT NULL;
CREATE TRIGGER qc_credential_rotated AFTER INSERT ON qc_developer_tokens
WHEN new.rotated_from IS NOT NULL
BEGIN
 UPDATE qc_developer_tokens SET revoked=unixepoch()*1000
 WHERE id=new.rotated_from AND account=new.account AND revoked IS NULL;
 INSERT INTO qc_credential_audit(credential,account,issuer,action,created)
 VALUES(new.id,new.account,new.issuer,'rotated',unixepoch()*1000);
END;
