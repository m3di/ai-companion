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

  CREATE TABLE IF NOT EXISTS session_prefs (
    session_key     TEXT PRIMARY KEY,
    permission_mode TEXT,
    cwd             TEXT
  );

  -- Multiple logical sessions live inside one chat, each a numbered "slot".
  -- The composite key "<chatId>:<slot>" indexes everything above; slot 0 is the
  -- legacy default session, preserved on first contact (see ensureChat).
  CREATE TABLE IF NOT EXISTS chat_sessions (
    chat_id     INTEGER NOT NULL,
    slot        INTEGER NOT NULL,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'closed'
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_active TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, slot)
  );

  CREATE TABLE IF NOT EXISTS chat_state (
    chat_id     INTEGER PRIMARY KEY,
    active_slot INTEGER NOT NULL DEFAULT 0
  );

  -- Bot-wide shared memory: facts/preferences true across every thread, curated
  -- by the concierge and injected into each work thread's prompt.
  CREATE TABLE IF NOT EXISTS shared_memory (
    chat_id    INTEGER PRIMARY KEY,
    content    TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Knowledge notes: a structured, linked memory base the concierge onboards
  -- from. Each note is a compact, self-contained unit; the concierge sees the
  -- (key, summary) index and reads full content on demand.
  CREATE TABLE IF NOT EXISTS notes (
    chat_id    INTEGER NOT NULL,
    key        TEXT NOT NULL,
    summary    TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, key)
  );

  -- Routing history: every router decision, and corrections (wrong_slot set when
  -- the user overrode the route). Fed back into the router as recent-sequence
  -- context + few-shot examples so it learns in-context.
  CREATE TABLE IF NOT EXISTS route_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    message     TEXT NOT NULL,
    slot        INTEGER NOT NULL,
    title       TEXT NOT NULL,
    wrong_slot  INTEGER,
    wrong_title TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Maps a bot message_id back to the session that produced it, so a user's
  -- reply to that message addresses its session deterministically (reply-routing).
  CREATE TABLE IF NOT EXISTS message_routes (
    chat_id     INTEGER NOT NULL,
    message_id  INTEGER NOT NULL,
    session_key TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, message_id)
  );

  -- The user's workspace: repos cloned on THIS machine, so agents know what
  -- exists and where to operate. Machine-global (not per-chat); built by a scan.
  CREATE TABLE IF NOT EXISTS repos (
    name        TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    remote      TEXT,
    branch      TEXT,
    conventions TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Captured-but-not-yet-run messages. While a chat is "capturing", incoming
  -- notes/forwards/replies queue here (acked with a reaction, no agent turn);
  -- /process drains and fans them out. target_key set = pre-addressed by a reply.
  CREATE TABLE IF NOT EXISTS pending_inbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    text       TEXT NOT NULL,
    target_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Persisted "dream" reflections: each offline reflection pass stores its full
  -- report here so it isn't post-and-forget. "grow" (Phase 1) consumes the
  -- unprocessed ones; processed_at is stamped once it has acted on a record.
  CREATE TABLE IF NOT EXISTS dreams (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      INTEGER NOT NULL,
    report       TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  );
`);

// Each thread keeps a durable "memo": a short summary of what it's about and
// where it's at, written by the session itself via the setMemo tool. It labels
// the thread, enriches catch-up, and (later) feeds the auto-router.
const hasMemo = db
  .prepare("SELECT 1 FROM pragma_table_info('chat_sessions') WHERE name = 'memo'")
  .get();
if (!hasMemo) db.exec('ALTER TABLE chat_sessions ADD COLUMN memo TEXT');

// auto_title=1 means the title tracks Claude Code's free session summary; an
// explicit rename (concierge setThreadMemo) flips it to 0 so we stop overriding.
const hasAutoTitle = db
  .prepare("SELECT 1 FROM pragma_table_info('chat_sessions') WHERE name = 'auto_title'")
  .get();
if (!hasAutoTitle) db.exec('ALTER TABLE chat_sessions ADD COLUMN auto_title INTEGER NOT NULL DEFAULT 1');

// Routing settings (Phase 1): auto_route toggles the classifier; pinned locks
// routing to the active thread regardless.
const hasAutoRoute = db
  .prepare("SELECT 1 FROM pragma_table_info('chat_state') WHERE name = 'auto_route'")
  .get();
if (!hasAutoRoute) {
  db.exec('ALTER TABLE chat_state ADD COLUMN auto_route INTEGER NOT NULL DEFAULT 1');
  db.exec('ALTER TABLE chat_state ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
}
// Capture mode: while on, incoming messages queue in pending_inbox for /process.
const hasCapturing = db
  .prepare("SELECT 1 FROM pragma_table_info('chat_state') WHERE name = 'capturing'")
  .get();
if (!hasCapturing) {
  db.exec('ALTER TABLE chat_state ADD COLUMN capturing INTEGER NOT NULL DEFAULT 0');
}

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
  getPrefs: db.prepare<[string]>(
    'SELECT permission_mode, cwd FROM session_prefs WHERE session_key = ?',
  ),
  setMode: db.prepare<[string, string]>(`
    INSERT INTO session_prefs (session_key, permission_mode) VALUES (?, ?)
    ON CONFLICT(session_key) DO UPDATE SET permission_mode = excluded.permission_mode
  `),
  setCwd: db.prepare<[string, string]>(`
    INSERT INTO session_prefs (session_key, cwd) VALUES (?, ?)
    ON CONFLICT(session_key) DO UPDATE SET cwd = excluded.cwd
  `),
  clearMode: db.prepare<[string]>(
    'UPDATE session_prefs SET permission_mode = NULL WHERE session_key = ?',
  ),
  recentMessages: db.prepare<[string, number]>(
    'SELECT role, content FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?',
  ),
  chatTimeline: db.prepare<[string, number]>(
    "SELECT session_key, role, content FROM messages WHERE session_key LIKE ? ORDER BY id DESC LIMIT ?",
  ),
  // chat / slot management
  listSessions: db.prepare<[number, string]>(
    'SELECT slot, title, status FROM chat_sessions WHERE chat_id = ? AND status = ? ORDER BY slot',
  ),
  getSessionRow: db.prepare<[number, number]>(
    'SELECT slot, title, status FROM chat_sessions WHERE chat_id = ? AND slot = ?',
  ),
  insertSession: db.prepare<[number, number, string]>(
    "INSERT INTO chat_sessions (chat_id, slot, title) VALUES (?, ?, ?)",
  ),
  maxSlot: db.prepare<[number]>(
    'SELECT MAX(slot) AS m FROM chat_sessions WHERE chat_id = ?',
  ),
  countSessions: db.prepare<[number, string]>(
    'SELECT COUNT(*) AS n FROM chat_sessions WHERE chat_id = ? AND status = ?',
  ),
  setSessionStatus: db.prepare<[string, number, number]>(
    'UPDATE chat_sessions SET status = ? WHERE chat_id = ? AND slot = ?',
  ),
  setSessionTitle: db.prepare<[string, number, number]>(
    'UPDATE chat_sessions SET title = ? WHERE chat_id = ? AND slot = ?',
  ),
  setMemo: db.prepare<[string, string, number, number]>(
    "UPDATE chat_sessions SET title = ?, memo = ?, auto_title = 0, last_active = datetime('now') WHERE chat_id = ? AND slot = ?",
  ),
  getMemo: db.prepare<[number, number]>(
    'SELECT title, memo FROM chat_sessions WHERE chat_id = ? AND slot = ?',
  ),
  // Refresh the auto-title from Claude Code's session summary — only while the
  // thread hasn't been explicitly renamed AND has no concierge memo. A memo
  // means the concierge curated it; its title beats the generic auto-summary
  // (and the router keys on titles, so generic ones degrade routing).
  refreshAutoTitle: db.prepare<[string, number, number]>(
    "UPDATE chat_sessions SET title = ? WHERE chat_id = ? AND slot = ? AND auto_title = 1 AND (memo IS NULL OR memo = '')",
  ),
  markTitleExplicit: db.prepare<[number, number]>(
    'UPDATE chat_sessions SET auto_title = 0 WHERE chat_id = ? AND slot = ?',
  ),
  touchSession: db.prepare<[number, number]>(
    "UPDATE chat_sessions SET last_active = datetime('now') WHERE chat_id = ? AND slot = ?",
  ),
  getActiveSlot: db.prepare<[number]>('SELECT active_slot FROM chat_state WHERE chat_id = ?'),
  setActiveSlot: db.prepare<[number, number]>(`
    INSERT INTO chat_state (chat_id, active_slot) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET active_slot = excluded.active_slot
  `),
  getChatSettings: db.prepare<[number]>(
    'SELECT auto_route, pinned FROM chat_state WHERE chat_id = ?',
  ),
  setAutoRoute: db.prepare<[number, number]>(
    'UPDATE chat_state SET auto_route = ? WHERE chat_id = ?',
  ),
  setPinned: db.prepare<[number, number]>('UPDATE chat_state SET pinned = ? WHERE chat_id = ?'),
  getShared: db.prepare<[number]>('SELECT content FROM shared_memory WHERE chat_id = ?'),
  setShared: db.prepare<[number, string]>(`
    INSERT INTO shared_memory (chat_id, content, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
  `),
  insertRoute: db.prepare<[number, string, number, string, number | null, string | null]>(
    'INSERT INTO route_log (chat_id, message, slot, title, wrong_slot, wrong_title) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  recentRoutes: db.prepare<[number, number]>(
    'SELECT message, title FROM route_log WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
  ),
  recentCorrections: db.prepare<[number, number]>(
    'SELECT message, title, wrong_title FROM route_log WHERE chat_id = ? AND wrong_slot IS NOT NULL ORDER BY id DESC LIMIT ?',
  ),
  // Notes moved to the file-backed knowledge base (src/knowledge.ts); the table
  // is kept only as a one-time migration source (latest write per key wins).
  allNotesForMigration: db.prepare(
    'SELECT key, summary, content FROM notes ORDER BY updated_at ASC',
  ),
  recordOutbound: db.prepare<[number, number, string]>(`
    INSERT INTO message_routes (chat_id, message_id, session_key) VALUES (?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET session_key = excluded.session_key
  `),
  sessionForMessage: db.prepare<[number, number]>(
    'SELECT session_key FROM message_routes WHERE chat_id = ? AND message_id = ?',
  ),
  upsertRepo: db.prepare<[string, string, string | null, string | null, string | null]>(`
    INSERT INTO repos (name, path, remote, branch, conventions, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET path = excluded.path, remote = excluded.remote,
      branch = excluded.branch, conventions = excluded.conventions, updated_at = datetime('now')
  `),
  listRepos: db.prepare('SELECT name, path, remote, branch, conventions FROM repos ORDER BY name'),
  addPending: db.prepare<[number, number, string, string | null]>(
    'INSERT INTO pending_inbox (chat_id, message_id, text, target_key) VALUES (?, ?, ?, ?)',
  ),
  listPending: db.prepare<[number]>(
    'SELECT message_id, text, target_key FROM pending_inbox WHERE chat_id = ? ORDER BY id',
  ),
  clearPending: db.prepare<[number]>('DELETE FROM pending_inbox WHERE chat_id = ?'),
  countPending: db.prepare<[number]>('SELECT COUNT(*) AS n FROM pending_inbox WHERE chat_id = ?'),
  isCapturing: db.prepare<[number]>('SELECT capturing FROM chat_state WHERE chat_id = ?'),
  setCapturing: db.prepare<[number, number]>('UPDATE chat_state SET capturing = ? WHERE chat_id = ?'),
  saveDream: db.prepare<[number, string]>('INSERT INTO dreams (chat_id, report) VALUES (?, ?)'),
  recentDreams: db.prepare<[number, number]>(
    'SELECT id, report, created_at, processed_at FROM dreams WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
  ),
  pendingDreams: db.prepare<[number]>(
    'SELECT id, report, created_at FROM dreams WHERE chat_id = ? AND processed_at IS NULL ORDER BY id',
  ),
  markDreamProcessed: db.prepare<[number]>(
    "UPDATE dreams SET processed_at = datetime('now') WHERE id = ?",
  ),
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

export interface SessionPrefs {
  permissionMode?: string;
  cwd?: string;
}

/** Persisted per-session preferences (permission mode, working dir). */
export function getPrefs(key: string): SessionPrefs {
  const row = stmts.getPrefs.get(key) as
    | { permission_mode: string | null; cwd: string | null }
    | undefined;
  return { permissionMode: row?.permission_mode ?? undefined, cwd: row?.cwd ?? undefined };
}

export function setMode(key: string, mode: string): void {
  stmts.setMode.run(key, mode);
}

export function setCwd(key: string, cwd: string): void {
  stmts.setCwd.run(key, cwd);
}

/** Clear only the permission mode (kept on /new so the mode is re-asked). */
export function clearMode(key: string): void {
  stmts.clearMode.run(key);
}

/** Most recent messages for a session, oldest-first (for catch-up on attach). */
export function recentMessages(
  key: string,
  limit: number,
): Array<{ role: string; content: string }> {
  const rows = stmts.recentMessages.all(key, limit) as Array<{ role: string; content: string }>;
  return rows.reverse();
}

/**
 * Every recent message across a chat's threads, oldest-first — the interleaved
 * timeline the user actually experienced (each row tagged with its session_key
 * so callers can show where it was routed). For the dreamer's input.
 */
export function chatTimeline(
  chatId: number,
  limit: number,
): Array<{ session_key: string; role: string; content: string }> {
  const rows = stmts.chatTimeline.all(`${chatId}:%`, limit) as Array<{
    session_key: string;
    role: string;
    content: string;
  }>;
  return rows.reverse();
}

export interface ChatSession {
  slot: number;
  title: string;
  status: 'active' | 'closed';
}

/** The composite key under which a session's state, prefs, and log are stored. */
export function sessionKey(chatId: number, slot: number): string {
  return `${chatId}:${slot}`;
}

export function listSessions(chatId: number, status: 'active' | 'closed'): ChatSession[] {
  return stmts.listSessions.all(chatId, status) as ChatSession[];
}

export function getSession(chatId: number, slot: number): ChatSession | undefined {
  return stmts.getSessionRow.get(chatId, slot) as ChatSession | undefined;
}

export function countSessions(chatId: number, status: 'active' | 'closed'): number {
  return (stmts.countSessions.get(chatId, status) as { n: number }).n;
}

/** Create a new session slot in a chat and return its number. */
export function createSession(chatId: number, title: string): number {
  const max = (stmts.maxSlot.get(chatId) as { m: number | null }).m;
  const slot = max === null ? 0 : max + 1;
  stmts.insertSession.run(chatId, slot, title);
  return slot;
}

export function setSessionStatus(chatId: number, slot: number, status: 'active' | 'closed'): void {
  stmts.setSessionStatus.run(status, chatId, slot);
}

export function setSessionTitle(chatId: number, slot: number, title: string): void {
  stmts.setSessionTitle.run(title, chatId, slot);
}

/** Update the title from Claude Code's free session summary (auto-titles only). */
export function refreshAutoTitle(chatId: number, slot: number, title: string): void {
  stmts.refreshAutoTitle.run(title, chatId, slot);
}

/** Stop auto-titling this thread (it was explicitly renamed). */
export function markTitleExplicit(chatId: number, slot: number): void {
  stmts.markTitleExplicit.run(chatId, slot);
}

export interface Memo {
  title: string;
  summary?: string;
}

/** Write a thread's memo (also updates its title, used on the keyboard). */
export function setMemo(chatId: number, slot: number, title: string, summary: string): void {
  stmts.setMemo.run(title, summary, chatId, slot);
}

export function getMemo(chatId: number, slot: number): Memo | undefined {
  const row = stmts.getMemo.get(chatId, slot) as
    | { title: string; memo: string | null }
    | undefined;
  return row ? { title: row.title, summary: row.memo ?? undefined } : undefined;
}

export function touchSession(chatId: number, slot: number): void {
  stmts.touchSession.run(chatId, slot);
}

export function getActiveSlot(chatId: number): number | undefined {
  const row = stmts.getActiveSlot.get(chatId) as { active_slot: number } | undefined;
  return row?.active_slot;
}

export function setActiveSlot(chatId: number, slot: number): void {
  stmts.setActiveSlot.run(chatId, slot);
}

export interface ChatSettings {
  autoRoute: boolean;
  pinned: boolean;
}

export function getChatSettings(chatId: number): ChatSettings {
  const row = stmts.getChatSettings.get(chatId) as
    | { auto_route: number; pinned: number }
    | undefined;
  return { autoRoute: (row?.auto_route ?? 1) === 1, pinned: (row?.pinned ?? 0) === 1 };
}

export function setAutoRoute(chatId: number, on: boolean): void {
  stmts.setAutoRoute.run(on ? 1 : 0, chatId);
}

export function setPinned(chatId: number, on: boolean): void {
  stmts.setPinned.run(on ? 1 : 0, chatId);
}

/** Bot-wide shared memory, injected into every work thread's prompt. */
export function getSharedMemory(chatId: number): string {
  const row = stmts.getShared.get(chatId) as { content: string } | undefined;
  return row?.content ?? '';
}

export function setSharedMemory(chatId: number, content: string): void {
  stmts.setShared.run(chatId, content);
}

/** Record a routing decision (wrong set when the user overrode an auto-route). */
export function logRoute(
  chatId: number,
  message: string,
  slot: number,
  title: string,
  wrong?: { slot: number; title: string },
): void {
  stmts.insertRoute.run(chatId, message.slice(0, 160), slot, title, wrong?.slot ?? null, wrong?.title ?? null);
}

/** The last `n` routing decisions, oldest-first — the recent sequence context. */
export function recentRoutes(chatId: number, n: number): Array<{ message: string; title: string }> {
  const rows = stmts.recentRoutes.all(chatId, n) as Array<{ message: string; title: string }>;
  return rows.reverse();
}

/** The last `n` corrections, oldest-first — few-shot examples for the router. */
export function recentCorrections(
  chatId: number,
  n: number,
): Array<{ message: string; title: string; wrong_title: string }> {
  const rows = stmts.recentCorrections.all(chatId, n) as Array<{
    message: string;
    title: string;
    wrong_title: string;
  }>;
  return rows.reverse();
}

export interface Note {
  key: string;
  summary: string;
  content: string;
}

/** All legacy notes from SQLite, oldest first — the one-time migration source. */
export function allNotesForMigration(): Note[] {
  return stmts.allNotesForMigration.all() as Note[];
}

/** Tag a bot message with the session it belongs to (for reply-routing). */
export function recordOutbound(chatId: number, messageId: number, sessionKey: string): void {
  stmts.recordOutbound.run(chatId, messageId, sessionKey);
}

/** The session a bot message belongs to, if known (used to route a user's reply). */
export function sessionForMessage(chatId: number, messageId: number): string | undefined {
  const row = stmts.sessionForMessage.get(chatId, messageId) as { session_key: string } | undefined;
  return row?.session_key;
}

export interface RepoInfo {
  name: string;
  path: string;
  remote: string | null;
  branch: string | null;
  conventions: string | null;
}

/** Register (or refresh) a workspace repo. */
export function upsertRepo(
  name: string,
  path: string,
  remote?: string,
  branch?: string,
  conventions?: string,
): void {
  stmts.upsertRepo.run(name, path, remote ?? null, branch ?? null, conventions ?? null);
}

/** All registered workspace repos, alphabetical. */
export function listRepos(): RepoInfo[] {
  return stmts.listRepos.all() as RepoInfo[];
}

export interface PendingItem {
  message_id: number;
  text: string;
  target_key: string | null;
}

/** Queue a captured message. target_key set = pre-addressed by a reply. */
export function addPending(chatId: number, messageId: number, text: string, targetKey?: string): void {
  stmts.addPending.run(chatId, messageId, text, targetKey ?? null);
}

/** Captured messages for a chat, oldest-first. */
export function listPending(chatId: number): PendingItem[] {
  return stmts.listPending.all(chatId) as PendingItem[];
}

export function clearPending(chatId: number): void {
  stmts.clearPending.run(chatId);
}

export function countPending(chatId: number): number {
  return (stmts.countPending.get(chatId) as { n: number }).n;
}

export function isCapturing(chatId: number): boolean {
  const row = stmts.isCapturing.get(chatId) as { capturing?: number } | undefined;
  return (row?.capturing ?? 0) === 1;
}

export function setCapturing(chatId: number, on: boolean): void {
  stmts.setCapturing.run(on ? 1 : 0, chatId);
}

export interface DreamRecord {
  id: number;
  report: string;
  created_at: string;
  processed_at?: string | null;
}

/** Persist a dream reflection's report. Returns its id. */
export function saveDream(chatId: number, report: string): number {
  return Number(stmts.saveDream.run(chatId, report).lastInsertRowid);
}

/** Recent dreams for a chat, newest-first. */
export function recentDreams(chatId: number, limit = 10): DreamRecord[] {
  return stmts.recentDreams.all(chatId, limit) as DreamRecord[];
}

/** Dreams not yet consumed by grow, oldest-first. */
export function pendingDreams(chatId: number): DreamRecord[] {
  return stmts.pendingDreams.all(chatId) as DreamRecord[];
}

/** Mark a dream as acted-on (called by grow once it has consumed it). */
export function markDreamProcessed(id: number): void {
  stmts.markDreamProcessed.run(id);
}
