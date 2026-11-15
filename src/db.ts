import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { setPulseSink } from './pulse.js';

/**
 * A TEST MAY NOT OPEN THE LIVE DATABASE. (I11, 2026-08-05.)
 *
 * `test/prepare.ts` already refuses to DELETE the live DB, which is the lesson
 * 2026-08-02 bought. It does not stop a test from WRITING to it, and the suite's
 * fixtures write freely — journal rows, fact clocks, observations. `npm test`
 * sets `DB_PATH` so they land in a scratch copy; running one test file directly
 * (`npx tsx --test test/entityWrite.test.ts`) does not, and every fixture write
 * goes straight into Mehdi's memory. That happened while building this table:
 * 80 journal rows for `demo/alpha` and friends, plus five `test:` call rows,
 * had to be deleted out of the live journal by hand.
 *
 * "Remember to set DB_PATH" is an instruction, and I9 says an instruction that
 * must hold cannot be one. `NODE_TEST_CONTEXT` is set by node's test runner and
 * by nothing else — the bot never runs under it — so the check is mechanical and
 * cannot be forgotten by whoever writes the next test file.
 */
if (process.env.NODE_TEST_CONTEXT && resolve(config.dbPath) === resolve(process.env.LIVE_DB_PATH || 'data/companion.db')) {
  throw new Error(
    `[db] REFUSING TO OPEN THE LIVE DATABASE FROM A TEST (${config.dbPath}).\n` +
      `     Tests write fixtures. Run the suite with "npm test", or set DB_PATH to a scratch path\n` +
      `     (e.g. DB_PATH=data/tmp/test.db npx tsx --test test/yourFile.test.ts).`,
  );
}

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
// Several processes open this file at once (the bot, a CLI, the gardener, six
// test processes): without a busy timeout a concurrent schema write fails
// fast with SQLITE_BUSY instead of waiting — the FTS shadow-table race that
// reddened the suite (proposal #36, 2026-10-25).
db.pragma('busy_timeout = 5000');

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
// The full-text index below mirrors this table, so it must go with it —
// otherwise the rebuild is skipped (the index "already exists") and search
// answers from rows that no longer exist.
if (hasLegacyMessages) db.exec('DROP TABLE messages; DROP TABLE IF EXISTS messages_fts;');

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
    status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived' | 'closed' (legacy)
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

  -- "grow" change-log: each grow pass applies edits directly to the knowledge
  -- files (no git) and records here what it did — a prose summary plus a JSON
  -- list of per-file changes (path, action, before, after) — so the history is
  -- visible (/grows) and reversible without a parallel git repo in the data dir.
  CREATE TABLE IF NOT EXISTS grows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    summary    TEXT NOT NULL,
    changes    TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Typed findings extracted from each dream (reflect) pass — the machine-
  -- readable spine of the nightly pipeline. 'memory-fix'/'knowledge' are applied
  -- by the act stage (grow); 'reminder' is delivered in the morning brief;
  -- 'proposal' (src/prompt changes) is ALWAYS operator-gated, never auto-applied;
  -- 'idea' accumulates for the ideas ledger.
  CREATE TABLE IF NOT EXISTS findings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    dream_id    INTEGER,
    kind        TEXT NOT NULL,   -- 'memory-fix' | 'knowledge' | 'reminder' | 'proposal' | 'idea'
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'applied' | 'delivered' | 'dismissed'
    resolution  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );


  -- Self-scheduled wakeups: cron-like prompts the bot (or the operator) sets for
  -- itself. When one fires, its prompt runs as a concierge turn — the bot decides
  -- what to do (brief the user, check something, dispatch, reschedule). The
  -- morning brief is just a default 'daily' wakeup the bot may reconfigure.
  CREATE TABLE IF NOT EXISTS wakeups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       INTEGER NOT NULL,
    label         TEXT NOT NULL,
    prompt        TEXT NOT NULL,
    fire_at       TEXT NOT NULL,  -- UTC datetime text
    recur         TEXT,           -- 'daily' | 'weekly' | NULL (one-off)
    status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'done' | 'cancelled'
    created_by    TEXT NOT NULL DEFAULT 'bot',
    last_fired_at TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Awareness events (the blackboard): one-liners of "what just happened"
  -- across the system — worker recaps, concierge dispatches, nightly passes,
  -- fired wakeups. The per-turn bulletin is built from today's tail: cheap,
  -- fixed-cost, no LLM. Localized attention, shared awareness.
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    source     TEXT NOT NULL,   -- thread title / 'concierge' / 'nightly' / 'wakeup'
    body       TEXT NOT NULL,   -- one line
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat_id, id);

  -- Waiting-on ledger: blocked/pending items with a stated way and time to
  -- re-check. Intelligence at the edges, plain data in the middle: the entry
  -- says how to check; the pulse agent (a concierge turn on due entries)
  -- decides to check, notify the user, or defer.
  CREATE TABLE IF NOT EXISTS waiting (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       INTEGER NOT NULL,
    what          TEXT NOT NULL,
    blocked_on    TEXT NOT NULL,       -- person · event · time
    how_to_check  TEXT NOT NULL,       -- free text: a command, a query, "just ask"
    next_check_at TEXT NOT NULL,       -- UTC datetime text
    thread_slot   INTEGER,             -- originating thread, if any
    status        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved' | 'dropped'
    resolution    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at   TEXT
  );

  -- COMMITMENTS (round 5): the ONE prospective table — everything the system
  -- has promised its future self, replacing wakeups + waiting. Two firing
  -- modes, keyed on how_to_check: NULL = when due, the body runs as a fresh
  -- concierge turn (reminders, routines, the nightly pipeline by label);
  -- set = when due, batched into a [PULSE] turn that judges each entry
  -- (check / notify / defer) — advance-before-run defers it first so a
  -- crashed pulse can't loop. Old wakeups/waiting tables stay dormant.
  CREATE TABLE IF NOT EXISTS commitments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       INTEGER NOT NULL,
    label         TEXT NOT NULL,
    body          TEXT NOT NULL,        -- the self-contained prompt / what's watched
    due_at        TEXT NOT NULL,        -- UTC datetime text
    recur         TEXT,                 -- 'daily' | 'weekly' | NULL (one-off)
    how_to_check  TEXT,                 -- NULL = fire as a turn; set = pulse-checked
    thread_slot   INTEGER,              -- originating thread, if any
    status        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'done' | 'dropped'
    created_by    TEXT NOT NULL DEFAULT 'bot',
    last_fired_at TEXT,
    resolution    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at   TEXT
  );

  -- FOCUS CHANGES (round 7): the escalation queue. A focus item moving is the
  -- ONLY thing that should wake the concierge about it — so every observed
  -- change lands here first (from the deterministic checker, or from a worker
  -- that noticed one in passing), and the pulse that follows carries the diff
  -- instead of re-fetching it. consumed_at marks a row already handed over.
  CREATE TABLE IF NOT EXISTS focus_changes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       INTEGER NOT NULL,
    commitment_id INTEGER NOT NULL,
    source        TEXT NOT NULL,   -- 'checker' | 'worker'
    observation   TEXT,            -- a worker's own words, when it came from one
    before        TEXT,            -- previous scrubbed check output (excerpt)
    after         TEXT,            -- current scrubbed check output (excerpt)
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    consumed_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_focus_changes_open
    ON focus_changes(commitment_id, consumed_at);

  -- ENTITY STATE (round 8): the ONE writer of an entity's state is the prober.
  -- The record file carries state/state_at for a human to read, but this
  -- table is the authority: the linter compares the two and REJECTS a file whose
  -- state was hand-edited. Without that, a hand-written "merged" and a probed
  -- "OPEN" diverge silently and the graph starts lying — the exact failure the
  -- round exists to end.
  CREATE TABLE IF NOT EXISTS entity_state (
    id         TEXT PRIMARY KEY,
    state      TEXT,
    state_at   TEXT,
    status     TEXT NOT NULL DEFAULT 'open',
    -- sha of the last scrubbed probe output, so an unchanged probe is free
    last_seen  TEXT,
    probed_at  TEXT
  );

  -- The DERIVED graph index, rebuilt wholesale on every successful parse. Files
  -- stay the source of truth; this exists so graph questions are SQL instead of
  -- a tree walk, and so the concierge can look an entity up by alias.
  CREATE TABLE IF NOT EXISTS entities (
    id       TEXT PRIMARY KEY,
    domain   TEXT NOT NULL,
    kind     TEXT NOT NULL,
    aka      TEXT NOT NULL DEFAULT '[]',
    facts    TEXT NOT NULL DEFAULT '[]',
    chain    TEXT NOT NULL DEFAULT '[]',
    probe    TEXT,
    actor    TEXT,
    goal     INTEGER NOT NULL DEFAULT 0,
    note     TEXT
  );
  CREATE TABLE IF NOT EXISTS entity_edges (
    src TEXT NOT NULL,
    rel TEXT NOT NULL,
    dst TEXT NOT NULL,
    PRIMARY KEY (src, rel, dst)
  );
  -- Entity state CHANGES — the escalation queue, the entity-shaped twin of
  -- focus_changes. A probe moving is the only reason the concierge is woken
  -- about knowledge; status_flip marks the ones that changed open/closed,
  -- which is what actually reshapes the graph and therefore the focus set.
  CREATE TABLE IF NOT EXISTS entity_changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   TEXT NOT NULL,
    before      TEXT,
    after       TEXT,
    status_flip INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    consumed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_entity_changes_open
    ON entity_changes(entity_id, consumed_at);
  CREATE INDEX IF NOT EXISTS idx_entity_edges_dst ON entity_edges(dst, rel);
  CREATE INDEX IF NOT EXISTS idx_entities_domain ON entities(domain);

  -- THE WRITE JOURNAL (round 10). Every change record() makes to the graph,
  -- with the evidence that justified it.
  --
  -- Round 10 gives the night a direct write path: it corrects a fact and the
  -- graph changes, with no queue for a human to drain. That was a deliberate
  -- call — a queue nobody drains is the same failure as a graph nobody writes,
  -- one level up. But direct writes with no trail is the version that is
  -- actually dangerous: a confidently wrong night silently overwriting a true
  -- fact, indistinguishable afterwards from a correct one.
  --
  -- So the safety is not a gate, it is a DIFF. Every write records what changed,
  -- from what, and why, which makes a bad night reviewable after the fact and
  -- revertible field by field. before is the whole prior value, so a revert
  -- needs nothing but this row.
  CREATE TABLE IF NOT EXISTS entity_writes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id  TEXT NOT NULL,
    -- correct-fact | add-fact | drop-fact | observe | note | goal | dormant | edge | mint
    op         TEXT NOT NULL,
    before     TEXT,
    after      TEXT,
    -- WHY, in the writer's words: the evidence that justified the change. An
    -- empty reason is refused at the call site — a write nobody can explain is
    -- exactly the write this table exists to catch.
    reason     TEXT NOT NULL,
    -- who wrote: 'nightly', a chat/slot session key, or 'cli'
    actor      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reverted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_entity_writes_entity ON entity_writes(entity_id, created_at);

  -- FACT PROVENANCE (round 10). When a fact first appeared, and when a night
  -- last confirmed it against the world.
  --
  -- facts[] is in the never-perishes half of an entity by design, and that is
  -- still right: a fact is not a state and must not be probed. But "does not
  -- perish on its own" was silently read as "cannot be wrong", and the proving
  -- case is reference/repos-and-platforms, which named five Core-API network
  -- clients of which zero were still current. Nothing in the system could have
  -- corrected it, and nothing could even have SAID it was old — a fact was a
  -- bare string with no age, so "stale" was not expressible.
  --
  -- It lives in SQL rather than in the grammar for the same reason state does:
  -- the files are authored and git-diffable, and stamping every fact line with
  -- two dates would make every diff unreadable while adding nothing an author
  -- writes by hand. The DB is the authority for maintained fields; the files are
  -- the authority for what a human wrote.
  --
  -- Keyed by a hash of the fact TEXT, so correcting a fact starts a new clock —
  -- which is correct: a corrected fact is a new claim, and its predecessor's
  -- life is preserved in entity_writes.
  CREATE TABLE IF NOT EXISTS fact_seen (
    entity_id  TEXT NOT NULL,
    fact_sha   TEXT NOT NULL,
    since      TEXT NOT NULL DEFAULT (datetime('now')),
    -- last time a night read this fact against real material and let it stand.
    -- NULL means it has never been confirmed by anything — written once and
    -- never looked at since, which is the state most of the graph is in.
    confirmed_at TEXT,
    PRIMARY KEY (entity_id, fact_sha)
  );

  -- THE FRICTION LEDGER (round 9). Where the memory layer failed the agent that
  -- was using it — recorded by the RUNTIME, with no agent cooperation required.
  --
  -- This is the round's whole premise made mechanical. Round 8 produced four
  -- instances of the same lesson: every rule stated as an INSTRUCTION to a model
  -- decayed or was simply wrong, and every rule made MECHANICAL held. Asking an
  -- agent "was anything missing?" is an instruction, and the answer would be
  -- polite noise. An agent that needs something the API cannot give does not
  -- file a complaint — it greps the raw file and moves on. So the grep IS the
  -- complaint, and this table is where it lands.
  --
  -- The governor is the partial unique index below: repeats of the same friction
  -- bump the hit count instead of inserting a row. One broken function is one row
  -- with hits=500 rather than 500 rows drowning everything else — the same
  -- lesson round 7 learned from a flapping probe, applied before it bites.
  CREATE TABLE IF NOT EXISTS friction (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- error | empty | slow | unknown_fn | bypass | missing_concept | mid-thread-reset
    kind        TEXT NOT NULL,
    -- what was being used: a module/function once those exist; for a bypass,
    -- the knowledge file that was read raw.
    module      TEXT NOT NULL DEFAULT '',
    fn          TEXT NOT NULL DEFAULT '',
    -- what makes two occurrences THE SAME friction (the dedup key).
    signature   TEXT NOT NULL,
    -- the most recent occurrence's specifics, for whoever fixes it.
    detail      TEXT NOT NULL DEFAULT '',
    session_key TEXT,
    hits        INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_at     TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolution  TEXT
  );
  -- Partial: only OPEN friction is deduplicated. Once the night resolves a row,
  -- the same friction recurring is genuine news — the fix did not hold.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_friction_open
    ON friction(kind, module, fn, signature) WHERE resolved_at IS NULL;

  -- WHAT THE CHECKS COULD NOT ANSWER (Charter M2). The third outcome, kept.
  --
  -- I3 says a check has three outcomes and only a value may become state. The
  -- prober and the focus checker both honour that now — they touch the clock
  -- and leave the last real state standing. But honouring it SILENTLY means a
  -- checker that has been broken for a week looks exactly like a checker whose
  -- answer never changes, which is the same confusion one layer up: a graph
  -- that stopped moving read as a graph with nothing to report.
  --
  -- Only NON-values are stored, which is what keeps this cheap: 56 probes every
  -- quarter hour would be five thousand rows a day, and the interesting ones are
  -- a handful. Deduped per ref per day so a checker failing every fifteen
  -- minutes is one loud row, not ninety-six quiet ones.
  -- THE GRAPH'S ROT, ONE ROW PER READING. The ratchet's memory.
  --
  -- A budget needs a trend before it can have a threshold: pick a number today
  -- and tomorrow the night defends the number instead of the graph. So this
  -- records and nothing more, until the series says what a fair ceiling is.
  -- Per-code counts are kept as JSON so a later question ("did W208 fall while
  -- W204 rose?") does not need a migration.
  CREATE TABLE IF NOT EXISTS graph_rot (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rot        INTEGER NOT NULL,
    birth      INTEGER NOT NULL,
    entities   INTEGER NOT NULL,
    by_code    TEXT NOT NULL DEFAULT '{}',
    -- WHICH RULES PRODUCED THIS NUMBER. Without it a trend line silently spans
    -- a ruleset change and means nothing: on 2026-08-07 demoting W208 moved rot
    -- from 145 to 86 with the graph untouched, and a reader comparing those two
    -- readings would conclude the night had done a night's gardening.
    ruleset    TEXT NOT NULL DEFAULT '',
    at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- THE WORK STATE. One row at most: present means debug, absent means live.
  --
  -- In the DATABASE and not in a variable, because the runner restarts this
  -- process on every source edit (tsx watch) — exactly what one does while
  -- debugging. A mode held in memory would silently revert to live mid-session
  -- and let the day back in through a door the operator thought was shut.
  CREATE TABLE IF NOT EXISTS debug_session (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    reason            TEXT NOT NULL DEFAULT '',
    since             TEXT NOT NULL,
    snapshot          TEXT NOT NULL,
    baseline_write_id INTEGER NOT NULL
  );

  -- THE DREAM PHASE. One row at most: present means a rewrite pass is running.
  --
  -- This was an in-process variable in operator.ts, guarding against the
  -- 2026-08-05 double-nightly that minted core-api/ci-robustness-38 twice. It
  -- guarded nothing across a process boundary: the scheduled nightly runs in
  -- the bot, an induced one runs from a CLI, and neither could see the other's
  -- lock. Third time the interesting boundary turned out to be between
  -- processes, after the pulse bus and the open run.
  --
  -- The pid is here so a pass killed mid-flight can be recognised as stale
  -- rather than wedging the night shut forever.
  CREATE TABLE IF NOT EXISTS dream_phase (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    scope TEXT NOT NULL,
    since TEXT NOT NULL,
    pid   INTEGER NOT NULL
  );

  -- A RETRIEVAL EPISODE — one question, and the path memory took to answer it.
  --
  -- The unit is the QUESTION, not the call, for the same reason the run and not
  -- the write became the unit of operator review: a judgement about a path
  -- cannot be made from a bag of steps. module_use already counts calls, but it
  -- aggregates by shape and throws away ordering, grouping and outcome — so it
  -- can say "find was called 7 times" and never "answering what-is-Mehdi-on
  -- took find → neighbours → find → gave up".
  --
  -- "path" is the ordered function names joined, and it is deliberately the
  -- whole design: grouping by it gives the recurring paths M9 collapses,
  -- without a second table or a join. "find→neighbours" appearing 40 times is
  -- one call waiting to be born.
  --
  -- "outcome" is the ranking key, and give-up beats cost. A question answered
  -- in six steps is worse than one answered in two; a question that ended in a
  -- BYPASS — the agent stopped asking and read root.md — means the structure is
  -- missing something, and that is a different and more valuable complaint.
  CREATE TABLE IF NOT EXISTS retrieval_episodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    -- day | night | operator | worker — who was asking
    actor       TEXT NOT NULL,
    -- the prompt head: what question this path was trying to answer
    trigger     TEXT NOT NULL,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT,
    path        TEXT NOT NULL DEFAULT '',
    steps       INTEGER NOT NULL DEFAULT 0,
    bypasses    INTEGER NOT NULL DEFAULT 0,
    ms          INTEGER NOT NULL DEFAULT 0,
    -- answered | bypassed | no-reach (never touched the graph at all)
    outcome     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_episode_path ON retrieval_episodes(path);
  -- WHICH NODES the path actually reached, denormalised at close.
  --
  -- Absent from the first cut, and its absence is the argument for the lens
  -- that exposed it: this table recorded "find→neighbours→openLoops" and not
  -- one entity id, so it could not be drawn, and nothing in a green suite could
  -- notice. I4 says every event names the nodes it touched; the episode did
  -- not, hours after the invariant was cited in its own commit message.
  --
  -- Denormalised rather than joined against module_calls at read time, because
  -- the join key is (session_key, time window) and that is exactly the kind of
  -- reconstruction the episode exists to make unnecessary.

  -- The episode a session is currently inside, so a call knows what it belongs
  -- to. Exactly the shape of open_run, and for the same reason: the writer and
  -- the thing being written to are in different call stacks.
  CREATE TABLE IF NOT EXISTS open_episode (
    session_key TEXT PRIMARY KEY,
    episode_id  INTEGER NOT NULL
  );

  -- THE NIGHTS THAT HAVE BEEN ACCOUNTED FOR.
  --
  -- One row per night boundary that the machine has settled, and the ONLY
  -- record of it. "Did we dream last night" was previously answered from the
  -- dreams table, which cannot answer it: a pass that ran and found a quiet
  -- window writes no row, so a legitimately empty night is indistinguishable
  -- from a night that never happened. Asking a debt-driven scheduler to read
  -- that would have it re-dreaming every 60 seconds, all day, forever.
  --
  -- "how" is the distinction that matters when reading back a week:
  --   dreamt    — a pass ran and folded the window
  --   quiet     — a pass ran, the window was empty, nothing to fold
  --   cancelled — the operator took the night back and its writes were rolled
  --               back, because something urgent could not wait for it
  CREATE TABLE IF NOT EXISTS night_settled (
    boundary   TEXT PRIMARY KEY,
    settled_at TEXT NOT NULL,
    how        TEXT NOT NULL,
    note       TEXT
  );

  -- A PLAN THE OPERATOR HAS NOT APPROVED YET.
  --
  -- The shape of nearly every operator conversation is: ask what something
  -- costs, read the answer, say "yes please do that". That last message carries
  -- no information — the plan was in the agent's context one message earlier —
  -- and typing it is the only thing standing between a considered plan and a
  -- performed one. So the agent ENDS a planning turn by declaring what it would
  -- do, and approval becomes a click.
  --
  -- A row and not a chat message, because approval is the moment worth being
  -- able to audit later: WHAT was approved, WHEN, and which turn proposed it.
  -- "I said yes to something" recoverable only by re-reading a transcript is
  -- not a record of consent.
  CREATE TABLE IF NOT EXISTS proposals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     INTEGER NOT NULL,
    summary    TEXT NOT NULL,
    -- The concrete steps, as the agent stated them: one JSON array of strings.
    -- Deliberately PROSE, not a machine-executable op list: the agent applies
    -- them through record() like any other write, and a list this table could
    -- execute itself would be a second write path around applyWrite.
    steps      TEXT NOT NULL DEFAULT '[]',
    status     TEXT NOT NULL DEFAULT 'open',   -- open | applied | discarded
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT,
    -- The run that CARRIED OUT the approval, once one has.
    applied_run_id INTEGER
  );

  -- WHAT A DEBUG SESSION DID, after it closed.
  --
  -- The open session lives in debug_session and is deleted on exit. That was
  -- enough while exiting was a two-line report in a terminal, and is not enough
  -- now: keeping writes RESETS the concierge context, and the night needs to
  -- know that happened. A dream that finds the day's context inexplicably empty
  -- and no record of why will reconstruct a reason, and the reason will be
  -- wrong.
  CREATE TABLE IF NOT EXISTS debug_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    reason        TEXT NOT NULL DEFAULT '',
    since         TEXT NOT NULL,
    until         TEXT NOT NULL,
    writes        INTEGER NOT NULL DEFAULT 0,
    rolled_back   INTEGER NOT NULL DEFAULT 0,
    context_reset INTEGER NOT NULL DEFAULT 0
  );

  -- PULSES THAT CROSS A PROCESS BOUNDARY.
  --
  -- The pulse bus is an in-memory EventEmitter, which is right for the bot: the
  -- prober, the dispatcher and the Atlas all live in one process and a write
  -- lights a node with no hop at all. It is also why a write made from a CLI
  -- was INVISIBLE — the gardener changed the graph and the Atlas showed nothing,
  -- which defeats the point of watching a gardening pass land.
  --
  -- So every pulse is also written here, and the bot relays back anything from
  -- another pid. Small and self-trimming: this is a window, not a log, and the
  -- durable record of what changed is entity_writes.
  -- A RUN: one attempt by an agent to change the graph, with a stated intent.
  --
  -- entity_writes already says WHAT changed and why, one row per change. What
  -- it cannot say is which ATTEMPT a change belonged to, and that is the thing
  -- worth seeing: nine writes are nine rows, but "this prompt, in linter mode,
  -- produced those nine and touched these six nodes" is a judgement about the
  -- PROMPT. Without it you can review a graph and never improve the thing that
  -- edits it.
  CREATE TABLE IF NOT EXISTS graph_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 'gardener' | 'nightly' | 'day' | 'manual'
    kind       TEXT NOT NULL,
    -- what started it: 'prompt' (a human asked), 'linter' (a finding did),
    -- 'schedule' (the clock did)
    trigger    TEXT NOT NULL,
    -- the INSTRUCTION, verbatim. This is the row's whole reason to exist: it is
    -- what you compare against the writes to decide whether to reword it.
    prompt     TEXT NOT NULL DEFAULT '',
    -- lint codes this run was aimed at, JSON array, when a linter drove it
    codes      TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at   TEXT,
    -- the agent's own account of what it did and refused to do
    outcome    TEXT
  );

  -- WHICH RUN IS OPEN, across processes. At most one row.
  --
  -- The run started life as a module-level variable, which attributed nothing:
  -- a run is opened by one command and the writes are made by another (a
  -- module call, an agent, a second terminal), so every write landed with a
  -- null run_id while the ledger claimed an attempt was in progress. Same shape
  -- as the pulse bus and the work state — in this system the interesting
  -- boundary is almost always BETWEEN processes.
  CREATE TABLE IF NOT EXISTS open_run (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    run_id INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pulses (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    pid  INTEGER NOT NULL,
    at   TEXT NOT NULL,
    body TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS check_misses (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 'probe' (an entity's state) | 'focus' (a focus item's check)
    kind     TEXT NOT NULL,
    ref      TEXT NOT NULL,
    -- 'unanswered' (ran, said nothing usable) | 'failed' (could not run)
    outcome  TEXT NOT NULL,
    detail   TEXT NOT NULL DEFAULT '',
    day      TEXT NOT NULL,
    hits     INTEGER NOT NULL DEFAULT 1,
    first_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_check_misses_day
    ON check_misses(kind, ref, outcome, day);

  -- THE OBSERVATION INBOX (round 11 / Charter M1). The DAY's write path.
  --
  -- Round 10 gave the night a pen (record()), and the day still had none: a
  -- worker that watched a PR merge, or a concierge told a hold was lifted, could
  -- write prose and nothing else. So the night's job was to RE-DERIVE the day
  -- from 300 messages and guess what changed — the most expensive and least
  -- accurate moment to decide what a fact is.
  --
  -- An observation is captured where the context actually exists: at the moment
  -- of seeing, by the agent seeing it, naming the entities it is about. The
  -- night then COMPACTS a typed queue instead of reconstructing a day. This
  -- table is the write-ahead log of the graph, and folded_at is its LSN.
  --
  -- unresolved is the half that is not bookkeeping: a ref naming no node is
  -- not an error, it is the day telling us the graph is missing something it
  -- needed. That is how domains get discovered instead of invented (I5).
  CREATE TABLE IF NOT EXISTS observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    -- JSON arrays: refs that RESOLVED to an entity id, and refs that named
    -- nothing. Both are kept — the second is the discovery signal.
    refs        TEXT NOT NULL DEFAULT '[]',
    unresolved  TEXT NOT NULL DEFAULT '[]',
    -- The route back: msg#, episode#, a PR url, a file. Same currency as an
    -- entity's chain, because that is where it is headed.
    evidence    TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    -- When the night drained it, and what it did. An unfolded row is the queue.
    folded_at   TEXT,
    outcome     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_observations_pending
    ON observations(folded_at, id);

  -- THE USE LEDGER (round 9). Friction records where the API FAILED; this
  -- records where it was USED, which turns out to be the louder signal.
  --
  -- Live testing produced the case: asked which item had been open longest, an
  -- agent hand-rolled date extraction out of entity records with two eval
  -- expressions and answered confidently — and wrongly, because the graph has no
  -- creation date and the chain's first message id is when something was first
  -- DISCUSSED, not when it opened. Nothing failed. No error, no empty, no
  -- bypass: from the runtime's side that turn was a clean success.
  --
  -- So instrumenting failure is not enough. An evalInModule expression is a
  -- SPECIFICATION WRITTEN BY THE CALLER: a composition that keeps recurring is a
  -- missing function, by exactly the same logic that makes a raw grep one. And
  -- the same rows answer §8's other question — a function nothing has called in
  -- weeks is a retirement candidate, which is the only force pushing back on a
  -- catalog that otherwise only grows.
  CREATE TABLE IF NOT EXISTS module_use (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    module       TEXT NOT NULL,
    -- the function called, or '(eval)' for an expression
    fn           TEXT NOT NULL,
    -- what makes two uses THE SAME use: a function name, or for an expression
    -- the set of module functions it touched (composition coalesces far better
    -- than wording does)
    shape        TEXT NOT NULL,
    -- rolling list of distinct recent forms, newest first
    examples     TEXT NOT NULL DEFAULT '',
    hits         INTEGER NOT NULL DEFAULT 0,
    ok_hits      INTEGER NOT NULL DEFAULT 0,
    ms_total     INTEGER NOT NULL DEFAULT 0,
    first_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_session TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_module_use ON module_use(module, fn, shape);

  -- THE CALL LOG (M3/M4, 2026-08-05). module_use above is an UPSERT: it keeps a
  -- running total per function and overwrites last_session on every call. That
  -- answers "does this function earn its place" and nothing else — after a day
  -- of work it can say find has been called 243 times and that the most recent
  -- caller was the Atlas, but not whether the CONCIERGE called it once, nor
  -- which nodes any call touched.
  --
  -- Three separate things need exactly that row and none of them could have it:
  -- the measurement for dropping the tree index from the day's context (I9, M4);
  -- I4's "every read is attributable", which is listed as its own test; and M3's
  -- overlay — "select last night's dream and see exactly what it touched".
  --
  -- The refs were already being COMPUTED, by entityRefs(args, value), and handed
  -- to pulse, which is explicitly in-process, bounded and lossy. Its own comment
  -- names the rule this table follows: if a fact matters, it belongs in a table,
  -- and the pulse is not that table.
  CREATE TABLE IF NOT EXISTS module_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL DEFAULT (datetime('now')),
    -- who called: a session key, 'nightly', 'atlas', or NULL for a bare CLI run
    session_key TEXT,
    module      TEXT NOT NULL,
    fn          TEXT NOT NULL,
    args        TEXT NOT NULL DEFAULT '',
    ok          INTEGER NOT NULL DEFAULT 1,
    ms          INTEGER NOT NULL DEFAULT 0,
    -- entity ids seen in the arguments or the result, as a JSON array. Best
    -- effort and deliberately unvalidated against history: a ref to a node that
    -- has since moved stays as it was recorded, because this is a log of what
    -- was touched, not a claim about what currently exists.
    refs        TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_module_calls_at ON module_calls(at);
  CREATE INDEX IF NOT EXISTS idx_module_calls_session ON module_calls(session_key, at);

  -- WHICH DOOR (2026-08-05). module_calls answers "did it call the API"; this
  -- answers the question that actually matters, "which way did it go" — the API,
  -- a note, the message log, or a raw file. Without it, an empty API ledger is
  -- indistinguishable between an agent that ignored memory and one that reached
  -- for it through a different door, and those call for opposite fixes.
  CREATE TABLE IF NOT EXISTS tool_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL DEFAULT (datetime('now')),
    session_key TEXT,
    tool        TEXT NOT NULL,
    -- a short, human-readable target: the note key, file path, search term or
    -- module.fn. Enough to tell doors apart, never enough to be a second copy
    -- of the payload.
    target      TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_at ON tool_calls(at);

  -- Retrieval counters (round 5): every readNote / locateThreadTrace /
  -- findThread bumps one row. Pure attention data for the nightly operator
  -- (promote what's hot, decay what's never touched). Cheap, no UI.
  CREATE TABLE IF NOT EXISTS retrievals (
    kind    TEXT NOT NULL,   -- 'note' | 'trace' | 'search'
    key     TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    last_at TEXT,
    PRIMARY KEY (kind, key)
  );

  -- HARVESTED EPISODES (round 6 step 1): Mehdi's own local Claude Code work,
  -- which the system was blind to because it only saw Telegram. The unit is an
  -- EPISODE — a contiguous burst inside a session, bounded by an idle gap —
  -- because sessions stay open for days and a session-level recap is stale on
  -- arrival. The skeleton column is the ~900-char extract (title + prompts +
  -- closing text) that step 2 distils; the transcript itself is never read by
  -- an agent to build memory. Keyed (session_id, seq) so re-harvest is
  -- idempotent. closed = the burst went idle, so it will not change again.
  CREATE TABLE IF NOT EXISTS episodes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    project      TEXT NOT NULL,
    cwd          TEXT NOT NULL DEFAULT '',
    git_branch   TEXT,
    started_at   TEXT NOT NULL,
    ended_at     TEXT NOT NULL,
    turns        INTEGER NOT NULL DEFAULT 0,
    user_prompts INTEGER NOT NULL DEFAULT 0,
    tools        TEXT NOT NULL DEFAULT '{}',
    files        TEXT NOT NULL DEFAULT '[]',
    title        TEXT,
    skeleton     TEXT NOT NULL DEFAULT '',
    closed       INTEGER NOT NULL DEFAULT 0,
    distilled_at TEXT,
    recap        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_episodes_ended ON episodes(ended_at);
  CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project);

  -- Session ids the bot itself created through a bare query() (distillation,
  -- and anything similar later). Worker/concierge sessions are already in the
  -- sessions table; these are not, so without this the harvest re-ingests the
  -- bot's own runs as Mehdi's local work. One distill pass writes ~90
  -- transcripts into the ai-companion project dir.
  CREATE TABLE IF NOT EXISTS bot_sessions (
    session_id TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Background watches: a worker launches a long external wait (gh run watch,
  -- gh pr checks --watch) and its turn ENDS; the bot process keeps the child
  -- alive across turns/session limits and re-invokes the worker when it exits.
  -- Persisted so a bot restart re-arms the still-running watch instead of
  -- silently dropping it.
  CREATE TABLE IF NOT EXISTS watches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    slot        INTEGER NOT NULL,
    command     TEXT NOT NULL,
    label       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'done'
    exit_code   INTEGER,
    output_tail TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );

  -- Harvest bookkeeping: skip transcripts that have not changed since the last
  -- pass (152MB across 165 files; only the live ones ever move).
  CREATE TABLE IF NOT EXISTS harvest_files (
    path         TEXT PRIMARY KEY,
    mtime        INTEGER NOT NULL,
    size         INTEGER NOT NULL,
    harvested_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Per-turn usage/cost, captured from the SDK result message (model, tokens,
  -- cost, latency). One row per completed turn. input_tokens of the latest turn
  -- ≈ how much context that turn carried — the closest proxy to "current context
  -- length" for a session.
  CREATE TABLE IF NOT EXISTS usage (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key     TEXT NOT NULL,
    model           TEXT NOT NULL DEFAULT '',
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_read      INTEGER NOT NULL DEFAULT 0,
    cache_creation  INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    num_turns       INTEGER NOT NULL DEFAULT 0,
    context_window  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_key);
`);

/**
 * Add a column if it is not there, tolerating a LOST RACE.
 *
 * Every migration here was check-then-act, which is safe in one process and a
 * coin flip across several: `npm test` runs each test file in its own process
 * against one database, and two of them reaching the same `ALTER TABLE` at the
 * same moment meant one threw `duplicate column name` and took a whole test
 * file down with it. The suite was therefore intermittently red — 4 runs in 8
 * on 2026-08-02 — which is worse than steadily red, because a flake teaches
 * everyone to re-run instead of to look. Found by M2's audit on its first pass,
 * which is the argument for the audit.
 *
 * Losing the race is not a failure: the other process created exactly the
 * column this one wanted, so the postcondition holds either way. Any OTHER
 * error still throws — a migration that fails for a real reason must not be
 * swallowed alongside it.
 */
function addColumn(table: string, col: string, ddl: string): void {
  if (db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  } catch (e) {
    if (!/duplicate column name/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

// Each dream covers a specific, non-overlapping time window — (end of the last
// dream, now) — so nightly dreams each reflect on ~a day and never re-scan the
// same activity. Added after the table's first ship.
addColumn('dreams', 'covers_from', 'TEXT');
addColumn('dreams', 'covers_to', 'TEXT');

// The operator's ask to stop a pass mid-flight, read by the process running it.
addColumn('dream_phase', 'cancel_requested', 'TEXT');

// Proof of life from a running pass. Empty on an old row, which reads as
// `since` — so an upgrade in the middle of a fold degrades to the old rule
// rather than killing the hold outright.
addColumn('dream_phase', 'beat', 'TEXT');

// M4: the entity a focus item is about — the day's door into the graph.
addColumn('commitments', 'ref', 'TEXT');

// I4: the nodes a question actually reached. See the note on the table.
addColumn('retrieval_episodes', 'refs', "TEXT NOT NULL DEFAULT '[]'");

// M5: reads that went to the PROSE tree rather than the graph. Without this a
// turn answered entirely from root.md scored `no-reach` — indistinguishable
// from a turn that used no memory at all.
addColumn('retrieval_episodes', 'tree', 'INTEGER NOT NULL DEFAULT 0');
// THE MEMORY CUE (src/recall.ts): the entity ids the incoming message NAMED,
// as told to the concierge under the message. `refs` is what the turn then
// reached; hinted ∩ refs is whether the cue was followed.
addColumn('retrieval_episodes', 'hinted', "TEXT NOT NULL DEFAULT '[]'");

// Round 11 P2: how many DISTINCT reached refs were OFFERED by the story's
// [[pointers]] at the moment of the reach (deduped like `refs`, so the ratio
// of the two columns stays honest). The story's whole bet is that a named
// pointer gets followed where an open-ended query does not, and without this
// column a followed pointer and a spontaneous reach are the same row — the
// bet stays unmeasured, which is the round-9 failure again.
addColumn('retrieval_episodes', 'story_followed', 'INTEGER NOT NULL DEFAULT 0');
// The two ways a pointer gets taken are two different claims, so they are two
// columns (P2b): `story_followed` is an ENTITY ref from the injected block
// reached through the graph API — spontaneous, the day chose find() on a name
// it was shown; `story_read` is the door the block names, readStory, opened.
// One count would let the door's traffic hide the absence of the other, and
// the round's thesis is the one the door cannot prove by itself.
addColumn('retrieval_episodes', 'story_read', 'INTEGER NOT NULL DEFAULT 0');

/**
 * BACKFILL THE NIGHT LEDGER FROM THE DREAMS THAT ALREADY HAPPENED.
 *
 * An empty `night_settled` means "no night has ever been settled", and the debt
 * is honest about that: it holds the day and folds immediately. Which is what
 * it did — the first process to boot with this code started an unscheduled pass
 * at 09:44 local on a day that had already dreamt at 09:18, i.e. it reproduced
 * the exact double-fold the debt exists to prevent, on its first run.
 *
 * A new ledger about a machine with 70 nights of history must not claim the
 * history did not happen. The most recent dream settles its own boundary, and
 * the day starts square.
 *
 * Guarded on the table being EMPTY rather than on a version flag: the condition
 * this repairs is "nothing has ever been recorded here", which is precisely
 * what the emptiness says, and re-running it after a real cancel would forgive
 * a night the operator deliberately gave up on.
 */
if (!db.prepare('SELECT 1 FROM night_settled LIMIT 1').get()) {
  const last = db.prepare('SELECT created_at FROM dreams ORDER BY id DESC LIMIT 1').get() as { created_at: string } | undefined;
  if (last) {
    const at = new Date(`${last.created_at.replace(' ', 'T')}Z`);
    const b = new Date(at);
    b.setHours(Number(process.env.NIGHTLY_HOUR ?? 4), 0, 0, 0);
    if (b.getTime() > at.getTime()) b.setDate(b.getDate() - 1);
    const boundary = b.toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('INSERT OR IGNORE INTO night_settled (boundary, settled_at, how, note) VALUES (?, ?, ?, ?)').run(
      boundary,
      last.created_at,
      'dreamt',
      'backfilled from the dream journal when the night became a debt',
    );
    console.log(`[night] backfilled the ledger from dream at ${last.created_at} — night ${boundary} settled`);
  }
}

// Legacy "memo" column — retired in round 5 (briefs + recaps replaced it).
// Kept dormant for rollback; no code reads or writes it anymore.
addColumn('chat_sessions', 'memo', 'TEXT');

// auto_title=1 means the title tracks Claude Code's free session summary; an
// explicit rename (concierge setThreadMemo) flips it to 0 so we stop overriding.
addColumn('chat_sessions', 'auto_title', 'INTEGER NOT NULL DEFAULT 1');

// Rolling recap: an auto-maintained one-liner of a worker's latest state,
// refreshed after each of its turns (no LLM call). Unlike the curated memo it
// can't go stale, so "what's that worker doing?" is answerable cheaply.
addColumn('chat_sessions', 'recap', 'TEXT');

// The thread's BRIEF (round 5): the worker's whole world — task, relevant root
// lines, domain leads, artifacts, non-goals — composed by the concierge at
// dispatch, stored here, and injected into every worker turn. Replaces the
// blanket shared/bulletin/workspace injection AND the curated memo (that
// column stays, dormant).
addColumn('chat_sessions', 'brief', 'TEXT');

/**
 * DOES THIS WORKER REMEMBER ITS LAST RUN?
 *
 * On 2026-08-19 the Morning Routine emitted a standup line about stagebox PROD and
 * Fabrikam #2613 that Mehdi had explicitly closed the day before. Every durable
 * store was correct: commitment #108 was closed on 08-16, the concierge fixed
 * the tree note, both observations folded into the graph. The worker never read
 * any of them — it resumes session 7848d7e8 every morning and rebuilt the sheet
 * from its own previous output. Supporting number from the same day: workers
 * produced 17 retrieval episodes and every one scored `no-reach`.
 *
 * A warm worker is right for a task that spans days and wrong for a routine
 * that runs daily, and until now nothing could express the difference — there
 * was no path to reset a worker's context at all (`clearSession` was only ever
 * called on the concierge). This is that switch, and it lives on the THREAD
 * rather than in the concierge's head because the concierge's head is cleared
 * every night, which is the same reason the night's own conclusions had to
 * become rows.
 */
addColumn('chat_sessions', 'fresh', 'INTEGER NOT NULL DEFAULT 0');
// Which model and how hard it thinks, per worker — chosen by the concierge at
// dispatch and kept on the thread, because a later turn on the same slot must
// run the way the work was sized, not the way the deployment default happens
// to be. NULL = the deployment default (config.workerModel / workerEffort).
// Until 2026-08-27 one CLAUDE_MODEL ran everyone — concierge, every worker,
// the night — on the strongest tier at default effort, and the ledger read
// ~$375 a week with the concierge's prefix as the biggest line.
addColumn('chat_sessions', 'model', 'TEXT');
addColumn('chat_sessions', 'effort', 'TEXT');

/**
 * ONE-OFF REPAIRS, named. A backfill that guards on its own postcondition
 * re-runs whenever the postcondition looks unmet again — which for "threads
 * with no model" is every thread dispatched without one from now on. A named
 * row says "this repair happened", once, and the guard is the row.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS backfills (
    name    TEXT PRIMARY KEY,
    done_at TEXT NOT NULL DEFAULT (datetime('now')),
    note    TEXT
  );
`);

/**
 * Warm threads that predate per-thread models have a stored session built on
 * the previous default (one CLAUDE_MODEL for everyone — opus). Continuing that
 * transcript on the new worker default would swap the model under a running
 * conversation, silently. Pin them to what they were running on; a thread
 * without a session has nothing to continue and takes the new defaults.
 */
export function backfillThreadModels(previousDefault = 'opus'): number {
  const name = 'thread-model-2026-08-27';
  // CLAIM FIRST, THEN DO. Two processes booting at once (the schema race test
  // boots six) both read "not done", both updated, and the second INSERT threw
  // UNIQUE constraint failed — a boot that crashed on a marker for work that
  // was already done. The marker is claimed with OR IGNORE and the loser of
  // the race simply returns; the UPDATE is idempotent, so either order is fine.
  const claimed = db.prepare('INSERT OR IGNORE INTO backfills (name, note) VALUES (?, ?)').run(name, 'claimed').changes;
  if (!claimed) return 0;
  const r = db
    .prepare(
      `UPDATE chat_sessions SET model = ?
        WHERE model IS NULL AND slot >= 0
          AND EXISTS (SELECT 1 FROM sessions s WHERE s.session_key = chat_sessions.chat_id || ':' || chat_sessions.slot)`,
    )
    .run(previousDefault);
  db.prepare('UPDATE backfills SET note = ? WHERE name = ?').run(
    `${r.changes} warm thread(s) pinned to ${previousDefault}, the default they were running on`,
    name,
  );
  if (r.changes) console.log(`[db] pinned ${r.changes} warm thread(s) to ${previousDefault} — per-thread models begin`);
  return r.changes;
}

/**
 * TURNS IN FLIGHT — the only record that a turn was RUNNING when the process
 * died.
 *
 * A turn's liveness lived entirely in memory (the `running` map, the badges
 * map), so a process that stopped mid-turn left nothing behind at all: no
 * result event, therefore no usage row, therefore no trace. On 2026-08-02 a
 * `tsx watch` restart killed slot 46 mid-edit at 21:27 and the system's own
 * account of itself never noticed — the concierge went on telling Mehdi the
 * worker was "actively running and streaming its progress" for the next 34
 * minutes, because after a restart an interrupted thread and an idle one look
 * identical.
 *
 * A row is written when a turn starts and deleted when it ends, by any exit —
 * success, error, abort. So anything still here at boot is by definition a turn
 * that did not get to finish, and boot is the one place that can say so.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS turns_running (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    chat_id     INTEGER NOT NULL,
    slot        INTEGER NOT NULL,
    prompt_head TEXT NOT NULL DEFAULT '',
    started_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
// A turn that outlived its process can be REPLAYED only if its whole text and
// its provenance survived with it. `prompt_head` was written for a report; the
// 2026-08-27 restart showed the report is not enough when the row is a person's
// message that was never answered.
addColumn('turns_running', 'text', "TEXT NOT NULL DEFAULT ''");
addColumn('turns_running', 'human', 'INTEGER NOT NULL DEFAULT 0');
addColumn('turns_running', 'user_msg_id', 'INTEGER');
// WHOSE process wrote the row. Restart recovery takes rows a PREVIOUS process
// left; from the minute tick (index.ts) the same take used to sweep up this
// process's own live turns — every turn longer than a minute was marked
// "killed by restart" and replayed (2026-08-28: one message answered twice,
// a running worker re-dispatched under itself). A row is stranded only when
// nobody alive owns it, and ownership is the boot id, not the table.
addColumn('turns_running', 'boot_id', "TEXT NOT NULL DEFAULT ''");
/** This process's identity on the rows it writes. Rows carrying any other
 *  value (including the pre-08-28 empty default) belong to a dead process. */
export const BOOT_ID = randomUUID();

/*
 * THE TURN QUEUE, DURABLE.
 *
 * Turns queued behind a held session lock used to live in a Map in
 * `turnLock.ts`. The runner restarts the process on every source edit, a crash
 * restarts it, and on 2026-08-27 the fix for a two-hour hang restarted it — and
 * each time every queued message vanished with the eyes reaction still on it.
 * The row is written when a turn is queued and deleted when it is dequeued or
 * the lock is released, so what is here at boot is exactly what nobody ran.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS turn_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    chat_id     INTEGER NOT NULL,
    slot        INTEGER NOT NULL,
    text        TEXT NOT NULL,
    visible     INTEGER NOT NULL DEFAULT 1,
    background  INTEGER NOT NULL DEFAULT 0,
    user_msg_id INTEGER,
    human       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_turn_queue_key ON turn_queue(session_key, id);
`);
addColumn('turn_queue', 'boot_id', "TEXT NOT NULL DEFAULT ''");

/*
 * THE PENDING HANDOFF.
 *
 * A rotation (src/rotation.ts) clears a session and hands the next turn a
 * render of what the old one was doing. Held only in memory, the handoff died
 * with the process on 2026-08-27: the 09:15 turn rotated, hung, was restarted,
 * and the next turn re-onboarded — the exact failure the rotation exists to
 * prevent. The row is written at rotation and deleted only when a NEW session
 * has acknowledged the turn that carried it; a stale one is dropped, never
 * delivered. A deliberate clear (nightly, /reset, debug exit) drops it too:
 * a clear supersedes a rotation.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_handoff (
    session_key TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- THE CONCIERGE'S SYSTEM PROMPT, FROZEN FOR THE LIFE OF ITS SESSION (I12).
  --
  -- The prompt used to be rebuilt every turn and interpolated live state (the
  -- attention set, today's events, open commitments). Any changed byte in it
  -- moved the cache prefix, and everything behind that byte — the whole
  -- transcript — was re-uploaded on the first call of every turn. The ledger
  -- showed it plainly: cache_read stuck at 13,573 tokens (the tool schemas,
  -- the only stable part) while cache_written ran 60k–160k per turn.
  -- Isolation experiments proved the SDK caches a resumed transcript across
  -- processes whenever the prefix holds still. So the prompt is now built ONCE
  -- at session open, stored here, and reused byte-for-byte until the session
  -- is cleared; the volatile state goes into the first turn as a snapshot.
  -- contract is the session contract the prompt was built under — a new
  -- contract means a new session, and the prompt is rebuilt with it.
  -- snapshot_owed is set when the SDK hands back a DIFFERENT session id than
  -- the one resumed (the transcript is new; the snapshot never reached it), so
  -- the next turn re-sends the state once.
  CREATE TABLE IF NOT EXISTS session_prompts (
    session_key   TEXT PRIMARY KEY,
    contract      TEXT NOT NULL DEFAULT '',
    prompt        TEXT NOT NULL,
    snapshot_owed INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// THE CONTRACT A SESSION WAS BUILT UNDER.
//
// A stored session id is a promise that the transcript behind it still makes
// sense to continue. That promise breaks when the agent's WORLD changes, not
// just when its history gets long: on 2026-08-02 the worker lost its focus set,
// its knowledge tools and its graph tools in one commit, and every stored
// worker session was suddenly a 629k-token transcript full of calls to tools
// that no longer exist, assembled from context the worker can no longer see.
// Resuming one pays full price to re-cache a history that actively misleads.
//
// So a session records the contract it was built under, and a session whose
// contract no longer matches is not resumed — it starts fresh from its brief.
// Mechanism, not a note to remember to clear sessions by hand (I9).
addColumn('sessions', 'contract', "TEXT NOT NULL DEFAULT ''");

// Routing settings (Phase 1): auto_route toggles the classifier; pinned locks
// routing to the active thread regardless.
addColumn('chat_state', 'auto_route', 'INTEGER NOT NULL DEFAULT 1');
addColumn('chat_state', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
// Capture mode: while on, incoming messages queue in pending_inbox for /process.
addColumn('chat_state', 'capturing', 'INTEGER NOT NULL DEFAULT 0');

// Round 6 step 1 follow-up: an episode carries its ARC, not just a title.
// Claude Code titles a session once and never revisits it, so the title names
// only where a session started — a 10-hour burst that wandered from a question
// to a planning doc to a PR needs its beats, not its opening label.
for (const col of ['milestones', 'entities', 'anchor_uuid']) addColumn('episodes', col, "TEXT NOT NULL DEFAULT '[]'");
addColumn('episodes', 'distillable', 'INTEGER NOT NULL DEFAULT 1');
// Summarised, but kept out of the knowledge tree — the operator never sees it.
addColumn('episodes', 'foldable', 'INTEGER NOT NULL DEFAULT 1');
// The turn count captured at the last distill. NULL = never distilled. Lets a
// LIVE episode be summarised provisionally now and re-summarised once it has
// grown materially — Mehdi leaves sessions open for days, so "distil only when
// closed" left today's work invisible until it went idle.
addColumn('episodes', 'distilled_turns', 'INTEGER');
// Backfill, OUTSIDE the column guard so it also heals a DB whose column predates
// this line: an already-distilled row was summarised at its current size, so
// seed distilled_turns = turns. Idempotent (only fills NULLs), so re-running it
// every boot never erases a real "grown since distill" gap. Without it the
// re-distill clause reads the NULL as 0 and re-summarises every episode once.
db.exec('UPDATE episodes SET distilled_turns = turns WHERE distilled_at IS NOT NULL AND distilled_turns IS NULL');

// Round 7 — FOCUS. A focus item is not a new kind of thing: it is a watched
// commitment the system keeps VERIFIED. `how_to_check` is free text written for
// an LLM ("ask Mehdi"); `check_cmd` is the machine's version — a deterministic
// command whose scrubbed stdout is comparable run to run, so an unchanged item
// costs a subprocess instead of a concierge turn. The rest is the diff state
// that makes "changed" decidable without asking a model.
//
// `focus` is a TIER, not a flag: 0 = not in the set, 1 = closest to the user,
// and upward for quieter bands. The count is deliberately open — the concierge
// cuts the set into as many bands as the items warrant and names each one in
// `focus_band`, rather than the schema fixing "active vs backlog" forever.
for (const [col, ddl] of [
  ['focus', 'INTEGER NOT NULL DEFAULT 0'],
  ['focus_band', 'TEXT'],
  ['check_cmd', 'TEXT'],
  ['check_state', 'TEXT'],
  ['last_seen', 'TEXT'],
  ['last_checked_at', 'TEXT'],
  // THE LEDGER (design proposal #1, 2026-10-30): a watched item's accumulating
  // state. `watch_head` is the check's own structured glance (JSON), and
  // `watch_mode` decides what a changed head does: NULL = wake on any change
  // (the hash-diff default), 'log' = never wake, anything else = a predicate
  // over the head (src/ledger.ts) that must be true to wake.
  ['watch_mode', 'TEXT'],
  ['watch_head', 'TEXT'],
] as const) {
  addColumn('commitments', col, ddl);
}

// A PROPOSAL'S OWN CHECK — the command that passes once the fix has shipped.
//
// Without one the queue is a second store of facts that nothing reconciles. On
// 2026-08-06 all five pending proposals had already been fixed in the repo
// while every row still read `pending`; the night read the queue, believed it,
// and opened its report calling shipped bugs live — including #28, whose
// success was sitting in the evidence directly above it (`readFocus` firing 13×
// IS the injected copy being gone). It counted a win as an outstanding task.
//
// The rule this buys: a proposal that cannot name what would prove it done is
// not a proposal yet. Same three outcomes as every other check (I3) — passes,
// fails, or could not run — and it never resolves anything by itself, because
// the operator gate is what keeps the bot out of its own source.
addColumn('findings', 'verify', 'TEXT');
addColumn('findings', 'verified_at', 'TEXT');
addColumn('findings', 'verdict', 'TEXT');
addColumn('graph_rot', 'ruleset', "TEXT NOT NULL DEFAULT ''");
// Which attempt a write belonged to. Null for everything before runs existed,
// and for any write made outside one — a hand-run CLI call is still a write.
addColumn('entity_writes', 'run_id', 'INTEGER');
// Reads belong to an attempt too. A run's footprint is everything it TOUCHED,
// and an agent that read six nodes to justify changing one has reached for all
// seven — showing only the write hides the reasoning.
addColumn('module_calls', 'run_id', 'INTEGER');
// WHOSE attempt it is. Without this the open run is a global sink: run #7 was
// opened from the Atlas and left open, and every module call in the process
// since — including the Atlas's OWN reads as someone clicked around the graph —
// was recorded as part of that attempt. Ambient state needs an owner or it
// collects strangers.
addColumn('graph_runs', 'actor', "TEXT NOT NULL DEFAULT ''");
// Rotation (src/rotation.ts): the EXACT context the SDK reported for the turn
// (getContextUsage), beside the per-run sums — which are summed across every
// internal API call of the run and overstate a live window by ~num_turns×
// (a real row: 1,026,095 "context" on a 1M window at num_turns=12).
addColumn('usage', 'context_tokens', 'INTEGER NOT NULL DEFAULT 0');
addColumn('usage', 'context_max', 'INTEGER NOT NULL DEFAULT 0');
// The thinking effort the turn was ASKED for, beside its model — so the cost
// line can split a role by both and a change to either is judged by the
// ledger. Named for the truth: `model` is what RAN (the result message says),
// `effort_asked` is what was requested — the SDK may silently downgrade an
// effort the model does not support, and the resolved value is not on the
// result message, so this column cannot claim more than it knows.
addColumn('usage', 'effort_asked', "TEXT NOT NULL DEFAULT ''");
// Who a 'user' row came from: 'human' (typed, tapped, pressed) or 'machine'
// (composed by the bot — a seed, a nudge, a watched run's verdict). Provenance
// is set where the row is written, never sniffed from its text: [USER ANSWERED]
// and [PROCESS BATCH] are human-initiated and bracket-led. NULL on rows older
// than the column; readers fall back to the bracket sniff for those only.
addColumn('messages', 'source', 'TEXT');

// FULL-TEXT INDEX over the message log. Substring LIKE was the only way in, so
// a question only found a message that literally contained its wording: a
// pasted document about a lease renewal was unreachable from "paperwork",
// and any multi-word term was matched as one contiguous string, i.e. almost
// never. FTS5 gives stemming, per-word OR matching and bm25 ranking. It is an
// EXTERNAL-CONTENT index (content='messages'): the rows live once, in messages;
// this stores only the index, kept in sync by triggers.
//
// Guarded and non-fatal: if this SQLite build lacks FTS5, search silently falls
// back to the old LIKE path rather than taking the bot down.
export const messagesFts = (() => {
  try {
    const existed = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
      .get();
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    // Backfill every message logged before the index existed. 'rebuild' reads
    // straight from the content table, so it is correct and idempotent; we only
    // pay for it the once, on the boot that creates the index.
    if (!existed) {
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
      const n = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
      console.log(`[db] built messages_fts over ${n} message(s)`);
    }
    return true;
  } catch (err) {
    console.warn(`[db] FTS5 unavailable — message search stays substring-only: ${String(err)}`);
    return false;
  }
})();

// One-time data migration into commitments: every wakeup row (status mapped,
// so a cancelled morning-brief STAYS cancelled for the ensure-seeding logic)
// plus the open waiting entries. Old tables keep their rows, dormant, for
// rollback. Guarded on the commitments table being empty.
const commitmentsEmpty =
  (db.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n === 0;
const hasLegacyProspective =
  (db.prepare("SELECT (SELECT COUNT(*) FROM wakeups) + (SELECT COUNT(*) FROM waiting) AS n").get() as { n: number }).n > 0;
if (commitmentsEmpty && hasLegacyProspective) {
  const migrated = db.transaction(() => {
    const w = db
      .prepare(
        `INSERT INTO commitments (chat_id, label, body, due_at, recur, how_to_check, thread_slot, status, created_by, last_fired_at, created_at)
         SELECT chat_id, label, prompt, fire_at, recur, NULL, NULL,
                CASE status WHEN 'active' THEN 'open' WHEN 'cancelled' THEN 'dropped' ELSE 'done' END,
                created_by, last_fired_at, created_at
         FROM wakeups`,
      )
      .run().changes;
    const p = db
      .prepare(
        `INSERT INTO commitments (chat_id, label, body, due_at, recur, how_to_check, thread_slot, status, created_by, created_at)
         SELECT chat_id, substr(what, 1, 40), what || char(10) || 'blocked on: ' || blocked_on,
                next_check_at, NULL, how_to_check, thread_slot, 'open', 'bot', created_at
         FROM waiting WHERE status = 'open'`,
      )
      .run().changes;
    return { w, p };
  })();
  console.log(`[db] migrated ${migrated.w} wakeup(s) + ${migrated.p} open waiting item(s) → commitments`);
}

backfillThreadModels();

const stmts = {
  getSession: db.prepare<[string]>('SELECT session_id, contract FROM sessions WHERE session_key = ?'),
  setSession: db.prepare<[string, string, string]>(`
    INSERT INTO sessions (session_key, session_id, contract, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(session_key) DO UPDATE SET
      session_id = excluded.session_id, contract = excluded.contract, updated_at = datetime('now')
  `),
  clearSession: db.prepare<[string]>('DELETE FROM sessions WHERE session_key = ?'),
  beginTurn: db.prepare<[string, number, number, string, string, number, number | null, string]>(
    'INSERT INTO turns_running (session_key, chat_id, slot, prompt_head, text, human, user_msg_id, boot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ),
  endTurn: db.prepare<[number]>('DELETE FROM turns_running WHERE id = ?'),
  strandedTurns: db.prepare('SELECT * FROM turns_running ORDER BY started_at, id'),
  clearTurns: db.prepare('DELETE FROM turns_running'),
  foreignTurns: db.prepare<[string]>('SELECT * FROM turns_running WHERE boot_id != ? ORDER BY started_at, id'),
  clearForeignTurns: db.prepare<[string]>('DELETE FROM turns_running WHERE boot_id != ?'),
  foreignQueued: db.prepare<[string]>('SELECT * FROM turn_queue WHERE boot_id != ? ORDER BY id'),
  clearForeignQueued: db.prepare<[string]>('DELETE FROM turn_queue WHERE boot_id != ?'),
  countForeign: db.prepare<[string, string]>('SELECT (SELECT COUNT(*) FROM turns_running WHERE boot_id != ?) + (SELECT COUNT(*) FROM turn_queue WHERE boot_id != ?) AS n'),
  queueTurn: db.prepare<[string, number, number, string, number, number, number | null, number, string]>(
    'INSERT INTO turn_queue (session_key, chat_id, slot, text, visible, background, user_msg_id, human, boot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ),
  oldestQueued: db.prepare<[string]>('SELECT * FROM turn_queue WHERE session_key = ? ORDER BY id LIMIT 1'),
  deleteQueued: db.prepare<[number]>('DELETE FROM turn_queue WHERE id = ?'),
  dropQueued: db.prepare<[string]>('DELETE FROM turn_queue WHERE session_key = ?'),
  countQueued: db.prepare<[string]>('SELECT COUNT(*) AS n FROM turn_queue WHERE session_key = ?'),
  allQueued: db.prepare('SELECT * FROM turn_queue ORDER BY id'),
  clearQueued: db.prepare('DELETE FROM turn_queue'),
  saveHandoff: db.prepare<[string, string, string]>(
    'INSERT OR REPLACE INTO pending_handoff (session_key, text, reason, created_at) VALUES (?, ?, ?, datetime(\'now\'))',
  ),
  getHandoff: db.prepare<[string]>('SELECT * FROM pending_handoff WHERE session_key = ?'),
  dropHandoff: db.prepare<[string]>('DELETE FROM pending_handoff WHERE session_key = ?'),
  getPrompt: db.prepare<[string]>('SELECT contract, prompt, snapshot_owed FROM session_prompts WHERE session_key = ?'),
  setPrompt: db.prepare<[string, string, string, number]>(
    "INSERT OR REPLACE INTO session_prompts (session_key, contract, prompt, snapshot_owed, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
  ),
  dropPrompt: db.prepare<[string]>('DELETE FROM session_prompts WHERE session_key = ?'),
  setSnapshotOwed: db.prepare<[number, string]>('UPDATE session_prompts SET snapshot_owed = ? WHERE session_key = ?'),
  oweBriefUpdate: db.prepare<[string]>('UPDATE session_prompts SET snapshot_owed = 3 WHERE session_key = ? AND snapshot_owed = 0'),
  logMessage: db.prepare<[string, string, string, string | null]>(
    'INSERT INTO messages (session_key, role, content, source) VALUES (?, ?, ?, ?)',
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
    "SELECT id, session_key, role, content FROM messages WHERE session_key LIKE ? ORDER BY id DESC LIMIT ?",
  ),
  // Messages within a half-open time window (from, to] — for time-scoped dreams.
  chatTimelineWindow: db.prepare<[string, string, string, number]>(
    'SELECT id, session_key, role, content FROM messages WHERE session_key LIKE ? AND created_at > ? AND created_at <= ? ORDER BY id DESC LIMIT ?',
  ),
  chatTimelineWindowCount: db.prepare<[string, string, string]>(
    'SELECT COUNT(*) AS n FROM messages WHERE session_key LIKE ? AND created_at > ? AND created_at <= ?',
  ),
  // Free full-history retrieval: the message log is the cheapest rung of the
  // trace-retrieval ladder (notes → recaps → THIS → code → transcripts).
  searchMessages: db.prepare<[string, string, number]>(
    "SELECT id, session_key, role, content, created_at FROM messages WHERE session_key LIKE ? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?",
  ),
  // Same log, ranked: stemmed per-word matching via the FTS index. bm25 is
  // negative-is-better in SQLite, so plain ASC order puts the best hit first.
  searchMessagesFts: db.prepare<[string, string, number]>(`
    SELECT m.id, m.session_key, m.role, m.content, m.created_at
    FROM messages_fts f JOIN messages m ON m.id = f.rowid
    WHERE f.content MATCH ? AND m.session_key LIKE ?
    ORDER BY bm25(messages_fts), m.id DESC
    LIMIT ?
  `),
  // One message, whole. The counterpart to every truncated excerpt: an id in a
  // search result or a cut digest line is a dead end without this.
  getMessage: db.prepare<[number, string]>(
    'SELECT id, session_key, role, content, created_at FROM messages WHERE id = ? AND session_key LIKE ?',
  ),
  // chat / slot management
  listSessions: db.prepare<[number, string]>(
    'SELECT slot, title, status, last_active FROM chat_sessions WHERE chat_id = ? AND status = ? ORDER BY slot',
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
  setBrief: db.prepare<[string, number, number]>(
    "UPDATE chat_sessions SET brief = ?, last_active = datetime('now') WHERE chat_id = ? AND slot = ?",
  ),
  getCard: db.prepare<[number, number]>(
    'SELECT slot, title, status, brief, recap, last_active FROM chat_sessions WHERE chat_id = ? AND slot = ?',
  ),
  setRecap: db.prepare<[string, number, number]>(
    "UPDATE chat_sessions SET recap = ?, last_active = datetime('now') WHERE chat_id = ? AND slot = ?",
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
  saveDream: db.prepare<[number, string, string | null, string | null]>(
    'INSERT INTO dreams (chat_id, report, covers_from, covers_to) VALUES (?, ?, ?, ?)',
  ),
  // Where the most recent dream's window ended (its covers_to), so the next dream
  // starts there. Falls back to the dream's created_at for pre-windowing rows.
  lastDreamCoveredTo: db.prepare<[number]>(
    'SELECT COALESCE(covers_to, created_at) AS t FROM dreams WHERE chat_id = ? ORDER BY id DESC LIMIT 1',
  ),
  recentDreams: db.prepare<[number, number]>(
    'SELECT id, report, created_at, processed_at, covers_from, covers_to FROM dreams WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
  ),
  pendingDreams: db.prepare<[number]>(
    'SELECT id, report, created_at, covers_from, covers_to FROM dreams WHERE chat_id = ? AND processed_at IS NULL ORDER BY id',
  ),
  markDreamProcessed: db.prepare<[number]>(
    "UPDATE dreams SET processed_at = datetime('now') WHERE id = ?",
  ),
  saveGrow: db.prepare<[number, string, string]>(
    'INSERT INTO grows (chat_id, summary, changes) VALUES (?, ?, ?)',
  ),
  recentGrows: db.prepare<[number, number]>(
    'SELECT id, summary, changes, created_at FROM grows WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
  ),
  saveFinding: db.prepare<[number, number | null, string, string]>(
    'INSERT INTO findings (chat_id, dream_id, kind, body) VALUES (?, ?, ?, ?)',
  ),
  pendingFindings: db.prepare<[number]>(
    "SELECT id, dream_id, kind, body, created_at, verify, verified_at, verdict FROM findings WHERE chat_id = ? AND status = 'pending' ORDER BY id",
  ),
  setFindingVerify: db.prepare<[string | null, number]>('UPDATE findings SET verify = ? WHERE id = ?'),
  recordFindingVerdict: db.prepare<[string, number]>(
    "UPDATE findings SET verdict = ?, verified_at = datetime('now') WHERE id = ?",
  ),
  resolveFinding: db.prepare<[string, string | null, number]>(
    "UPDATE findings SET status = ?, resolution = ?, resolved_at = datetime('now') WHERE id = ?",
  ),
  postEvent: db.prepare<[number, string, string]>('INSERT INTO events (chat_id, source, body) VALUES (?, ?, ?)'),
  eventsSince: db.prepare<[number, string, number]>(
    'SELECT source, body, created_at FROM events WHERE chat_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?',
  ),
  // (wakeups/waiting tables stay in the schema, dormant — their rows were
  // migrated into commitments and their code paths deleted in round 5.)
  addCommitment: db.prepare<[number, string, string, string, string | null, string | null, number | null, string, number, string | null, string | null, string | null]>(
    'INSERT INTO commitments (chat_id, label, body, due_at, recur, how_to_check, thread_slot, created_by, focus, focus_band, check_cmd, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ),
  setCommitmentRef: db.prepare<[string | null, number, number]>(
    "UPDATE commitments SET ref = ? WHERE id = ? AND chat_id = ? AND status = 'open'",
  ),
  listCommitments: db.prepare<[number]>(
    "SELECT id, chat_id, label, body, due_at, recur, how_to_check, thread_slot, status, created_by, last_fired_at, focus, focus_band, check_cmd, check_state, last_seen, last_checked_at, ref, watch_mode, watch_head FROM commitments WHERE chat_id = ? AND status = 'open' ORDER BY due_at",
  ),
  dueCommitments: db.prepare(
    "SELECT id, chat_id, label, body, due_at, recur, how_to_check, thread_slot, status, created_by, last_fired_at, focus, focus_band, check_cmd, check_state, last_seen, last_checked_at, ref, watch_mode, watch_head FROM commitments WHERE status = 'open' AND due_at <= datetime('now') AND COALESCE(watch_mode, '') != 'log' ORDER BY due_at",
  ),
  anyCommitmentByLabel: db.prepare<[number, string]>(
    'SELECT id, chat_id, label, body, due_at, recur, how_to_check, thread_slot, status, created_by, last_fired_at, focus, focus_band, check_cmd, check_state, last_seen, last_checked_at, ref, watch_mode, watch_head FROM commitments WHERE chat_id = ? AND label = ? ORDER BY id DESC LIMIT 1',
  ),
  // Advance a recurring commitment past now (handles missed days after
  // downtime); datetime arithmetic in SQL keeps the stored UTC wall-time stable.
  advanceCommitment: db.prepare<[number]>(
    `UPDATE commitments SET last_fired_at = datetime('now'),
       due_at = CASE WHEN recur = 'daily'
         THEN datetime(due_at, '+' || (CAST(julianday('now') - julianday(due_at) AS INTEGER) + 1) || ' days')
         ELSE datetime(due_at, '+' || ((CAST((julianday('now') - julianday(due_at)) / 7 AS INTEGER) + 1) * 7) || ' days')
       END
     WHERE id = ? AND recur IS NOT NULL`,
  ),
  finishCommitment: db.prepare<[number]>(
    "UPDATE commitments SET status = 'done', last_fired_at = datetime('now'), resolved_at = datetime('now') WHERE id = ? AND recur IS NULL",
  ),
  deferCommitment: db.prepare<[string, number, number]>(
    "UPDATE commitments SET due_at = ? WHERE id = ? AND chat_id = ? AND status = 'open'",
  ),
  resolveCommitment: db.prepare<[string, string | null, number, number]>(
    "UPDATE commitments SET status = ?, resolution = ?, resolved_at = datetime('now') WHERE id = ? AND chat_id = ? AND status = 'open'",
  ),
  setCommitmentBody: db.prepare<[string, number]>('UPDATE commitments SET body = ? WHERE id = ?'),
  // Re-scope an OPEN watch in place. Without this the only way to correct a
  // watch whose situation moved on was defer/drop-and-recreate, so agents left
  // stale check text in place and talked themselves out of the edit.
  rescopeCommitment: db.prepare<[string | null, string | null, string | null, string | null, string | null, number, number]>(`
    UPDATE commitments
       SET how_to_check = COALESCE(?, how_to_check),
           body         = COALESCE(?, body),
           check_cmd    = COALESCE(?, check_cmd),
           -- a re-scoped check watches something else: its old baseline is not a
           -- comparable "before" any more, so the next run re-baselines instead
           -- of escalating the difference between two different questions.
           check_state  = CASE WHEN ? IS NULL THEN check_state ELSE NULL END,
           last_seen    = CASE WHEN ? IS NULL THEN last_seen   ELSE NULL END
     WHERE id = ? AND chat_id = ? AND status = 'open'
  `),
  // --- Focus (round 7) ------------------------------------------------------
  focusItems: db.prepare<[number]>(
    `SELECT id, chat_id, label, body, due_at, recur, how_to_check, thread_slot, status, created_by, last_fired_at, focus, focus_band, check_cmd, check_state, last_seen, last_checked_at, ref, watch_mode, watch_head
       FROM commitments WHERE chat_id = ? AND status = 'open' AND focus > 0 ORDER BY focus, due_at`,
  ),
  // The checker's input: any OPEN commitment with a machine check, oldest-checked
  // first, that has not been run inside the cadence window. Across all chats —
  // it is a background sweep, not a per-chat one.
  checkableCommitments: db.prepare<[string]>(
    `SELECT id, chat_id, label, body, due_at, recur, how_to_check, thread_slot, status, created_by, last_fired_at, focus, focus_band, check_cmd, check_state, last_seen, last_checked_at, ref, watch_mode, watch_head
       FROM commitments
      WHERE status = 'open' AND check_cmd IS NOT NULL
        AND (last_checked_at IS NULL OR last_checked_at <= ?)
      ORDER BY last_checked_at IS NOT NULL, last_checked_at`,
  ),
  setFocusFields: db.prepare<[number, string | null, string | null, number]>(
    `UPDATE commitments SET focus = ?, focus_band = COALESCE(?, focus_band), check_cmd = COALESCE(?, check_cmd) WHERE id = ?`,
  ),
  recordCheck: db.prepare<[string | null, string | null, number]>(
    `UPDATE commitments SET check_state = ?, last_seen = ?, last_checked_at = datetime('now') WHERE id = ?`,
  ),
  touchCheck: db.prepare<[number]>(
    `UPDATE commitments SET last_checked_at = datetime('now') WHERE id = ?`,
  ),
  dueNow: db.prepare<[number]>(`UPDATE commitments SET due_at = datetime('now') WHERE id = ? AND status = 'open'`),
  addFocusChange: db.prepare<[number, number, string, string | null, string | null, string | null]>(
    'INSERT INTO focus_changes (chat_id, commitment_id, source, observation, before, after) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  openFocusChanges: db.prepare<[number]>(
    'SELECT id, commitment_id, source, observation, before, after, created_at FROM focus_changes WHERE commitment_id = ? AND consumed_at IS NULL ORDER BY id',
  ),
  consumeFocusChanges: db.prepare<[number]>(
    "UPDATE focus_changes SET consumed_at = datetime('now') WHERE commitment_id = ? AND consumed_at IS NULL",
  ),
  recentEscalations: db.prepare<[number]>(
    "SELECT COUNT(*) AS n FROM focus_changes WHERE commitment_id = ? AND created_at >= datetime('now', '-1 day')",
  ),
  botSessionIds: db.prepare(
    'SELECT session_id FROM sessions UNION SELECT session_id FROM bot_sessions',
  ),
  recordBotSession: db.prepare<[string, string]>(
    'INSERT OR IGNORE INTO bot_sessions (session_id, kind) VALUES (?, ?)',
  ),
  insertWatch: db.prepare<[number, number, string, string]>(
    'INSERT INTO watches (chat_id, slot, command, label) VALUES (?, ?, ?, ?)',
  ),
  finishWatch: db.prepare<[number, string, number]>(
    "UPDATE watches SET status = 'done', exit_code = ?, output_tail = ?, finished_at = datetime('now') WHERE id = ?",
  ),
  runningWatches: db.prepare(
    "SELECT id, chat_id, slot, command, label FROM watches WHERE status = 'running' ORDER BY id",
  ),
  countRunningWatches: db.prepare<[number, number]>(
    "SELECT COUNT(*) AS n FROM watches WHERE chat_id = ? AND slot = ? AND status = 'running'",
  ),
  upsertEpisode: db.prepare<
    [string, number, string, string, string | null, string, string, number, number, string, string, string, string, string | null, string, number, string | null, number, number]
  >(`
    INSERT INTO episodes (session_id, seq, project, cwd, git_branch, started_at, ended_at,
                          turns, user_prompts, tools, files, milestones, entities, title, skeleton, closed, anchor_uuid, distillable, foldable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, seq) DO UPDATE SET
      ended_at = excluded.ended_at, turns = excluded.turns,
      user_prompts = excluded.user_prompts, tools = excluded.tools,
      files = excluded.files, milestones = excluded.milestones,
      entities = excluded.entities, anchor_uuid = excluded.anchor_uuid,
      distillable = excluded.distillable, foldable = excluded.foldable, title = excluded.title,
      skeleton = excluded.skeleton, closed = excluded.closed,
      git_branch = excluded.git_branch
  `),
  dedupeEpisodes: db.prepare(`
    DELETE FROM episodes WHERE anchor_uuid IS NOT NULL AND id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY anchor_uuid ORDER BY turns DESC, user_prompts DESC, (distilled_at IS NOT NULL) DESC, id ASC
        ) rn FROM episodes WHERE anchor_uuid IS NOT NULL
      ) WHERE rn = 1
    )
  `),
  // The row another transcript already holds for this anchor — a forked
  // session shares its first-event uuid with its parent, and the harvest must
  // not re-insert the copy the dedupe just removed (design proposal #2).
  anchorOwner: db.prepare<[string, string]>(
    'SELECT id, session_id, turns FROM episodes WHERE anchor_uuid = ? AND session_id != ? ORDER BY turns DESC, id ASC LIMIT 1',
  ),
  episodeById: db.prepare<[number]>('SELECT * FROM episodes WHERE id = ?'),
  searchEpisodeText: db.prepare<[string, string, string, string, number]>(
    `SELECT id, session_id, project, started_at, skeleton, recap
       FROM episodes
      WHERE skeleton LIKE ? OR recap LIKE ? OR title LIKE ? OR entities LIKE ?
      ORDER BY ended_at DESC LIMIT ?`,
  ),
  episodesInWindow: db.prepare<[string, string, number]>(
    `SELECT id, project, started_at, ended_at, turns, user_prompts, recap, closed
       FROM episodes
      WHERE ended_at >= ? AND ended_at <= ? AND distillable = 1 AND foldable = 1
        AND recap IS NOT NULL
      ORDER BY ended_at ASC LIMIT ?`,
  ),
  episodesInWindowCount: db.prepare<[string, string]>(
    `SELECT COUNT(*) AS n FROM episodes
      WHERE ended_at >= ? AND ended_at <= ? AND distillable = 1 AND foldable = 1
        AND recap IS NOT NULL`,
  ),
  episodeForDistill: db.prepare<[number]>(
    `SELECT id, session_id, project, started_at, ended_at, turns, user_prompts, skeleton, closed, distillable
       FROM episodes WHERE id = ?`,
  ),
  // A live burst can be summarised provisionally and re-summarised as it grows;
  // an idle one never re-fires. Eligible when never distilled (>=2 turns, live
  // or closed) OR grown >=6 turns since the last distill. Live/recent first, so
  // a capped pass summarises what's active before backfilling old closed work.
  episodesToDistill: db.prepare<[number]>(`
    SELECT id, session_id, project, started_at, ended_at, turns, user_prompts, skeleton, recap
      FROM episodes
     WHERE distillable = 1 AND (
             (distilled_at IS NULL AND turns >= 2)
             OR turns - COALESCE(distilled_turns, 0) >= 6
           )
     ORDER BY closed ASC, ended_at DESC LIMIT ?
  `),
  episodesByProject: db.prepare<[string, number]>(`
    SELECT id, session_id, seq, project, git_branch, started_at, ended_at, turns,
           user_prompts, tools, files, milestones, entities, title, closed, distillable,
           distilled_at, recap
      FROM episodes WHERE project = ? COLLATE NOCASE ORDER BY ended_at DESC LIMIT ?
  `),
  markEpisodeDistilled: db.prepare<[string, number]>(
    "UPDATE episodes SET recap = ?, distilled_at = datetime('now'), distilled_turns = turns WHERE id = ?",
  ),
  dropEpisodesFrom: db.prepare<[string, number]>('DELETE FROM episodes WHERE session_id = ? AND seq >= ?'),
  fileHarvestState: db.prepare<[string]>('SELECT mtime, size FROM harvest_files WHERE path = ?'),
  markFileHarvested: db.prepare<[string, number, number]>(`
    INSERT INTO harvest_files (path, mtime, size, harvested_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size,
      harvested_at = excluded.harvested_at
  `),
  recentEpisodes: db.prepare<[number]>(`
    SELECT id, session_id, seq, project, git_branch, started_at, ended_at, turns,
           user_prompts, tools, files, milestones, entities, title, closed, distillable,
           distilled_at, recap
      FROM episodes ORDER BY ended_at DESC LIMIT ?
  `),
  episodeStats: db.prepare(`
    SELECT project, COUNT(*) AS episodes, SUM(turns) AS turns,
           MIN(started_at) AS first_seen, MAX(ended_at) AS last_seen
      FROM episodes GROUP BY project ORDER BY episodes DESC
  `),
  bumpRetrieval: db.prepare<[string, string]>(`
    INSERT INTO retrievals (kind, key, count, last_at) VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(kind, key) DO UPDATE SET count = count + 1, last_at = datetime('now')
  `),
  topRetrievals: db.prepare<[number]>(
    'SELECT kind, key, count, last_at FROM retrievals ORDER BY count DESC LIMIT ?',
  ),
  retrievedKeys: db.prepare<[string]>('SELECT key FROM retrievals WHERE kind = ?'),
  retrievalSince: db.prepare<[string, string]>(
    "SELECT COALESCE(SUM(count), 0) AS n FROM retrievals WHERE kind = ? AND last_at >= ?",
  ),
  saveUsage: db.prepare<
    [string, string, number, number, number, number, number, number, number, number, number, number, string]
  >(`
    INSERT INTO usage (session_key, model, input_tokens, output_tokens, cache_read,
      cache_creation, cost_usd, duration_ms, num_turns, context_window, context_tokens, context_max, effort_asked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  // The most recent run's token breakdown — the raw material for estimating
  // the session's live context size (see latestContextInfo).
  latestContext: db.prepare<[string]>(
    `SELECT input_tokens, cache_creation, cache_read, num_turns, context_window
       FROM usage WHERE session_key = ? ORDER BY id DESC LIMIT 1`,
  ),
};

/**
 * The session to resume for `key`, or undefined to start fresh.
 *
 * `contract` names the world the caller is about to run the agent in. A stored
 * session built under a DIFFERENT world is not returned: continuing it would
 * replay a transcript whose tool calls no longer resolve and whose context no
 * longer exists. Callers that genuinely want the raw id regardless (the
 * transcript locator, discovery) use `storedSessionId`.
 */
export function getSessionId(key: string, contract = ''): string | undefined {
  const row = stmts.getSession.get(key) as { session_id: string; contract: string } | undefined;
  if (!row) return undefined;
  return row.contract === contract ? row.session_id : undefined;
}

/** The stored id whatever contract it was built under — for reading a past
 *  session's traces, never for resuming one. */
export function storedSessionId(key: string): string | undefined {
  return (stmts.getSession.get(key) as { session_id: string } | undefined)?.session_id;
}

export function setSessionId(key: string, sessionId: string, contract = ''): void {
  stmts.setSession.run(key, sessionId, contract);
}

/** Forget a session. A deliberate clear also drops any handoff a rotation
 *  left pending for it — the clear supersedes the rotation, and delivering a
 *  "your predecessor is gone, do not re-onboard" note into a session that is
 *  SUPPOSED to onboard would be the 2026-08-27 review's finding #2 again. */
export function clearSession(key: string): void {
  stmts.clearSession.run(key);
  stmts.dropHandoff.run(key);
  // The frozen prompt belongs to the session; the next session builds its own.
  stmts.dropPrompt.run(key);
}

/**
 * Why the state snapshot is still owed to a frozen prompt's session:
 *   0 — settled: a turn carrying it ENDED ok, so it is in the transcript;
 *   1 — opening: the session has not yet completed a turn with it;
 *   2 — replaced: the SDK answered a resume with a new session id, so the
 *       transcript that exists never saw it;
 *   3 — brief updated: a worker's brief was rewritten on a warm slot after the
 *       block settled (dispatchTask / switchThread), so the transcript holds a
 *       stale brief — re-sent as [BRIEF UPDATED].
 * The debt is settled at the END of a successful turn, never at the session
 * acknowledgement: a first turn that dies after init (overload, Stop, an idle
 * abort, a restart) would otherwise leave a matching row with no debt and no
 * transcript, and every later turn would open a fresh transcript with no state
 * for the rest of the day, silently.
 */
export type SnapshotOwed = 0 | 1 | 2 | 3;

export interface FrozenPrompt {
  contract: string;
  prompt: string;
  snapshotOwed: SnapshotOwed;
}

/** The prompt this session was opened with, if one was frozen. */
export function frozenPrompt(key: string): FrozenPrompt | undefined {
  const row = stmts.getPrompt.get(key) as { contract: string; prompt: string; snapshot_owed: number } | undefined;
  if (!row) return undefined;
  const owed: SnapshotOwed = row.snapshot_owed === 3 ? 3 : row.snapshot_owed === 2 ? 2 : row.snapshot_owed === 1 ? 1 : 0;
  return { contract: row.contract, prompt: row.prompt, snapshotOwed: owed };
}

/** Freeze the prompt for this session under its contract, stating whether the
 *  state snapshot is still owed (a new session: yes; a prompt refreshed under
 *  a live session: no — the transcript already carries the state). */
export function freezePrompt(key: string, contract: string, prompt: string, owed: SnapshotOwed): void {
  stmts.setPrompt.run(key, contract, prompt, owed);
}

/** Forget a frozen prompt without touching the session: the next turn
 *  rebuilds it under the same transcript. Used when the root render moves
 *  under a live session by a writer that does not clear it (src/rootBehavior.ts). */
export function dropFrozenPrompt(key: string): void {
  stmts.dropPrompt.run(key);
}

/** Owe (or settle) the one-time state snapshot for a frozen prompt. */
export function setSnapshotOwed(key: string, owed: SnapshotOwed): void {
  stmts.setSnapshotOwed.run(owed, key);
}

export interface StrandedTurn {
  id: number;
  session_key: string;
  chat_id: number;
  slot: number;
  prompt_head: string;
  started_at: string;
  /** The whole prompt, so a person's unanswered message can be replayed. */
  text: string;
  human: number;
  /** The person's message id, so a replay can move its reaction like a queued turn does. */
  user_msg_id: number | null;
}

/** Mark a turn as running. Returns the row id to hand to endTurn. */
export function beginTurn(key: string, chatId: number, slot: number, text: string, human = false, userMsgId?: number): number {
  const r = stmts.beginTurn.run(key, chatId, slot, text.replace(/\s+/g, ' ').slice(0, 300), text, human ? 1 : 0, userMsgId ?? null, BOOT_ID);
  return Number(r.lastInsertRowid);
}

// --- The durable turn queue (behind turnLock.ts) -----------------------------

export interface QueuedTurnRow {
  id: number;
  session_key: string;
  chat_id: number;
  slot: number;
  text: string;
  visible: number;
  background: number;
  user_msg_id: number | null;
  human: number;
  created_at: string;
}

export function queueTurn(
  key: string,
  chatId: number,
  slot: number,
  turn: { text: string; visible: boolean; background?: boolean; userMsgId?: number; human?: boolean },
): void {
  stmts.queueTurn.run(key, chatId, slot, turn.text, turn.visible ? 1 : 0, turn.background ? 1 : 0, turn.userMsgId ?? null, turn.human ? 1 : 0, BOOT_ID);
}

/** Take the oldest queued turn for a session, deleting it — one reader, one row. */
export function dequeueTurn(key: string): QueuedTurnRow | undefined {
  const row = stmts.oldestQueued.get(key) as QueuedTurnRow | undefined;
  if (row) stmts.deleteQueued.run(row.id);
  return row;
}

export function dropQueuedTurns(key: string): void {
  stmts.dropQueued.run(key);
}

export function queuedTurnCount(key: string): number {
  return Number((stmts.countQueued.get(key) as { n: number }).n);
}

export function allQueuedTurns(): QueuedTurnRow[] {
  return stmts.allQueued.all() as QueuedTurnRow[];
}

export function clearQueuedTurns(): void {
  stmts.clearQueued.run();
}

/** Anything a DEAD process left behind, without taking it. */
export function hasRecoveryRows(): boolean {
  const n = (stmts.countForeign.get(BOOT_ID, BOOT_ID) as { n: number }).n;
  return n > 0;
}

/**
 * Everything the last process left unfinished, taken in ONE transaction so a
 * boot that dies mid-recovery cannot replay the same row twice: the rows are
 * gone before any of them is re-enqueued, and re-enqueueing writes fresh rows.
 * At-most-once by construction; a row lost to a second crash is the price.
 */
export function takeRecoveryRows(): { stranded: StrandedTurn[]; queued: QueuedTurnRow[] } {
  return db.transaction(() => {
    const stranded = stmts.foreignTurns.all(BOOT_ID) as StrandedTurn[];
    const queued = stmts.foreignQueued.all(BOOT_ID) as QueuedTurnRow[];
    stmts.clearForeignTurns.run(BOOT_ID);
    stmts.clearForeignQueued.run(BOOT_ID);
    return { stranded, queued };
  })();
}

// --- The pending handoff (behind rotation.ts) --------------------------------

export interface PendingHandoffRow {
  session_key: string;
  text: string;
  reason: string;
  created_at: string;
}

export function savePendingHandoff(key: string, text: string, reason: string): void {
  stmts.saveHandoff.run(key, text, reason);
}

export function pendingHandoffRow(key: string): PendingHandoffRow | undefined {
  return stmts.getHandoff.get(key) as PendingHandoffRow | undefined;
}

export function dropPendingHandoff(key: string): void {
  stmts.dropHandoff.run(key);
}

/** Clear a turn's in-flight row. Must run on EVERY exit path, or a completed
 *  turn is reported as interrupted at the next boot. */
export function endTurn(id: number): void {
  stmts.endTurn.run(id);
}

/** Turns still marked running — at boot, exactly the ones the last process
 *  did not finish. */
export function strandedTurns(): StrandedTurn[] {
  return stmts.strandedTurns.all() as StrandedTurn[];
}

export function clearStrandedTurns(): void {
  stmts.clearTurns.run();
}

export type MessageSource = 'human' | 'machine';

/**
 * `source` says who a 'user' row came from — set by the caller that knows,
 * never inferred from the text. Optional only for the assistant's own rows and
 * for callers that predate the column.
 */
export function logMessage(key: string, role: 'user' | 'assistant', content: string, source?: MessageSource): void {
  stmts.logMessage.run(key, role, content, source ?? null);
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

/** The same, with ids — so a brief can say WHICH message holds the long text (readMessage). */
export function recentMessagesWithIds(
  key: string,
  limit: number,
): Array<{ id: number; role: string; content: string }> {
  const rows = db
    .prepare('SELECT id, role, content FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?')
    .all(key, limit) as Array<{ id: number; role: string; content: string }>;
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
): Array<{ id: number; session_key: string; role: string; content: string }> {
  const rows = stmts.chatTimeline.all(`${chatId}:%`, limit) as Array<{
    id: number;
    session_key: string;
    role: string;
    content: string;
  }>;
  return rows.reverse();
}

/** Messages in the half-open window (from, to], oldest-first, capped at `limit`. */
export function chatTimelineBetween(
  chatId: number,
  from: string,
  to: string,
  limit: number,
): Array<{ id: number; session_key: string; role: string; content: string }> {
  const rows = stmts.chatTimelineWindow.all(`${chatId}:%`, from, to, limit) as Array<{
    id: number;
    session_key: string;
    role: string;
    content: string;
  }>;
  return rows.reverse();
}

/** How many messages fall in a window (so a capped digest can say what it dropped). */
export function chatTimelineCountBetween(chatId: number, from: string, to: string): number {
  const row = stmts.chatTimelineWindowCount.get(`${chatId}:%`, from, to) as { n: number };
  return row.n;
}

export interface LoggedMessage {
  id: number;
  session_key: string;
  role: string;
  content: string;
  created_at: string;
}

/**
 * Turn a human term into a safe FTS5 MATCH expression: every word becomes a
 * quoted phrase, OR-ed together, so a hit needs only part of the wording and
 * ranking sorts out which hit is best. Quoting is what makes this injection-
 * proof — punctuation ("PR #1234", "src/db.ts:19") would otherwise parse as
 * FTS operators and throw. Returns '' when nothing usable survives.
 */
function ftsQuery(term: string): string {
  const words = term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
    .slice(0, 24);
  return words.map((w) => `"${w}"`).join(' OR ');
}

/**
 * Search the full message log. Ranked full-text hits first (stemmed, any-word),
 * then any exact-substring hits the index missed — the tokenizer splits on
 * punctuation, so a literal "#1234" or "foo.ts:19" still needs LIKE. Deduped by
 * id; each row carries its id so a caller can fetch the whole message.
 */
export function searchChatMessages(chatId: number, term: string, limit = 20): LoggedMessage[] {
  const scope = `${chatId}:%`;
  const out: LoggedMessage[] = [];
  const seen = new Set<number>();

  const match = messagesFts ? ftsQuery(term) : '';
  if (match) {
    try {
      for (const r of stmts.searchMessagesFts.all(match, scope, limit) as LoggedMessage[]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    } catch (err) {
      // A malformed MATCH must not lose the answer — fall through to LIKE.
      console.warn(`[db] FTS search failed for "${term}": ${String(err)}`);
    }
  }

  if (out.length < limit) {
    const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    for (const r of stmts.searchMessages.all(scope, like, limit) as LoggedMessage[]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out.slice(0, limit);
}

/** One logged message by id, in full and untruncated, scoped to its chat. */
export function getMessageById(chatId: number, id: number): LoggedMessage | undefined {
  return stmts.getMessage.get(id, `${chatId}:%`) as LoggedMessage | undefined;
}

/** Current time in the DB's text format (UTC), for window boundaries. */
export function dbNow(): string {
  return (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t;
}

/** A thread's lifecycle status. 'closed' is the legacy pre-round-5 value —
 *  treated like 'archived' (findThread searches it; revive works). */
export type ThreadStatus = 'active' | 'archived' | 'closed';

export interface ChatSession {
  slot: number;
  title: string;
  status: ThreadStatus;
  last_active: string;
}

/** The composite key under which a session's state, prefs, and log are stored. */
export function sessionKey(chatId: number, slot: number): string {
  return `${chatId}:${slot}`;
}

export function listSessions(chatId: number, status: ThreadStatus): ChatSession[] {
  return stmts.listSessions.all(chatId, status) as ChatSession[];
}

export function getSession(chatId: number, slot: number): ChatSession | undefined {
  return stmts.getSessionRow.get(chatId, slot) as ChatSession | undefined;
}

/**
 * Set whether a thread starts each dispatch with no memory of the last one.
 *
 * Enforced at DISPATCH (see dispatch.ts) rather than trusted to whoever set it:
 * a policy that has to be remembered at the moment it matters is the shape that
 * failed here in the first place.
 */
export function setThreadFresh(chatId: number, slot: number, fresh: boolean): void {
  db.prepare('UPDATE chat_sessions SET fresh = ? WHERE chat_id = ? AND slot = ?').run(fresh ? 1 : 0, chatId, slot);
}

/**
 * The model and effort a worker runs at, chosen by the concierge at dispatch
 * (null = the deployment default). Kept on the thread for the same reason
 * `fresh` is: a later turn on this slot must not silently run on a different
 * tier than the one the work was sized for.
 */
export interface ThreadModel {
  model?: string;
  effort?: string;
}

export function setThreadModel(chatId: number, slot: number, m: ThreadModel): void {
  db.prepare('UPDATE chat_sessions SET model = ?, effort = ? WHERE chat_id = ? AND slot = ?').run(
    m.model ?? null,
    m.effort ?? null,
    chatId,
    slot,
  );
}

export function threadModel(chatId: number, slot: number): ThreadModel {
  const r = db.prepare('SELECT model, effort FROM chat_sessions WHERE chat_id = ? AND slot = ?').get(chatId, slot) as
    | { model: string | null; effort: string | null }
    | undefined;
  return { model: r?.model ?? undefined, effort: r?.effort ?? undefined };
}

export function isThreadFresh(chatId: number, slot: number): boolean {
  const r = db.prepare('SELECT fresh FROM chat_sessions WHERE chat_id = ? AND slot = ?').get(chatId, slot) as
    | { fresh: number }
    | undefined;
  return !!r?.fresh;
}

export function countSessions(chatId: number, status: ThreadStatus): number {
  return (stmts.countSessions.get(chatId, status) as { n: number }).n;
}

/** Create a new session slot in a chat and return its number. */
export function createSession(chatId: number, title: string): number {
  const max = (stmts.maxSlot.get(chatId) as { m: number | null }).m;
  const slot = max === null ? 0 : max + 1;
  stmts.insertSession.run(chatId, slot, title);
  return slot;
}

export function setSessionStatus(chatId: number, slot: number, status: ThreadStatus): void {
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

/** A thread's context card: everything a reader needs to place it — title,
 *  brief (its dispatched mission), latest auto-recap, lifecycle, recency. */
export interface ThreadCard {
  slot: number;
  title: string;
  status: ThreadStatus;
  brief?: string;
  /** Auto-maintained latest-state line (set after each worker turn). */
  recap?: string;
  last_active: string;
}

/** Store a thread's brief. Deliberately does NOT touch auto_title — a brief is
 *  task context, not a rename (the SDK summary keeps refreshing the title). */
export function setBrief(chatId: number, slot: number, brief: string): void {
  stmts.setBrief.run(brief, chatId, slot);
  // The brief rides in the worker's one-time session-open block, so a brief
  // rewritten after that block settled must be re-sent: owe it as 3 (brief
  // updated). A debt still open (1/2) already re-reads the current brief.
  stmts.oweBriefUpdate.run(sessionKey(chatId, slot));
}

export function getCard(chatId: number, slot: number): ThreadCard | undefined {
  const row = stmts.getCard.get(chatId, slot) as
    | { slot: number; title: string; status: ThreadStatus; brief: string | null; recap: string | null; last_active: string }
    | undefined;
  return row
    ? { slot: row.slot, title: row.title, status: row.status, brief: row.brief ?? undefined, recap: row.recap ?? undefined, last_active: row.last_active }
    : undefined;
}

/**
 * Search threads across ALL statuses by title/brief/recap, then by message
 * content — the retrieval path behind the bounded attention set: anything not
 * in the concierge's prompt is findable here (and revivable: session ids
 * persist, so a revived thread resumes warm).
 */
export function findThreads(chatId: number, query: string, limit = 10): ThreadCard[] {
  const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const direct = db
    .prepare(
      `SELECT slot, title, status, brief, recap, last_active FROM chat_sessions
       WHERE chat_id = ? AND (title LIKE ? ESCAPE '\\' OR brief LIKE ? ESCAPE '\\' OR recap LIKE ? ESCAPE '\\')
       ORDER BY last_active DESC LIMIT ?`,
    )
    .all(chatId, like, like, like, limit) as Array<{
    slot: number;
    title: string;
    status: ThreadStatus;
    brief: string | null;
    recap: string | null;
    last_active: string;
  }>;
  const seen = new Set(direct.map((r) => r.slot));
  const out: ThreadCard[] = direct.map((r) => ({
    slot: r.slot,
    title: r.title,
    status: r.status,
    brief: r.brief ?? undefined,
    recap: r.recap ?? undefined,
    last_active: r.last_active,
  }));
  if (out.length < limit) {
    const msgKeys = db
      .prepare(
        `SELECT DISTINCT session_key FROM messages
         WHERE session_key LIKE ? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 200`,
      )
      .all(`${chatId}:%`, like) as Array<{ session_key: string }>;
    for (const { session_key } of msgKeys) {
      const slot = Number(session_key.split(':')[1]);
      if (!Number.isFinite(slot) || slot < 0 || seen.has(slot)) continue;
      seen.add(slot);
      const card = getCard(chatId, slot);
      if (card) out.push(card);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Refresh a worker's auto recap (its latest-state one-liner). */
export function setRecap(chatId: number, slot: number, recap: string): void {
  stmts.setRecap.run(recap, chatId, slot);
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

// (shared_memory table stays in the schema, dormant — its content was folded
// into root.md ## Global facts in round 5 and its code paths deleted.)

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
  /** The activity window this dream reflected on (half-open: covers_from..covers_to]. */
  covers_from?: string | null;
  covers_to?: string | null;
}

/** Persist a dream reflection's report + the activity window it covered. */
export function saveDream(
  chatId: number,
  report: string,
  coversFrom?: string,
  coversTo?: string,
): number {
  return Number(stmts.saveDream.run(chatId, report, coversFrom ?? null, coversTo ?? null).lastInsertRowid);
}

/** Where the last dream's window ended (so the next dream starts there), or undefined. */
export function lastDreamCoveredTo(chatId: number): string | undefined {
  const row = stmts.lastDreamCoveredTo.get(chatId) as { t: string } | undefined;
  return row?.t;
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

export interface GrowRecord {
  id: number;
  summary: string;
  /** JSON array of { path, action: 'A'|'M'|'D', before, after }. */
  changes: string;
  created_at: string;
}

/** Record a grow pass (its summary + per-file change-log). Returns its id. */
export function saveGrow(chatId: number, summary: string, changes: string): number {
  return Number(stmts.saveGrow.run(chatId, summary, changes).lastInsertRowid);
}

/** Recent grow passes for a chat, newest-first. */
export function recentGrows(chatId: number, limit = 10): GrowRecord[] {
  return stmts.recentGrows.all(chatId, limit) as GrowRecord[];
}

/** Only 'proposal' is written since round 5 (the operator's one gated output);
 *  the other kinds remain readable on legacy rows. */
export type FindingKind = 'memory-fix' | 'knowledge' | 'behavior' | 'reminder' | 'proposal' | 'idea';

export interface FindingRecord {
  id: number;
  dream_id: number | null;
  kind: FindingKind;
  body: string;
  created_at: string;
  /** The command that PASSES once this has shipped. Null means unfalsifiable —
   *  nothing can tell this row from a stale one but a human reading it. */
  verify: string | null;
  verified_at: string | null;
  /** 'shipped' | 'not-yet' | 'broken: …' — the last run of `verify`. */
  verdict: string | null;
}

/** Every finding, open or closed — the record, where `pendingFindings` is the queue. */
export function allFindings(chatId: number, limit = 200): Array<FindingRecord & { status: string; resolution: string | null }> {
  return db
    .prepare('SELECT * FROM findings WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
    .all(chatId, limit) as Array<FindingRecord & { status: string; resolution: string | null }>;
}

/**
 * WHAT A NIGHT ACTUALLY TOUCHED.
 *
 * Joined on the window rather than stored, because a pass has no id until it
 * ENDS: `saveDream` runs last, so a write made mid-fold cannot carry the id of
 * the dream making it. The window is exact either way — `covers_to` is stamped
 * at the top of `runRewrite` and `created_at` when the report lands, so the
 * interval is precisely the pass.
 */
export function dreamFootprint(coversTo: string | null, createdAt: string): string[] {
  if (!coversTo) return [];
  return (
    db
      .prepare('SELECT DISTINCT entity_id FROM entity_writes WHERE created_at BETWEEN ? AND ? ORDER BY entity_id')
      .all(coversTo, createdAt) as Array<{ entity_id: string }>
  ).map((r) => r.entity_id);
}

/** The change-log entry written by the same pass as this dream (1:1, same stamp). */
export function growAt(chatId: number, createdAt: string): GrowRecord | undefined {
  return db
    .prepare('SELECT * FROM grows WHERE chat_id = ? AND created_at = ? LIMIT 1')
    .get(chatId, createdAt) as GrowRecord | undefined;
}

/** Persist one typed finding from a dream (reflect) pass. */
export function saveDreamFinding(
  chatId: number,
  dreamId: number | null,
  kind: FindingKind,
  body: string,
  verify?: string,
): number {
  const id = Number(stmts.saveFinding.run(chatId, dreamId, kind, body).lastInsertRowid);
  if (verify?.trim()) stmts.setFindingVerify.run(verify.trim(), id);
  return id;
}

/** Attach (or replace) a proposal's check, so a stale row becomes detectable. */
export function setFindingVerify(id: number, verify: string | null): void {
  stmts.setFindingVerify.run(verify?.trim() || null, id);
}

export function recordFindingVerdict(id: number, verdict: string): void {
  stmts.recordFindingVerdict.run(verdict, id);
}

/** Unresolved findings for a chat, oldest-first; optionally one kind only. */
export function pendingFindings(chatId: number, kind?: FindingKind): FindingRecord[] {
  const rows = stmts.pendingFindings.all(chatId) as FindingRecord[];
  return kind ? rows.filter((f) => f.kind === kind) : rows;
}

/** Resolve a finding: applied (act stage), delivered (brief), scheduled (timed
 *  reminder → commitment), or dismissed. */
export function resolveFinding(
  id: number,
  status: 'applied' | 'delivered' | 'scheduled' | 'dismissed',
  resolution?: string,
): void {
  stmts.resolveFinding.run(status, resolution ?? null, id);
}

// --- Awareness events (the blackboard behind the awareness feed) --------------

export interface EventRecord {
  source: string;
  body: string;
  created_at: string;
}

/** Post a one-line awareness event. Free to write — no LLM involved. */
export function postEvent(chatId: number, source: string, body: string): void {
  const line = body.replace(/\s+/g, ' ').trim();
  if (!line) return;
  stmts.postEvent.run(chatId, source.slice(0, 60), line.slice(0, 220));
}

/** Events since a UTC time, oldest-first, capped (the bulletin's tail). */
export function eventsSince(chatId: number, sinceUtc: string, limit: number): EventRecord[] {
  return (stmts.eventsSince.all(chatId, sinceUtc, limit) as EventRecord[]).reverse();
}

// --- Retrieval counters (attention data for the nightly operator) -------------

export type RetrievalKind = 'note' | 'trace' | 'search' | 'message' | 'focus' | 'story';

/** Count one retrieval. Free — no LLM, no UI; the operator reads the totals. */
/** Remember a session the bot created itself, so the harvest never reads the
 *  bot's own output back as Mehdi's work. */
export function recordBotSession(sessionId: string, kind: string): void {
  stmts.recordBotSession.run(sessionId, kind);
}

// --- Background watches (worker CI/deploy waits, re-invoke on exit) -----------

export interface WatchRow {
  id: number;
  chat_id: number;
  slot: number;
  command: string;
  label: string;
}

export function insertWatch(chatId: number, slot: number, command: string, label: string): number {
  return Number(stmts.insertWatch.run(chatId, slot, command, label).lastInsertRowid);
}
export function finishWatch(id: number, exitCode: number, outputTail: string): void {
  stmts.finishWatch.run(exitCode, outputTail, id);
}
export function runningWatches(): WatchRow[] {
  return stmts.runningWatches.all() as WatchRow[];
}
export function countRunningWatches(chatId: number, slot: number): number {
  return (stmts.countRunningWatches.get(chatId, slot) as { n: number }).n;
}

/** Session ids the BOT spawned — excluded from the harvest so the fleet's own
 *  work is never counted as Mehdi's (it already exists as threads). Covers
 *  both worker/concierge sessions and bare query() runs like distillation. */
export function botSessionIds(): Set<string> {
  return new Set((stmts.botSessionIds.all() as Array<{ session_id: string }>).map((r) => r.session_id));
}

export interface EpisodeRow {
  id: number;
  session_id: string;
  seq: number;
  project: string;
  git_branch: string | null;
  started_at: string;
  ended_at: string;
  turns: number;
  user_prompts: number;
  tools: string;
  files: string;
  milestones: string;
  entities: string;
  title: string | null;
  closed: number;
  distillable: number;
  distilled_at: string | null;
  recap: string | null;
}

export function upsertEpisode(e: {
  sessionId: string;
  seq: number;
  project: string;
  cwd: string;
  gitBranch: string | null;
  startedAt: string;
  endedAt: string;
  turns: number;
  userPrompts: number;
  tools: Record<string, number>;
  files: string[];
  milestones: Array<{ at: string; kind: string; detail?: string }>;
  entities: string[];
  title: string | null;
  skeleton: string;
  closed: boolean;
  distillable: boolean;
  foldable: boolean;
  anchor: string | null;
}): void {
  stmts.upsertEpisode.run(
    e.sessionId, e.seq, e.project, e.cwd, e.gitBranch, e.startedAt, e.endedAt,
    e.turns, e.userPrompts, JSON.stringify(e.tools), JSON.stringify(e.files),
    JSON.stringify(e.milestones), JSON.stringify(e.entities),
    e.title, e.skeleton, e.closed ? 1 : 0, e.anchor, e.distillable ? 1 : 0, e.foldable ? 1 : 0,
  );
}

/** Stamp a distilled recap. Only called on success — a failure leaves
 *  distilled_at NULL so the episode stays in the queue for the next pass. */
export function markEpisodeDistilled(id: number, recap: string): void {
  stmts.markEpisodeDistilled.run(recap, id);
}

/** Remove episodes past a re-parse's new tail — upsert alone never deletes. */
export function dropEpisodesFrom(sessionId: string, fromSeq: number): void {
  stmts.dropEpisodesFrom.run(sessionId, fromSeq);
}

export function fileHarvestState(path: string): { mtime: number; size: number } | undefined {
  return stmts.fileHarvestState.get(path) as { mtime: number; size: number } | undefined;
}

export function markFileHarvested(path: string, mtime: number, size: number): void {
  stmts.markFileHarvested.run(path, mtime, size);
}

export function recentEpisodes(limit = 20): EpisodeRow[] {
  return stmts.recentEpisodes.all(limit) as EpisodeRow[];
}

export function episodesByProject(project: string, limit = 20): EpisodeRow[] {
  return stmts.episodesByProject.all(project, limit) as EpisodeRow[];
}

/** Every project name that has harvested episodes, commonest first. Callers
 *  match their own vocabulary against it — a knowledge domain and a project
 *  directory rarely share an exact string. */
export function episodeProjects(): Array<{ project: string; n: number }> {
  return db.prepare('SELECT project, COUNT(*) AS n FROM episodes GROUP BY project ORDER BY n DESC').all() as Array<{
    project: string;
    n: number;
  }>;
}

export function episodeById(id: number): (EpisodeRow & { skeleton: string; cwd: string }) | undefined {
  return stmts.episodeById.get(id) as (EpisodeRow & { skeleton: string; cwd: string }) | undefined;
}

/**
 * The distillation queue — THE ONLY DOOR into step 2, so the exclusions are
 * structural rather than a convention someone has to remember:
 *  - `closed`: a live burst is still changing; distilling it would be stale.
 *  - `distillable`: projects Mehdi keeps out of the tree stay searchable as
 *    traces but are never summarised (config.noDistillProjects).
 *  - `distilled_at IS NULL`: exactly once.
 */
/** Free-text search over what has already been harvested and summarised —
 *  the cheap first rung of the discovery ladder. */
export function searchEpisodeText(
  term: string,
  limit = 12,
): Array<{ id: number; session_id: string; project: string; started_at: string; skeleton: string; recap: string | null }> {
  const like = `%${term.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  return stmts.searchEpisodeText.all(like, like, like, like, limit) as never;
}

/** Summarised local work that ENDED inside a window — the operator's view of
 *  the half of Mehdi's work that never came through the chat. Excludes
 *  no-distill projects and anything not yet summarised. */
export function episodesInWindow(
  from: string,
  to: string,
  limit = 40,
): Array<{
  id: number;
  project: string;
  started_at: string;
  ended_at: string;
  turns: number;
  user_prompts: number;
  recap: string;
  closed: number;
}> {
  return stmts.episodesInWindow.all(from, to, limit) as never;
}

export function episodesInWindowCount(from: string, to: string): number {
  return (stmts.episodesInWindowCount.get(from, to) as { n: number }).n;
}

/** One episode by id, for on-demand distillation. Unlike the queue this
 *  ignores `closed` and `distilled_at` — a live burst can be summarised now,
 *  and a stale summary can be regenerated — but the caller must still respect
 *  `distillable`, which is the privacy boundary, not a scheduling detail. */
export function episodeForDistill(id: number): {
  id: number;
  session_id: string;
  project: string;
  started_at: string;
  ended_at: string;
  turns: number;
  user_prompts: number;
  skeleton: string;
  closed: number;
  distillable: number;
} | undefined {
  return stmts.episodeForDistill.get(id) as never;
}

export function episodesToDistill(limit = 20): Array<{
  id: number;
  session_id: string;
  project: string;
  started_at: string;
  ended_at: string;
  turns: number;
  user_prompts: number;
  skeleton: string;
  /** The previous recap (JSON) when this is a re-summary of a grown burst —
   *  what its loops were last time, so only NEW ones leave the distiller. */
  recap: string | null;
}> {
  return stmts.episodesToDistill.all(limit) as Array<{
    id: number;
    session_id: string;
    project: string;
    started_at: string;
    ended_at: string;
    turns: number;
    user_prompts: number;
    skeleton: string;
    recap: string | null;
  }>;
}

/** Collapse fork duplicates: resuming a session copies its history into a NEW
 *  session id (verified: 909 of 910 message uuids shared between two files),
 *  so the same real work lands once per fork. Message uuids survive the copy,
 *  so the first event's uuid identifies the work; keep the richest lineage. */
export function dedupeEpisodes(): number {
  return stmts.dedupeEpisodes.run().changes;
}

/**
 * Is this anchor already represented by another transcript's row that is at
 * least as complete? Then this copy would only be inserted to be deleted by
 * `dedupeEpisodes` — and until 2026-11-04 that is exactly what happened, every
 * harvest pass, to two forked kube sessions: the fresh copy won the tie
 * (`id DESC`), the distilled twin was deleted, and the winner was summarised
 * again as new work. The decision now happens before the insert (I6).
 */
export function anchorOwnedElsewhere(anchor: string | null, sessionId: string): boolean {
  if (!anchor) return false;
  // Ownership STICKS: the first transcript to hold a segment keeps it, however
  // the other fork grows. A fork copies history, so a shared-anchor segment is
  // the same bytes in both files; letting the bigger copy take over would move
  // the row (and its recap) between files on every append to the live fork.
  return !!stmts.anchorOwner.get(anchor, sessionId);
}

export function episodeStats(): Array<{
  project: string;
  episodes: number;
  turns: number;
  first_seen: string;
  last_seen: string;
}> {
  return stmts.episodeStats.all() as Array<{
    project: string;
    episodes: number;
    turns: number;
    first_seen: string;
    last_seen: string;
  }>;
}

export function bumpRetrieval(kind: RetrievalKind, key: string): void {
  stmts.bumpRetrieval.run(kind, key.slice(0, 120));
}

export interface RetrievalRow {
  kind: RetrievalKind;
  key: string;
  count: number;
  last_at: string | null;
}

/** The hottest retrieval keys across kinds. */
export function topRetrievals(limit = 15): RetrievalRow[] {
  return stmts.topRetrievals.all(limit) as RetrievalRow[];
}

/** How often a retrieval kind has been reached for since `since`. Counts are
 *  cumulative per key, so this is "has this been used lately", not an exact
 *  window total — enough to answer whether a tool is being reached for at all. */
export function retrievalsSince(kind: RetrievalKind, since: string): number {
  return Number((stmts.retrievalSince.get(kind, since) as { n: number }).n);
}

/** Keys ever retrieved for one kind (to find the never-read notes). */
export function retrievedKeys(kind: RetrievalKind): Set<string> {
  return new Set((stmts.retrievedKeys.all(kind) as Array<{ key: string }>).map((r) => r.key));
}

// --- Commitments (the ONE prospective table — round 5) ------------------------

export interface CommitmentRecord {
  id: number;
  chat_id: number;
  label: string;
  body: string;
  /** UTC datetime text. */
  due_at: string;
  recur: 'daily' | 'weekly' | null;
  /** NULL → fires as a concierge turn; set → batched into a [PULSE] check. */
  how_to_check: string | null;
  thread_slot: number | null;
  status: string;
  created_by: string;
  last_fired_at: string | null;
  /** FOCUS TIER: 0 = not in the set; 1 = closest to the user, upward for
   *  quieter bands. How many bands exist is the concierge's call, not the
   *  schema's — it depends on what is actually in the set. */
  focus: number;
  /** Short name the concierge gave this item's band ("your ball", "tracked"). */
  focus_band: string | null;
  /** Deterministic command whose scrubbed output is compared run-to-run. */
  check_cmd: string | null;
  /** Last scrubbed check output (excerpt) — the "before" of the next diff. */
  check_state: string | null;
  /** NULL = wake on change; 'log' = never wake; else a predicate over watch_head. */
  watch_mode: string | null;
  /** The check's own structured state, JSON, overwritten each run (the glance). */
  watch_head: string | null;
  /** Hash of the last scrubbed output. */
  last_seen: string | null;
  last_checked_at: string | null;
  /**
   * THE ENTITY THIS ITEM IS ABOUT — the day's door into the graph (M4).
   *
   * AUTHORED, never matched. Every focus label already reads like an entity
   * name (`ci-robustness-38`, `vacancy-posting-bram-approval`), and the
   * temptation was to resolve them with string matching. Measured on the live
   * set: 1 exact, ~5 real, and the rest garbage — `launchpad-release-candidate-
   * conflict` "matched" `launchpad/system`, a domain fallback wearing a match's
   * clothes. A wrong ref is worse than none, because the day would follow it.
   * Whoever creates the item knows what they meant; a matcher does not (I2).
   *
   * NULL is not a failure either. An item pointing at nothing is the day saying
   * the graph is missing a node — the same discovery signal M1 built for
   * unattributed observation refs, arriving from the other side.
   */
  ref: string | null;
}

export interface CommitmentOpts {
  recur?: 'daily' | 'weekly';
  howToCheck?: string;
  threadSlot?: number;
  createdBy?: string;
  /** Focus tier: omit or 0 to stay out of the set, 1 = closest, upward. */
  focus?: number;
  focusBand?: string;
  checkCmd?: string;
  /** The entity this item is about — authored by the caller, never matched. */
  ref?: string;
}

/** Record a commitment. dueAtUtc is DB-format UTC ('YYYY-MM-DD HH:MM:SS'). */
export function addCommitment(
  chatId: number,
  label: string,
  body: string,
  dueAtUtc: string,
  opts: CommitmentOpts = {},
): number {
  return Number(
    stmts.addCommitment.run(
      chatId,
      label,
      body,
      dueAtUtc,
      opts.recur ?? null,
      opts.howToCheck ?? null,
      opts.threadSlot ?? null,
      opts.createdBy ?? 'bot',
      Math.max(0, Math.round(opts.focus ?? 0)),
      opts.focusBand?.slice(0, 40) ?? null,
      opts.checkCmd ?? null,
      opts.ref ?? null,
    ).lastInsertRowid,
  );
}

/** Point a focus item at an entity, or clear it. Returns whether it changed. */
export function setCommitmentRef(id: number, chatId: number, ref: string | null): boolean {
  return stmts.setCommitmentRef.run(ref, id, chatId).changes > 0;
}

/** Open commitments for a chat, soonest-due first. */
export function listCommitments(chatId: number): CommitmentRecord[] {
  return stmts.listCommitments.all(chatId) as CommitmentRecord[];
}

/** Every open commitment due now, across all chats (the poller's input). */
export function dueCommitments(): CommitmentRecord[] {
  return stmts.dueCommitments.all() as CommitmentRecord[];
}

/** The most recent commitment with a label, ANY status — "was this ever seeded?". */
export function getAnyCommitmentByLabel(chatId: number, label: string): CommitmentRecord | undefined {
  return stmts.anyCommitmentByLabel.get(chatId, label) as CommitmentRecord | undefined;
}

/** Mark a FIRE-mode commitment fired: recurring ones advance past now, one-offs
 *  finish. (Pulse-mode entries are deferred instead — see deferCommitment.) */
export function markCommitmentFired(c: CommitmentRecord): void {
  if (c.recur) stmts.advanceCommitment.run(c.id);
  else stmts.finishCommitment.run(c.id);
}

/** Push a commitment's due time out. Returns whether anything changed. */
export function deferCommitment(id: number, chatId: number, dueAtUtc: string): boolean {
  return stmts.deferCommitment.run(dueAtUtc, id, chatId).changes > 0;
}

/** Close a commitment (done or dropped). Returns whether anything changed. */
export function resolveCommitment(
  id: number,
  chatId: number,
  status: 'done' | 'dropped',
  resolution?: string,
): boolean {
  return stmts.resolveCommitment.run(status, resolution ?? null, id, chatId).changes > 0;
}

/**
 * Narrow or correct an OPEN commitment in place: its how-to-check, its body, or
 * both (undefined leaves a field alone). The point is that a watch survives its
 * own progress — when half of what it watched lands, the entry should re-scope
 * to what's left rather than stay stale or be dropped and rebuilt.
 */
export function rescopeCommitment(
  id: number,
  chatId: number,
  fields: { howToCheck?: string; body?: string; checkCmd?: string },
): boolean {
  if (fields.howToCheck === undefined && fields.body === undefined && fields.checkCmd === undefined) return false;
  const cmd = fields.checkCmd ?? null;
  return (
    stmts.rescopeCommitment.run(fields.howToCheck ?? null, fields.body ?? null, cmd, cmd, cmd, id, chatId).changes > 0
  );
}

// --- Focus (round 7) --------------------------------------------------------

/** Open FOCUS items for a chat, closest band first. */
export function focusItems(chatId: number): CommitmentRecord[] {
  return stmts.focusItems.all(chatId) as CommitmentRecord[];
}

/**
 * Group the set into the bands it actually has. The number of bands is data,
 * not a constant: a set of three all on the user's plate renders as one band,
 * the same code renders four when the set has spread out. Each band's title is
 * the first name the concierge gave any item in it.
 */
// --- Entities (round 8) -----------------------------------------------------

export interface EntityStateRow {
  id: string;
  state: string | null;
  state_at: string | null;
  status: string;
  last_seen: string | null;
  probed_at: string | null;
}

/** The prober's record of what an entity's state actually was, last time a
 *  command answered the question. The authority; the file is a rendering. */
export function entityState(id: string): EntityStateRow | undefined {
  return db.prepare('SELECT id, state, state_at, status, last_seen, probed_at FROM entity_state WHERE id = ?').get(id) as
    | EntityStateRow
    | undefined;
}

export function allEntityState(): Map<string, EntityStateRow> {
  const rows = db.prepare('SELECT id, state, state_at, status, last_seen, probed_at FROM entity_state').all() as EntityStateRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Write a probe result. THE ONLY path that may set an entity's state. */
export function recordEntityProbe(id: string, state: string, hash: string, status: string): void {
  db.prepare(
    `INSERT INTO entity_state (id, state, state_at, status, last_seen, probed_at)
     VALUES (?, ?, datetime('now'), ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state, state_at = excluded.state_at,
       status = excluded.status, last_seen = excluded.last_seen, probed_at = excluded.probed_at`,
  ).run(id, state, status, hash);
}

/** Mark a probe as run without changing what it saw (the unchanged path). */
export function touchEntityProbe(id: string): void {
  db.prepare("UPDATE entity_state SET probed_at = datetime('now') WHERE id = ?").run(id);
}

/** Queue a state change. Returns how many this entity has had in 24h, so the
 *  caller can absorb a flapping probe instead of letting it pump turns. */
export function addEntityChange(entityId: string, before: string, after: string, statusFlip: boolean): number {
  db.prepare('INSERT INTO entity_changes (entity_id, before, after, status_flip) VALUES (?, ?, ?, ?)').run(
    entityId,
    before,
    after,
    statusFlip ? 1 : 0,
  );
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM entity_changes WHERE entity_id = ? AND created_at >= datetime('now', '-1 day')")
    .get(entityId) as { n: number };
  return row.n;
}

export interface EntityChangeRow {
  id: number;
  entity_id: string;
  before: string | null;
  after: string | null;
  status_flip: number;
  created_at: string;
}

/** Unconsumed state changes across the graph — what a pulse should carry. */
export function openEntityChanges(): EntityChangeRow[] {
  return db
    .prepare(
      'SELECT id, entity_id, before, after, status_flip, created_at FROM entity_changes WHERE consumed_at IS NULL ORDER BY status_flip DESC, id',
    )
    .all() as EntityChangeRow[];
}

export function consumeEntityChanges(ids: number[]): void {
  if (!ids.length) return;
  const stmt = db.prepare("UPDATE entity_changes SET consumed_at = datetime('now') WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

// --- The write journal + fact provenance (round 10) ------------------------

export type WriteOp = 'correct-fact' | 'add-fact' | 'drop-fact' | 'observe' | 'note' | 'goal' | 'dormant' | 'correct-chain' | 'edge' | 'drop-edge' | 'mint' | 'move' | 'retire';

/**
 * Carry an entity's SIDECAR rows to a new id. Called only by a `move` write,
 * after the files are on disk and lint clean.
 *
 * `entities` and `entity_edges` are derived — the next parse rebuilds them from
 * the files and needs nothing here. These are not: the prober's state clock, the
 * confirmation clock, and the escalation queue are all keyed by id and would
 * silently detach from a moved entity, which reads as "never probed, never
 * confirmed" rather than as a bug. A stale row already sitting on the
 * destination id is dropped first — it belongs to nothing.
 *
 * THE PENDING INBOX GOES TOO, and that one is not obvious. M1's whole design is
 * that an observation's refs are RESOLVED at the moment of seeing, so the night
 * folds a compare instead of an inference. A move invalidates exactly that: the
 * first `move` this system ever ran (2026-08-05,
 * `affiliate-app/northwind-payment-method-2297` → core-api) left observation #12
 * pointing at an id that no longer existed. #12 was already folded so it cost
 * nothing, but a PENDING row rewritten this way is a row the night will fail to
 * place — and "resolved to nothing" is the signal reserved for a node the graph
 * is MISSING (I5), so a stale ref does not just get dropped, it lies.
 *
 * Folded rows are deliberately left alone: like `entity_writes.before`, they are
 * history, and history records the id that was true when it was written.
 */
export function carryEntityKeys(from: string, to: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM entity_state WHERE id = ?').run(to);
    db.prepare('UPDATE entity_state SET id = ? WHERE id = ?').run(to, from);
    db.prepare('DELETE FROM fact_seen WHERE entity_id = ?').run(to);
    db.prepare('UPDATE fact_seen SET entity_id = ? WHERE entity_id = ?').run(to, from);
    db.prepare('UPDATE entity_changes SET entity_id = ? WHERE entity_id = ?').run(to, from);
    for (const row of db
      .prepare('SELECT id, refs FROM observations WHERE folded_at IS NULL AND refs LIKE ?')
      .all(`%"${from}"%`) as Array<{ id: number; refs: string }>) {
      const refs = (JSON.parse(row.refs) as string[]).map((r) => (r === from ? to : r));
      db.prepare('UPDATE observations SET refs = ? WHERE id = ?').run(JSON.stringify([...new Set(refs)]), row.id);
    }
  })();
}

export interface EntityWriteRow {
  id: number;
  entity_id: string;
  op: WriteOp;
  before: string | null;
  after: string | null;
  reason: string;
  actor: string;
  created_at: string;
  reverted_at: string | null;
}

/** Journal one applied change. Called by `record()` AFTER the write has been
 *  validated and persisted — a row here means it is on disk. */
export function journalEntityWrite(w: {
  entityId: string;
  op: WriteOp;
  before?: string;
  after?: string;
  reason: string;
  actor: string;
  /** The attempt this belonged to, when one was open. */
  runId?: number;
}): number {
  const r = db
    .prepare('INSERT INTO entity_writes (entity_id, op, before, after, reason, actor, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(w.entityId, w.op, w.before ?? null, w.after ?? null, w.reason, w.actor, w.runId ?? null);
  return Number(r.lastInsertRowid);
}

/** Recent writes — the diff a human reads to audit a night. */
export function recentEntityWrites(limit = 50, sinceHours?: number): EntityWriteRow[] {
  const where = sinceHours ? `WHERE created_at >= datetime('now', '-${Math.floor(sinceHours)} hours')` : '';
  return db
    .prepare(`SELECT * FROM entity_writes ${where} ORDER BY id DESC LIMIT ?`)
    .all(limit) as EntityWriteRow[];
}

export function entityWrites(entityId: string, limit = 20): EntityWriteRow[] {
  return db
    .prepare('SELECT * FROM entity_writes WHERE entity_id = ? ORDER BY id DESC LIMIT ?')
    .all(entityId, limit) as EntityWriteRow[];
}

export function markWriteReverted(id: number): void {
  db.prepare("UPDATE entity_writes SET reverted_at = datetime('now') WHERE id = ?").run(id);
}

/**
 * Stamp the facts an entity currently has, and retire the rows for facts it no
 * longer carries. Called on every index rebuild, so provenance tracks the files
 * without anyone having to remember to maintain it.
 *
 * A fact appearing for the first time gets `since = now`. That is a lie for the
 * facts already in the tree when this shipped — they are older than their row
 * says — and it is the honest kind of lie: the alternative is inventing a date,
 * and "first seen by the system at" is exactly what the column means.
 */
export function syncFactProvenance(entityId: string, shas: string[]): void {
  const ins = db.prepare('INSERT OR IGNORE INTO fact_seen (entity_id, fact_sha) VALUES (?, ?)');
  for (const s of shas) ins.run(entityId, s);
  if (shas.length) {
    const holes = shas.map(() => '?').join(',');
    db.prepare(`DELETE FROM fact_seen WHERE entity_id = ? AND fact_sha NOT IN (${holes})`).run(entityId, ...shas);
  } else {
    db.prepare('DELETE FROM fact_seen WHERE entity_id = ?').run(entityId);
  }
}

/** A night read this fact against real material and let it stand. */
export function confirmFact(entityId: string, sha: string): void {
  db.prepare("UPDATE fact_seen SET confirmed_at = datetime('now') WHERE entity_id = ? AND fact_sha = ?").run(entityId, sha);
}

export interface FactSeenRow {
  entity_id: string;
  fact_sha: string;
  since: string;
  confirmed_at: string | null;
}

export function factProvenance(entityId: string): Map<string, FactSeenRow> {
  const rows = db.prepare('SELECT * FROM fact_seen WHERE entity_id = ?').all(entityId) as FactSeenRow[];
  return new Map(rows.map((r) => [r.fact_sha, r]));
}

/** Facts nothing has confirmed in `days` — the age-based review queue. Ordered
 *  oldest first, because the point is to ask about one per night, not all. */
export function staleFacts(days: number, limit = 20): FactSeenRow[] {
  return db
    .prepare(
      `SELECT * FROM fact_seen
       WHERE COALESCE(confirmed_at, since) <= datetime('now', '-${Math.floor(days)} days')
       ORDER BY COALESCE(confirmed_at, since) LIMIT ?`,
    )
    .all(limit) as FactSeenRow[];
}

// --- Friction ledger (round 9) ---------------------------------------------

// 'mid-thread-reset': the concierge's context was rotated within minutes of a
// human message (only the context CEILING can do that — the idle rule cannot),
// so the person mid-sentence met a session that had never heard them. Filed as
// friction so the night sees it; the count in cycleCli must be zero.
export type FrictionKind = 'error' | 'empty' | 'slow' | 'unknown_fn' | 'bypass' | 'missing_concept' | 'mid-thread-reset';

export type CheckOutcome = 'unanswered' | 'failed';

/**
 * Record that a check could not answer. Never that it could — see the table.
 *
 * Deduped per ref per day, so the row's `hits` is the honest measure of how
 * broken a checker is: 96 means it has not worked once since midnight.
 */
export function noteCheckMiss(kind: 'probe' | 'focus', ref: string, outcome: CheckOutcome, detail: string): void {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO check_misses (kind, ref, outcome, detail, day) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, ref, outcome, day)
       DO UPDATE SET hits = hits + 1, last_at = datetime('now'), detail = excluded.detail`,
  ).run(kind, ref, outcome, detail.slice(0, 200), day);
}

/** The most recent rot reading, or undefined on the very first run. */
export function lastRot(ruleset: string): number | undefined {
  // Only a reading from the SAME rules is comparable. A mismatch returns
  // undefined — "no previous count" — which is the honest answer and reads as
  // a fresh baseline rather than as movement that never happened.
  const row = db.prepare('SELECT rot, ruleset FROM graph_rot ORDER BY id DESC LIMIT 1').get() as
    | { rot: number; ruleset: string }
    | undefined;
  return row && row.ruleset === ruleset ? row.rot : undefined;
}

/** Record one reading. Called by the audit, which is the only thing that lints. */
export function recordRot(
  rot: number,
  birth: number,
  entities: number,
  byCode: Record<string, number>,
  ruleset: string,
): void {
  db.prepare('INSERT INTO graph_rot (rot, birth, entities, by_code, ruleset) VALUES (?, ?, ?, ?, ?)').run(
    rot,
    birth,
    entities,
    JSON.stringify(byCode),
    ruleset,
  );
}

/** The series, newest first — for asking whether the ratchet is holding. */
export function rotHistory(limit = 30): Array<{ rot: number; birth: number; entities: number; at: string }> {
  return db
    .prepare('SELECT rot, birth, entities, at FROM graph_rot ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<{ rot: number; birth: number; entities: number; at: string }>;
}

// EVERY PROCESS WITH A DATABASE PUBLISHES ITS PULSES, automatically.
//
// Registered here rather than in each entry point because the failure is
// silent: a CLI that forgets to wire this still works, still writes the graph,
// and simply never appears on the Atlas — which is exactly the bug this whole
// mechanism exists to fix, reintroduced one command at a time. `pulse.ts`
// imports nothing but node:events, so this direction cannot cycle.
setPulseSink(publishPulse);

/** Record a pulse for other processes to pick up. Never throws — an observation
 *  hook in a hot path must not be able to take down what it observes (I11). */
export function publishPulse(pid: number, at: string, body: string): void {
  try {
    db.prepare('INSERT INTO pulses (pid, at, body) VALUES (?, ?, ?)').run(pid, at, body);
    // Trim on the way in rather than on a timer: no extra loop, and the table
    // cannot grow while nobody is reading.
    if (Math.random() < 0.02) db.prepare('DELETE FROM pulses WHERE id < (SELECT MAX(id) - 500 FROM pulses)').run();
  } catch {
    /* a pulse that cannot be recorded is still a pulse that was emitted */
  }
}

/** Pulses from OTHER processes since an id. The bot polls this and re-emits. */
export function foreignPulses(sinceId: number, pid: number): Array<{ id: number; body: string }> {
  return db
    .prepare('SELECT id, body FROM pulses WHERE id > ? AND pid != ? ORDER BY id LIMIT 200')
    .all(sinceId, pid) as Array<{ id: number; body: string }>;
}

export function latestPulseId(): number {
  return ((db.prepare('SELECT MAX(id) AS n FROM pulses').get() as { n: number | null }).n ?? 0);
}

/** Cheap counts for the vital-signs read. Each is one indexed query — if a
 *  sign here ever needs a scan, it does not belong in vitals. */
export function countMessagesSince(iso: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?').get(iso) as { n: number }).n;
}

export function focusOpenCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM commitments WHERE focus > 0 AND status = 'open'").get() as { n: number }).n;
}

/**
 * Is the concierge carrying a session, and since when?
 *
 * NOT the turn count — that lives in an in-memory Map in `sessions.ts` and a
 * CLI cannot see it. This is the honest cheap answer to the question an
 * operator actually has: would a /reset do anything, or is it already fresh?
 * The transcript itself belongs to the agent runtime, not to this database.
 */
export function conciergeSession(chatId: number): { since: string } | null {
  const r = db.prepare('SELECT updated_at FROM sessions WHERE session_key = ?').get(`${chatId}:-1`) as
    | { updated_at: string }
    | undefined;
  return r ? { since: r.updated_at } : null;
}

export function dreamVitals(): { count: number; last: string | null } {
  const r = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM dreams').get() as { n: number; last: string | null };
  return { count: r.n, last: r.last };
}

export interface GraphRunRow {
  id: number;
  kind: string;
  trigger: string;
  prompt: string;
  codes: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
}

export function beginGraphRun(kind: string, trigger: string, prompt: string, codes: string[], actor: string): number {
  return Number(
    db.prepare('INSERT INTO graph_runs (kind, trigger, prompt, codes, actor) VALUES (?, ?, ?, ?, ?)')
      .run(kind, trigger, prompt, JSON.stringify(codes), actor).lastInsertRowid,
  );
}

/**
 * The open run — but only for the actor it belongs to.
 *
 * A caller that does not name itself gets nothing, which is the safe default:
 * an unattributed call is better than one attributed to the wrong attempt.
 */
export function openRunId(actor?: string): number | undefined {
  const r = db
    .prepare('SELECT r.id AS id, r.actor AS actor FROM open_run o JOIN graph_runs r ON r.id = o.run_id WHERE o.id = 1')
    .get() as { id: number; actor: string } | undefined;
  if (!r) return undefined;
  // An empty actor is a pre-2026-08-07 run; treat it as unowned rather than as
  // owned-by-everyone.
  if (!r.actor) return undefined;
  return actor === r.actor ? r.id : undefined;
}

/** The open run regardless of owner — for status displays and for refusing to
 *  nest, both of which need to know one exists even if it is not theirs. */
export function anyOpenRun(): { id: number; actor: string } | undefined {
  return db
    .prepare('SELECT r.id AS id, r.actor AS actor FROM open_run o JOIN graph_runs r ON r.id = o.run_id WHERE o.id = 1')
    .get() as { id: number; actor: string } | undefined;
}

export function setOpenRun(runId: number | null): void {
  if (runId === null) db.prepare('DELETE FROM open_run WHERE id = 1').run();
  else db.prepare('INSERT OR REPLACE INTO open_run (id, run_id) VALUES (1, ?)').run(runId);
}

export function endGraphRun(id: number, outcome: string): void {
  db.prepare("UPDATE graph_runs SET ended_at = datetime('now'), outcome = ? WHERE id = ?").run(outcome, id);
}

export function recentGraphRuns(limit = 20): GraphRunRow[] {
  return db.prepare('SELECT * FROM graph_runs ORDER BY id DESC LIMIT ?').all(limit) as GraphRunRow[];
}

/** What one run actually wrote — the evidence its prompt is judged on. */
export function runWrites(runId: number): Array<{ id: number; op: string; entity_id: string; reason: string; reverted_at: string | null }> {
  return db
    .prepare('SELECT id, op, entity_id, reason, reverted_at FROM entity_writes WHERE run_id = ? ORDER BY id')
    .all(runId) as Array<{ id: number; op: string; entity_id: string; reason: string; reverted_at: string | null }>;
}

/** Every entity a run READ, from its module calls. Half of a run's footprint:
 *  an agent that read six nodes to change one reached for all seven. */
export function runReads(runId: number): string[] {
  const rows = db.prepare('SELECT refs FROM module_calls WHERE run_id = ?').all(runId) as Array<{ refs: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    try {
      for (const id of JSON.parse(r.refs) as string[]) out.add(id);
    } catch {
      /* a malformed refs blob is not worth failing a read for */
    }
  }
  return [...out];
}

/** The full journal rows for a run — what a revert needs (before/after values). */
export function runWriteRows(runId: number): EntityWriteRow[] {
  return db.prepare('SELECT * FROM entity_writes WHERE run_id = ? ORDER BY id').all(runId) as EntityWriteRow[];
}

export interface DebugRow {
  reason: string;
  since: string;
  snapshot: string;
  baselineWriteId: number;
}

/** The open debug session, or undefined when the bot is live. */
export function debugSession(): DebugRow | undefined {
  const r = db.prepare('SELECT reason, since, snapshot, baseline_write_id FROM debug_session WHERE id = 1').get() as
    | { reason: string; since: string; snapshot: string; baseline_write_id: number }
    | undefined;
  return r ? { reason: r.reason, since: r.since, snapshot: r.snapshot, baselineWriteId: r.baseline_write_id } : undefined;
}

export function openDebugSession(d: DebugRow): void {
  db.prepare(
    'INSERT OR REPLACE INTO debug_session (id, reason, since, snapshot, baseline_write_id) VALUES (1, ?, ?, ?, ?)',
  ).run(d.reason, d.since, d.snapshot, d.baselineWriteId);
}

export function clearDebugSession(): void {
  db.prepare('DELETE FROM debug_session WHERE id = 1').run();
}

export interface ProposalRow {
  id: number;
  run_id: number;
  summary: string;
  steps: string;
  status: 'open' | 'applied' | 'discarded';
  created_at: string;
  decided_at: string | null;
  applied_run_id: number | null;
}

export function addProposal(runId: number, summary: string, steps: string[]): number {
  return Number(
    db.prepare('INSERT INTO proposals (run_id, summary, steps) VALUES (?, ?, ?)').run(runId, summary, JSON.stringify(steps))
      .lastInsertRowid,
  );
}

/** Proposals nobody has decided on yet, newest first. */
export function openProposals(): ProposalRow[] {
  return db.prepare("SELECT * FROM proposals WHERE status = 'open' ORDER BY id DESC").all() as ProposalRow[];
}

export function getProposal(id: number): ProposalRow | undefined {
  return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
}

/**
 * Decide a proposal.
 *
 * Guarded on it still being open, and the guard is the point: the Atlas polls,
 * so two clicks on a stale panel — or a second tab — must not apply the same
 * plan twice. Returns whether THIS call was the one that decided it.
 */
export function decideProposal(id: number, status: 'applied' | 'discarded', appliedRunId?: number): boolean {
  return (
    db
      .prepare("UPDATE proposals SET status = ?, decided_at = datetime('now'), applied_run_id = ? WHERE id = ? AND status = 'open'")
      .run(status, appliedRunId ?? null, id).changes > 0
  );
}

/**
 * Put a claimed proposal back on the table.
 *
 * The claim is taken BEFORE the applying turn starts, so a double click cannot
 * run the same plan twice. That means a turn which never starts — the machine
 * was taken, a run was stuck — would leave the plan marked as carried out when
 * nothing was. A proposal recorded as applied that was not is the one state
 * this table must never hold: it is a record of consent, and it would say the
 * operator approved something that never happened.
 */
/** Record WHICH run carried out an approved plan, once it has one. The claim
 *  is taken before the turn exists, so the link can only be made afterwards —
 *  and without it the table says a plan was applied but not by what, which is
 *  half an audit trail. */
export function setProposalRun(id: number, runId: number): void {
  db.prepare('UPDATE proposals SET applied_run_id = ? WHERE id = ?').run(runId, id);
}

export function reopenProposal(id: number): void {
  db.prepare("UPDATE proposals SET status = 'open', decided_at = NULL, applied_run_id = NULL WHERE id = ?").run(id);
}

/** Every proposal a run made — so a ledger row can show what it offered. */
export function runProposals(runId: number): ProposalRow[] {
  return db.prepare('SELECT * FROM proposals WHERE run_id = ? ORDER BY id').all(runId) as ProposalRow[];
}

export interface DreamPhaseRow {
  scope: string;
  since: string;
  pid: number;
  /** Last proof of life from the running pass; falls back to `since`. */
  beat: string;
}

/**
 * How long a pass may hold the machine before the hold is treated as debris.
 *
 * A nightly is minutes. This is set far above that and still far below "a
 * person notices the bot has been mute all day", because the two failures are
 * not symmetric: a stale hold blocks EVERYTHING — turns, sweeps, the next
 * night — and it blocks the operator's own way out too. A rare double-fold is
 * recoverable; a machine that cannot be woken is the shape I8 exists to forbid.
 */
/**
 * How long a pass may go silent before the vitals SAY SO. Not a expiry.
 *
 * This was 45 minutes measured from the pass's START, on the reasoning that a
 * nightly is minutes. Three consecutive real nights say otherwise: dreams #71,
 * #72 and #73 spanned 5.0h, 5.9h and 3.8h between the window stamp and the
 * report landing — a laptop that sleeps mid-fold advances the wall clock
 * without advancing the pass. So EVERY night, about 45 minutes in, the hold was
 * discarded as debris while the fold was still writing, and the machine went
 * back to reporting `live` for the next four hours. The dreaming guarantee —
 * the thing I11 is built on — was void nightly and nothing said so.
 *
 * Raising the number would trade one wrong answer for another: a genuinely
 * dead pass would then wedge the day shut for hours. The fix is that liveness
 * must be PROVEN rather than assumed from a start time. A running pass touches
 * `beat` every couple of seconds, so silence means dead and the threshold can
 * be short — which is strictly better in both directions than any timeout
 * measured from the beginning.
 */
const DREAM_SILENCE_MS = 5 * 60_000;

/**
 * The final backstop: no pass is real after this, whatever its pid says.
 *
 * Kept because I8 requires a hold to be escapable WITHOUT a person, and pid
 * liveness alone loses that: a wedged pass inside a healthy process would hold
 * the day until someone noticed. Measured from the START rather than the last
 * beat, and set far beyond any plausible sleep — a fold that has been open
 * half a day is broken no matter what the process thinks.
 */
const DREAM_HARD_MAX_MS = 12 * 60 * 60_000;

/**
 * The phase, with debris filtered out.
 *
 * Staleness is checked on the READ and not only on the claim, which is the
 * lesson of 2026-08-08: the claim path had the check and the read path did not,
 * so a hold nobody could clear would still have reported DREAMING to every
 * caller forever. A guard that only runs when someone tries to take the lock
 * does not help the callers who are merely asking whether they may act.
 *
 * The pid is a weak signal here and is deliberately not trusted alone: the
 * holder is usually the bot itself, so after a restart the recorded pid is
 * alive by construction, and pids are reused. Age is the signal that does not
 * lie about a pass that ended without saying so.
 */
export function dreamPhase(): DreamPhaseRow | undefined {
  const r = db.prepare('SELECT scope, since, pid, beat FROM dream_phase WHERE id = 1').get() as DreamPhaseRow | undefined;
  if (!r) return undefined;
  // LIVENESS IS THE PROCESS, NOT THE CLOCK.
  //
  // The heartbeat shipped this morning was still a wall-clock rule and so was
  // still wrong for the case that actually happens every night: the laptop
  // SLEEPS mid-fold. A suspended process emits no beats, so on wake the hold
  // looked hours-silent and was discarded — while the pass was alive and about
  // to resume. Same failure as the 45-minute timeout it replaced, at a
  // different threshold, and no threshold fixes it because a sleep can be any
  // length.
  //
  // So the question is not "how long since it spoke" but "is the thing that
  // claimed this still there". A live pid is trusted outright; a dead one is
  // cleared instantly, which is also far faster than any timeout was. The two
  // escape hatches that make this I8-safe already exist and are unaffected:
  // `modeCli clear-dream` for debris and `cancel-dream` for a pass in the way.
  const age = Date.now() - Date.parse(r.since);
  if (Number.isFinite(age) && age > DREAM_HARD_MAX_MS) {
    console.warn(`[mode] clearing a ${r.scope} hold ${Math.round(age / 3_600_000)}h old — past any plausible pass, whatever its process reports`);
    db.prepare('DELETE FROM dream_phase WHERE id = 1').run();
    return undefined;
  }
  let alive = true;
  try {
    process.kill(r.pid, 0);
  } catch {
    alive = false;
  }
  if (!alive) {
    console.warn(`[mode] clearing a ${r.scope} hold whose process (pid ${r.pid}) is gone — the pass died without releasing it`);
    db.prepare('DELETE FROM dream_phase WHERE id = 1').run();
    return undefined;
  }
  // `beat` stays, as the observable answer to "when did it last do anything" —
  // useful in the vitals, never a reason to discard the hold.
  const silence = Date.now() - Date.parse(r.beat || r.since);
  if (Number.isFinite(silence) && silence > DREAM_SILENCE_MS) {
    console.warn(`[mode] ${r.scope} pass (pid ${r.pid}) has been silent ${Math.round(silence / 60000)}m but is alive — holding. Machine asleep, or the pass is stuck; clear-dream if you need it back.`);
  }
  return r;
}

/**
 * "I am still folding." Called by the running pass every couple of seconds.
 *
 * Cheap on purpose — one indexed UPDATE of one row — because the alternative
 * to a heartbeat is a timeout, and a timeout is wrong in one direction or the
 * other for every pass that is not average.
 */
export function beatDreamPhase(): void {
  db.prepare('UPDATE dream_phase SET beat = ? WHERE id = 1').run(new Date().toISOString());
}

/**
 * Drop any hold left behind by a previous process.
 *
 * Called at boot. A rewrite pass cannot survive the process that ran it — the
 * SDK query, the digest and the whole in-memory pass die with it — so a hold
 * present at startup is by definition debris, and leaving it would greet the
 * day with a bot that refuses to answer and cannot be told to.
 */
export function clearStaleDreamPhase(): void {
  const r = db.prepare('SELECT scope, since, pid, beat FROM dream_phase WHERE id = 1').get() as DreamPhaseRow | undefined;
  if (!r) return;
  if (r.pid === process.pid) return;
  console.warn(`[mode] boot: clearing a ${r.scope} hold from pid ${r.pid} (since ${r.since}) — a pass does not survive a restart`);
  db.prepare('DELETE FROM dream_phase WHERE id = 1').run();
}

/**
 * Claim the dream phase, or report who holds it.
 *
 * One statement, so two processes racing cannot both believe they won: the
 * primary-key conflict is the arbitration. A holder whose pid is gone is
 * cleared first — a pass killed with ^C would otherwise wedge the night shut
 * until someone found this table, and a lock you cannot recover from is the
 * shape Charter I8 exists to forbid.
 */
export function claimDreamPhase(scope: string, since: string): { ok: true } | { ok: false; held: DreamPhaseRow } {
  const held = dreamPhase();
  if (held) {
    let alive = true;
    try {
      process.kill(held.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) return { ok: false, held };
    db.prepare('DELETE FROM dream_phase WHERE id = 1').run();
  }
  try {
    db.prepare('INSERT INTO dream_phase (id, scope, since, pid, beat) VALUES (1, ?, ?, ?, ?)').run(scope, since, process.pid, since);
    return { ok: true };
  } catch {
    return { ok: false, held: dreamPhase() ?? { scope, since, pid: 0, beat: since } };
  }
}

export function releaseDreamPhase(): void {
  db.prepare('DELETE FROM dream_phase WHERE id = 1').run();
}

/**
 * ASK THE RUNNING PASS TO STOP.
 *
 * A flag and not a signal, because the operator's cancel button is not
 * necessarily in the process doing the dreaming: the scheduled pass runs inside
 * the bot, an induced one runs from a CLI, and the Atlas that offers the button
 * may be either. The holder polls this and does its own unwinding — which is
 * the only place that CAN unwind it, since the snapshot to restore from is held
 * by whoever took it.
 *
 * Written onto the phase row, so it dies with the phase. A cancel that outlived
 * its pass would abort the NEXT one, minutes later, for a reason nobody could
 * see.
 */
export function requestDreamCancel(reason: string): boolean {
  if (!dreamPhase()) return false;
  db.prepare('UPDATE dream_phase SET cancel_requested = ? WHERE id = 1').run(reason || 'cancelled by the operator');
  return true;
}

/** The reason a cancel was asked for, if one was. Polled by the running pass. */
export function dreamCancelRequested(): string | undefined {
  const r = db.prepare('SELECT cancel_requested AS c FROM dream_phase WHERE id = 1').get() as { c: string | null } | undefined;
  return r?.c ?? undefined;
}

export interface RetrievalEpisode {
  id: number;
  session_key: string;
  actor: string;
  trigger: string;
  started_at: string;
  ended_at: string | null;
  path: string;
  steps: number;
  bypasses: number;
  ms: number;
  outcome: 'answered' | 'bypassed' | 'tree-only' | 'no-reach' | null;
  /** JSON array of entity ids this question reached (I4). */
  refs: string;
  /** Reads that went to the prose tree instead of the graph — the M5 split. */
  tree: number;
  /** Distinct reached ENTITY refs the injected story block had on offer —
   *  round 11 P2. Deduped like `refs`, so followed/reached ratios stay ≤ 1. */
  story_followed: number;
  /** readStory calls that opened a story the block pointed at (P2b) — the
   *  door, counted apart from the spontaneous entity follows above. */
  story_read: number;
}

/** Open an episode for a session, closing any stale one it left behind. */
export function openRetrievalEpisode(sessionKey: string, actor: string, trigger: string): number {
  closeRetrievalEpisode(sessionKey);
  const id = Number(
    db
      .prepare('INSERT INTO retrieval_episodes (session_key, actor, trigger, started_at) VALUES (?, ?, ?, ?)')
      .run(sessionKey, actor, trigger.replace(/\s+/g, ' ').slice(0, 300), dbNow()).lastInsertRowid,
  );
  db.prepare('INSERT OR REPLACE INTO open_episode (session_key, episode_id) VALUES (?, ?)').run(sessionKey, id);
  return id;
}

function currentEpisodeId(sessionKey: string): number | undefined {
  const r = db.prepare('SELECT episode_id AS id FROM open_episode WHERE session_key = ?').get(sessionKey) as { id: number } | undefined;
  return r?.id;
}

/**
 * Append one graph call to whatever episode this session is inside.
 *
 * A no-op when there is no open episode, deliberately: a CLI or a probe reads
 * the graph outside any question, and inventing an episode for it would put
 * noise into the workload M9 optimizes against.
 */
export function noteRetrievalStep(sessionKey: string, fn: string, ms = 0, refs: string[] = []): void {
  const id = currentEpisodeId(sessionKey);
  if (id === undefined) return;
  db.prepare(
    `UPDATE retrieval_episodes
        SET path = CASE WHEN path = '' THEN ? ELSE path || '→' || ? END,
            steps = steps + 1,
            ms = ms + ?
      WHERE id = ?`,
  ).run(fn, fn, Math.max(0, Math.round(ms)), id);
  if (refs.length) addRetrievalRefs(id, refs);
}

/**
 * Add the nodes a step reached, de-duplicated (I4).
 *
 * Separate from `noteRetrievalStep` because the two arrive from different
 * places: the step is named by the TOOL CALL as it is issued, and the refs are
 * known only once the call returns and its arguments have been resolved against
 * the live graph. A step that turns out to name a node is still one step.
 */
export function addRetrievalRefs(episodeId: number, refs: string[]): void {
  const row = db.prepare('SELECT refs FROM retrieval_episodes WHERE id = ?').get(episodeId) as { refs: string } | undefined;
  if (!row) return;
  const merged = [...new Set([...(JSON.parse(row.refs || '[]') as string[]), ...refs])];
  db.prepare('UPDATE retrieval_episodes SET refs = ? WHERE id = ?').run(JSON.stringify(merged), episodeId);
}

/** Record the nodes the message NAMED (the cue), on the episode just opened. */
export function noteRetrievalHints(sessionKey: string, refs: string[]): void {
  const id = currentEpisodeId(sessionKey);
  if (id !== undefined && refs.length) db.prepare('UPDATE retrieval_episodes SET hinted = ? WHERE id = ?').run(JSON.stringify(refs), id);
}

/** Of the day's questions that carried a cue: how many read a node it named, and how many read nothing. */
export function hintTally(since: string): { cued: number; followed: number; ignored: number } {
  const rows = db
    .prepare(`SELECT hinted, refs FROM retrieval_episodes WHERE started_at >= ? AND ended_at IS NOT NULL AND actor = 'day' AND hinted != '[]'`)
    .all(since) as Array<{ hinted: string; refs: string }>;
  let followed = 0;
  for (const r of rows) {
    const hinted = new Set(JSON.parse(r.hinted) as string[]);
    if ((JSON.parse(r.refs || '[]') as string[]).some((x) => hinted.has(x))) followed++;
  }
  return { cued: rows.length, followed, ignored: rows.length - followed };
}

/** Attach refs to whatever episode this session is inside, if any. */
export function noteRetrievalRefs(sessionKey: string, refs: string[]): void {
  const id = currentEpisodeId(sessionKey);
  if (id !== undefined && refs.length) addRetrievalRefs(id, refs);
}

/** Is this session inside an open episode? Exported so the follow-counter can
 *  bail before it builds an offered set nobody will be charged against. */
export function hasOpenRetrievalEpisode(sessionKey: string): boolean {
  return currentEpisodeId(sessionKey) !== undefined;
}

/** The graph's ids from the derived index — a read, where `loadGraph()` is a
 *  parse that WRITES (rebuilds the index, syncs provenance) and so is barred
 *  from read-only paths (I11). */
export function knownEntityIds(): Set<string> {
  return new Set((db.prepare('SELECT id FROM entities').all() as Array<{ id: string }>).map((r) => r.id));
}

/**
 * Count story-offered refs this episode reaches, each ref ONCE per episode.
 *
 * Must be called BEFORE the same refs land via `addRetrievalRefs`: the dedupe
 * reads the episode's current refs list as "already counted", so a ref that
 * three calls reach scores one follow, matching the deduped `refs` column a
 * consumer will divide by. The offered-set membership is the caller's (the set
 * lives in storyTree, and db.ts must not import it — entities.ts sits
 * between); this lands the number. A no-op outside an episode, for the same
 * reason as the step itself.
 */
export function noteStoryFollowed(sessionKey: string, offeredReached: string[]): void {
  if (!offeredReached.length) return;
  const id = currentEpisodeId(sessionKey);
  if (id === undefined) return;
  const row = db.prepare('SELECT refs FROM retrieval_episodes WHERE id = ?').get(id) as { refs: string } | undefined;
  if (!row) return;
  const counted = new Set(JSON.parse(row.refs || '[]') as string[]);
  const fresh = new Set(offeredReached.filter((r) => !counted.has(r))).size;
  if (!fresh) return;
  db.prepare('UPDATE retrieval_episodes SET story_followed = story_followed + ? WHERE id = ?').run(fresh, id);
}

/** One story opened through the door the block names. No dedupe: opening two
 *  domains is two reads, and re-opening one is a real second read. */
export function noteStoryRead(sessionKey: string): void {
  const id = currentEpisodeId(sessionKey);
  if (id === undefined) return;
  db.prepare('UPDATE retrieval_episodes SET story_read = story_read + 1 WHERE id = ?').run(id);
}

/** A read that went to the prose tree rather than the graph (M5's numerator). */
export function noteRetrievalTreeStep(sessionKey: string, _fn: string): void {
  const id = currentEpisodeId(sessionKey);
  if (id === undefined) return;
  db.prepare('UPDATE retrieval_episodes SET tree = tree + 1 WHERE id = ?').run(id);
}

/** Record that the asker gave up and read prose instead. */
export function noteRetrievalBypass(sessionKey: string): void {
  const id = currentEpisodeId(sessionKey);
  if (id === undefined) return;
  db.prepare('UPDATE retrieval_episodes SET bypasses = bypasses + 1 WHERE id = ?').run(id);
}

/**
 * Close the episode and score it.
 *
 * The outcome is DERIVED here rather than asserted by the caller, because the
 * caller does not know: a turn ends the same way whether the graph answered it
 * or was never asked, and "never asked" is the finding this whole milestone
 * exists to move off zero.
 */
export function closeRetrievalEpisode(sessionKey: string): RetrievalEpisode | undefined {
  const id = currentEpisodeId(sessionKey);
  if (id === undefined) return undefined;
  db.prepare('DELETE FROM open_episode WHERE session_key = ?').run(sessionKey);
  const row = db.prepare('SELECT * FROM retrieval_episodes WHERE id = ?').get(id) as RetrievalEpisode | undefined;
  if (!row) return undefined;
  // Ordered by what it says about the GRAPH, worst first: a give-up is a
  // structural complaint, a graph reach is the goal, a tree-only answer is the
  // thing M5 exists to convert, and no-reach is a turn that needed nothing.
  const outcome =
    row.bypasses > 0 ? 'bypassed' : row.steps > 0 ? 'answered' : row.tree > 0 ? 'tree-only' : 'no-reach';
  db.prepare('UPDATE retrieval_episodes SET ended_at = ?, outcome = ? WHERE id = ?').run(dbNow(), outcome, id);
  return { ...row, ended_at: dbNow(), outcome };
}

/** Drop episodes a dead process left open — they would never be scored. */
export function clearOpenRetrievalEpisodes(): void {
  const n = db.prepare('SELECT count(*) AS n FROM open_episode').get() as { n: number };
  if (!n.n) return;
  db.prepare(
    "UPDATE retrieval_episodes SET ended_at = datetime('now'), outcome = CASE WHEN bypasses > 0 THEN 'bypassed' WHEN steps > 0 THEN 'answered' WHEN tree > 0 THEN 'tree-only' ELSE 'no-reach' END WHERE id IN (SELECT episode_id FROM open_episode)",
  ).run();
  db.prepare('DELETE FROM open_episode').run();
  console.log(`[episodes] boot: scored ${n.n} episode(s) left open by a previous process`);
}

export function recentRetrievalEpisodes(limit = 50): RetrievalEpisode[] {
  return db.prepare('SELECT * FROM retrieval_episodes ORDER BY id DESC LIMIT ?').all(limit) as RetrievalEpisode[];
}

/**
 * The recurring paths, worst first — M9's input.
 *
 * Ordered by give-up before cost: a path that ends in a bypass is a question
 * the graph could not serve, which is a structural complaint, where a long path
 * is merely an expensive answer.
 */
export function retrievalPaths(limit = 20): Array<{ path: string; n: number; steps: number; bypasses: number; ms: number }> {
  return db
    .prepare(
      `SELECT path, count(*) AS n, avg(steps) AS steps, sum(bypasses) AS bypasses, avg(ms) AS ms
         FROM retrieval_episodes
        WHERE ended_at IS NOT NULL AND outcome != 'no-reach'
        GROUP BY path
        ORDER BY bypasses DESC, n * avg(steps) DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ path: string; n: number; steps: number; bypasses: number; ms: number }>;
}

/**
 * TURNS THAT LEFT NO TRACE — what the day heard and never wrote down.
 *
 * The night is already instructed, in capitals, that "every open loop the day
 * put through his hands belongs here". On 2026-08-16 Mehdi asked which
 * documents he had to sign and send to Iris; the concierge looked up
 * `paperwork/form-signing`, answered him, and filed nothing. The night had
 * that message inside dream #72's window, read past it, and filed nothing
 * either. The next morning a worker faithfully reported the focus set — which
 * still said the whole thread was "waiting on Bram, not you".
 *
 * Three chances, three misses, and the instruction to catch it already existed.
 * That is the round-8 lesson in a new place: a rule stated decays, a rule made
 * mechanical holds. So the night stops being asked to FIND the needles in a
 * hundred-message timeline and is handed them.
 *
 * "Durable" is deliberately generous — an observation, a commitment touched, or
 * a graph write, by anyone, while the turn was open. A turn that produced any
 * of those is off this list. What is left is the day hearing something and
 * keeping it nowhere.
 *
 * System-authored turns are excluded (`[PULSE]`, `[COMMITMENT]`, `[SYSTEM
 * EVENT]`): those are the machine talking to itself, and their open loops are
 * already tracked by the rows that triggered them. This block is about what the
 * PERSON said.
 */
export function unfiledTurns(
  from: string,
  to: string,
  limit = 25,
): Array<{ id: number; trigger: string; refs: string; started_at: string; outcome: string | null }> {
  return db
    .prepare(
      `SELECT e.id, e.trigger, e.refs, e.started_at, e.outcome
         FROM retrieval_episodes e
        WHERE e.actor = 'day'
          AND e.started_at >= ? AND e.started_at <= ?
          AND e.trigger NOT LIKE '[%'
          AND NOT EXISTS (SELECT 1 FROM observations o
                           WHERE o.created_at >= e.started_at
                             AND o.created_at <= COALESCE(e.ended_at, e.started_at))
          AND NOT EXISTS (SELECT 1 FROM commitments c
                           WHERE (c.created_at  >= e.started_at AND c.created_at  <= COALESCE(e.ended_at, e.started_at))
                              OR (c.resolved_at >= e.started_at AND c.resolved_at <= COALESCE(e.ended_at, e.started_at)))
          AND NOT EXISTS (SELECT 1 FROM entity_writes w
                           WHERE w.created_at >= e.started_at
                             AND w.created_at <= COALESCE(e.ended_at, e.started_at))
        ORDER BY e.id DESC
        LIMIT ?`,
    )
    .all(from, to, limit) as Array<{ id: number; trigger: string; refs: string; started_at: string; outcome: string | null }>;
}

/** How the day's questions went, over a window — the M4 number. */
export function retrievalTally(since: string): { total: number; answered: number; bypassed: number; treeOnly: number; noReach: number } {
  const r = db
    .prepare(
      `SELECT count(*) AS total,
              sum(outcome = 'answered') AS answered,
              sum(outcome = 'bypassed') AS bypassed,
              sum(outcome = 'tree-only') AS treeOnly,
              sum(outcome = 'no-reach') AS noReach
         FROM retrieval_episodes WHERE started_at >= ? AND ended_at IS NOT NULL`,
    )
    .get(since) as { total: number; answered: number | null; bypassed: number | null; treeOnly: number | null; noReach: number | null };
  return { total: r.total, answered: r.answered ?? 0, bypassed: r.bypassed ?? 0, treeOnly: r.treeOnly ?? 0, noReach: r.noReach ?? 0 };
}

/**
 * Drill-through, per window (round 11 P2): of the DAY's questions that reached
 * the graph at all, how many followed a pointer the story had offered — and of
 * those, how they ENDED. The pair is the metric on purpose: follow-rate alone
 * would reward a story that baits reads it cannot answer, and the downstream
 * outcome is what catches it.
 */
export function storyFollowTally(
  from: string,
  to: string,
): { reached: number; followed: number; storyReads: number; answered: number; bypassed: number; treeOnly: number } {
  // "took a pointer" = an entity follow OR a story read; the downstream split
  // is over that union, because a bait-y pointer can fail either way.
  const r = db
    .prepare(
      `SELECT sum(steps > 0) AS reached,
              sum(story_followed > 0) AS followed,
              sum(story_read > 0) AS storyReads,
              sum((story_followed > 0 OR story_read > 0) AND outcome = 'answered') AS answered,
              sum((story_followed > 0 OR story_read > 0) AND outcome = 'bypassed') AS bypassed,
              sum((story_followed > 0 OR story_read > 0) AND outcome = 'tree-only') AS treeOnly
         FROM retrieval_episodes
        WHERE actor IN ('day', 'worker') AND started_at >= ? AND started_at <= ? AND ended_at IS NOT NULL`,
    )
    .get(from, to) as {
    reached: number | null;
    followed: number | null;
    storyReads: number | null;
    answered: number | null;
    bypassed: number | null;
    treeOnly: number | null;
  };
  return {
    reached: r.reached ?? 0,
    followed: r.followed ?? 0,
    storyReads: r.storyReads ?? 0,
    answered: r.answered ?? 0,
    bypassed: r.bypassed ?? 0,
    treeOnly: r.treeOnly ?? 0,
  };
}

export interface NightSettledRow {
  boundary: string;
  settled_at: string;
  how: 'dreamt' | 'quiet' | 'cancelled';
  note: string | null;
}

/** The most recent night boundary the machine has accounted for. */
export function lastSettledNight(): NightSettledRow | undefined {
  return db.prepare('SELECT * FROM night_settled ORDER BY boundary DESC LIMIT 1').get() as NightSettledRow | undefined;
}

/**
 * Mark a night accounted for.
 *
 * `INSERT OR REPLACE` on purpose: a night settled `quiet` and later dreamt for
 * real should read as dreamt, and the reverse cannot happen (nothing settles a
 * boundary that is already behind the newest one).
 */
export function settleNight(boundary: string, how: NightSettledRow['how'], note?: string): void {
  db.prepare('INSERT OR REPLACE INTO night_settled (boundary, settled_at, how, note) VALUES (?, ?, ?, ?)').run(
    boundary,
    dbNow(),
    how,
    note ?? null,
  );
}

/** Recent nights, newest first — for the audit and the vitals. */
export function settledNights(limit = 10): NightSettledRow[] {
  return db.prepare('SELECT * FROM night_settled ORDER BY boundary DESC LIMIT ?').all(limit) as NightSettledRow[];
}

/** File a closed debug session, so the night can see the context was reset. */
export function recordDebugSession(r: {
  reason: string;
  since: string;
  writes: number;
  rolledBack: boolean;
  contextReset: boolean;
}): void {
  db.prepare(
    'INSERT INTO debug_history (reason, since, until, writes, rolled_back, context_reset) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(r.reason, r.since, dbNow(), r.writes, r.rolledBack ? 1 : 0, r.contextReset ? 1 : 0);
}

export interface DebugHistoryRow {
  id: number;
  reason: string;
  since: string;
  until: string;
  writes: number;
  rolled_back: number;
  context_reset: number;
}

/** Debug sessions that closed since a timestamp — the night's window. */
export function debugSessionsSince(since: string): DebugHistoryRow[] {
  return db
    .prepare('SELECT * FROM debug_history WHERE until >= ? ORDER BY id')
    .all(since) as DebugHistoryRow[];
}

export function maxEntityWriteId(): number {
  return ((db.prepare('SELECT MAX(id) AS n FROM entity_writes').get() as { n: number | null }).n ?? 0);
}

/** Everything written since a journal id — the debug session's own diff. */
export function writesSince(id: number): Array<{ id: number; op: string; entity_id: string; reason: string; actor: string }> {
  return db
    .prepare('SELECT id, op, entity_id, reason, actor FROM entity_writes WHERE id > ? ORDER BY id')
    .all(id) as Array<{ id: number; op: string; entity_id: string; reason: string; actor: string }>;
}

export interface CheckMissRow {
  kind: string;
  ref: string;
  outcome: string;
  detail: string;
  hits: number;
  last_at: string;
}

/** Everything that could not answer since `sinceDay` (inclusive), loudest first. */
export function recentCheckMisses(sinceDay: string, limit = 40): CheckMissRow[] {
  return db
    .prepare(
      `SELECT kind, ref, outcome, detail, SUM(hits) AS hits, MAX(last_at) AS last_at
         FROM check_misses WHERE day >= ?
        GROUP BY kind, ref, outcome
        ORDER BY hits DESC, ref LIMIT ?`,
    )
    .all(sinceDay, limit) as CheckMissRow[];
}

export interface Observation {
  id: number;
  text: string;
  refs: string[];
  unresolved: string[];
  evidence: string;
  source: string;
  created_at: string;
  folded_at: string | null;
  outcome: string | null;
}

interface ObservationRow extends Omit<Observation, 'refs' | 'unresolved'> {
  refs: string;
  unresolved: string;
}

const hydrate = (r: ObservationRow): Observation => ({
  ...r,
  refs: JSON.parse(r.refs) as string[],
  unresolved: JSON.parse(r.unresolved) as string[],
});

/** Queue one observation. Refs are already resolved by the caller (`observe`). */
export function saveObservation(o: {
  text: string;
  refs: string[];
  unresolved: string[];
  evidence: string;
  source: string;
}): number {
  const r = db
    .prepare('INSERT INTO observations (text, refs, unresolved, evidence, source) VALUES (?, ?, ?, ?, ?)')
    .run(o.text, JSON.stringify(o.refs), JSON.stringify(o.unresolved), o.evidence, o.source);
  return Number(r.lastInsertRowid);
}

/** The queue: everything the night has not yet folded into the graph. */
export function pendingObservations(limit = 200): Observation[] {
  return (
    db
      .prepare('SELECT * FROM observations WHERE folded_at IS NULL ORDER BY id LIMIT ?')
      .all(limit) as ObservationRow[]
  ).map(hydrate);
}

/**
 * Recent observations, FOLDED OR NOT — newest first.
 *
 * Distinct from `pendingObservations`, which is the night's work queue and by
 * design empties itself. Reading the inbox lens through that showed nothing at
 * all: all 50 rows were folded, and the thing worth looking at — 44 of them
 * carry a name that resolved to no node — lives entirely in the folded half. A
 * queue and a record are different questions about the same table.
 */
export function recentObservations(limit = 200): Observation[] {
  return (
    db.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT ?').all(limit) as ObservationRow[]
  ).map(hydrate);
}

/**
 * How deep the queue is, and how old its head is.
 *
 * Surfaced rather than merely stored, because an inbox nobody drains is the
 * exact failure this round exists to end — one level up from a graph nobody
 * writes. A depth that climbs for a week has to be LOUD.
 */
export function inboxDepth(): { pending: number; oldest: string | null; unattributable: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS pending, MIN(created_at) AS oldest,
              SUM(CASE WHEN refs = '[]' THEN 1 ELSE 0 END) AS unattributable
         FROM observations WHERE folded_at IS NULL`,
    )
    .get() as { pending: number; oldest: string | null; unattributable: number | null };
  return { pending: row.pending, oldest: row.oldest, unattributable: row.unattributable ?? 0 };
}

/** Mark one drained, with what the night actually did about it. */
export function foldObservation(id: number, outcome: string): void {
  db.prepare("UPDATE observations SET folded_at = datetime('now'), outcome = ? WHERE id = ?").run(outcome, id);
}

/**
 * Every ref the day named that resolved to nothing, commonest first.
 *
 * This is the demand signal for new entities (I5): the graph should grow where
 * the day kept reaching and finding no node, not where a nightly pass imagined
 * a domain might be useful.
 */
export function unattributedRefs(limit = 20): Array<{ ref: string; hits: number }> {
  const counts = new Map<string, number>();
  for (const r of db.prepare('SELECT unresolved FROM observations').all() as Array<{ unresolved: string }>)
    for (const ref of JSON.parse(r.unresolved) as string[]) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  return [...counts]
    .map(([ref, hits]) => ({ ref, hits }))
    .sort((a, b) => b.hits - a.hits || a.ref.localeCompare(b.ref))
    .slice(0, limit);
}

export interface FrictionRow {
  id: number;
  kind: FrictionKind;
  module: string;
  fn: string;
  signature: string;
  detail: string;
  session_key: string | null;
  hits: number;
  created_at: string;
  last_at: string;
}

export interface FrictionInput {
  kind: FrictionKind;
  /** The dedup key: what makes two occurrences the same friction. */
  signature: string;
  module?: string;
  fn?: string;
  detail?: string;
  sessionKey?: string;
}

/**
 * Record one friction event, coalescing repeats.
 *
 * Deliberately silent and non-throwing: instrumentation that can break the thing
 * it measures does not get installed, and a ledger nobody trusts to be harmless
 * gets switched off the first time it costs someone a turn.
 */
export function recordFriction(f: FrictionInput): void {
  try {
    db.prepare(
      `INSERT INTO friction (kind, module, fn, signature, detail, session_key)
       VALUES (@kind, @module, @fn, @signature, @detail, @sessionKey)
       ON CONFLICT (kind, module, fn, signature) WHERE resolved_at IS NULL DO UPDATE SET
         hits        = hits + 1,
         last_at     = datetime('now'),
         -- Keep a rolling list of DISTINCT recent occurrences, newest first.
         -- The signature says a function is missing; these say what it would
         -- have to answer, in the agent's own words — which is the only part
         -- the night can actually build from.
         detail      = CASE
                         WHEN instr(detail, excluded.detail) = 1 THEN detail
                         ELSE substr(excluded.detail || char(10) || detail, 1, 2000)
                       END,
         session_key = excluded.session_key`,
    ).run({
      kind: f.kind,
      module: f.module ?? '',
      fn: f.fn ?? '',
      signature: f.signature,
      detail: (f.detail ?? '').slice(0, 2000),
      sessionKey: f.sessionKey ?? null,
    });
  } catch (e) {
    console.error('[friction] could not record', e);
  }
}

/** Open friction, loudest first — what the night's code audit reads. */
export function openFriction(sinceIso?: string): FrictionRow[] {
  return db
    .prepare(
      `SELECT id, kind, module, fn, signature, detail, session_key, hits, created_at, last_at
         FROM friction
        WHERE resolved_at IS NULL ${sinceIso ? 'AND last_at >= @since' : ''}
        ORDER BY hits DESC, last_at DESC`,
    )
    .all(sinceIso ? { since: sinceIso } : {}) as FrictionRow[];
}

export function resolveFriction(ids: number[], resolution: string): void {
  if (!ids.length) return;
  const stmt = db.prepare("UPDATE friction SET resolved_at = datetime('now'), resolution = ? WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) stmt.run(resolution.slice(0, 500), id);
  })();
}

/** One line per kind — cheap enough to print anywhere. */
export function frictionSummary(): Array<{ kind: string; rows: number; hits: number }> {
  return db
    .prepare(
      'SELECT kind, COUNT(*) AS rows, SUM(hits) AS hits FROM friction WHERE resolved_at IS NULL GROUP BY kind ORDER BY hits DESC',
    )
    .all() as Array<{ kind: string; rows: number; hits: number }>;
}

// --- Use ledger (round 9) ---------------------------------------------------

export interface ModuleUseRow {
  id: number;
  module: string;
  fn: string;
  shape: string;
  examples: string;
  hits: number;
  ok_hits: number;
  ms_total: number;
  first_at: string;
  last_at: string;
  last_session: string | null;
}

export interface ModuleUseInput {
  module: string;
  fn: string;
  /** Dedup key — a function name, or the functions an expression composed. */
  shape: string;
  /** One concrete form of this use, kept as a rolling distinct list. */
  example?: string;
  ms: number;
  ok: boolean;
  sessionKey?: string;
}

/** Note one module call or expression. Silent on failure, like the friction
 *  ledger: measurement must never be able to break the thing it measures. */
/**
 * Which DOOR an agent used to reach memory.
 *
 * `noteToolCall` already pulses every tool call and persists only the ones it
 * judges a bypass. Its own comment names what that loses: "a turn that reads six
 * files and calls nothing is exactly the picture that explains why the API
 * ledger is empty" — and that picture went to the pulse ring, which is lossy.
 *
 * On 2026-08-05 that cost a live diagnosis. The cycle report said the day never
 * reached for memory; the day had in fact grounded itself twice, deliberately
 * and correctly, via `readNote` and the message log. Establishing that took
 * reading the conversation by hand and cross-referencing `retrievals`, because
 * the one table that should have said it did not exist. The question is never
 * "did it reach for memory" — it is "which door", and only this answers it.
 */
export function logToolCall(sessionKey: string, tool: string, target: string): void {
  try {
    db.prepare('INSERT INTO tool_calls (session_key, tool, target) VALUES (?, ?, ?)').run(
      sessionKey,
      tool.replace(/^mcp__[^_]+__/, '').slice(0, 60),
      // 400, not 160: a Bash line's READ target sits after `cd X && cat … |
      // grep …`, and src/doors.ts needs the whole pipeline to name the door.
      target.slice(0, 400),
    );
  } catch (e) {
    console.error('[db] logToolCall failed', e);
  }
}

/** Doors used in a window, per caller — the cycle report's "how it looked". */
export function doorsUsed(from: string, to: string): Array<{ session_key: string; tool: string; n: number }> {
  return db
    .prepare(
      `SELECT COALESCE(session_key,'(none)') AS session_key, tool, COUNT(*) AS n
       FROM tool_calls WHERE at >= ? AND at <= ? GROUP BY 1,2 ORDER BY session_key, n DESC`,
    )
    .all(from, to) as Array<{ session_key: string; tool: string; n: number }>;
}

export interface ToolCallRow {
  at: string;
  session_key: string | null;
  tool: string;
  target: string;
}

/** The raw ledger for a window — src/doors.ts turns it into fold candidates. */
export function toolCallsBetween(from: string, to: string): ToolCallRow[] {
  return db
    .prepare('SELECT at, session_key, tool, target FROM tool_calls WHERE at >= ? AND at <= ? ORDER BY at')
    .all(from, to) as ToolCallRow[];
}

/**
 * The night's verdicts on doors (src/doors.ts). `offered` rows are written
 * when the digest shows a door; the decision rows when the operator calls
 * doorDecision. `dream_id` is stamped after the pass saves its journal, so a
 * pass that fails leaves its rows unstamped — visible, not counted as folded.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS door_decisions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL DEFAULT (datetime('now')),
    path      TEXT NOT NULL,
    decision  TEXT NOT NULL,
    note      TEXT NOT NULL DEFAULT '',
    dream_id  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_door_decisions_path ON door_decisions(path, at);
`);

export interface DoorDecisionRow {
  at: string;
  path: string;
  decision: string;
  note: string;
  dream_id: number | null;
}

export function recordDoorDecision(path: string, decision: string, note = ''): number {
  return Number(db.prepare('INSERT INTO door_decisions (path, decision, note) VALUES (?, ?, ?)').run(path, decision, note.slice(0, 300)).lastInsertRowid);
}

/** Stamp every unstamped row written since `since` with the dream that made it. */
export function stampDoorDecisions(dreamId: number, since: string): void {
  db.prepare('UPDATE door_decisions SET dream_id = ? WHERE dream_id IS NULL AND at >= ?').run(dreamId, since);
}

export function doorDecisionsBetween(from: string, to: string): DoorDecisionRow[] {
  return db
    .prepare('SELECT at, path, decision, note, dream_id FROM door_decisions WHERE at >= ? AND at <= ? ORDER BY at')
    .all(from, to) as DoorDecisionRow[];
}

/** Doors offered on a PAST pass that never received a verdict — skimmed, and
 *  carried forward until someone decides (2026-09-03: night 84 was offered 8
 *  and decided 3; cache/INDEX.md stayed a daily read for a week). */
export function undecidedDoorPaths(before: string): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT path FROM door_decisions o WHERE decision = 'offered' AND at < ?
         AND NOT EXISTS (SELECT 1 FROM door_decisions d WHERE d.path = o.path AND d.decision != 'offered')`,
      )
      .all(before) as Array<{ path: string }>
  ).map((r) => r.path);
}

/** One verdict per door per pass: an unstamped earlier verdict is replaced,
 *  not doubled (a pass that reconsiders overwrites itself). */
export function supersedeDoorDecision(path: string): void {
  db.prepare("DELETE FROM door_decisions WHERE path = ? AND decision != 'offered' AND dream_id IS NULL").run(path);
}

/** Whether this door was already offered for this window (the note carries the window key). */
export function hasOfferedDoor(path: string, windowKey: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM door_decisions WHERE path = ? AND decision = 'offered' AND note LIKE ? LIMIT 1")
    .get(path, `${windowKey}%`);
}

/** A cancelled pass takes its verdicts with it — the tree was rolled back, so
 *  a "fold" it recorded describes an entity that no longer exists. */
export function deleteUnstampedDoorDecisions(since: string): number {
  return db.prepare('DELETE FROM door_decisions WHERE dream_id IS NULL AND at >= ?').run(since).changes;
}

// THE VOICE MEHDI PICKED. One row per chat: which Piper voice, how brisk.
// Set by `/voice use` and `/voice rate`; read by every spoken message.
db.exec(`
  CREATE TABLE IF NOT EXISTS voice_prefs (
    chat_id INTEGER PRIMARY KEY,
    voice   TEXT NOT NULL,
    rate    REAL NOT NULL DEFAULT 1.0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function getVoicePrefs(chatId: number): { voice: string; rate: number } | undefined {
  return db.prepare('SELECT voice, rate FROM voice_prefs WHERE chat_id = ?').get(chatId) as { voice: string; rate: number } | undefined;
}

export function setVoicePrefs(chatId: number, prefs: { voice?: string; rate?: number }): { voice: string; rate: number } {
  const cur = getVoicePrefs(chatId);
  const next = { voice: prefs.voice ?? cur?.voice ?? 'en_US-lessac-medium', rate: prefs.rate ?? cur?.rate ?? 1.0 };
  db.prepare(
    `INSERT INTO voice_prefs (chat_id, voice, rate, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET voice = excluded.voice, rate = excluded.rate, updated_at = excluded.updated_at`,
  ).run(chatId, next.voice, next.rate);
  return next;
}

// GARDENING PACKETS THE NIGHT DECLINED, DURABLY. A packet is re-offered every
// pass until its finding stops firing, and for two W213 answers the finding
// never stops: "this process is a runbook, not a plan" (reference) and "the
// evidence does not say what this is for" (unknown). Without a memory those
// would take the same 8 slots every night and the night would relearn the
// same refusals; with one, a refusal is a row the DAY can read — an 'unknown'
// goal is the cue to ask when the topic next comes up. `evidence` is the
// entity's chain at decision time: a chain that has grown is new evidence, and
// the packet is offered again.
db.exec(`
  CREATE TABLE IF NOT EXISTS packet_decisions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL DEFAULT (datetime('now')),
    code      TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    decision  TEXT NOT NULL,     -- 'reference' | 'unknown'
    reason    TEXT NOT NULL DEFAULT '',
    evidence  TEXT NOT NULL DEFAULT '',
    actor     TEXT NOT NULL DEFAULT 'nightly'
  );
  CREATE INDEX IF NOT EXISTS idx_packet_decisions_key ON packet_decisions(code, entity_id, at);
`);

// THE DAY'S HALF. An 'unknown' verdict is a question only Mehdi can answer,
// and the day asks it IN THE FLOW — when the concierge next reads the node —
// never on a clock. These two columns are the ask count: how often the cue was
// shown, and when last, so it is shown at most once a day and the silence
// (asked N times, still no goal) becomes step three's dormancy signal.
addColumn('packet_decisions', 'nudges', 'INTEGER NOT NULL DEFAULT 0');
addColumn('packet_decisions', 'last_nudged_at', 'TEXT');

export interface PacketDecisionRow {
  id: number;
  at: string;
  code: string;
  entity_id: string;
  decision: string;
  reason: string;
  evidence: string;
  actor: string;
  nudges: number;
  last_nudged_at: string | null;
}

export function notePacketNudge(id: number): void {
  db.prepare("UPDATE packet_decisions SET nudges = nudges + 1, last_nudged_at = datetime('now') WHERE id = ?").run(id);
}

export function recordPacketDecision(row: Omit<PacketDecisionRow, 'id' | 'at' | 'nudges' | 'last_nudged_at'>): number {
  return Number(
    db
      .prepare('INSERT INTO packet_decisions (code, entity_id, decision, reason, evidence, actor) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.code, row.entity_id, row.decision, row.reason.slice(0, 300), row.evidence, row.actor).lastInsertRowid,
  );
}

/** The latest decision per (code, entity) — the standing verdicts. */
export function standingPacketDecisions(): PacketDecisionRow[] {
  return db
    .prepare(
      `SELECT * FROM packet_decisions p WHERE id = (
         SELECT id FROM packet_decisions q WHERE q.code = p.code AND q.entity_id = p.entity_id ORDER BY at DESC, id DESC LIMIT 1
       ) ORDER BY at`,
    )
    .all() as PacketDecisionRow[];
}

/** Paths with a STAMPED fold/pointer decision made BEFORE `before` — the ones whose re-reads are the metric. */
export function doorsSettledBefore(before: string): Array<{ path: string; decision: string; at: string }> {
  return db
    .prepare(
      `SELECT path, decision, MAX(at) AS at FROM door_decisions
       WHERE decision IN ('fold','pointer') AND dream_id IS NOT NULL AND at < ? GROUP BY path`,
    )
    .all(before) as Array<{ path: string; decision: string; at: string }>;
}

/**
 * Drop a retired entity's sidecar rows.
 *
 * The mirror of `carryEntityKeys`. `entities` and `entity_edges` are derived and
 * rebuild themselves on the next parse; the state clock, the confirmation clock
 * and the escalation queue are not, and a retired id left in them means the
 * prober keeps a state for a node that no longer exists and `unconfirmed()`
 * keeps nagging about facts nobody can read.
 *
 * `entity_writes` is deliberately untouched: it holds the retired row itself in
 * `before`, which is the only undo there is.
 */
export function retireEntityKeys(id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM entity_state WHERE id = ?').run(id);
    db.prepare('DELETE FROM fact_seen WHERE entity_id = ?').run(id);
    db.prepare('DELETE FROM entity_changes WHERE entity_id = ?').run(id);
  })();
}

export interface ModuleCallRow {
  id: number;
  at: string;
  session_key: string | null;
  module: string;
  fn: string;
  args: string;
  ok: number;
  ms: number;
  refs: string[];
}

/**
 * Log ONE call. The per-call twin of `recordModuleUse`'s running total.
 *
 * Never throws: an unloggable call must still be a call that happened. The
 * whole point of this table is measuring whether the day reaches for memory,
 * and a logger that can break the thing it measures would make a quiet failure
 * look exactly like a quiet day — which is the confusion the audit block exists
 * to prevent.
 */
export function logModuleCall(c: {
  sessionKey?: string;
  module: string;
  fn: string;
  args: string;
  ok: boolean;
  ms: number;
  refs: string[];
  runId?: number;
}): void {
  try {
    db.prepare(
      'INSERT INTO module_calls (session_key, module, fn, args, ok, ms, refs, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      c.sessionKey ?? null,
      c.module,
      c.fn,
      c.args.slice(0, 400),
      c.ok ? 1 : 0,
      Math.round(c.ms),
      JSON.stringify([...new Set(c.refs)].slice(0, 40)),
      c.runId ?? null,
    );
  } catch (e) {
    console.error('[db] logModuleCall failed', e);
  }
}

/** Calls in a window — the cycle view's raw material. Bounds are UTC db-format
 *  strings, the same shape `dreams.covers_from`/`covers_to` already carry. */
export function moduleCallsBetween(from: string, to: string, limit = 2000): ModuleCallRow[] {
  return (
    db
      .prepare('SELECT * FROM module_calls WHERE at >= ? AND at <= ? ORDER BY at, id LIMIT ?')
      .all(from, to, limit) as Array<Omit<ModuleCallRow, 'refs'> & { refs: string }>
  ).map((r) => ({ ...r, refs: safeRefs(r.refs) }));
}

/** Who called, how often, in a window — the one number M4 is judged on. */
export function callerBreakdown(from: string, to: string): Array<{ session_key: string; calls: number; fns: number }> {
  return db
    .prepare(
      `SELECT COALESCE(session_key, '(none)') AS session_key, COUNT(*) AS calls, COUNT(DISTINCT module || '.' || fn) AS fns
       FROM module_calls WHERE at >= ? AND at <= ? GROUP BY 1 ORDER BY calls DESC`,
    )
    .all(from, to) as Array<{ session_key: string; calls: number; fns: number }>;
}

function safeRefs(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function recordModuleUse(u: ModuleUseInput): void {
  try {
    db.prepare(
      `INSERT INTO module_use (module, fn, shape, examples, hits, ok_hits, ms_total, last_session)
       VALUES (@module, @fn, @shape, @example, 1, @ok, @ms, @sessionKey)
       ON CONFLICT (module, fn, shape) DO UPDATE SET
         hits         = hits + 1,
         ok_hits      = ok_hits + @ok,
         ms_total     = ms_total + @ms,
         last_at      = datetime('now'),
         last_session = @sessionKey,
         examples     = CASE
                          WHEN @example = '' OR instr(examples, @example) = 1 THEN examples
                          ELSE substr(@example || char(10) || examples, 1, 4000)
                        END`,
    ).run({
      module: u.module,
      fn: u.fn,
      shape: u.shape,
      example: (u.example ?? '').slice(0, 400),
      ms: Math.round(u.ms),
      ok: u.ok ? 1 : 0,
      sessionKey: u.sessionKey ?? null,
    });
  } catch (e) {
    console.error('[use] could not record', e);
  }
}

/** The use ledger, most-used first — what the night reads to decide what the
 *  API should GROW, alongside the friction ledger's account of what it lacks. */
/**
 * Per-function calls and failures IN A WINDOW, from the per-call log.
 *
 * `moduleUse` cannot answer this: `module_use` is a lifetime aggregate filtered
 * by `last_at`, so a function called once today reports its ALL-TIME failure
 * count. On 2026-08-07 that rendered as "87× entities.graph (5 failed)" in the
 * audit, and the 5 were from 2026-07-31 — a bug fixed six days earlier, read as
 * current. The same mistake as the check-miss report, one table over.
 */
export function apiUseSince(sinceIso: string): Array<{ module: string; fn: string; hits: number; failed: number }> {
  return db
    .prepare(
      `SELECT module, fn, COUNT(*) AS hits, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
         FROM module_calls WHERE at >= ?
        GROUP BY module, fn ORDER BY hits DESC`,
    )
    .all(sinceIso) as Array<{ module: string; fn: string; hits: number; failed: number }>;
}

export function moduleUse(sinceIso?: string): ModuleUseRow[] {
  return db
    .prepare(
      `SELECT * FROM module_use ${sinceIso ? 'WHERE last_at >= @since' : ''} ORDER BY hits DESC, last_at DESC`,
    )
    .all(sinceIso ? { since: sinceIso } : {}) as ModuleUseRow[];
}

/**
 * Hits per named function, for decay (§8): what nothing calls, nothing needs.
 *
 * A function reached through an EXPRESSION counts as called. It has to: two
 * expressions composing `openLoops` had it reported as never-called, which would
 * have made the retirement rule delete the most-used function in the catalog.
 * The eval row's shape is the list of functions it touched, so it is credited to
 * each of them.
 */
export function functionHits(module: string): Map<string, { hits: number; last_at: string }> {
  const rows = db
    .prepare('SELECT fn, shape, SUM(hits) AS hits, MAX(last_at) AS last_at FROM module_use WHERE module = ? GROUP BY fn, shape')
    .all(module) as Array<{ fn: string; shape: string; hits: number; last_at: string }>;
  const out = new Map<string, { hits: number; last_at: string }>();
  const credit = (fn: string, hits: number, at: string) => {
    const cur = out.get(fn);
    out.set(fn, { hits: (cur?.hits ?? 0) + hits, last_at: cur && cur.last_at > at ? cur.last_at : at });
  };
  for (const r of rows) {
    if (r.fn !== '(eval)') credit(r.fn, r.hits, r.last_at);
    else for (const fn of r.shape.split('+').filter((f) => f && f !== '(none)')) credit(fn, r.hits, r.last_at);
  }
  return out;
}

export interface EntityIndexRow {
  id: string;
  domain: string;
  kind: string;
  aka: string[];
  facts: string[];
  chain: string[];
  probe: string | null;
  actor: string | null;
  goal: number;
  note: string | null;
}

/**
 * Rebuild the derived index wholesale from a successful parse. Wholesale is the
 * point: an incremental index can disagree with the files, and the files are the
 * source of truth. `entity_state` is deliberately NOT touched — it is the
 * prober's, and it must survive a reform that rewrites every record.
 */
export function rebuildEntityIndex(
  rows: Array<{ id: string; domain: string; kind: string; aka: string[]; facts: string[]; chain: string[]; probe?: string; actor?: string; goal: boolean; note?: string }>,
  edges: Array<{ src: string; rel: string; dst: string }>,
): void {
  const ins = db.prepare(
    'INSERT INTO entities (id, domain, kind, aka, facts, chain, probe, actor, goal, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insEdge = db.prepare('INSERT OR IGNORE INTO entity_edges (src, rel, dst) VALUES (?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM entities').run();
    db.prepare('DELETE FROM entity_edges').run();
    for (const r of rows) {
      ins.run(
        r.id,
        r.domain,
        r.kind,
        JSON.stringify(r.aka),
        JSON.stringify(r.facts),
        JSON.stringify(r.chain),
        r.probe ?? null,
        r.actor ?? null,
        r.goal ? 1 : 0,
        r.note ?? null,
      );
    }
    for (const e of edges) insEdge.run(e.src, e.rel, e.dst);
  })();
}

/**
 * Resolve a loose reference to an entity id — an exact id, or a case-insensitive
 * hit in any entity's `aka`. This is what makes "#3181", "the TCP 4/4 PR" and
 * "the cron cascade one" land on one node; identity resolution is the hard part
 * of the round, and minting a duplicate is its worst failure.
 */
export function resolveEntity(ref: string): EntityIndexRow | undefined {
  const q = ref.trim().toLowerCase();
  const rows = db.prepare('SELECT id, domain, kind, aka, facts, chain, probe, actor, goal, note FROM entities').all() as Array<
    Omit<EntityIndexRow, 'aka' | 'facts' | 'chain'> & { aka: string; facts: string; chain: string }
  >;
  const hydrate = (r: (typeof rows)[number]): EntityIndexRow => ({
    ...r,
    aka: JSON.parse(r.aka) as string[],
    facts: JSON.parse(r.facts) as string[],
    chain: JSON.parse(r.chain) as string[],
  });
  const exact = rows.find((r) => r.id.toLowerCase() === q);
  if (exact) return hydrate(exact);
  const byAlias = rows.filter((r) => (JSON.parse(r.aka) as string[]).some((a) => a.toLowerCase() === q));
  // An ambiguous alias is NOT a match: silently picking one is how two distinct
  // things become one. The caller should see nothing and disambiguate.
  return byAlias.length === 1 ? hydrate(byAlias[0]!) : undefined;
}

export function focusBands(chatId: number): { tier: number; title: string; items: CommitmentRecord[] }[] {
  const bands = new Map<number, { tier: number; title: string; items: CommitmentRecord[] }>();
  for (const c of focusItems(chatId)) {
    const tier = c.focus;
    let band = bands.get(tier);
    if (!band) {
      band = { tier, title: '', items: [] };
      bands.set(tier, band);
    }
    if (!band.title && c.focus_band) band.title = c.focus_band;
    band.items.push(c);
  }
  return [...bands.values()]
    .sort((a, b) => a.tier - b.tier)
    .map((b) => ({ ...b, title: b.title || `tier ${b.tier}` }));
}

/** Everything the checker should run now: open, has a check_cmd, and not run
 *  since `notCheckedSinceUtc`. */
export function checkableCommitments(notCheckedSinceUtc: string): CommitmentRecord[] {
  return stmts.checkableCommitments.all(notCheckedSinceUtc) as CommitmentRecord[];
}

/** Move an item to a focus tier (0 = out of the set), optionally naming its
 *  band and attaching a machine check. */
export function setFocusFields(id: number, tier: number, band?: string, checkCmd?: string): void {
  stmts.setFocusFields.run(Math.max(0, Math.round(tier)), band?.slice(0, 40) ?? null, checkCmd ?? null, id);
}

/** Store the result of a check (state + hash + timestamp). */
export function recordCheck(id: number, state: string, hash: string): void {
  stmts.recordCheck.run(state, hash, id);
}

/** Mark a check as run without changing what it saw (the unchanged path). */
export function touchCheck(id: number): void {
  stmts.touchCheck.run(id);
}

/** Make a commitment due immediately — how a verified change wakes the pulse. */
export function makeCommitmentDue(id: number): void {
  stmts.dueNow.run(id);
}

export interface FocusChangeRow {
  id: number;
  commitment_id: number;
  source: string;
  observation: string | null;
  before: string | null;
  after: string | null;
  created_at: string;
}

export function addFocusChange(
  chatId: number,
  commitmentId: number,
  source: 'checker' | 'worker',
  fields: { observation?: string; before?: string; after?: string } = {},
): number {
  return Number(
    stmts.addFocusChange.run(
      chatId,
      commitmentId,
      source,
      fields.observation ?? null,
      fields.before ?? null,
      fields.after ?? null,
    ).lastInsertRowid,
  );
}

/** Unconsumed change rows for an item (what the next pulse should carry). */
export function openFocusChanges(commitmentId: number): FocusChangeRow[] {
  return stmts.openFocusChanges.all(commitmentId) as FocusChangeRow[];
}

/** Mark an item's pending changes as handed over. */
/**
 * Recent movements, with the watched item's label and graph ref carried along.
 *
 * The ref is JOINED, never stored on the change. A movement is about the thing
 * being watched, so duplicating its pointer here would be the authored version
 * of a derivable fact (I2) — and it would go stale the moment the item was
 * re-pointed. The join costs nothing and cannot drift.
 */
export function recentFocusChanges(limit = 200): Array<
  FocusChangeRow & { label: string; ref: string | null; band: string | null; consumed_at: string | null }
> {
  return db
    .prepare(
      `SELECT fc.id, fc.commitment_id, fc.source, fc.observation, fc.before, fc.after, fc.created_at, fc.consumed_at,
              c.label, c.ref, c.focus_band AS band
         FROM focus_changes fc JOIN commitments c ON c.id = fc.commitment_id
        ORDER BY fc.id DESC LIMIT ?`,
    )
    .all(limit) as Array<FocusChangeRow & { label: string; ref: string | null; band: string | null; consumed_at: string | null }>;
}

export function consumeFocusChanges(commitmentId: number): void {
  stmts.consumeFocusChanges.run(commitmentId);
}

/** How many times this item escalated in the last 24h — the noise governor. */
export function escalationsToday(commitmentId: number): number {
  return (stmts.recentEscalations.get(commitmentId) as { n: number }).n;
}

/** Replace a commitment's stored body (keeps system prompts code-current). */
export function setCommitmentBody(id: number, body: string): void {
  stmts.setCommitmentBody.run(body, id);
}

export interface TurnUsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  contextWindow: number;
  /** Exact live context after the turn, from the SDK's getContextUsage; 0 if it could not be read. */
  contextTokens?: number;
  contextMax?: number;
  /** The thinking effort the turn was ASKED for ('' = none requested); what ran may differ. */
  effortAsked?: string;
}

/** Record one completed turn's usage/cost. */
export function saveUsage(sessionKey: string, u: TurnUsageRow): void {
  stmts.saveUsage.run(
    sessionKey,
    u.model,
    u.inputTokens,
    u.outputTokens,
    u.cacheReadTokens,
    u.cacheCreationTokens,
    u.costUsd,
    u.durationMs,
    u.numTurns,
    u.contextWindow,
    u.contextTokens ?? 0,
    u.contextMax ?? 0,
    u.effortAsked ?? '',
  );
}

/**
 * THE COST LINE — what the week's dollars bought, by who spent them.
 *
 * Roles are read off the session key, which is the one thing every usage row
 * has, and THIS is the single classifier — /stats folds through it too, so
 * two surfaces cannot disagree about who spent what. Every key saveUsage
 * writes (grep it): the concierge is slot -1; a worker a numeric slot; the
 * night is every pass that maintains memory — :operator / :defrag (the
 * rewrite), :reform, :distill, :digest, and the retired :dream / :grow keys
 * still in old rows; the summarizer that briefs a worker's run writes under
 * :brief. Anything else is 'other' rather than folded into a role it is not.
 * Read by cycleCli per window and by the audit per day; a window with no
 * rows prints zeros, never nothing.
 */
export type CostRole = 'concierge' | 'worker' | 'night' | 'brief' | 'other';
const NIGHT_KEYS: ReadonlySet<string> = new Set(['operator', 'defrag', 'reform', 'distill', 'digest', 'dream', 'grow']);

export function costRoleOf(sessionKey: string): CostRole {
  const tail = sessionKey.slice(sessionKey.lastIndexOf(':') + 1);
  if (tail === '-1') return 'concierge';
  if (NIGHT_KEYS.has(tail)) return 'night';
  if (tail === 'brief') return 'brief';
  if (/^\d+$/.test(tail)) return 'worker';
  return 'other';
}

export interface CostModelRow {
  model: string;
  /** The effort ASKED for on those turns ('' = none); what ran may have been downgraded. */
  effort: string;
  turns: number;
  usd: number;
}
export interface CostRoleRow {
  role: CostRole;
  turns: number;
  usd: number;
  models: CostModelRow[];
}
export interface CostTally {
  total: number;
  turns: number;
  roles: CostRoleRow[];
}

/** Cost in a window, by role and (within a role) by model + effort. Inclusive both ends. */
export function costTally(fromUtc: string, toUtc: string): CostTally {
  const rows = db
    .prepare(
      `SELECT session_key, model, effort_asked AS effort, COUNT(*) AS turns, COALESCE(SUM(cost_usd), 0) AS usd
         FROM usage WHERE created_at >= ? AND created_at <= ?
         GROUP BY session_key, model, effort_asked`,
    )
    .all(fromUtc, toUtc) as Array<{ session_key: string; model: string; effort: string; turns: number; usd: number }>;
  const byRole = new Map<CostRole, CostRoleRow>();
  for (const r of rows) {
    const role = costRoleOf(r.session_key);
    const row = byRole.get(role) ?? { role, turns: 0, usd: 0, models: [] };
    row.turns += r.turns;
    row.usd += r.usd;
    const m = row.models.find((x) => x.model === r.model && x.effort === r.effort);
    if (m) {
      m.turns += r.turns;
      m.usd += r.usd;
    } else row.models.push({ model: r.model, effort: r.effort, turns: r.turns, usd: r.usd });
    byRole.set(role, row);
  }
  const order: CostRole[] = ['concierge', 'worker', 'night', 'brief', 'other'];
  const roles = order.map((role) => byRole.get(role) ?? { role, turns: 0, usd: 0, models: [] });
  for (const r of roles) r.models.sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));
  return {
    total: roles.reduce((n, r) => n + r.usd, 0),
    turns: roles.reduce((n, r) => n + r.turns, 0),
    roles,
  };
}

/** Dollars per UTC day over [fromDay, toDay], every day present (zero when quiet). */
export function costPerDay(fromDay: string, toDay: string): Array<{ day: string; usd: number }> {
  const got = new Map(
    (
      db
        .prepare(
          `SELECT date(created_at) AS day, COALESCE(SUM(cost_usd), 0) AS usd FROM usage
             WHERE date(created_at) >= ? AND date(created_at) <= ? GROUP BY day`,
        )
        .all(fromDay, toDay) as Array<{ day: string; usd: number }>
    ).map((r) => [r.day, r.usd]),
  );
  const out: Array<{ day: string; usd: number }> = [];
  const d = new Date(`${fromDay}T00:00:00Z`);
  const end = new Date(`${toDay}T00:00:00Z`);
  for (; d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    out.push({ day, usd: got.get(day) ?? 0 });
  }
  return out;
}

/** Context size AND window of a session's latest run — the compaction watch:
 *  a session nearing its window will auto-compact, discarding oldest detail.
 *
 *  `input_tokens` alone is NOT the context: a cached turn reports its context
 *  as `cache_read`, leaving input at ~1-2k. Reading it as context capped the
 *  measurable fullness at ~6% of a 1M window, so the operator's ≥50% warning
 *  could never fire while threads silently ran over and compacted. The usage
 *  row is per RUN, so cache totals are summed across its turns — divide by
 *  num_turns for the per-turn context. An estimate, but the right order. */
export function latestContextInfo(sessionKey: string): { tokens: number; window: number } | undefined {
  const row = stmts.latestContext.get(sessionKey) as
    | { input_tokens: number; cache_creation: number; cache_read: number; num_turns: number; context_window: number }
    | undefined;
  if (!row) return undefined;
  const perTurn = (row.cache_read + row.cache_creation) / Math.max(row.num_turns, 1);
  return { tokens: Math.round(row.input_tokens + perTurn), window: row.context_window };
}

// --- Session rotation inputs (src/rotation.ts) --------------------------------

export interface LastContext {
  tokens: number;
  /** 'exact' from the SDK's context report; 'est' from the per-run sums divided by the run's calls. */
  source: 'exact' | 'est';
}

/**
 * The session's live context after its LAST turn. Exact when the turn stored
 * the SDK's `getContextUsage` total; otherwise the same estimate as
 * `latestContextInfo` — the per-run cache sums are summed across every
 * internal API call, so `input + (read + created) / num_turns` is the live
 * window and `input + read + created` is the bill, ~num_turns× larger (the
 * first rotation rule read the bill and called 204k "612k"). 0 never ran.
 */
export function lastTurnContextTokens(sessionKey: string): LastContext {
  const row = db
    .prepare(
      `SELECT input_tokens, cache_creation, cache_read, num_turns, context_tokens
         FROM usage WHERE session_key = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(sessionKey) as
    | { input_tokens: number; cache_creation: number; cache_read: number; num_turns: number; context_tokens: number }
    | undefined;
  if (!row) return { tokens: 0, source: 'est' };
  if (row.context_tokens > 0) return { tokens: row.context_tokens, source: 'exact' };
  const perTurn = (row.cache_read + row.cache_creation) / Math.max(row.num_turns, 1);
  return { tokens: Math.round(row.input_tokens + perTurn), source: 'est' };
}

/**
 * A 'user' row the PERSON produced. `source` is authoritative where it exists;
 * rows from before the column fall back to the bracket sniff ([SYSTEM EVENT],
 * [COMMITMENT …], [PULSE] were the machine's) — the only place that sniff is
 * still allowed, and only for legacy rows.
 */
const HUMAN_ROW = "role = 'user' AND (source = 'human' OR (source IS NULL AND content NOT LIKE '[%'))";

/**
 * When the HUMAN last spoke in a session, UTC — or undefined if never. A
 * machine-composed turn does not make the person "active". `skipNewest` drops
 * the most recent row, for a caller whose own message has already been logged.
 */
export function lastHumanMessageAt(sessionKey: string, skipNewest = false): string | undefined {
  const row = db
    .prepare(`SELECT created_at FROM messages WHERE session_key = ? AND ${HUMAN_ROW} ORDER BY id DESC LIMIT 1 OFFSET ?`)
    .get(sessionKey, skipNewest ? 1 : 0) as { created_at: string } | undefined;
  return row?.created_at;
}

export interface HumanMessage {
  /** Wall-clock time in the process's local zone, HH:MM — for a person to read. */
  at: string;
  content: string;
}

/** The last `n` human messages of a session, oldest first, for a handoff. */
export function recentHumanMessages(sessionKey: string, n: number): HumanMessage[] {
  const rows = db
    .prepare(
      `SELECT strftime('%H:%M', created_at, 'localtime') AS at, content FROM messages
        WHERE session_key = ? AND ${HUMAN_ROW} ORDER BY id DESC LIMIT ?`,
    )
    .all(sessionKey, n) as HumanMessage[];
  return rows.reverse();
}

/** The last `n` assistant messages of a session, oldest first — what it last said. */
export function recentAssistantMessages(sessionKey: string, n: number): HumanMessage[] {
  const rows = db
    .prepare(
      `SELECT strftime('%H:%M', created_at, 'localtime') AS at, content FROM messages
        WHERE session_key = ? AND role = 'assistant' ORDER BY id DESC LIMIT ?`,
    )
    .all(sessionKey, n) as HumanMessage[];
  return rows.reverse();
}

export interface TouchedCommitment {
  id: number;
  label: string;
  due_at: string;
  status: string;
}

/** Commitments created, fired or resolved since a UTC time — what a session just did. */
export function commitmentsTouchedSince(chatId: number, sinceUtc: string): TouchedCommitment[] {
  return db
    .prepare(
      `SELECT id, label, due_at, status FROM commitments
        WHERE chat_id = ? AND (created_at >= ? OR resolved_at >= ? OR last_fired_at >= ?)
        ORDER BY id`,
    )
    .all(chatId, sinceUtc, sinceUtc, sinceUtc) as TouchedCommitment[];
}

/** Note keys a session wrote since a UTC time (from the tool-call log). */
export function notesWrittenSince(sessionKey: string, sinceUtc: string): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT target FROM tool_calls
          WHERE session_key = ? AND tool = 'writeNote' AND at >= ? AND target <> ''
          ORDER BY target`,
      )
      .all(sessionKey, sinceUtc) as { target: string }[]
  ).map((r) => r.target);
}

/** Rotation events in a window (source 'rotation'), oldest first. */
export function rotationEventsBetween(chatId: number, fromUtc: string, toUtc: string): { body: string; created_at: string }[] {
  return db
    .prepare(
      `SELECT body, created_at FROM events
        WHERE chat_id = ? AND source = 'rotation' AND created_at >= ? AND created_at <= ?
        ORDER BY id`,
    )
    .all(chatId, fromUtc, toUtc) as { body: string; created_at: string }[];
}

/** Restart-recovery events (dispatch.recoverAfterRestart) in a window — what
 *  cycleCli's RESTARTS line counts. Same shape as the rotation query above. */
export function restartEventsBetween(chatId: number, fromUtc: string, toUtc: string): { body: string; created_at: string }[] {
  return db
    .prepare(
      `SELECT body, created_at FROM events
        WHERE chat_id = ? AND source = 'restart' AND created_at >= ? AND created_at <= ?
        ORDER BY id`,
    )
    .all(chatId, fromUtc, toUtc) as { body: string; created_at: string }[];
}

export interface UsageSummary {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  models: string[];
}

/** Aggregate usage across a chat (optionally a single session). Ad-hoc query. */
export function usageSummary(chatId: number, sessionKey?: string): UsageSummary {
  const like = `${chatId}:%`;
  const where = sessionKey ? 'session_key = ?' : 'session_key LIKE ?';
  const arg = sessionKey ?? like;
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS turns, COALESCE(SUM(input_tokens),0) AS i,
              COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(cache_read),0) AS cr,
              COALESCE(SUM(cost_usd),0) AS cost
       FROM usage WHERE ${where}`,
    )
    .get(arg) as { turns: number; i: number; o: number; cr: number; cost: number };
  const models = (
    db
      .prepare(`SELECT DISTINCT model FROM usage WHERE ${where} AND model <> ''`)
      .all(arg) as Array<{ model: string }>
  ).map((r) => r.model);
  return {
    turns: agg.turns,
    inputTokens: agg.i,
    outputTokens: agg.o,
    cacheReadTokens: agg.cr,
    costUsd: agg.cost,
    models,
  };
}

export interface StatsRollup {
  total: { turns: number; inputTokens: number; outputTokens: number; costUsd: number; costToday: number };
  byArea: Array<{ area: string; runs: number; costUsd: number }>;
  topSessions: Array<{ slot: number; costUsd: number; turns: number }>;
  models: string[];
}

// /stats areas are the cost roles (costRoleOf) under display names — one
// classifier, so a :brief row can never read as a Worker here and a role in
// cycleCli's COST line. Folded in JS over per-key sums.
const AREA_NAME: Record<CostRole, string> = {
  concierge: 'Concierge',
  worker: 'Workers',
  night: 'Night',
  brief: 'Brief',
  other: 'Other',
};

/** The full /stats rollup for a chat: totals, per-area, top sessions, models. */
export function statsRollup(chatId: number): StatsRollup {
  const like = `${chatId}:%`;
  const total = db
    .prepare(
      `SELECT COUNT(*) AS turns, COALESCE(SUM(input_tokens),0) AS i,
              COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(cost_usd),0) AS cost,
              COALESCE(SUM(CASE WHEN date(created_at,'localtime')=date('now','localtime')
                                THEN cost_usd ELSE 0 END),0) AS today
       FROM usage WHERE session_key LIKE ?`,
    )
    .get(like) as { turns: number; i: number; o: number; cost: number; today: number };

  const perKey = db
    .prepare(`SELECT session_key, COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost FROM usage WHERE session_key LIKE ? GROUP BY session_key`)
    .all(like) as Array<{ session_key: string; runs: number; cost: number }>;
  const areas = new Map<string, { area: string; runs: number; cost: number }>();
  for (const k of perKey) {
    const area = AREA_NAME[costRoleOf(k.session_key)];
    const a = areas.get(area) ?? { area, runs: 0, cost: 0 };
    a.runs += k.runs;
    a.cost += k.cost;
    areas.set(area, a);
  }
  const byArea = [...areas.values()].sort((x, y) => y.cost - x.cost);

  // Top worker sessions by cost (numeric slot ≥ 0 only).
  const topSessions = db
    .prepare(
      `SELECT CAST(substr(session_key, instr(session_key, ':') + 1) AS INTEGER) AS slot,
              COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS turns
       FROM usage
       WHERE session_key LIKE ?
         AND substr(session_key, instr(session_key, ':') + 1) GLOB '[0-9]*'
       GROUP BY session_key ORDER BY cost DESC LIMIT 5`,
    )
    .all(like) as Array<{ slot: number; cost: number; turns: number }>;

  const models = (
    db
      .prepare(`SELECT DISTINCT model FROM usage WHERE session_key LIKE ? AND model <> ''`)
      .all(like) as Array<{ model: string }>
  ).map((r) => r.model);

  return {
    total: { turns: total.turns, inputTokens: total.i, outputTokens: total.o, costUsd: total.cost, costToday: total.today },
    byArea: byArea.map((a) => ({ area: a.area, runs: a.runs, costUsd: a.cost })),
    topSessions: topSessions.map((s) => ({ slot: s.slot, costUsd: s.cost, turns: s.turns })),
    models,
  };
}

// ---------------------------------------------------------------------------
// STORY NODES (round 11, P1) — the narrative layer over the graph.
//
// The graph holds facts; nothing holds the through-line. 246 retrieval
// episodes said the day does not REACH for a memory it must query (228
// no-reach), while the one injected render steers behaviour nightly — so the
// story is built to be PUSHED: a budgeted root narrative over per-domain
// sub-stories, rewritten by the night, spliced into root.md and story.md.
// These rows are a RENDER's source of truth for dirtiness and text, never a
// store of facts (I1/I2): every claim in `text` must carry a [[ref]] into the
// graph, enforced at the write tool, and the whole layer is droppable.
// `dirty` is the mechanical half: a graph write marks the touched domain's
// node and its ancestors, and the night rewrites dirty paths bottom-up.
db.exec(`
  CREATE TABLE IF NOT EXISTS story_nodes (
    id         TEXT PRIMARY KEY,
    parent_id  TEXT,
    scope      TEXT NOT NULL,
    text       TEXT NOT NULL DEFAULT '',
    dirty      INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT
  );
`);

export interface StoryNode {
  id: string;
  parent_id: string | null;
  scope: string;
  text: string;
  dirty: number;
  updated_at: string | null;
}

export function listStoryNodes(): StoryNode[] {
  return db.prepare('SELECT * FROM story_nodes ORDER BY id').all() as StoryNode[];
}

export function getStoryNode(id: string): StoryNode | undefined {
  return db.prepare('SELECT * FROM story_nodes WHERE id = ?').get(id) as StoryNode | undefined;
}

/** Create a node if absent. Never touches an existing row — the night's text
 *  survives every ensure pass. */
export function ensureStoryNode(id: string, parentId: string | null, scope: string): void {
  db.prepare('INSERT OR IGNORE INTO story_nodes (id, parent_id, scope) VALUES (?, ?, ?)').run(id, parentId, scope);
}

/** Mark a node and every ancestor dirty — the instant, mechanical half of the
 *  story's maintenance; the rewrite itself is the night's. */
export function markStoryPathDirty(id: string): void {
  const mark = db.prepare('UPDATE story_nodes SET dirty = 1 WHERE id = ?');
  let cur: StoryNode | undefined = getStoryNode(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    mark.run(cur.id);
    cur = cur.parent_id ? getStoryNode(cur.parent_id) : undefined;
  }
}

/** Remove a node outright. Nothing on the live path calls this — retiring a
 *  story is a judgement (an orphan flagged by the lint), not a sync — but the
 *  operator and the suite need a door that is not raw SQL. */
/** No production caller today (tests, and the future retire path's door). A
 *  caller that deletes a node with text must also `invalidateStoryRefs()` —
 *  the offered-set cache in storyTree does not watch this table. */
export function deleteStoryNode(id: string): void {
  db.prepare('DELETE FROM story_nodes WHERE id = ?').run(id);
}

/** Save a rewritten node: text in, dirty cleared, stamped. Validation happens
 *  at the tool that calls this — by mechanism, before the row moves. */
export function saveStoryText(id: string, text: string): boolean {
  const r = db
    .prepare("UPDATE story_nodes SET text = ?, dirty = 0, updated_at = datetime('now') WHERE id = ?")
    .run(text, id);
  return r.changes > 0;
}

// ---------------------------------------------------------------------------
// WHAT MEHDI DATED (src/dated.ts). On 2026-10-03 the whole of the next day —
// checkout, a film, a flight — was agreed in the concierge's transcript, the
// night cleared that transcript and judged the turns "transient logistics,
// nothing to file" (dream #121), and the morning offered sightseeing on
// departure day. The night was right by its own filing options: graph facts
// and open loops. A plan for a NAMED DAY is a third thing, and the only
// surface that reaches the next session is a commitment due that day. These
// rows make the verdict mandatory, the way door_decisions did for re-reads.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS dated_verdicts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL DEFAULT (datetime('now')),
    message_id  INTEGER NOT NULL,
    decision    TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    dream_id    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_dated_verdicts_msg ON dated_verdicts(message_id, at);
`);

export interface HumanMessageRow {
  id: number;
  /** Local wall-clock 'YYYY-MM-DD HH:MM' — the day the person was living in. */
  at: string;
  content: string;
}

/** Human messages in the window, oldest first — the person's own words, never the machine's. */
export function humanMessagesBetween(chatId: number, from: string, to: string, limit = 400): HumanMessageRow[] {
  return db
    .prepare(
      `SELECT id, strftime('%Y-%m-%d %H:%M', created_at, 'localtime') AS at, content FROM messages
        WHERE session_key LIKE ? AND created_at > ? AND created_at <= ? AND ${HUMAN_ROW}
        ORDER BY id LIMIT ?`,
    )
    .all(`${chatId}:%`, from, to, limit) as HumanMessageRow[];
}

export function humanMessagesById(ids: number[]): HumanMessageRow[] {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT id, strftime('%Y-%m-%d %H:%M', created_at, 'localtime') AS at, content FROM messages WHERE id IN (${marks}) ORDER BY id`)
    .all(...ids) as HumanMessageRow[];
}

export interface DueOnDayRow {
  id: number;
  label: string;
  status: string;
  /** Local HH:MM. */
  at: string;
}

/** Every commitment (any status) due on one LOCAL day — what the table already holds for that day. */
export function commitmentsDueOnLocalDay(chatId: number, day: string): DueOnDayRow[] {
  return db
    .prepare(
      `SELECT id, label, status, strftime('%H:%M', due_at, 'localtime') AS at FROM commitments
        WHERE chat_id = ? AND strftime('%Y-%m-%d', due_at, 'localtime') = ? ORDER BY due_at`,
    )
    .all(chatId, day) as DueOnDayRow[];
}

export interface DatedVerdictRow {
  at: string;
  message_id: number;
  decision: string;
  note: string;
  dream_id: number | null;
}

export function recordDatedVerdict(messageId: number, decision: string, note = ''): number {
  return Number(
    db.prepare('INSERT INTO dated_verdicts (message_id, decision, note) VALUES (?, ?, ?)').run(messageId, decision, note.slice(0, 300)).lastInsertRowid,
  );
}

export function hasOfferedDated(messageId: number): boolean {
  return !!db.prepare("SELECT 1 FROM dated_verdicts WHERE message_id = ? AND decision = 'offered' LIMIT 1").get(messageId);
}

/** One verdict per message per pass: a pass that reconsiders overwrites itself. */
export function supersedeDatedVerdict(messageId: number): void {
  db.prepare("DELETE FROM dated_verdicts WHERE message_id = ? AND decision != 'offered' AND dream_id IS NULL").run(messageId);
}

export function stampDatedVerdicts(dreamId: number, since: string): void {
  db.prepare('UPDATE dated_verdicts SET dream_id = ? WHERE dream_id IS NULL AND at >= ?').run(dreamId, since);
}

export function deleteUnstampedDatedVerdicts(since: string): number {
  return db.prepare('DELETE FROM dated_verdicts WHERE dream_id IS NULL AND at >= ?').run(since).changes;
}

export function datedVerdictsBetween(from: string, to: string): DatedVerdictRow[] {
  return db
    .prepare('SELECT at, message_id, decision, note, dream_id FROM dated_verdicts WHERE at >= ? AND at <= ? ORDER BY at')
    .all(from, to) as DatedVerdictRow[];
}

/** Statements offered on a PAST pass that never got a verdict — carried until judged. */
export function undecidedDatedMessageIds(before: string): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT message_id FROM dated_verdicts o WHERE decision = 'offered' AND at < ?
         AND NOT EXISTS (SELECT 1 FROM dated_verdicts d WHERE d.message_id = o.message_id AND d.decision != 'offered')`,
      )
      .all(before) as Array<{ message_id: number }>
  ).map((r) => r.message_id);
}

// ---------------------------------------------------------------------------
// DESIGN PROPOSALS — the channel between the bot and its developer.
//
// The day (a conversation like 2026-10-20's "the morning routine no longer
// works for me"), the night (friction evidence) and a developer session each
// reach the same row. The row is the ONE home (I1): the 2026-10-20 ledger
// proposal was written as an untracked file because the concierge had no
// tool for a design-level proposal, and a file has no evidence trail, no
// amendment, no merge. Evidence is append-only and ref-carrying (I4). Only a
// developer session moves a row past `open` — the actor is the developer,
// enforced here rather than asked of the prompt (I9). `findings` of kind
// 'proposal' stay what they are: the night's small code fixes with a verify.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS design_proposals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    problem      TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',
    -- the invariant(s) / milestone the proposer thinks it serves
    cites        TEXT NOT NULL DEFAULT '',
    -- open | accepted | landed | verified | rejected | merged
    status       TEXT NOT NULL DEFAULT 'open',
    created_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    -- the developer's idea-test verdict, verbatim; set on accept/reject
    decision     TEXT,
    decided_at   TEXT,
    -- a read-only command that prints something once the change has shipped
    verify       TEXT,
    verdict      TEXT,
    verified_at  TEXT,
    landed_ref   TEXT,
    merged_into  INTEGER
  );
  CREATE TABLE IF NOT EXISTS proposal_evidence (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id  INTEGER NOT NULL,
    at           TEXT NOT NULL DEFAULT (datetime('now')),
    actor        TEXT NOT NULL,
    -- message | episode | friction | measure | note | amend
    kind         TEXT NOT NULL,
    ref          TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_proposal_evidence ON proposal_evidence(proposal_id, id);
`);

export type ProposalStatus = 'open' | 'accepted' | 'landed' | 'verified' | 'rejected' | 'merged';
export const PROPOSAL_STATUSES: ProposalStatus[] = ['open', 'accepted', 'landed', 'verified', 'rejected', 'merged'];
export type ProposalActor = 'day' | 'night' | 'developer';
export type EvidenceKind = 'message' | 'episode' | 'friction' | 'measure' | 'note' | 'amend';

export interface DesignProposalRow {
  id: number;
  title: string;
  problem: string;
  body: string;
  cites: string;
  status: ProposalStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  decision: string | null;
  decided_at: string | null;
  verify: string | null;
  verdict: string | null;
  verified_at: string | null;
  landed_ref: string | null;
  merged_into: number | null;
  evidence_count: number;
  last_evidence_at: string | null;
}

export interface ProposalEvidenceRow {
  id: number;
  proposal_id: number;
  at: string;
  actor: string;
  kind: EvidenceKind;
  ref: string;
  text: string;
}

const PROPOSAL_SELECT = `
  SELECT p.*,
         (SELECT COUNT(*) FROM proposal_evidence e WHERE e.proposal_id = p.id) AS evidence_count,
         (SELECT MAX(at) FROM proposal_evidence e WHERE e.proposal_id = p.id) AS last_evidence_at
  FROM design_proposals p`;

export function createDesignProposal(p: {
  title: string;
  problem: string;
  body?: string;
  cites?: string;
  verify?: string;
  actor: ProposalActor;
}): number {
  return Number(
    db
      .prepare('INSERT INTO design_proposals (title, problem, body, cites, verify, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.title.trim(), p.problem.trim(), (p.body ?? '').trim(), (p.cites ?? '').trim(), p.verify?.trim() || null, p.actor).lastInsertRowid,
  );
}

export function getDesignProposal(id: number): (DesignProposalRow & { evidence: ProposalEvidenceRow[] }) | undefined {
  const row = db.prepare(`${PROPOSAL_SELECT} WHERE p.id = ?`).get(id) as DesignProposalRow | undefined;
  if (!row) return undefined;
  const evidence = db.prepare('SELECT * FROM proposal_evidence WHERE proposal_id = ? ORDER BY id').all(id) as ProposalEvidenceRow[];
  return { ...row, evidence };
}

/** Newest first. With no filter: everything that is not closed. */
export function listDesignProposals(statuses?: ProposalStatus[]): DesignProposalRow[] {
  const want = statuses?.length ? statuses : (['open', 'accepted', 'landed'] as ProposalStatus[]);
  const marks = want.map(() => '?').join(',');
  return db.prepare(`${PROPOSAL_SELECT} WHERE p.status IN (${marks}) ORDER BY p.id DESC`).all(...want) as DesignProposalRow[];
}

export function addProposalEvidence(e: { proposalId: number; actor: ProposalActor; kind: EvidenceKind; ref?: string; text: string }): number {
  const id = Number(
    db
      .prepare('INSERT INTO proposal_evidence (proposal_id, actor, kind, ref, text) VALUES (?, ?, ?, ?, ?)')
      .run(e.proposalId, e.actor, e.kind, (e.ref ?? '').trim(), e.text.trim()).lastInsertRowid,
  );
  db.prepare("UPDATE design_proposals SET updated_at = datetime('now') WHERE id = ?").run(e.proposalId);
  return id;
}

/**
 * Change the proposal's text. The old text is not lost: the amendment is an
 * evidence row of kind 'amend' carrying the note and what changed, so a
 * perspective that moved is a trail, not an overwrite.
 */
export function amendDesignProposal(
  id: number,
  changes: { title?: string; problem?: string; body?: string; cites?: string; verify?: string; appendBody?: string },
  actor: ProposalActor,
  note: string,
): boolean {
  const cur = db.prepare('SELECT * FROM design_proposals WHERE id = ?').get(id) as DesignProposalRow | undefined;
  if (!cur) return false;
  const body = changes.body !== undefined ? changes.body : changes.appendBody ? `${cur.body.trimEnd()}\n\n${changes.appendBody.trim()}` : cur.body;
  db.prepare(
    "UPDATE design_proposals SET title = ?, problem = ?, body = ?, cites = ?, verify = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(
    changes.title ?? cur.title,
    changes.problem ?? cur.problem,
    body,
    changes.cites ?? cur.cites,
    changes.verify !== undefined ? changes.verify.trim() || null : cur.verify,
    id,
  );
  const touched = Object.keys(changes).filter((k) => (changes as Record<string, unknown>)[k] !== undefined);
  addProposalEvidence({ proposalId: id, actor, kind: 'amend', ref: touched.join(','), text: note });
  return true;
}

/** Only the developer moves a row past `open`; the day and the night may only open, amend, evidence and merge. */
export function setDesignProposalStatus(
  id: number,
  status: ProposalStatus,
  extra: { decision?: string; landedRef?: string; mergedInto?: number } = {},
): boolean {
  const r = db
    .prepare(
      `UPDATE design_proposals
         SET status = ?, updated_at = datetime('now'),
             decision = COALESCE(?, decision),
             decided_at = CASE WHEN ? IN ('accepted','rejected') THEN datetime('now') ELSE decided_at END,
             landed_ref = COALESCE(?, landed_ref),
             merged_into = COALESCE(?, merged_into)
       WHERE id = ?`,
    )
    .run(status, extra.decision ?? null, status, extra.landedRef ?? null, extra.mergedInto ?? null, id);
  return r.changes > 0;
}

/** Fold one proposal into another: its evidence moves, its text is kept as an
 *  amendment on the target, and the source is marked merged. */
export function mergeDesignProposals(fromId: number, intoId: number, actor: ProposalActor, note: string): boolean {
  const from = getDesignProposal(fromId);
  const into = getDesignProposal(intoId);
  if (!from || !into || fromId === intoId || from.status === 'merged') return false;
  db.transaction(() => {
    db.prepare('UPDATE proposal_evidence SET proposal_id = ? WHERE proposal_id = ?').run(intoId, fromId);
    addProposalEvidence({
      proposalId: intoId,
      actor,
      kind: 'amend',
      ref: `merged #${fromId}`,
      text: `${note}\n\n--- merged from #${fromId} "${from.title}" ---\n${from.problem}\n\n${from.body}`.trim(),
    });
    setDesignProposalStatus(fromId, 'merged', { mergedInto: intoId });
  })();
  return true;
}

export function recordDesignProposalVerdict(id: number, verdict: string): void {
  db.prepare("UPDATE design_proposals SET verdict = ?, verified_at = datetime('now') WHERE id = ?").run(verdict, id);
}

// ---------------------------------------------------------------------------
// THE WATCH LEDGER — design proposal #1 (2026-10-30). A watched item keeps a
// HEAD (the glance, on the commitment row) and a LOG (the depth, here). The
// check writes both; the concierge reads heads on its own cadence and opens a
// log only when a head says to. Recording a change and judging it are two
// jobs again. Only a parsed value reaches the ledger (I3).
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS watch_ledger (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id  INTEGER NOT NULL,
    at       TEXT NOT NULL DEFAULT (datetime('now')),
    kind     TEXT NOT NULL,
    payload  TEXT NOT NULL,
    seen     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_watch_ledger_item ON watch_ledger(item_id, id);
`);

/** Rows kept per item — the log is append-only and must still converge (I6). */
export const LEDGER_ROWS_PER_ITEM = 200;

export interface WatchLedgerRow {
  id: number;
  item_id: number;
  at: string;
  kind: string;
  payload: string;
  seen: number;
}

export interface LedgerHead {
  id: number;
  chat_id: number;
  label: string;
  focus: number;
  focus_band: string | null;
  ref: string | null;
  watch_mode: string | null;
  head: unknown;
  last_checked_at: string | null;
  unseen: number;
  /** Clock-only item: no check_cmd, so the head is whatever was last written by hand (or nothing). */
  has_check: boolean;
}

export function setWatchMode(id: number, chatId: number, mode: string | null): boolean {
  return db.prepare('UPDATE commitments SET watch_mode = ? WHERE id = ? AND chat_id = ? AND status = \'open\'').run(mode?.trim() || null, id, chatId).changes > 0;
}

export function setWatchHead(id: number, head: unknown): void {
  db.prepare("UPDATE commitments SET watch_head = ?, last_checked_at = datetime('now') WHERE id = ?").run(JSON.stringify(head), id);
}

export function appendWatchLog(itemId: number, kind: string, payload: unknown): number {
  const id = Number(db.prepare('INSERT INTO watch_ledger (item_id, kind, payload) VALUES (?, ?, ?)').run(itemId, kind.slice(0, 40), JSON.stringify(payload)).lastInsertRowid);
  db.prepare('DELETE FROM watch_ledger WHERE item_id = ? AND id <= (SELECT id FROM watch_ledger WHERE item_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(itemId, itemId, LEDGER_ROWS_PER_ITEM);
  return id;
}

/** The glance: every open watched item that is on the ledger (has a head or a
 *  mode), with its unseen log count. Loudest band first, then most recently moved. */
export function ledgerHeads(chatId: number): LedgerHead[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.chat_id, c.label, c.focus, c.focus_band, c.ref, c.watch_mode, c.watch_head, c.last_checked_at,
              (c.check_cmd IS NOT NULL) AS has_check,
              (SELECT COUNT(*) FROM watch_ledger l WHERE l.item_id = c.id AND l.seen = 0) AS unseen
         FROM commitments c
        WHERE c.chat_id = ? AND c.status = 'open' AND c.how_to_check IS NOT NULL
          AND (c.watch_head IS NOT NULL OR c.watch_mode IS NOT NULL)
        ORDER BY CASE WHEN c.focus = 0 THEN 99 ELSE c.focus END, unseen DESC, c.last_checked_at DESC`,
    )
    .all(chatId) as Array<Omit<LedgerHead, 'head' | 'has_check'> & { watch_head: string | null; has_check: number }>;
  return rows.map((r) => {
    let head: unknown = null;
    try {
      head = r.watch_head ? JSON.parse(r.watch_head) : null;
    } catch {
      head = r.watch_head;
    }
    return { ...r, head, has_check: r.has_check === 1 };
  });
}

export function ledgerLog(itemId: number, n = 20): WatchLedgerRow[] {
  return db.prepare('SELECT * FROM watch_ledger WHERE item_id = ? ORDER BY id DESC LIMIT ?').all(itemId, Math.max(1, Math.min(200, n))) as WatchLedgerRow[];
}

/** Mark an item's log rows seen (all of them, or up to and including `uptoId`). */
export function ledgerAck(itemId: number, uptoId?: number): number {
  return uptoId
    ? db.prepare('UPDATE watch_ledger SET seen = 1 WHERE item_id = ? AND id <= ? AND seen = 0').run(itemId, uptoId).changes
    : db.prepare('UPDATE watch_ledger SET seen = 1 WHERE item_id = ? AND seen = 0').run(itemId).changes;
}

// ---------------------------------------------------------------------------
// LIFE UPKEEP — design proposal #7 (accepted 2026-11-13, narrowed). Item
// definitions and done-events live HERE, not in the graph: a "last done" time
// is an event log, and a node per chore would carry no facts (I1). Freshness
// and house health are never stored — `src/life.ts` derives them on read (I2).
// The concept, the tier design and why, lives in `personal/house-upkeep`.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS life_items (
    id             TEXT PRIMARY KEY,
    label          TEXT NOT NULL,
    tier           INTEGER NOT NULL CHECK (tier IN (1, 2)),
    -- tier 1: the cadence in days (due once this old); tier 2: the decay half-life
    days           REAL NOT NULL CHECK (days > 0),
    weight         REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
    aka            TEXT NOT NULL DEFAULT '[]',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS life_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id   TEXT NOT NULL REFERENCES life_items(id),
    at        TEXT NOT NULL,
    source    TEXT NOT NULL CHECK (source IN ('voice', 'text', 'other')),
    msg_id    INTEGER,
    logged_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_life_log_item ON life_log(item_id, at);
  CREATE TABLE IF NOT EXISTS life_params (
    key   TEXT PRIMARY KEY,
    value REAL NOT NULL
  );
`);

/** The seed, from msg#5486 (1 Aug) and msg#16935. Tunable afterwards; INSERT OR IGNORE never resets a tuned row. */
const LIFE_SEED: Array<[id: string, label: string, tier: 1 | 2, days: number, aka: string[]]> = [
  ['dishes', 'dishes and sink', 1, 1, ['dishes', 'sink', 'did the dishes', 'washing up']],
  ['teeth', 'teeth', 1, 1, ['brushed', 'brush teeth', 'floss']],
  ['bath', 'bath / shower', 1, 1, ['shower', 'showered', 'bathed']],
  ['haircut', 'haircut', 1, 28, ['hair', 'barber']],
  ['vacuum', 'vacuum and dust', 2, 7, ['vacuumed', 'dust', 'dusted', 'hoover']],
  ['toilet', 'toilet', 2, 7, ['bathroom', 'wc']],
  ['trash', 'trash can', 2, 4, ['garbage', 'bin', 'took out the trash']],
  ['stove', 'stove', 2, 14, ['cooktop', 'hob', 'oven']],
  ['fridge', 'inside the fridge', 2, 30, ['refrigerator']],
  ['windows', 'windows', 2, 60, ['window', 'glass']],
];
// IMMEDIATE, and in one transaction: every process imports this file, and an
// autocommit INSERT in WAL mode reads first and upgrades to a write lock — an
// upgrade that fails "database is locked" WITHOUT waiting on busy_timeout when
// another process committed in between. Six processes booting a fresh database
// at once (test/schema.test.ts) lost that race. Taking the write lock up front
// makes the busy handler apply.
db.transaction(() => {
  const ins = db.prepare('INSERT OR IGNORE INTO life_items (id, label, tier, days, aka) VALUES (?, ?, ?, ?, ?)');
  for (const [id, label, tier, days, aka] of LIFE_SEED) ins.run(id, label, tier, days, JSON.stringify(aka));
  const p = db.prepare('INSERT OR IGNORE INTO life_params (key, value) VALUES (?, ?)');
  p.run('target', 0.85);
  p.run('threshold', 0.75);
}).immediate();

export interface LifeItem {
  id: string;
  label: string;
  tier: 1 | 2;
  days: number;
  weight: number;
  aka: string[];
  /** UTC, the most recent done-event — or null if never logged. */
  last_at: string | null;
}

export function lifeItems(): LifeItem[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.label, i.tier, i.days, i.weight, i.aka,
              (SELECT MAX(at) FROM life_log l WHERE l.item_id = i.id) AS last_at
         FROM life_items i ORDER BY i.tier, i.days, i.id`,
    )
    .all() as Array<Omit<LifeItem, 'aka'> & { aka: string }>;
  return rows.map((r) => ({ ...r, aka: JSON.parse(r.aka) as string[] }));
}

