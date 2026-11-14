import { DatabaseSync } from 'node:sqlite';

export type JobState = 'queued' | 'reserving' | 'reserved' | 'calling_provider' | 'consume_pending' |
  'release_pending' | 'completed' | 'released' | 'manual_review';

export class JobStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, token TEXT NOT NULL,
        dedupe TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL,
        UNIQUE(account,dedupe)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_per_token ON jobs(token)
        WHERE state NOT IN ('completed','released');
      CREATE TABLE IF NOT EXISTS challenges (
        nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL
      );
    `);
  }

  enqueue(id: string, account: string, token: string, dedupe: string) {
    this.db.prepare("INSERT INTO jobs VALUES (?,?,?,?,'queued',?) ON CONFLICT(account,dedupe) DO NOTHING")
      .run(id,account,token,dedupe,Date.now());
    return this.db.prepare('SELECT id, token, state FROM jobs WHERE account=? AND dedupe=?').get(account,dedupe);
  }

  transition(id: string, previous: JobState, next: JobState) {
    return this.db.prepare('UPDATE jobs SET state=?,updated=? WHERE id=? AND state=?')
      .run(next,Date.now(),id,previous).changes === 1;
  }

  consumeNonce(nonce: string, expires: number, now = Date.now()) {
    if (expires <= now) return false;
    this.db.prepare('DELETE FROM challenges WHERE expires<=?').run(now);
    return this.db.prepare('INSERT OR IGNORE INTO challenges VALUES (?,?)').run(nonce,expires).changes === 1;
  }

  close() { this.db.close(); }
}
