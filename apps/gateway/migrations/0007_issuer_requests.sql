CREATE TABLE qc_issuer_requests (
 account TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL
 CHECK(state IN ('pending','approved','rejected','finalized')), issuer TEXT UNIQUE,
 updated INTEGER NOT NULL
);