export function logLifeDone(itemId: string, atUtc: string, source: 'voice' | 'text' | 'other', msgId?: number): number {
  return Number(db.prepare('INSERT INTO life_log (item_id, at, source, msg_id) VALUES (?, ?, ?, ?)').run(itemId, atUtc, source, msgId ?? null).lastInsertRowid);
}

/** Done-events logged since `sinceUtc`, by source — the number proposal #7 is judged by. */
export function lifeLogCounts(sinceUtc: string, untilUtc = '9999-12-31 23:59:59'): { voice: number; text: number; other: number; total: number } {
  const rows = db
    .prepare('SELECT source, COUNT(*) AS n FROM life_log WHERE logged_at > ? AND logged_at <= ? GROUP BY source')
    .all(sinceUtc, untilUtc) as Array<{ source: string; n: number }>;
  const out = { voice: 0, text: 0, other: 0, total: 0 };
  for (const r of rows) {
    out[r.source as 'voice' | 'text' | 'other'] = r.n;
    out.total += r.n;
  }
  return out;
}

export function lifeParams(): { target: number; threshold: number } {
  const rows = db.prepare('SELECT key, value FROM life_params').all() as Array<{ key: string; value: number }>;
  const m = new Map(rows.map((r) => [r.key, r.value]));
  return { target: m.get('target') ?? 0.85, threshold: m.get('threshold') ?? 0.75 };
}

