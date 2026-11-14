CREATE TABLE qc_issuer_teams (
 issuer TEXT PRIMARY KEY, controller TEXT NOT NULL, name TEXT NOT NULL
);
CREATE TABLE qc_team_members (
 issuer TEXT NOT NULL, account TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('administrator','developer','viewer')),
 accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)),
 PRIMARY KEY(issuer,account)
);
CREATE TABLE qc_team_audit (
 id INTEGER PRIMARY KEY, issuer TEXT NOT NULL, actor TEXT NOT NULL, target TEXT NOT NULL,
 action TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX qc_team_audit_issuer ON qc_team_audit(issuer,id);
