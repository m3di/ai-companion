import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    chat_id    INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmts = {
  getSession: db.prepare<[number]>('SELECT session_id FROM sessions WHERE chat_id = ?'),
  setSession: db.prepare<[number, string]>(`
    INSERT INTO sessions (chat_id, session_id, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = datetime('now')
  `),
  clearSession: db.prepare<[number]>('DELETE FROM sessions WHERE chat_id = ?'),
  logMessage: db.prepare<[number, string, string]>(
    'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
  ),
  countMessages: db.prepare<[number]>('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?'),
};

export function getSessionId(chatId: number): string | undefined {
  const row = stmts.getSession.get(chatId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSessionId(chatId: number, sessionId: string): void {
  stmts.setSession.run(chatId, sessionId);
}

export function clearSession(chatId: number): void {
  stmts.clearSession.run(chatId);
}

export function logMessage(chatId: number, role: 'user' | 'assistant', content: string): void {
  stmts.logMessage.run(chatId, role, content);
}

export function messageCount(chatId: number): number {
  const row = stmts.countMessages.get(chatId) as { n: number };
  return row.n;
}