export function setLifeParam(key: 'target' | 'threshold', value: number): void {
  db.prepare('INSERT INTO life_params (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function tuneLifeItem(id: string, field: 'days' | 'weight' | 'tier', value: number): boolean {
  return db.prepare(`UPDATE life_items SET ${field} = ? WHERE id = ?`).run(value, id).changes > 0;
}

export function addLifeItem(id: string, label: string, tier: 1 | 2, days: number, aka: string[]): boolean {
  return db.prepare('INSERT OR IGNORE INTO life_items (id, label, tier, days, aka) VALUES (?, ?, ?, ?, ?)').run(id, label, tier, days, JSON.stringify(aka)).changes > 0;
}

/** The newest human message of a session — what a capture tool is answering. */
export function lastHumanMessage(sessionKey: string): { id: number; content: string } | undefined {
  return db.prepare(`SELECT id, content FROM messages WHERE session_key = ? AND ${HUMAN_ROW} ORDER BY id DESC LIMIT 1`).get(sessionKey) as
    | { id: number; content: string }
    | undefined;
}

export interface LifeLogRow {
  item_id: string;
  at: string;
  source: string;
}

/** Done-events whose `at` falls in [fromUtc, toUtc), oldest first — what the view draws. */
export function lifeLogBetween(fromUtc: string, toUtc: string): LifeLogRow[] {
  return db.prepare('SELECT item_id, at, source FROM life_log WHERE at >= ? AND at < ? ORDER BY at').all(fromUtc, toUtc) as LifeLogRow[];
}

// ---------------------------------------------------------------------------
// THE BOARD — the day session's patches over the automatic timeline (proposal
// #7, Mehdi 2026-11-13: "it should show something if the day agent didn't
// customize it … and if we asked the day agent it can optimize it, not just
// override it, but fix it"). The automatic layer is DERIVED every read
// (src/board.ts) and never stored (I2); only the concierge's judgements live
// here — an item it added, an automatic item it moved or relabelled, one it
// hid — each with a reason, so the page can say who changed what and why (I10).
// A dated plan is still a commitment (I1): the automatic layer reads them.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS board (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    op          TEXT NOT NULL CHECK (op IN ('add', 'adjust', 'hide')),
    -- adjust/hide: the automatic item's key ("commitment:106@2026-11-17"); add: NULL
    target      TEXT,
    -- local dates YYYY-MM-DD; day_to only for a span (a tier-3 session)
    day         TEXT,
    day_to      TEXT,
    -- local HH:mm
    at          TEXT,
    until       TEXT,
    kind        TEXT,
    label       TEXT,
    ref         TEXT,
    reason      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_board_target ON board(target);
`);

export interface BoardPatch {
  id: number;
  op: 'add' | 'adjust' | 'hide';
  target: string | null;
  day: string | null;
  day_to: string | null;
  at: string | null;
  until: string | null;
  kind: string | null;
  label: string | null;
  ref: string | null;
  reason: string;
  created_at: string;
}

export function addBoardPatch(p: Omit<BoardPatch, 'id' | 'created_at'>): number {
  return Number(
    db
      .prepare('INSERT INTO board (op, target, day, day_to, at, until, kind, label, ref, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.op, p.target, p.day, p.day_to, p.at, p.until, p.kind, p.label, p.ref, p.reason).lastInsertRowid,
  );
}

/** Active patches, oldest first — a later patch on the same target wins. */
export function boardPatches(): BoardPatch[] {
  return db.prepare("SELECT * FROM board WHERE revoked_at IS NULL AND created_at > datetime('now', '-60 days') ORDER BY id").all() as BoardPatch[];
}

export function revokeBoardPatch(id: number): boolean {
  return db.prepare("UPDATE board SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(id).changes > 0;
}

export interface BoardCommitment {
  id: number;
  label: string;
  body: string;
  due_at: string;
  recur: string | null;
}

/**
 * Commitments that could be FOR HIM: open, dated, not a watched check, not the
 * machine's own sweeps (created_by 'system'), not a [CHECK-IN] turn. What is
 * left is still a mix — a bot nudge's due time is when the bot speaks, not when
 * the thing happens — which is exactly what the day session's patches fix.
 */
export function boardCommitments(): BoardCommitment[] {
  return db
    .prepare(
      `SELECT id, label, body, due_at, recur FROM commitments
        WHERE status = 'open' AND due_at IS NOT NULL AND how_to_check IS NULL
          AND created_by <> 'system' AND body NOT LIKE '[CHECK-IN]%'`,
    )
    .all() as BoardCommitment[];
}
