import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

// Sessions and messages are keyed by a composite "<chatId>:<threadId>" string
// so each Telegram forum topic is an independent Claude session. Migrate the
// legacy chat-only schema in place, preserving existing sessions as ":0".
const hasLegacySessions = db
  .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'chat_id'")
  .get();
if (hasLegacySessions) {
  db.exec(`
    ALTER TABLE sessions RENAME TO sessions_legacy;
    CREATE TABLE sessions (
      session_key TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO sessions (session_key, session_id, updated_at)
      SELECT chat_id || ':0', session_id, updated_at FROM sessions_legacy;
    DROP TABLE sessions_legacy;
  `);
}

const hasLegacyMessages = db
  .prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'chat_id'")
  .get();
if (hasLegacyMessages) db.exec('DROP TABLE messages');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_key TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmts = {
  getSession: db.prepare<[string]>('SELECT session_id FROM sessions WHERE session_key = ?'),
  setSession: db.prepare<[string, string]>(`
    INSERT INTO sessions (session_key, session_id, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(session_key) DO UPDATE SET session_id = excluded.session_id, updated_at = datetime('now')
  `),
  clearSession: db.prepare<[string]>('DELETE FROM sessions WHERE session_key = ?'),
  logMessage: db.prepare<[string, string, string]>(
    'INSERT INTO messages (session_key, role, content) VALUES (?, ?, ?)',
  ),
  countMessages: db.prepare<[string]>('SELECT COUNT(*) AS n FROM messages WHERE session_key = ?'),
};

export function getSessionId(key: string): string | undefined {
  const row = stmts.getSession.get(key) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSessionId(key: string, sessionId: string): void {
  stmts.setSession.run(key, sessionId);
}

export function clearSession(key: string): void {
  stmts.clearSession.run(key);
}

export function logMessage(key: string, role: 'user' | 'assistant', content: string): void {
  stmts.logMessage.run(key, role, content);
}

export function messageCount(key: string): number {
  const row = stmts.countMessages.get(key) as { n: number };
  return row.n;
}
