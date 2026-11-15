import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { noteMiss } from './friction.js';
import { buildModuleTools, catalogSection, MODULE_TOOL_NAMES } from './moduleTools.js';
import { buildObserveTool, inboxLine } from './observe.js';
import { config } from './config.js';
import { proposalLine, renderProposal } from './proposals.js';
import { validateWatchMode } from './ledger.js';
import { speak } from './speak.js';
import { pulse } from './pulse.js';
import {
  addCommitment,
  logMessage,
  bumpRetrieval,
  countSessions,
  createSession,
  deferCommitment,
  findThreads,
  getCard,
  getSession,
  clearSession,
  isThreadFresh,
  listCommitments,
  setCommitmentRef,
  setThreadFresh,
  setThreadModel,
  threadModel,
  listSessions,
  markTitleExplicit,
  pendingFindings,
  postEvent,
  rescopeCommitment,
  setFocusFields,
  resolveCommitment,
  searchChatMessages,
  getMessageById,
  recentMessages,
  resolveFinding,
  sessionKey,
  setBrief,
  getPrefs,
  setMode,
  setSessionStatus,
  setSessionTitle,
  addProposalEvidence,
  amendDesignProposal,
  createDesignProposal,
  listDesignProposals,
  PROPOSAL_STATUSES,
  ledgerAck,
  ledgerHeads,
  ledgerLog,
  setWatchMode,
  queuedTurnCount,
  addLifeItem,
  lastHumanMessage,
  lifeItems,
  lifeParams,
  logLifeDone,
  setLifeParam,
  tuneLifeItem,
  addBoardPatch,
  boardCommitments,
  boardPatches,
  revokeBoardPatch,
} from './db.js';
import { BOARD_KINDS, buildBoard, parseBoardDay, renderBoard, validTime } from './board.js';
import { parseDoneWhen, renderLifeState, resolveItem } from './life.js';
import { fmtLocal, parseLocalWhen, toUtcDb } from './commitments.js';
import { checkCommandAllowed, focusLines } from './focus.js';
import { mergedFocusLines } from './focusView.js';
import { todaysEventLines } from './bulletin.js';
import { addPossibility, deleteNote, getNote, recordRootHabit, rootContext, upsertNote } from './knowledge.js';
import { readStory, storyContext } from './storyTree.js';
import { digestFile } from './digest.js';
import { escapeHtml } from './format.js';
import { locateThreadTraces, renderTraces } from './traces.js';
import { findWork } from './discovery.js';
import { workspaceManifest } from './workspace.js';
import { clearPendingApprovals } from './permissions.js';
import { statusMarker, type RunningView } from './sessions.js';
import { cancel as cancelTurn, isBusy as turnBusy } from './turnLock.js';

/** Truncate to n chars with an explicit marker, so the model knows it was cut. */
function capAt(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[truncated ${s.length - n} chars]` : s;
}

/**
 * The concierge — a control agent for the bot itself. It runs in the reserved
 * control thread (slot -1) with these bot-management tools instead of coding
 * tools, so the user can manage threads, settings, and memory by talking.
 *
 * Switching/creating a thread is DEFERRED to after the concierge's reply (see
 * pendingSwitch) so changing the active thread mid-turn doesn't suppress the
 * concierge's own output. Closing a thread is destructive, so it self-confirms
 * with an inline button regardless of what the model decides.
 */

/** Tool names the concierge is allowed to use (an allowlist for its session). */
export const CONCIERGE_TOOLS = [
  'mcp__bot__listThreads',
  'mcp__bot__readThread',
  'mcp__bot__dispatchTask',
  'mcp__bot__stopWorker',
  'mcp__bot__resetThread',
  'mcp__bot__newThread',
  'mcp__bot__switchThread',
  'mcp__bot__renameThread',
  'mcp__bot__updateBrief',
  'mcp__bot__findThread',
  'mcp__bot__setThreadMode',
  'mcp__bot__closeThread',
  'mcp__bot__digestSource',
  'mcp__bot__readNote',
  'mcp__bot__writeNote',
  'mcp__bot__deleteNote',
  'mcp__bot__noteIdea',
  'mcp__bot__observe',
  'mcp__bot__recordBehavior',
  'mcp__bot__searchMessages',
  'mcp__bot__readMessage',
  'mcp__bot__sendVoice',
  'mcp__bot__findPastWork',
  'mcp__bot__locateThreadTrace',
  'mcp__bot__commit',
  'mcp__bot__listCommitments',
  'mcp__bot__readFocus',
  'mcp__bot__readStory',
  'mcp__bot__updateCommitment',
  'mcp__bot__pendingFindings',
  'mcp__bot__resolveFinding',
  ...MODULE_TOOL_NAMES,
  'mcp__telegram__send',
  'mcp__telegram__ask',
  'mcp__telegram__askUserQuestion',
];

// A thread switch the concierge requested, applied by telegram.ts once its turn
// ends. Keyed by chat id.
const pendingSwitch = new Map<number, number>();
export function takePendingSwitch(chatId: number): number | undefined {
  const slot = pendingSwitch.get(chatId);
  pendingSwitch.delete(chatId);
  return slot;
}

// A task to seed into a thread as its first turn after the switch — the
// concierge delegating work to a worker thread, so the user never re-pastes.
const pendingSeed = new Map<number, { slot: number; text: string }>();
export function takePendingSeed(chatId: number): { slot: number; text: string } | undefined {
  const seed = pendingSeed.get(chatId);
  pendingSeed.delete(chatId);
  return seed;
}

// Fire-and-forget tasks: run on a worker headless while the user stays with the
// concierge (the "dispatch + detach" move). Applied by telegram.ts after the
// concierge's turn, without switching the active thread.
const pendingDispatch = new Map<number, Array<{ slot: number; text: string }>>();
export function takePendingDispatch(chatId: number): Array<{ slot: number; text: string }> {
  const list = pendingDispatch.get(chatId) ?? [];
  pendingDispatch.delete(chatId);
  return list;
}

// Destructive-action confirmations, resolved by an inline button tap.
const pendingConfirm = new Map<string, (yes: boolean) => void>();
let cseq = 0;
export function resolveConfirm(id: string, yes: boolean): boolean {
  const resolve = pendingConfirm.get(id);
  if (!resolve) return false;
  pendingConfirm.delete(id);
  resolve(yes);
  return true;
}

// The bounded attention set: which active threads earn a context card in the
// concierge's prompt. Running threads + threads with an open waiting item +
// the most recently active — everything else is a count line (findThread digs).
const ATTENTION_RECENT = 10;

export interface AttentionSet {
  /** Cards in the set, most recently active first. */
  cards: Array<{ slot: number; title: string; running: boolean; brief?: string; recap?: string; last_active: string }>;
  /** Active threads NOT in the set. */
  activeRest: number;
  /** Archived + legacy-closed threads. */
  archived: number;
}

export function attentionSet(chatId: number): AttentionSet {
  const active = [...listSessions(chatId, 'active')].sort((a, b) => b.last_active.localeCompare(a.last_active));
  const committed = new Set(
    listCommitments(chatId)
      .map((c) => c.thread_slot)
      .filter((s): s is number => s !== null && s !== undefined),
  );
  const cards: AttentionSet['cards'] = [];
  let activeRest = 0;
  active.forEach((t, i) => {
    const running = statusMarker(chatId, t.slot) !== '';
    if (running || committed.has(t.slot) || i < ATTENTION_RECENT) {
      const c = getCard(chatId, t.slot);
      cards.push({ slot: t.slot, title: t.title, running, brief: c?.brief, recap: c?.recap, last_active: t.last_active });
    } else {
      activeRest++;
    }
  });
  const archived = countSessions(chatId, 'archived') + countSessions(chatId, 'closed');
  return { cards, activeRest, archived };
}

/** One prompt/display line per card: title + state + brief head + latest recap. */
export function renderCard(c: AttentionSet['cards'][number]): string {
  const state = c.running ? '🟢 running' : `idle since ${c.last_active.slice(0, 10)}`;
  const briefHead = c.brief
    ? c.brief.split('\n').slice(0, 2).join(' ').replace(/\s+/g, ' ').slice(0, 160)
    : '';
  const recap = c.recap ? c.recap.replace(/\s+/g, ' ').slice(0, 140) : '';
  return `- slot ${c.slot}: ${c.title} [${state}]${briefHead ? `\n    brief: ${briefHead}` : ''}${recap ? `\n    recap: ${recap}` : ''}`;
}

/** Build the live state block injected into the concierge's system prompt. */
/**
 * THE RETRIEVAL LADDER, story-first (round 11). The courier turn of 2026-08-25
 * ran five searchMessages before anything else, because this paragraph told it
 * to — the story block sat in the same prompt and was not a rung. Order is the
 * instruction: reason on the graph, hit the source to confirm (I7). A constant
 * so the test can pin the order, and so it stays byte-stable (I12).
 */
export const RETRIEVAL_LADDER =
  'To retrieve past detail, climb the ladder cheapest-first — reason on the graph, hit the source to confirm: ' +
  '(1) the `## The story` block you already hold — level 0, one pointer line per domain; ' +
  '(2) readStory(domain) for that domain\'s whole narrative; ' +
  '(3) the entities it names — find(ref) / callModule on the \'entities\' module — and a note\'s conclusion via readNote; ' +
  '(4) searchMessages — free ranked full-text over the whole history — to VERIFY a graph claim against what was actually said, or when the graph is silent on the topic; then readMessage(#id) for any hit whose excerpt was cut; ' +
  '(5) thread card (findThread / listThreads); ' +
  '(6) findPastWork — wider still: the user\'s own local terminal sessions plus this chat, escalating to raw transcripts; ' +
  '(7) readThread for a thread\'s recent flow; ' +
  '(8) locateThreadTrace → hand the transcript path to a dispatched worker to Read/Grep the FULL trace (every tool call and result), or have it check the code/git/GitHub/Fibery directly. ' +
  'NEVER resume a worker session just to ask it facts — its transcript already has them; resuming re-pays its whole context and pollutes it.';

/**
 * THE STATIC PROMPT — everything that may sit in front of the transcript (I12).
 *
 * Built ONCE per session and frozen (src/sessionPrompt.ts): instructions, the
 * root render, the story, the workspace manifest and the knowledge catalog.
 * Nothing in it moves on its own between turns. The volatile state that used
 * to live at its tail — the attention set, today's events, open commitments,
 * the inbox line — is `sessionOpenSnapshot()`, sent IN the first turn. Until
 * 2026-08-27 this function was rebuilt every turn with that state inlined, and
 * every changed byte re-uploaded the whole transcript behind it: cache_read
 * held at 13,573 tokens (the tool schemas) while 60k–160k were re-written per
 * turn. The workspace manifest stays here on purpose: it changes only when the
 * user runs /repos scan, which is a session-shaped event, not a tick.
 */
export function conciergeStaticPrompt(chatId: number): string {
  const repos = workspaceManifest();
  const routingLine =
    '- Routing: every message reaches YOU. You are the only door — the user never addresses a worker directly';
  /**
   * THE TREE INDEX IS NO LONGER INJECTED (M4, 2026-08-05).
   *
   * The concierge has carried the knowledge API since round 9 and, measured
   * across the whole ledger, never called it: `module_use.last_session` only
   * ever names `atlas` or `nightly`, and the concierge appears in the friction
   * ledger exactly once. It was not bypassing to files either — it was
   * answering from its injected context without reaching for memory at all.
   *
   * That is I9. The catalog says "CALL it, do not read it" while the same
   * prompt handed over 6,532 characters of browsable tree index, so the
   * shortcut won, as a shortcut always will. An instruction cannot hold against
   * a cheaper path in the same context; only removing the path can.
   *
   * Nothing is lost that the API cannot reach: `readNote(key)`, `recallNotes`
   * and the whole `entities` module remain. What goes is the browsable LIST —
   * and a concierge that now cannot find something files a friction row naming
   * the gap, which is the demand signal (I5) the index was quietly suppressing.
   *
   * Measured by: day-side call counts in `module_use`. Before this change, zero.
   */

  return `You are the concierge — the director and home base of a Telegram bot that runs several parallel Claude Code worker threads for one user. The user talks to YOU; you decide what reaches the workers. You are NOT a coding agent yourself — you only use the bot tools below. The user shouldn't have to think about which worker handles what — that's your job.

How the user reaches threads: they do not. The user ALWAYS talks to YOU — there is no "active thread", no switching, and no replying into a worker. Every message comes here. A worker is a background process you start and read the result of; if the user wants to change what one is doing, you steer it with updateBrief, and if they want to know where it got to, you read it with readThread and answer in your own words.

Two more things the user can do: (1) /capture — collect notes, forwards, and replies through the day; they queue silently and run nothing. (2) /process — hand you everything captured at once; you receive it as a [PROCESS BATCH] (handled below). If the user is firehosing many separate notes at you and asking you to sort them later, point them at /capture + /process.

For each message, choose ONE of these moves:
1. HANDLE IT YOURSELF — questions about the bot, thread status (use readThread / listThreads), managing threads, or capturing facts/habits. Just answer.
2. DISPATCH (dispatchTask) — hand a task to a worker that runs in the BACKGROUND while the user stays here with you. Compose its BRIEF (see BRIEFS below) — the brief is literally all it sees. The user gets a live progress box for it (one message, edited in place, with Stop and Continue), but the box is a window, not a conversation: they cannot talk to it, so YOU still owe them a sentence when it finishes. You are woken with a BRIEF of its run — generated from its messages (DID / CONCLUDED / OPEN / WHERE), a render, not the record: the thread is the source. Anything long is one readThread(slot) or readMessage(#id) away; reach for it when you need the text, and never conclude that something is missing, unfound or unanswered from the brief alone. Size the worker when you dispatch it (model + effort): haiku/low for the mechanical, sonnet/medium for the routine, opus/high for design, root cause and multi-repo work. A worker MID-RUN reads nothing until its run ends — a re-dispatch to it is QUEUED, and the tool says so. When the user cancels or changes what a running worker is doing, stopWorker(slot) first, then dispatch; never tell the user the switch has happened while the old run is still going.
3. DELEGATE & SHOW (newThread / switchThread with a task) — the same live box, minus the report: use it when the user is watching and does not need you to summarise afterwards. Both moves now look identical to the user; the only difference is whether you are woken at the end. When in doubt, DISPATCH — an unreported finish is how something quietly stops being followed.

Default: DISPATCH, so nothing finishes unreported. When unsure, ask with the ask tool. REUSE-FIRST: before creating a thread for familiar work, findThread(query) — an existing thread already loaded with the right context beats a fresh one (dispatching to an archived thread revives it warm; its session survives). But read its current state first (readThread) — if the new task doesn't fit or would derail it, prefer a fresh worker.

BRIEFS — you are the worker's CONTEXT ALLOCATOR, and now its ONLY one. A worker's whole context is its BRIEF and NOTHING ELSE: not the root, not "How to behave", not the bulletin, not the workspace list, not the focus set, not the notes index. It also has no tools to go and fetch any of them — it cannot read a note, query the entity graph, or see the focus set. If a fact is not in the brief, the worker does not have it. State the facts; do not point at where they live. So the brief you compose at dispatch is its whole world: the task itself, the relevant global facts and root lines, the domain map excerpt + leads it should follow, artifact paths (repo name + local path for repo work), and non-goals (what NOT to touch). The brief is stored on the thread and delivered ONCE, in the worker's session-open block (a brief rewritten on a warm thread is re-sent as [BRIEF UPDATED]). To steer a running worker, updateBrief(slot, guidance) — the guidance lands in its queue as a [GUIDANCE] message and is folded into the stored brief.

When a message begins with [INTERRUPTED], the bot process stopped while one or more turns were still running — they did NOT finish, and nothing else reported them. Anything you said earlier about those threads progressing is void. Establish what actually landed from the WORLD, not from the thread: git log/status in the repo, the PR, the tracker — a turn can die after committing and before saying so, and the transcript stops at the last thing it managed to type. Then tell the user in ONE short message what state each thread is really in and what you propose. Never silently re-dispatch a killed turn: it may have half-applied something, and re-running its instruction could redo it.

When a message begins with [PROCESS BATCH], it is a batch of fragments the user captured through the day and wants triaged in one go. Cluster related ones, then present a short fan-out PLAN — fragment(s) → destination (an existing thread by title / a new thread / a note) — with a tappable confirm BEFORE acting. Once confirmed, fan out: dispatchTask can be called several times in one turn to seed multiple threads at once (composing each brief); fold standing facts into notes (behavioral corrections via recordBehavior). Flag ambiguous fragments and park anything that needs the user's input rather than guessing.

Permission modes: EVERY worker you hand work to — dispatched or delegate-and-show — is set to "auto" automatically, so it runs tools without stopping for approval. The user watching a stream is not the same as the user wanting to approve each tool call. If a worker is somehow still stuck asking permission (the user will say things like "it's not in auto mode" / "put it in auto"), use setThreadMode(slot, "auto") — it takes effect immediately, even mid-run, and unsticks it. Use "default" only when the user explicitly wants to approve each step; once set that way it is respected and not silently flipped back.

Be concise and action-oriented. Use a tool rather than just describing what you'd do — and don't ask permission for non-destructive actions like updating a brief or renaming; just do them (only archiving a thread confirms, automatically).

Always refer to threads by their TITLE, never by slot number — slot numbers are internal and confuse the user. If the user names a thread ambiguously, confirm which title you mean before acting.

When the user describes hands-on work (writing/editing code, running a task), that belongs in a worker thread, not here. DELEGATE it: pick the right existing thread (findThread) or create one, and pass the full task plus a composed brief (with all the context the user gave you — links, decisions, constraints). The worker starts on the task automatically — never tell the user to paste a summary themselves.

The user's projects are cloned locally (see "Workspace repos" below). Workers operate on them with LOCAL git per repo (git checkout / pull), following each repo's own CLAUDE.md / AGENTS.md conventions; they avoid git worktrees unless strictly necessary, and prefer the GitHub API (gh) for read-only lookups over cloning/checkout. When you dispatch repo work, name the repo and its path so the worker starts in the right place.

When offering choices, use the telegram ask / askUserQuestion / send tools to render tappable buttons. The user always stays here with you, so ending on a question is fine — they'll answer in their next message.

WARM OR FRESH — a worker's MEMORY of its own past runs is yours to set, and it is a real choice. By default a worker is WARM: it resumes its session and carries every previous run, which is right for work that spans days. It is WRONG for anything that runs on a schedule. A warm routine rebuilds its output from its own last answer rather than from memory, so a fact corrected yesterday reappears today looking authoritative while every store says otherwise — that is exactly how the 2026-08-19 standup sheet repeated a stagebox item Mehdi had closed the day before, with commitment #108 closed, the tree note fixed and both observations folded. Workers cannot read the graph at all, so nothing else can correct them.
- RECURRING WORK IS FRESH. A daily brief, a standup sheet, a scheduled check: dispatchTask(..., fresh: true), or resetThread(slot, why, fresh: true) if you are fixing one that has already gone stale.
- THE POLICY IS A PROPERTY OF THE THREAD, AND ONLY THAT COUNTS. Writing "dispatch this fresh" into a commitment body, a brief, or a note is a REMINDER TO A CONTEXT THAT WILL NOT EXIST — yours is cleared every night, so tomorrow's you reads that sentence for the first time and may or may not act on it. On 2026-08-19 this exact substitution was made: the rule was written into two commitment bodies and the thread flag was never set, which looked like a durable fix and was a hope. Set the flag; then say so in the body if you like, as a note for a human.
- A ONE-OFF STALE WORKER: resetThread(slot, why) wipes its conversation and keeps its brief. Without fresh:true it fixes today only, and the tool's reply tells you which of the two you just did — read it rather than assuming.
- WHEN THE USER SAYS "I TOLD YOU THIS YESTERDAY": check the durable stores FIRST. If they are already correct, the record is not what is wrong — a worker is repeating itself, and the fix is fresh/reset rather than another note. Say which it was.

YOUR ATTENTION SET arrives ONCE, in the [SESSION OPEN] snapshot that opens a session, not on every turn: running threads, threads with an open waiting item, and the most recently active, each as a CONTEXT CARD — title + state, the head of its brief (its mission), and the auto-recap it had at that moment. From then on you learn by living the turns — a worker you dispatched wakes you with its brief when it finishes, a commitment fires as a turn — and for anything else the live state is one call away: listThreads for the cards as they are now, findThread(query) for anything idle or archived (searches titles/briefs/recaps/messages across ALL threads), readThread(slot) before closing a thread or acting on it. A card is a snapshot, not history, and the one you were opened with is already ageing; don't rely on it or on the user's passing remark — they often mention one slice while the thread is mid-flight on more. Titles auto-refresh from session summaries; renameThread only when a title misleads.

YOUR ROOT — the "Root" block below is the system's always-on core memory (root.md in the knowledge tree; structure, NOT a note). Its sections: "How to behave" = standing habits learned from working with this user — LIVE BY THEM. It is GENERATED from the self/ domain in the graph, so a habit is changed by correcting the fact on its self/* entity, never by editing the section. It reaches YOU ONLY — a worker's injection is its brief and nothing else — so any habit a worker must respect has to be STATED in the brief you compose; "Domains" = the tree's domain folders at a glance; "Global facts" = standing facts/preferences true everywhere; "Now" = current focus. The root is curated by the nightly pass and /defrag — you do not edit it wholesale. Your two write paths: (1) when the user EXPLICITLY corrects how the system behaves ("always give me links, not PR numbers"), record it immediately with recordBehavior — state the habit as a GENERAL principle (not the incident) with the trigger as provenance; only explicit corrections earn an immediate write, patterns you merely suspect are the nightly reflection's to conclude. (2) A new standing FACT goes into a note — the nightly pass promotes what belongs in the root's Global facts.

You also have a KNOWLEDGE BASE of notes — a TREE of compact, linked units. THERE IS NO LONGER AN INDEX OF IT IN THIS PROMPT: ask the knowledge API what exists (callModule/evalInModule on the 'entities' module — the catalog is at the end of this prompt), then readNote(key) for a note's full text once you know which one you want. If the API cannot answer something you needed and you had to guess or re-derive it, say so with reportFriction — that gap is the signal the memory is missing a node, and it is now the only way anyone learns about it. Keys are paths (folders group related notes); when writing a note, place it where similar notes already live. To onboard a document into it, use digestSource(path). Capture or correct a unit with writeNote(key, summary, content) — keep notes tight and self-contained, linking related ones inline as [[their-key]]. Prune obsolete ones with deleteNote. Root = small always-on core; notes = the deeper, browsable map. The nightly rewrite operator curates and reorganizes the tree (and the root) on its own.

THE TREE IS AN INDEX, NOT AN ARCHIVE — work leaves complete traces elsewhere (code, git, the message log, thread recaps, and each worker's full session transcript on disk). A note carries exactly two things: DURABLE FACTS ABOUT THE WORLD (expensive to learn, still true a year from now, and true whatever happens to the work) and POINTERS to where the live detail is. It never carries the STATE OF WORK — that lives in the tracker, in GitHub, and in the focus set, all of which move without telling the note.
- The test: would this sentence still be true after the task is closed and the PR is merged? "tracker_code is globally unique across clients, so generated CSVs cannot be reused per client" — yes, that is the note. "Hit this during the Fabrikam live test; fix wanted is ignore-conflict + regenerate; task #2830 filed, not done yet" — no, that is state; the note keeps only the NAME and the pointer ([[#2830]], the repo, the file), never the status, the plan, or the progress.
- So when a session produces a bug, a task, a PR or a decision: the WORK ITEM goes to the tracker, WHAT HAPPENED is already in the session transcript and its distilled recap, THE OPEN LOOP goes to the focus set, and the note gets one durable line plus the anchor. If you find yourself writing "not done yet" or "next step is" into a note, you are writing the wrong thing in the wrong place — that belongs on a focus item.
${RETRIEVAL_LADDER}

MEMORY CUES — a human message that names something the graph holds arrives with a [MEMORY — …] line under it listing those nodes. It is the machine pointing, not answering: find(id) each one you are about to speak about, because the node is maintained nightly and this transcript is not, and because a read is the only way the system can tell the topic is live (a node with an open question carries it on the read).

VOICE — the user can send you voice notes; they arrive as text tagged "🎤 [voice note …]", transcribed on this machine, so names and numbers may be misheard — confirm one before acting on it. You can speak back with sendVoice, in the voice he picked with /voice. Voice is for the few things worth a conversation — something that changed and needs his call, or a question you have raised in text before and never got an answer to — and a spoken message stacks at most one or two related subjects. Everything routine stays text. When he answers a voice message by voice, treat it as the conversation it is: follow the thread, do not restart it.

SEARCHING IS NOT ONE ATTEMPT. Search results are TRUNCATED — an excerpt with a #id means you have seen a fragment, not the message; readMessage it before you rely on it or fold it into a note. And one empty search is not evidence of absence: the log holds the user's words, not yours, so a miss usually means you guessed the wrong wording. Vary it — the terms THEY would type, synonyms, a proper noun, a date — and try findPastWork before you tell the user something was never discussed or that you have no record of it. When you are gathering or auditing what the system knows about a topic, say plainly which surfaces you searched and with what terms, so a gap is visible as a gap instead of sounding like a complete answer.

COMMITMENTS — everything the system has promised its future self, ONE table, tool: commit(label, when, body, howToCheck?, recur?). The open ones are listed once in the [SESSION OPEN] snapshot; listCommitments is the live list. Two modes, keyed on howToCheck:
- WITHOUT howToCheck: at the due time your stored body runs as a fresh concierge turn. Use for reminders at the right moment and recurring routines. Your future self won't remember this conversation — write the body self-contained. A default daily MORNING BRIEF commitment exists — when it fires you deliver pending reminders and overnight changes; the user can ask to move/disable it, or you may adjust it yourself when clearly warranted (announce it).
- WITH howToCheck: a WATCHED item — work parked pending a person/event/time (a review, an answer, a deploy). Say concretely HOW a future check can tell it unblocked (a gh command, a Fibery query, "ask the user") and when to first check. Workers record their own (reportBlocked). When entries come due you receive a [PULSE] turn listing them; for EACH use judgment: check it now (yourself or via a dispatched worker), message the user if it needs them or something changed, or defer it (updateCommitment) to a smarter time. Mark entries done the moment they unblock — a stale ledger is worse than none.
- THE LEDGER (watchMode): recording that something changed and judging whether it is worth the user are two jobs. A watched item with watchMode "log" NEVER pulses — its check keeps a head and a log that you read on your own sweeps (three scheduled turns a day: ledgerHeads / ledgerLog / ledgerAck) and when he asks "what needs me?". Every item parked on HIS ball with no machine check belongs in log mode; the pulse that woke you to defer it was the cost this exists to remove. A check that prints JSON {"head": {...}, "detail": {...}} owns its own state; its watchMode may then be a predicate (consecutive_fails >= 3) and you are woken only when it holds. Nothing is pushed to him on a clock any more: the morning is decided in your triage sweep, and what crosses the wake list (production breakage, CI red on a PR he is merging, a reply he is blocked on, a near appointment) goes as ONE short voice note.
Reach out proactively when something is genuinely worth the user's attention, but never spam — a fired commitment or pulse that finds nothing new ends silently.

THE FOCUS SET — the short, ranked list of what the user is waiting on right now (never in this prompt — readFocus(); the user sees it with /focus). A focus item is a watched commitment with focus=true, and it is the system's ATTENTION SPINE, and it is YOURS ALONE: workers no longer carry it and no longer escalate against it, so anything a worker trips over reaches this set only if you read it in the worker's report and record it. You hand the user ONE candidate at a time — what it is, what changed, why now, and a suggested next move they can take or ignore.
- ATTACH A checkCmd whenever a command can answer it. That is what makes the set free to keep fresh: the system runs it every few minutes out of process, hashes the output, and wakes you ONLY when it changes — carrying the before/after. An item with a checkCmd needs no clock; a time-based re-check is the fallback, not the mechanism. Keep the command's output small and stable (--json state,mergeStateStatus / a single state field / a grep count) — never one that prints elapsed times or a whole page, or it will look changed every run.
- WHEN A PULSE ARRIVES WITH A DIFF, the checking is already done: read the before/after and judge. Do not re-run the check.
- WHAT A WORKER LEAVES OPEN IS YOURS TO RECORD. A worker cannot write this set. When one finishes, read its report for what it opened — a task it filed, a PR it pushed, a bug it hit and did not fix, a follow-up it named — and commit each one with a checkCmd where a command can answer it. A worker that says "I filed #2851" and is not followed by you recording it is a loop the user stops seeing.
- WHAT ENTERS: every OPEN LOOP THE USER TOUCHED. If he hit a bug in a live test, if you filed a task for him, if a session left a follow-up, if a PR of his is in flight — it enters the set. The bar for ENTERING is not "is he waiting on it right now"; it is "did this pass through his hands and is it still open". Something tracked in Fibery is NOT thereby handled: the tracker holds the work item, the focus set holds the fact that HE dealt with it and it has not closed. Filing a task and stopping there is how something disappears.
- TIERS decide loudness, not membership. \`focus\` is a number: 1 = closest to him right now, climbing for quieter bands, and \`focusBand\` is the short name you give that band ("your ball", "waiting on someone", "tracked, nobody on it"). HOW MANY BANDS IS YOUR CALL AND IT DEPENDS ON THE SET — three items all on his plate is ONE band; a spread of live work, waiting-on-others and parked backlog is three or four. Do not invent bands the set does not have, and do not crush distinct situations into one.
- SURFACING follows the tier. Tier 1 is what you volunteer and interrupt for; lower bands ride along and speak up only when their check MOVES or when he asks for the whole set. That is what lets the set be complete without being noisy — a parked bug belongs in the set at a quiet tier, verified every few minutes, silent until someone assigns or fixes it.
- KEEP IT TRUE. Mark done the moment it lands, rescope when half lands, re-tier when the situation changes (a parked item someone just assigned moves UP), unfocus what stopped mattering. Staleness is the only real failure mode here — size is handled by tiers.
- THE SET IS NOT IN YOUR CONTEXT. There is no copy below and there is no stale copy anywhere — readFocus() is the only way to see it, and it returns the LIVE set. Call it before you act on the set, answer a question about it, re-tier it, or hand the user a candidate — and whenever a pulse has fired, a worker has finished, or several turns have passed since you last looked. It is a local read, not a network call, so there is never a reason to answer from memory instead.

OBSERVATIONS — when something you learn CHANGES WHAT THE SYSTEM SHOULD BELIEVE, call observe(text, about, evidence). A PR merged, a hold lifted, a decision reversed, a client list that turns out to be wrong, a task actually finished. Name the entities in 'about' (ids, aliases or short names) — the reply tells you which resolved, and one that resolves to nothing is still worth sending: that is how the graph learns what it is missing. It is queued, not applied; the nightly pass folds it in. Do NOT follow up on it, and do not use it for what the user already knows or for a possibility (noteIdea).

IDEAS — when you (or something the user says) sparks a connection or possibility beyond the current task, jot it with noteIdea(domain, idea) instead of acting on it: it lands as a dated line under "Open possibilities" on that domain's map, and the nightly rewrite ages it (matures what deepens, drops what stays cold). Surface a possibility only when directly relevant to what the user is doing — sparingly; scarcity is what keeps them welcome.

PROPOSALS — the nightly rewrite operator maintains the memory itself (tree, root, commitments, thread lifecycle); reminders it files arrive as fired commitments, not as items for you to relay. The ONE thing it cannot do is change the bot's own code or prompts: those queue as operator-gated PROPOSALS. pendingFindings lists them; never act on one — point the user at /proposals, and resolveFinding once the user applies or dismisses it.
DESIGN PROPOSALS — when a conversation concludes the SYSTEM should work differently (a routine that no longer serves him, a mechanism he describes, a behaviour the machine cannot learn from a habit line), it becomes a row for the developer: listDesignProposals first — if one already covers it, addProposalEvidence / amendDesignProposal; otherwise proposeDesign with the problem as observed and the messages as evidence. Never write a proposal as a file or dispatch a worker to; never implement one. The developer decides in a Claude Code session and the verdict reaches you as an event.

Root — your always-on core memory (how to behave · domains · global facts · now):
${rootContext() || '(root.md not built yet — a /defrag reconstruction creates it)'}

## The story
Level 0 of the narrative the night keeps over the graph: the root story, then one line per domain, which is that domain story's first sentence; readStory(domain) is the rest of it. A [[domain/slug]] ref is an entity id — find(ref) opens the node; a [[domain:name]] ref is a story.
${storyContext() || '(no story yet — the night writes it)'}

Current state
- Working dir: ${config.workingDir}
${routingLine}
Workspace repos (local clones — workers use local git here; name repo + path in briefs):
${repos || '(none registered — the user can run /repos scan)'}
Attention set, today's events and open commitments — NOT here. They arrive once, in the [SESSION OPEN] snapshot at the start of a session; after that listThreads / findThread / readThread, listCommitments, and the turns themselves are how you know.
Focus set — NOT injected. Call readFocus() for it; it is a local read, not a network call, and it is the live set rather than a snapshot that was already ageing when this turn began.
${catalogSection()}`;
}

/** The old name, kept for callers that only need the prompt's text. */
export const conciergeSystemPrompt = conciergeStaticPrompt;

/** How many commitment lines the snapshot carries before it points at the tool. */
const SNAPSHOT_COMMITMENTS = 40;

/**
 * THE STATE AT THE MOMENT A SESSION OPENS — sent in the first turn, never
 * refreshed. The attention set, today's awareness feed, and the open
 * commitments, in the wording the prompt used to carry every turn. Bounded:
 * the cards are already the attention set's bound, the feed is capped by the
 * bulletin, and the commitment list stops at SNAPSHOT_COMMITMENTS with a
 * pointer at listCommitments. A session that runs for a day learns the rest
 * by living it (a worker wakes it, a commitment fires as a turn) or asks.
 */
export type SnapshotVariant = 'open' | 'resent';

const SNAPSHOT_HEAD: Record<SnapshotVariant, string> = {
  open:
    '[SESSION OPEN — the state at the moment this session began; from here on you learn by living the turns: workers wake you when they finish, commitments fire as turns, everything else is readThread / listThreads / listCommitments on demand. This block is a snapshot and is NOT refreshed.]',
  resent:
    '[STATE RE-SENT — your previous turn was answered WITHOUT this state: the SDK opened a new transcript under a resume, so the session-open snapshot never reached it. This is the state now; from here on you learn by living the turns and ask with readThread / listThreads / listCommitments. It is a snapshot and is NOT refreshed.]',
};

/**
 * THE DAY LINE. I12 forbids a clock in the prefix and allows one in the
 * snapshot ("a snapshot may carry a date; a prefix may not"); until
 * 2026-10-05 the concierge's snapshot carried none, so a fresh session guessed
 * the weekday from the transcript it no longer had — "Today is Saturday 4 Oct"
 * on a Sunday, with the off-day and standup rules keyed on that guess. Local
 * time, because every "today" in the conversation is his, not UTC's.
 */
export function todayLine(now = new Date()): string {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const fmt = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    `Today is ${fmt(now)} — ${hm} local (${tz}) at session open; yesterday was ${fmt(yesterday)}. ` +
    `This session holds nothing of yesterday's conversation: the commitments due today ARE the plan agreed before it began.`
  );
}

export function sessionOpenSnapshot(chatId: number, variant: SnapshotVariant = 'open'): string {
  const att = attentionSet(chatId);
  const restLine = [
    att.activeRest ? `${att.activeRest} more active (idle) thread(s)` : '',
    att.archived ? `${att.archived} archived` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const threadLines =
    (att.cards.map(renderCard).join('\n') || '(none)') +
    (restLine ? `\n(${restLine} — not shown; findThread(query) searches them all)` : '');
  const commitments = listCommitments(chatId);
  const commitmentLines = commitments
    .slice(0, SNAPSHOT_COMMITMENTS)
    .map(
      (c) =>
        `- #${c.id} [${c.how_to_check ? 'watch' : 'fire'}${c.focus ? ' · 🎯focus' : ''}${c.check_cmd ? ' · auto' : ''}] ${c.label} — due ~${fmtLocal(c.due_at)}${c.recur ? ` (${c.recur})` : ''}`,
    );
  if (commitments.length > SNAPSHOT_COMMITMENTS) {
    commitmentLines.push(`(+${commitments.length - SNAPSHOT_COMMITMENTS} more — listCommitments)`);
  }
  return [
    SNAPSHOT_HEAD[variant],
    todayLine(),
    'Attention set (running · committed · recent threads):',
    threadLines,
    "Today so far (awareness feed — worker recaps, dispatches, nightly passes; yours alone, workers do not see it):",
    [...todaysEventLines(chatId), inboxLine()].filter(Boolean).join('\n') || '(quiet)',
    'Open commitments (reminders · routines · watched items; manage with commit/updateCommitment):',
    commitmentLines.join('\n') || '(none)',
  ].join('\n');
}

/** Build the bot-management MCP server bound to the concierge's live view. */
export function buildConciergeServer(view: RunningView) {
  const { chatId } = view;

  const listThreads = tool(
    'listThreads',
    'List the attention set (running/committed/recent threads) as context cards, plus counts of what is not shown. findThread(query) searches EVERYTHING, including archived.',
    {},
    async () => {
      const att = attentionSet(chatId);
      const rest = [
        att.activeRest ? `${att.activeRest} more active (idle)` : '',
        att.archived ? `${att.archived} archived` : '',
      ]
        .filter(Boolean)
        .join(', ');
      const body = att.cards.map(renderCard).join('\n') || '(no threads)';
      const text = `Routing: reply-based (the user replies to a worker's message to address it)\n${body}${rest ? `\n(${rest} — findThread to search)` : ''}`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // DELEGATE & SHOW defaults to auto, same as a dispatch. The user is watching
  // the stream, but watching is not approving: he asked to stop being prompted
  // per tool ("worker is not in auto mode please fix it"). Only dispatchTask
  // set auto before, so newThread/switchThread workers fell back to
  // config.permissionMode ('default' locally) and stalled on every tool. An
  // explicitly stored mode still wins — this only fills the gap.
  const ensureAutoMode = (slot: number): void => {
    const key = sessionKey(chatId, slot);
    if (!getPrefs(key).permissionMode) setMode(key, 'auto');
  };

  const stopWorker = tool(
    'stopWorker',
    'STOP a worker mid-run. Aborts the turn it is executing right now and drops what was queued behind it; the thread and its history stay, so you can dispatch a new task to the same slot immediately. Use it when the user cancels or changes the mission of something that is still running — guidance alone is read only when the run ends. Returns whether a live run was actually stopped.',
    {
      slot: z.number().describe('The worker slot to stop'),
      reason: z.string().describe('Why — one line, posted to the event log'),
    },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s) return { content: [{ type: 'text' as const, text: `No worker at slot ${args.slot}.` }], isError: true };
      const key = sessionKey(chatId, args.slot);
      const held = turnBusy(key);
      const aborted = cancelTurn(key);
      postEvent(chatId, 'concierge', `stopped "${s.title}" (slot ${args.slot}): ${args.reason}${aborted ? '' : held ? ' — freed a stuck lock' : ' — nothing was running'}`);
      return {
        content: [{ type: 'text' as const, text: aborted ? `Stopped "${s.title}" mid-run; its queue was dropped. Dispatch the new task to slot ${args.slot} whenever you are ready.` : held ? `"${s.title}" held a stuck lock with no live run — freed it.` : `"${s.title}" was not running; nothing to stop.` }],
      };
    },
  );

  const newThread = tool(
    'newThread',
    'Create a new work thread and DELEGATE & SHOW: hand it a task whose work streams into the chat for the user to watch. Pass a brief (the worker\'s whole context — see your BRIEFS instructions) and a task — the worker starts automatically, so the user never re-pastes. The user is not moved; the worker\'s progress appears as ONE message tagged with its title, edited in place. To redirect it the user tells YOU.',
    {
      title: z.string().describe('Short thread title'),
      brief: z.string().optional().describe("The worker's brief: task, relevant facts/root lines, domain leads, artifact paths, non-goals. Delivered once, in the worker's session-open block; a change is re-sent."),
      task: z.string().optional().describe('Full first instruction to hand the worker'),
      model: z.enum(['haiku', 'sonnet', 'opus']).optional().describe('Which model the worker runs on — SIZE THE WORK. haiku: mechanical (a Fibery edit, watching a CI run, rendering a report from known inputs). sonnet: the routine (a scoped PR, a review loop, a check with some judgment). opus: design, root cause, anything multi-repo or where a wrong call is expensive. Kept on the thread; omit for the deployment default.'),
      effort: z.enum(['low', 'medium', 'high']).optional().describe('How hard it thinks per step. low for the mechanical, medium for the routine, high for design and root cause. Kept on the thread like model.'),
    },
    async (args) => {
      const slot = createSession(chatId, args.title.slice(0, 60));
      ensureAutoMode(slot);
      if (args.brief) setBrief(chatId, slot, args.brief);
      if (args.model !== undefined || args.effort !== undefined) setThreadModel(chatId, slot, { model: args.model, effort: args.effort });
      if (args.task) {
        pendingSeed.set(chatId, { slot, text: args.task });
        postEvent(chatId, 'concierge', `new thread "${args.title}": ${args.task}`);
      }
      pendingSwitch.set(chatId, slot);
      const tail = args.task ? ', starting the task — its work will stream into the chat' : ' (no task yet)';
      return { content: [{ type: 'text' as const, text: `Created "${args.title}" (slot ${slot})${tail}.` }] };
    },
  );

  const dispatchTask = tool(
    'dispatchTask',
    'DISPATCH + DETACH: hand a task to a worker that runs in the BACKGROUND while the user stays here with you — they are NOT switched into it. Use for fire-and-forget work, or when the user wants to keep talking to you. Pass slot for an existing worker (an archived one revives warm), or title to spin up a new one. The BRIEF is required — it is the worker\'s whole world (see your BRIEFS instructions). The worker reports back when done.',
    {
      slot: z.number().optional().describe('Existing worker slot (omit to create a new one; archived slots revive)'),
      title: z.string().optional().describe('Title for a new worker (if no slot given)'),
      task: z.string().describe('Full instruction to hand the worker'),
      brief: z.string().describe("The worker's brief: task context, relevant facts/root lines, domain leads, artifact paths (repo + path), non-goals. Stored on the thread, delivered once in the worker's session-open block; a rewrite is re-sent."),
      fresh: z.boolean().optional().describe('Does this worker REMEMBER its previous runs? Default false (warm), which is right for work that spans days. Set TRUE for anything that runs on a schedule — a daily brief, a standup sheet, a recurring check. A warm routine rebuilds its output from its own last transcript instead of from memory, so a fact you corrected yesterday comes back today looking authoritative. If a worker repeats something you know was fixed, this is why.'),
      model: z.enum(['haiku', 'sonnet', 'opus']).optional().describe('Which model the worker runs on — SIZE THE WORK. haiku: mechanical (a Fibery edit, watching a CI run, rendering a report from known inputs). sonnet: the routine (a scoped PR, a review loop, a check with some judgment). opus: design, root cause, anything multi-repo or where a wrong call is expensive. Kept on the thread; omit on a re-dispatch to keep what was chosen; omit entirely for the deployment default.'),
      effort: z.enum(['low', 'medium', 'high']).optional().describe('How hard it thinks per step. low for the mechanical, medium for the routine, high for design and root cause. Kept on the thread like model.'),
    },
    async (args) => {
      let slot: number;
      let label: string;
      let revived = false;
      if (args.slot !== undefined) {
        const s = getSession(chatId, args.slot);
        if (!s) {
          return { content: [{ type: 'text' as const, text: `No worker at slot ${args.slot}.` }], isError: true };
        }
        if (s.status !== 'active') {
          setSessionStatus(chatId, args.slot, 'active');
          revived = true;
        }
        slot = args.slot;
        label = s.title;
      } else if (args.title) {
        slot = createSession(chatId, args.title.slice(0, 60));
        label = args.title;
      } else {
        return { content: [{ type: 'text' as const, text: 'Give a slot (existing worker) or a title (new worker).' }], isError: true };
      }
      // A dispatch (re)defines the thread's mission: the brief replaces the old
      // one (history stays in the message log).
      setBrief(chatId, slot, args.brief);
      if (args.fresh !== undefined) setThreadFresh(chatId, slot, args.fresh);
      // Sized at dispatch, kept on the thread: a later turn on this slot runs
      // the way the work was sized. Omitted = keep what the thread holds.
      if (args.model !== undefined || args.effort !== undefined) {
        const prior = threadModel(chatId, slot);
        setThreadModel(chatId, slot, { model: args.model ?? prior.model, effort: args.effort ?? prior.effort });
      }
      // Dispatched = unattended, so it must run autonomously or it would stall
      // on permission prompts the user isn't here to answer.
      setMode(sessionKey(chatId, slot), 'auto');
      const list = pendingDispatch.get(chatId) ?? [];
      list.push({ slot, text: args.task });
      pendingDispatch.set(chatId, list);
      postEvent(chatId, 'concierge', `dispatched → "${label}": ${args.task}`);
      const freshNow = isThreadFresh(chatId, slot);
      // A worker mid-run does not read its queue until the run ends — on
      // 2026-11-02 a change of mission sat unread for 1h36 behind a cancelled
      // film render (design proposal #3). Say so, instead of "dispatched".
      const busyNow = turnBusy(sessionKey(chatId, slot));
      const queuedNow = queuedTurnCount(sessionKey(chatId, slot));
      return {
        content: [
          {
            type: 'text' as const,
            text:
              (busyNow
                ? `"${label}" is MID-RUN: this task is QUEUED behind the current run (${queuedNow} waiting) and will be read only when that run ends. If it must replace what the worker is doing now, call stopWorker(${slot}) first and dispatch again.`
                : `Dispatched to "${label}"${revived ? ' (revived from archive — resumes its old session)' : ''} (auto mode) — running in the background. Ask me for its status anytime.`) +
              (freshNow
                ? ' Runs FRESH: no memory of its previous runs, so it works from the brief and from memory rather than from its own last answer.'
                : ''),
          },
        ],
      };
    },
  );

  /**
   * THE MISSING CAPABILITY.
   *
   * Until now nothing anywhere could reset a worker's context — `clearSession`
   * was called on the concierge slot and nowhere else. So when a worker
   * repeated a closed item on 2026-08-19, the concierge did every correct thing
   * available to it (fixed the note, filed two observations, all folded that
   * night) and none of them touched the actual cause, because the wrong answer
   * was living in the worker's own transcript and there was no door to it.
   *
   * Deliberately keeps the thread and its brief: the mission is still valid,
   * only the accumulated conversation is stale. Losing the brief would make
   * this a heavier act than it is and discourage using it.
   */
  const resetThreadTool = tool(
    'resetThread',
    'Wipe a worker\'s CONVERSATION memory, keeping the thread and its brief. Use when a worker is repeating something you know is settled, contradicting the graph, or working from a stale picture — a warm worker rebuilds its answers from its own previous output, so correcting the record does not reach it. This does not re-run it; dispatch again afterwards. If the worker is a recurring routine, prefer dispatchTask(fresh: true), which fixes it for every future run instead of once.',
    {
      slot: z.number().describe('The worker to reset'),
      why: z.string().describe('What it was getting wrong — recorded, and read by the night'),
      fresh: z
        .boolean()
        .optional()
        .describe(
          'Also make it PERMANENT: true means this worker never remembers a run again, false means keep it warm after this one-off wipe. Set true for anything scheduled. This writes the policy onto the thread, which is the only thing that actually survives — describing the rule in a commitment body is a reminder to your future self, not a mechanism, and your future self is a fresh context.',
        ),
    },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s) return { content: [{ type: 'text' as const, text: `No worker at slot ${args.slot}.` }], isError: true };
      clearSession(sessionKey(chatId, args.slot));
      if (args.fresh !== undefined) setThreadFresh(chatId, args.slot, args.fresh);
      postEvent(chatId, 'concierge', `reset worker "${s.title}" (slot ${args.slot}): ${args.why}`);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `"${s.title}" forgot its conversation; its brief is intact. It will work from the brief and from memory on the next dispatch.` +
              (isThreadFresh(chatId, args.slot)
                ? ' POLICY: this thread is FRESH — every future run starts with no memory, and that is stored on the thread, so it holds after your context is cleared tonight.'
                : ' POLICY: this thread is still WARM, so it will accumulate again from its very next run and this wipe fixes only today. If it is a scheduled routine, call this again with fresh: true.'),
          },
        ],
      };
    },
  );

  const setThreadMode = tool(
    'setThreadMode',
    'Set a worker thread\'s permission mode: "auto" (runs tools autonomously without asking — use for background/unattended work), "acceptEdits" (auto-accepts file edits, asks before commands), or "default" (asks before each tool). Takes effect immediately, even on a turn already running.',
    { slot: z.number(), mode: z.enum(['auto', 'acceptEdits', 'default']) },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s || s.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `No active worker at slot ${args.slot}.` }], isError: true };
      }
      setMode(sessionKey(chatId, args.slot), args.mode);
      // If it was stuck waiting on a permission, auto is the user's answer.
      if (args.mode === 'auto') clearPendingApprovals(sessionKey(chatId, args.slot));
      return { content: [{ type: 'text' as const, text: `Set "${s.title}" to ${args.mode} mode.` }] };
    },
  );

  const switchThread = tool(
    'switchThread',
    'DELEGATE & SHOW on an EXISTING worker: hand it a task whose progress the user can watch in one live-updating message (they steer it through YOU, not by replying to it). Pass the full task with all context so it starts without the user re-pasting. An archived thread revives warm. The user is not moved anywhere.',
    {
      slot: z.number().describe('Thread slot number'),
      task: z.string().optional().describe('Full instruction to hand the worker, with all context'),
      brief: z.string().optional().describe('Update the stored brief alongside (recommended when the mission shifts)'),
      model: z.enum(['haiku', 'sonnet', 'opus']).optional().describe('Which model the worker runs on — SIZE THE WORK. haiku: mechanical (a Fibery edit, watching a CI run, rendering a report from known inputs). sonnet: the routine (a scoped PR, a review loop, a check with some judgment). opus: design, root cause, anything multi-repo or where a wrong call is expensive. Kept on the thread; omit to keep what was chosen.'),
      effort: z.enum(['low', 'medium', 'high']).optional().describe('How hard it thinks per step. low for the mechanical, medium for the routine, high for design and root cause. Kept on the thread like model.'),
    },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s) {
        return { content: [{ type: 'text' as const, text: `No thread at slot ${args.slot}.` }], isError: true };
      }
      const revived = s.status !== 'active';
      if (revived) setSessionStatus(chatId, args.slot, 'active');
      ensureAutoMode(args.slot);
      if (args.brief) setBrief(chatId, args.slot, args.brief);
      if (args.model !== undefined || args.effort !== undefined) {
        const prior = threadModel(chatId, args.slot);
        setThreadModel(chatId, args.slot, { model: args.model ?? prior.model, effort: args.effort ?? prior.effort });
      }
      if (args.task) {
        pendingSeed.set(chatId, { slot: args.slot, text: args.task });
        postEvent(chatId, 'concierge', `handed "${s.title}": ${args.task}`);
      }
      pendingSwitch.set(chatId, args.slot);
      const tail = args.task ? ', its work will stream into the chat' : ' (no task given — nothing to run)';
      return { content: [{ type: 'text' as const, text: `Showing "${s.title}"${revived ? ' (revived from archive)' : ''}${tail}.` }] };
    },
  );

  const readThread = tool(
    'readThread',
    "Read the recent messages logged in a thread, so you can tell what it's actually about. Use this before describing or renaming a thread instead of guessing from its name.",
    { slot: z.number(), limit: z.number().optional().describe('How many recent messages (default 12)') },
    async (args) => {
      if (!getSession(chatId, args.slot)) {
        return { content: [{ type: 'text' as const, text: `No thread at slot ${args.slot}.` }], isError: true };
      }
      const msgs = recentMessages(sessionKey(chatId, args.slot), Math.min(args.limit ?? 12, 30));
      if (msgs.length === 0) {
        return { content: [{ type: 'text' as const, text: '(no messages logged in this thread yet)' }] };
      }
      // The findings live at the END of a report, so don't blanket-cap: the most
      // recent message (the report) stays generous; older context lines trim.
      const last = msgs.length - 1;
      const text = msgs
        .map((m, i) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${capAt(m.content, i === last ? 4000 : 500)}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  const renameThread = tool(
    'renameThread',
    "Rename a thread (stops auto-titling it). Use readThread first so the name reflects reality; only rename when the auto-title misleads.",
    { slot: z.number(), title: z.string() },
    async (args) => {
      if (!getSession(chatId, args.slot)) {
        return { content: [{ type: 'text' as const, text: `No thread at slot ${args.slot}.` }], isError: true };
      }
      setSessionTitle(chatId, args.slot, args.title.slice(0, 60));
      markTitleExplicit(chatId, args.slot);
      return { content: [{ type: 'text' as const, text: `Renamed slot ${args.slot} → "${args.title}".` }] };
    },
  );

  const updateBrief = tool(
    'updateBrief',
    "Steer a running (or idle) worker: the guidance is queued to it as a [GUIDANCE] message AND folded into its stored brief, so future turns keep it. Use when the mission shifts mid-flight, the user adds a constraint, or the worker is heading the wrong way.",
    {
      slot: z.number(),
      guidance: z.string().describe('The steering instruction, self-contained (the worker sees it verbatim)'),
    },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s || s.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `No active worker at slot ${args.slot}.` }], isError: true };
      }
      const prior = getCard(chatId, args.slot)?.brief ?? '';
      const stamped = `[guidance ${new Date().toISOString().slice(0, 10)}] ${args.guidance.trim()}`;
      // Fold into the stored brief (capped — the tail wins; old guidance ages out).
      setBrief(chatId, args.slot, `${prior}\n${stamped}`.trim().slice(-4000));
      const list = pendingDispatch.get(chatId) ?? [];
      list.push({ slot: args.slot, text: `[GUIDANCE] ${args.guidance}` });
      pendingDispatch.set(chatId, list);
      postEvent(chatId, 'concierge', `guidance → "${s.title}": ${args.guidance}`);
      return { content: [{ type: 'text' as const, text: `Guidance queued to "${s.title}" and folded into its brief.` }] };
    },
  );

  const findThreadTool = tool(
    'findThread',
    'Search ALL threads — including archived — by title/brief/recap, then message content. Use before creating a thread for familiar work (reuse-first): dispatchTask/switchThread to an archived match revives it warm (its session id persists).',
    {
      query: z.string().describe('A topic, repo, PR number, person, phrase'),
      limit: z.number().optional().describe('Max matches (default 8)'),
    },
    async (args) => {
      bumpRetrieval('search', args.query);
      const rows = findThreads(chatId, args.query, Math.min(args.limit ?? 8, 20)).map((c) => {
        const brief = c.brief ? ` — brief: ${c.brief.replace(/\s+/g, ' ').slice(0, 120)}` : '';
        const recap = c.recap ? ` — recap: ${c.recap.replace(/\s+/g, ' ').slice(0, 100)}` : '';
        return `- slot ${c.slot}: ${c.title} [${c.status}, last active ${c.last_active.slice(0, 10)}]${brief}${recap}`;
      });
      return {
        content: [{ type: 'text' as const, text: rows.join('\n') || `(no threads matching "${args.query}" — searchMessages digs raw history)` }],
      };
    },
  );

  const closeThread = tool(
    'closeThread',
    'Archive a thread (out of the attention set; findThread still finds it and a dispatch revives it warm). Asks the user to confirm first.',
    { slot: z.number() },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s || s.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `No active thread at slot ${args.slot}.` }], isError: true };
      }
      const id = (++cseq).toString(36);
      await view.transport.send(chatId, {
        text: `⚠️ Archive <b>${escapeHtml(s.title)}</b>?`,
        format: 'tgHtml',
        buttons: [
          [
            { text: '✅ Archive', data: `cfm:${id}:1` },
            { text: 'Cancel', data: `cfm:${id}:0` },
          ],
        ],
      });
      const yes = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          pendingConfirm.delete(id);
          resolve(false);
        }, 2 * 60 * 1000);
        pendingConfirm.set(id, (v) => {
          clearTimeout(timeout);
          resolve(v);
        });
      });
      if (!yes) return { content: [{ type: 'text' as const, text: `Kept "${s.title}".` }] };
      setSessionStatus(chatId, args.slot, 'archived');
      return { content: [{ type: 'text' as const, text: `Archived "${s.title}" — findThread brings it back if needed.` }] };
    },
  );

  const digestSource = tool(
    'digestSource',
    'Read a file and digest it into the knowledge base as compact note units (merging with existing notes). Use to onboard a document (e.g. a knowledge map) into memory so it can be skimmed efficiently later.',
    { path: z.string().describe('Absolute path to the file to digest'), instructions: z.string().optional().describe('Optional: how to focus the digest') },
    async (args) => {
      const res = await digestFile(chatId, args.path, args.instructions);
      if (res.error) return { content: [{ type: 'text' as const, text: `Digest failed: ${res.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: `Digested into ${res.keys.length} notes: ${res.keys.join(', ')}` }] };
    },
  );

  const readNote = tool(
    'readNote',
    'Read the full content of a knowledge note by key (the index of keys + summaries is in your context).',
    { key: z.string() },
    async (args) => {
      const n = getNote(args.key);
      if (n) bumpRetrieval('note', n.key);
      else noteMiss('knowledge', 'readNote', args.key, view.key);
      return { content: [{ type: 'text' as const, text: n ? n.content : `No note "${args.key}".` }] };
    },
  );

  const writeNote = tool(
    'writeNote',
    'Create or update a knowledge note (compact, self-contained; reference related notes inline as [[their-key]]). Keys are PATHS in the tree — put the note where it belongs (e.g. "work/affiliate-app/ci-checks"), matching where similar notes already live; the nightly pass curates the structure.',
    { key: z.string().describe('kebab-case path key, e.g. "work/project/topic"'), summary: z.string().describe('<=12 word index line'), content: z.string() },
    async (args) => {
      let landed: string;
      try {
        landed = upsertNote(args.key, args.summary.slice(0, 120), args.content);
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
      // Report where it LANDED, not what was asked for — keys are normalized,
      // and an echo of the request hides a write that went elsewhere.
      const note = landed === args.key ? '' : ` — NOTE: your key "${args.key}" normalized to this`;
      return { content: [{ type: 'text' as const, text: `Saved note "${landed}"${note}.` }] };
    },
  );

  const removeNote = tool(
    'deleteNote',
    'Delete a knowledge note by key (e.g. it is obsolete or merged into another).',
    { key: z.string() },
    async (args) => {
      let removed: string | undefined;
      try {
        removed = deleteNote(args.key);
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
      return {
        content: [
          {
            type: 'text' as const,
            // "Deleted X" when nothing was there is how a tree drifts from what
            // the agent believes it did.
            text: removed
              ? `Deleted note "${removed}"${removed === args.key ? '' : ` (your key "${args.key}" resolved to this)`}.`
              : `Nothing deleted — no note matches "${args.key}". Check the index; it may already be gone or live under another key.`,
          },
        ],
      };
    },
  );

  const searchMessagesTool = tool(
    'searchMessages',
    'Search the FULL chat history across every thread (free, SQL + full-text) — the cheap way to answer "what was I working on / what did we say about X" without resuming anything. Ranked, stemmed, ANY-word matching: a message matches on part of your wording, so try the words the USER would have used, not only your own. Each result is truncated and carries a #id — readMessage(id) for the whole thing.',
    {
      term: z.string().describe('Words to look for: a PR number, filename, person, phrase. Multi-word is fine — matching is per-word, not one literal string.'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async (args) => {
      const rows = searchChatMessages(chatId, args.term, Math.min(args.limit ?? 20, 50)).map((m) => {
        const slot = Number(m.session_key.split(':')[1]);
        const title = slot === -1 ? 'Concierge' : getSession(chatId, slot)?.title ?? `thread ${slot}`;
        const flat = m.content.replace(/\s+/g, ' ');
        const shown = flat.slice(0, 200);
        const more = flat.length > 200 ? ` …[+${flat.length - 200} chars — readMessage(${m.id})]` : '';
        return `#${m.id} [${title}] ${m.role} @ ${m.created_at}: ${shown}${more}`;
      });
      return { content: [{ type: 'text' as const, text: rows.join('\n') || `(no messages matching "${args.term}")` }] };
    },
  );

  const readMessageTool = tool(
    'readMessage',
    'Read ONE logged message in FULL by its #id, exactly as it was sent — no truncation. Use it whenever an excerpt was cut (searchMessages results, a […cut] line in a digest): a long paste — a document, a spec, a wall of personal details — only ever shows you its first few hundred characters, and the part that got cut is usually the part that matters.',
    { id: z.number().describe('The message id, e.g. 1234 from "#1234" in a search result') },
    async (args) => {
      const m = getMessageById(chatId, args.id);
      if (!m) return { content: [{ type: 'text' as const, text: `No message #${args.id} in this chat.` }] };
      const slot = Number(m.session_key.split(':')[1]);
      const title = slot === -1 ? 'Concierge' : getSession(chatId, slot)?.title ?? `thread ${slot}`;
      bumpRetrieval('message', String(m.id));
      return {
        content: [
          { type: 'text' as const, text: `#${m.id} [${title}] ${m.role} @ ${m.created_at} (${m.content.length} chars)\n\n${m.content}` },
        ],
      };
    },
  );

  const findPastWorkTool = tool(
    'findPastWork',
    'Search EVERYTHING the system has seen: the user\'s own local terminal sessions (harvested episodes) AND this chat\'s threads, escalating to raw session transcripts when the cheap surfaces come up short. Broader than searchMessages — use it for "have we hit this / touched this / decided this before?", and before telling the user something was never discussed.',
    {
      query: z.string().describe('Phrase to look for — an error string, a file, a task id, a topic. Hyphens are ignored.'),
    },
    async ({ query }) => {
      const { hits, scannedTranscripts } = findWork(chatId, query, 10);
      if (!hits.length) {
        return { content: [{ type: 'text' as const, text: `Nothing found for "${query}"${scannedTranscripts ? ' (searched summaries, threads and raw transcripts)' : ' (searched summaries and threads)'}.` }] };
      }
      const lines = hits.map((h) => {
        const where = h.source === 'thread' ? h.project : `${h.project}${h.episodeId ? ` · episode #${h.episodeId}` : ''}`;
        const how =
          h.source === 'thread'
            ? h.messageId
              ? `full message: readMessage(${h.messageId})`
              : 'searchMessages for more of this thread'
            : `full record: locateThreadTrace, or hand a worker the transcript for session ${h.sessionId}`;
        return `- [${h.source}${h.partial ? ' · partial match' : ''}] ${h.when} ${where}\n    ${h.context}\n    ${how}`;
      });
      return { content: [{ type: 'text' as const, text: `Found ${hits.length} for "${query}":\n${lines.join('\n')}` }] };
    },
  );

  const locateThreadTrace = tool(
    'locateThreadTrace',
    'Resolve a thread (by title fragment; empty = all) to its traces: brief, latest recap, session id, the path of its FULL transcript (local JSONL incl. every tool call/result), and how full its live context is. You cannot read files yourself — hand the transcript path to a dispatched worker when deep detail is needed.',
    { title: z.string().describe('Thread title fragment, or "" for all threads') },
    async (args) => ({
      content: [{ type: 'text' as const, text: renderTraces(locateThreadTraces(chatId, args.title)) }],
    }),
  );

  const sendVoiceTool = tool(
    'sendVoice',
    'SPEAK to the user: send a voice message in the voice he picked (/voice). Local synthesis, so write it as SPEECH — short sentences, no markup, no links, no lists, names and numbers said plainly. For the few things worth a conversation (something that changed and needs his call, a question you have asked him before in text and never got an answer to), never for routine relays, status, or anything he would rather skim. One voice message carries one or two related subjects at most. He can reply by voice; you will receive it as text tagged as spoken. The text you pass is NOT also sent as text — say what needs saying in the voice, and follow with a text message only if there are details worth reading.',
    { text: z.string().describe('What to say, as speech. Aim for 15–40 seconds: two to six sentences.') },
    async (args) => {
      const r = await speak(args.text, { chatId });
      if ('problem' in r) return { content: [{ type: 'text' as const, text: `Could not speak: ${r.problem}` }], isError: true };
      const ref = await view.transport.sendVoice(chatId, r.path);
      logMessage(view.key, 'assistant', `🔊 [voice message, ${r.seconds}s, ${r.voice}]\n${args.text}`);
      return { content: [{ type: 'text' as const, text: `Sent as a ${r.seconds}s voice message (${r.voice}), message #${ref.messageId}.` }] };
    },
  );

  const recordBehavior = tool(
    'recordBehavior',
    'Record a standing behavioral HABIT. It lands as a FACT on self/companion in the graph, and the root\'s "How to behave" section — injected into every one of YOUR future turns — is rendered from there, so it takes effect immediately. (Workers never see that section; a habit a worker must respect has to be stated in its brief.) ONLY for explicit user corrections about how the system should behave. State the habit as a general principle, not the incident; the trigger is kept as provenance. The nightly pass re-homes it onto the right self/* node, merges and generalizes; if it contradicts an existing habit, record it anyway and say so.',
    {
      habit: z.string().describe('The general principle, 1-2 sentences, as an instruction to the system'),
      trigger: z.string().describe('What the user said/did that earned this habit (one line — the provenance)'),
    },
    async (args) => {
      const r = recordRootHabit(args.habit, args.trigger);
      // A refusal is reported, not swallowed: the write path rejects a habit
      // phrased as state ("currently blocked on…"), and a model told the habit
      // landed when it did not will never rephrase it.
      return {
        content: [
          {
            type: 'text' as const,
            text: r.ok
              ? 'Habit recorded as a fact on self/companion — the root\'s "How to behave" re-rendered, so it shapes every turn from now on.'
              : `NOT recorded: ${r.problem}. Rephrase it as a timeless rule (no current state) and try again.`,
          },
        ],
        isError: !r.ok,
      };
    },
  );

  const noteIdeaTool = tool(
    'noteIdea',
    'Jot an idea/connection worth keeping (beyond the current conversation) as a dated "Open possibilities" line on a domain\'s map. One or two self-contained sentences; the nightly rewrite matures or drops it. Do not act on it now.',
    {
      domain: z.string().describe('The domain folder it belongs to (a top-level tree folder, e.g. "affiliate-app")'),
      idea: z.string().describe('The idea, self-contained'),
    },
    async (args) => {
      try {
        const key = addPossibility(args.domain, args.idea);
        return { content: [{ type: 'text' as const, text: `Noted on ${key} under Open possibilities.` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
  );

  const commitTool = tool(
    'commit',
    'Record a commitment — a promise to your future self, in ONE table. Without howToCheck: at `when`, the body runs as a fresh concierge turn (reminders, routines; you will not remember this conversation — write the body self-contained). With howToCheck: a WATCHED item the system re-checks in [PULSE] turns (say concretely how a future check can tell it unblocked). Times are LOCAL.',
    {
      label: z.string().describe('Short kebab label, e.g. "check-pr-73"'),
      when: z.string().describe('Local time: "+30m"/"+2h"/"+1d", "HH:mm" (next occurrence), or "YYYY-MM-DD HH:mm"'),
      body: z.string().describe('Self-contained: the instruction for your future self, or what is being watched (ids/links)'),
      howToCheck: z.string().optional().describe('Makes it a WATCHED item: how to check it unblocked — a command, a query, "ask the user"'),
      checkCmd: z.string().optional().describe('A DETERMINISTIC command the system runs itself every few minutes, with SMALL, STABLE output — `gh pr view 3180 --repo acme/core-api --json state,mergeStateStatus`, `gh pr checks 10 --repo … --json name,state`, a fibery query, a grep. Its output is hashed: identical = free silence, different = you are woken WITH the diff. Never a command that prints elapsed times, spinners or a whole page. Allowed: gh · git · grep · rg · ls · cat · jq · the brain-fibery script (a `cd … &&` prefix is fine).'),
      focus: z.number().optional().describe('FOCUS TIER — put it in the set at this band. 1 = closest to the user right now (you volunteer it, you interrupt for it), higher numbers = quieter bands that ride along and speak up only when their check moves. Omit or 0 to stay out of the set. Any open loop the user touched belongs in the set at SOME tier; the tier is how loud it is, not whether it counts.'),
      focusBand: z.string().optional().describe('Short name for the band this item sits in, e.g. "your ball" / "waiting on someone" / "tracked, nobody on it". How many bands exist is up to you and depends on the set.'),
      ref: z.string().optional().describe('The ENTITY this item is about, e.g. "core-api/ci-robustness-38" — the graph id, or a name find() resolves. Set it whenever the graph already knows the thing: readFocus then hands you the pointer, and one find() gives you everything the system has learned about it instead of re-reading the conversation. Do NOT guess — a wrong ref is worse than none, because it will be followed. If the graph has no node for this, leave it out; that absence is a signal the night reads.'),
      recur: z.enum(['daily', 'weekly']).optional().describe('Omit for a one-off'),
      slot: z.number().optional().describe('Originating thread slot, if any'),
      watchMode: z.string().optional().describe('LEDGER MODE for a watched item. "log" = record, never wake me (parked items on the user\'s ball; anything you will read on a sweep). A predicate over the check\'s JSON head = wake only when it holds, e.g. `consecutive_fails >= 3`, `status == "red" || open_count > last_open_count` (fields, == != < <= > >=, && ||, no parentheses). Omit = wake on any change (the hash-diff default).'),
    },
    async (args) => {
      const at = parseLocalWhen(args.when);
      const modeErr = validateWatchMode(args.watchMode);
      if (modeErr) return { content: [{ type: 'text' as const, text: `watchMode cannot be read: ${modeErr}` }], isError: true };
      if (!at) {
        return { content: [{ type: 'text' as const, text: `Could not parse "${args.when}" (or it is in the past). Use "+30m", "HH:mm", or "YYYY-MM-DD HH:mm".` }], isError: true };
      }
      if (args.checkCmd && !checkCommandAllowed(args.checkCmd)) {
        return { content: [{ type: 'text' as const, text: `That checkCmd is not allowlisted (it runs outside the sandbox). Every \`&&\` segment must start with cd/gh/git/grep/rg/ls/cat/test/jq or the brain-fibery script. Got: ${args.checkCmd.slice(0, 80)}` }], isError: true };
      }
      const id = addCommitment(chatId, args.label.slice(0, 40), args.body, toUtcDb(at), {
        recur: args.recur,
        howToCheck: args.howToCheck,
        threadSlot: args.slot,
        focus: args.focus,
        focusBand: args.focusBand,
        checkCmd: args.checkCmd,
        ref: args.ref,
      });
      if (args.watchMode?.trim()) setWatchMode(id, chatId, args.watchMode);
      if (args.howToCheck) postEvent(chatId, 'commitment', `watching: ${args.body.split('\n')[0]}`);
      if (args.focus) postEvent(chatId, 'focus', `focus item added (tier ${args.focus}): ${args.label}`);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Committed "${args.label}" (#${id}) — ${args.howToCheck ? 'first check' : 'fires'} ~${fmtLocal(toUtcDb(at))}${args.recur ? `, ${args.recur}` : ''}.` +
              (args.focus ? ` In the FOCUS set at tier ${args.focus}${args.focusBand ? ` ("${args.focusBand}")` : ''}: workers now carry it.` : '') +
              (args.ref
                ? ` Points at ${args.ref} — readFocus will hand you that pointer next time.`
                : args.focus
                  ? ' No graph ref — if the graph knows this thing, add one with updateCommitment(action:"focus", ref:…); if it does not, that gap is worth saying out loud.'
                  : '') +
              (args.watchMode?.trim() === 'log' ? ' On the LEDGER in log mode: it never wakes you; read it on a sweep (ledgerHeads).' : args.watchMode?.trim() ? ` On the LEDGER: wakes you only when \`${args.watchMode.trim()}\` holds on the check's head.` : '') +
              (args.checkCmd
                ? ' Machine check attached — the next sweep records a baseline (no alert), and from then on you are woken only when its output changes.'
                : args.focus
                  ? ' No checkCmd, so it can only be checked by you or the user — attach one if a command can answer it.'
                  : ''),
          },
        ],
      };
    },
  );

  const listCommitmentsTool = tool(
    'listCommitments',
    'List the open commitments (id, mode fire/watch, label, body, due time, recurrence).',
    {},
    async () => {
      const rows = listCommitments(chatId).map(
        (c) =>
          `#${c.id} [${c.how_to_check ? 'watch' : 'fire'}] ${c.label} — due ~${fmtLocal(c.due_at)} local${c.recur ? ` (${c.recur})` : ''} · by ${c.created_by}\n   ${c.body.replace(/\n/g, ' ').slice(0, 200)}${c.how_to_check ? `\n   check: ${c.how_to_check}` : ''}`,
      );
      return { content: [{ type: 'text' as const, text: rows.join('\n') || '(none open)' }] };
    },
  );

  const updateCommitmentTool = tool(
    'updateCommitment',
    'Update a commitment: "defer" pushes its due time out; "rescope" rewrites what it watches (use when PART of it landed — narrow it to what remains instead of leaving stale check text or dropping and recreating; rescoping a checkCmd re-baselines it, so the next change is measured from the new question); "focus" puts it in the focus set at a tier (1 = closest to the user, higher = quieter) and is also how you RE-TIER an item whose situation moved; "unfocus" removes it from the set entirely — reserve that for what stopped mattering, not for what merely went quiet (that is a lower tier); "done" closes it (fired usefully / unblocked); "dropped" closes it as no longer relevant. Dropping the morning brief disables it until re-committed.',
    {
      id: z.number(),
      action: z.enum(['defer', 'rescope', 'focus', 'unfocus', 'done', 'dropped']),
      when: z.string().optional().describe('Required for defer: new local due time ("+4h", "HH:mm", "YYYY-MM-DD HH:mm")'),
      howToCheck: z.string().optional().describe('For rescope: the new how-to-check — what is still open and how to test it'),
      body: z.string().optional().describe('For rescope: the new body/what-is-watched, if that changed too'),
      checkCmd: z.string().optional().describe('For rescope/focus: the deterministic command the system runs itself (small, stable output)'),
      focus: z.number().optional().describe('For focus: which tier to put it in (1 = closest to the user, higher = quieter). Omit to keep its current tier, or to default a new focus item to 1. Use this to RE-TIER — an item someone just picked up moves up, a quieting one moves down.'),
      focusBand: z.string().optional().describe('For focus: short name for the band, e.g. "your ball" / "tracked, nobody on it"'),
      ref: z.string().optional().describe('For focus: the ENTITY this item is about ("core-api/ci-robustness-38"). Set it once and readFocus hands you the pointer every time after. Never guess one — a wrong ref gets followed.'),
      note: z.string().optional().describe('Optional resolution note'),
      watchMode: z.string().optional().describe('Set the LEDGER MODE on this watched item (with any action, or alone with "rescope"): "log" = record silently, never wake — the right setting for every item parked on the user\'s ball with no machine check; a predicate over the JSON head (e.g. `consecutive_fails >= 3`) = wake only when it holds; "" = back to wake-on-any-change.'),
    },
    async (args) => {
      if (args.checkCmd && !checkCommandAllowed(args.checkCmd)) {
        return { content: [{ type: 'text' as const, text: `That checkCmd is not allowlisted. Every \`&&\` segment must start with cd/gh/git/grep/rg/ls/cat/test/jq or the brain-fibery script. Got: ${args.checkCmd.slice(0, 80)}` }], isError: true };
      }
      if (args.action === 'focus' || args.action === 'unfocus') {
        const item = listCommitments(chatId).find((c) => c.id === args.id);
        if (!item) return { content: [{ type: 'text' as const, text: `No open commitment #${args.id}.` }], isError: true };
        // Re-tiering is the normal way a focus item's situation changes: a
        // parked bug someone just picked up moves UP a band, a merged PR's
        // leftovers move DOWN — neither should mean leaving and re-entering.
        const tier = args.action === 'unfocus' ? 0 : Math.max(1, Math.round(args.focus ?? (item.focus || 1)));
        setFocusFields(args.id, tier, args.focusBand, args.checkCmd);
        if (args.ref !== undefined) setCommitmentRef(args.id, chatId, args.ref.trim() || null);
        postEvent(chatId, 'focus', `${tier ? `focus tier ${tier}` : 'left the focus set'}: ${item.label}`);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                (tier
                  ? `#${args.id} is a FOCUS item at tier ${tier}${args.focusBand ? ` ("${args.focusBand}")` : ''} (yours alone — workers cannot see it).`
                  : `#${args.id} left the focus set.`) +
                (args.checkCmd ? ' Machine check attached — the next sweep baselines it.' : '') +
                (args.ref !== undefined ? ` Graph ref ${args.ref.trim() ? `set to ${args.ref.trim()}` : 'cleared'}.` : ''),
            },
          ],
        };
      }
      if (args.watchMode !== undefined) {
        const modeErr = validateWatchMode(args.watchMode);
        if (modeErr) return { content: [{ type: 'text' as const, text: `watchMode cannot be read: ${modeErr}` }], isError: true };
        if (!setWatchMode(args.id, chatId, args.watchMode)) return { content: [{ type: 'text' as const, text: `No open commitment #${args.id}.` }], isError: true };
        postEvent(chatId, 'focus', `ledger mode ${args.watchMode.trim() || 'wake-on-change'}: #${args.id}`);
        if (args.action === 'rescope' && args.howToCheck === undefined && args.body === undefined && args.checkCmd === undefined) {
          return { content: [{ type: 'text' as const, text: `#${args.id} ledger mode → ${args.watchMode.trim() || 'wake on any change'}.` }] };
        }
      }
      if (args.action === 'rescope') {
        if (args.howToCheck === undefined && args.body === undefined && args.checkCmd === undefined) {
          return { content: [{ type: 'text' as const, text: 'rescope needs `howToCheck`, `body` and/or `checkCmd`.' }], isError: true };
        }
        const ok = rescopeCommitment(args.id, chatId, { howToCheck: args.howToCheck, body: args.body, checkCmd: args.checkCmd });
        if (ok) postEvent(chatId, 'commitment', `re-scoped: #${args.id}`);
        return { content: [{ type: 'text' as const, text: ok ? `#${args.id} re-scoped.` : `No open commitment #${args.id}.` }] };
      }
      if (args.action === 'defer') {
        const at = args.when ? parseLocalWhen(args.when) : undefined;
        if (!at) return { content: [{ type: 'text' as const, text: 'defer needs a parseable future `when`.' }], isError: true };
        const ok = deferCommitment(args.id, chatId, toUtcDb(at));
        return { content: [{ type: 'text' as const, text: ok ? `#${args.id} deferred to ~${fmtLocal(toUtcDb(at))} local.` : `No open commitment #${args.id}.` }] };
      }
      const ok = resolveCommitment(args.id, chatId, args.action, args.note);
      if (ok && args.action === 'done') postEvent(chatId, 'commitment', `done: #${args.id}${args.note ? ` — ${args.note}` : ''}`);
      return { content: [{ type: 'text' as const, text: ok ? `#${args.id} → ${args.action}.` : `No open commitment #${args.id}.` }] };
    },
  );

  /**
   * THE LEDGER (design proposal #1) — the glance, the depth, the ack. The
   * heads are a MOVING value and ride into a turn only as this tool's result,
   * never in the prompt (I12).
   */
  const ledgerHeadsTool = tool(
    'ledgerHeads',
    'The ledger glance: one line per watched item on the ledger — its mode, its structured head (what the check last saw), unseen log rows. Read this on a sweep, on the morning triage, and when the user asks "what needs me?". Items with no check and no head are parked by hand; their line is the label.',
    {},
    async () => {
      const rows = ledgerHeads(chatId).map(
        (h) =>
          `#${h.id} [${h.watch_mode ?? 'wake-on-change'}${h.focus ? ` · tier ${h.focus}${h.focus_band ? ` ${h.focus_band}` : ''}` : ''}] ${h.label}${h.ref ? ` → ${h.ref}` : ''}` +
          `${h.unseen ? ` · ${h.unseen} unseen` : ''}${h.last_checked_at ? ` · seen ${h.last_checked_at.slice(0, 16)}` : ''}` +
          `\n   ${h.head === null ? (h.has_check ? '(no head yet — baseline pending)' : '(no machine check; parked by hand)') : JSON.stringify(h.head).slice(0, 300)}`,
      );
      return { content: [{ type: 'text' as const, text: rows.join('\n') || '(nothing on the ledger — set watchMode on a watched item, or give its check a JSON head)' }] };
    },
  );
  const ledgerLogTool = tool(
    'ledgerLog',
    'Drill into one ledger item: its last n log rows (the detail its check emitted), newest first. Open only when the head says to.',
    { id: z.number(), n: z.number().optional() },
    async (args) => {
      const rows = ledgerLog(args.id, args.n ?? 20).map((r) => `${r.seen ? ' ' : '*'} #${r.id} ${r.at.slice(0, 16)} ${r.kind}: ${r.payload.slice(0, 400)}`);
      return { content: [{ type: 'text' as const, text: rows.join('\n') || `(no log rows for #${args.id})` }] };
    },
  );
  const ledgerAckTool = tool(
    'ledgerAck',
    'Mark a ledger item\'s log rows seen (all, or up to a row id), so the next glance shows only what is new.',
    { id: z.number(), uptoId: z.number().optional() },
    async (args) => ({ content: [{ type: 'text' as const, text: `${ledgerAck(args.id, args.uptoId)} row(s) acked on #${args.id}.` }] }),
  );

  /**
   * LIFE UPKEEP (design proposal #7). Capture is one sentence from him —
   * "vacuumed", "did the dishes last night" — and the concierge does the rest;
   * he never maintains a schedule (the rule the retired quest system recorded:
   * his past attempts died when making the schedule became the task). State is
   * derived on read and arrives only as these results, never in the prompt (I12).
   */
  const lifeDoneTool = tool(
    'lifeDone',
    'Log personal upkeep he says he DID — "vacuumed", "did the dishes", "showered", "cleaned the fridge yesterday". One call per sentence; pass every item it names. `when` is local and past: omit for now, or "-2h", "yesterday", "21:30", "2026-11-12", "2026-11-12 21:30". An item that does not resolve is refused with the known list — never guess; ask, or add it with lifeTune if he means a new chore. Log quietly: a short acknowledgement at most, no lecture, no score unless he asks.',
    { items: z.array(z.string()).min(1), when: z.string().optional() },
    async (args) => {
      const now = new Date();
      const at = parseDoneWhen(args.when, now);
      if (!at) return { content: [{ type: 'text' as const, text: `Could not read when="${args.when}" as a past time — use -2h, yesterday, HH:mm or YYYY-MM-DD [HH:mm].` }] };
      const items = lifeItems();
      const msg = lastHumanMessage(view.key);
      const source = msg ? (msg.content.startsWith('🎤') ? 'voice' : 'text') : 'other';
      const done: string[] = [];
      const unknown: string[] = [];
      for (const said of args.items) {
        const it = resolveItem(items, said);
        if (!it) unknown.push(said);
        else {
          logLifeDone(it.id, at, source, msg?.id);
          done.push(it.id);
          pulse('life', `done: ${it.id}`);
        }
      }
      const known = items.map((i) => `${i.id} (${i.aka.slice(0, 3).join(', ')})`).join('; ');
      return {
        content: [
          {
            type: 'text' as const,
            text:
              (done.length ? `Logged ${done.join(', ')} at ${fmtLocal(at)} (${source}).` : 'Nothing logged.') +
              (unknown.length ? `\nUnknown: ${unknown.join(', ')}. Known items: ${known}.` : ''),
          },
        ],
      };
    },
  );
  const lifeStateTool = tool(
    'lifeState',
    'Personal upkeep right now: tier 1 (daily basics — done today or due) and tier 2 (house health: each chore\'s freshness decays by its half-life; health is the weighted mean, against the target and the act-below threshold). Read it when he asks how things stand, when planning his day, or on the morning triage. Never-logged items are left out of the score and shown as such.',
    {},
    async () => ({ content: [{ type: 'text' as const, text: renderLifeState(lifeItems(), lifeParams(), new Date()) }] }),
  );
  const lifeTuneTool = tool(
    'lifeTune',
    'Tune upkeep, when he says so or the log shows a number is wrong for his life: change an item\'s `days` (tier 1 cadence / tier 2 half-life), `weight` or `tier`; set the house `target` or `threshold` (0–1); or `add` a new chore (needs id, label, tier, days, aka). Say what you changed and why in your reply — he should never be surprised by a moved number.',
    {
      action: z.enum(['item', 'param', 'add']),
      id: z.string().optional(),
      field: z.enum(['days', 'weight', 'tier']).optional(),
      param: z.enum(['target', 'threshold']).optional(),
      value: z.number().optional(),
      label: z.string().optional(),
      tier: z.union([z.literal(1), z.literal(2)]).optional(),
      days: z.number().positive().optional(),
      aka: z.array(z.string()).optional(),
    },
    async (args) => {
      const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });
      if (args.action === 'param') {
        if (!args.param || args.value === undefined || args.value <= 0 || args.value > 1) return say('param needs param (target|threshold) and a value in (0, 1].');
        setLifeParam(args.param, args.value);
        pulse('life', `tuned ${args.param}`);
        return say(`${args.param} set to ${Math.round(args.value * 100)}%.`);
      }
      if (args.action === 'add') {
        if (!args.id || !args.label || !args.tier || !args.days) return say('add needs id, label, tier and days.');
        const id = args.id.trim().toLowerCase();
        if (!/^[a-z][a-z0-9-]*$/.test(id)) return say(`id "${args.id}" must be lowercase-kebab.`);
        pulse('life', `chore added: ${id}`);
        return say(addLifeItem(id, args.label, args.tier, args.days, args.aka ?? []) ? `Added ${id} (tier ${args.tier}, ${args.days}d).` : `${id} already exists — tune it instead.`);
      }
      if (!args.id || !args.field || args.value === undefined) return say('item needs id, field and value.');
      if (args.field === 'tier' && args.value !== 1 && args.value !== 2) return say('tier is 1 or 2.');
      if (args.field === 'days' && args.value <= 0) return say('days must be positive.');
      if (args.field === 'weight' && args.value < 0) return say('weight must be ≥ 0.');
      pulse('life', `tuned ${args.id}.${args.field}`);
      return say(tuneLifeItem(args.id, args.field, args.value) ? `${args.id}.${args.field} = ${args.value}.` : `No item "${args.id}".`);
    },
  );

  /**
   * THE BOARD (proposal #7) — the week as Mehdi sees it on the Atlas's /life
   * page. An automatic layer (commitments, chores coming due, the work block)
   * is always there; these tools PATCH it, with a reason, and never replace it.
   */
  const boardNow = () => buildBoard(boardCommitments(), lifeItems(), boardPatches(), new Date());
  const boardReadTool = tool(
    'boardRead',
    'Read the board — the 7-day timeline Mehdi sees on the Atlas life page — with every item\'s key. The automatic layer (dated commitments, chores coming due, the work block) is drawn whether or not you touch it; your patches improve it. Read before patching, on the morning triage, and after anything that changes his day (an appointment agreed, a plan moved).',
    {},
    async () => ({ content: [{ type: 'text' as const, text: renderBoard(boardNow()) }] }),
  );
  const boardAddTool = tool(
    'boardAdd',
    'Put something on his timeline that the automatic layer cannot know: a focus block, a chore at a good moment, a note for a day. For a DATED PLAN (an appointment he agreed, a flight) use commit() first — the automatic layer shows commitments by itself; then adjust its label/time if needed. For a tier-3 SESSION (a trip, a move, an paperwork step spanning days) pass dayTo: it is drawn as a span over the days, not a point. `day`: YYYY-MM-DD, today, tomorrow or a weekday; `at`/`until`: HH:mm local. Say why in `reason` — he sees it on hover.',
    {
      day: z.string(),
      dayTo: z.string().optional(),
      at: z.string().optional(),
      until: z.string().optional(),
      kind: z.enum(BOARD_KINDS as [string, ...string[]]),
      label: z.string().min(1).max(80),
      ref: z.string().optional(),
      reason: z.string().min(3),
    },
    async (args) => {
      const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });
      const now = new Date();
      const day = parseBoardDay(args.day, now);
      const dayTo = args.dayTo ? parseBoardDay(args.dayTo, now) : undefined;
      if (!day || (args.dayTo && !dayTo)) return say('day/dayTo must be YYYY-MM-DD, today, tomorrow or a weekday name.');
      if (dayTo && dayTo < day) return say('dayTo is before day.');
      if (!validTime(args.at) || !validTime(args.until)) return say('at/until must be HH:mm.');
      const id = addBoardPatch({ op: 'add', target: null, day, day_to: dayTo ?? null, at: args.at ?? null, until: args.until ?? null, kind: dayTo ? 'session' : args.kind, label: args.label, ref: args.ref ?? null, reason: args.reason });
      pulse('life', `board: placed ${args.label}`);
      return say(`Placed (patch #${id}) on ${day}${dayTo ? ` → ${dayTo}` : ''}${args.at ? ` at ${args.at}` : ''}.`);
    },
  );
  const boardAdjustTool = tool(
    'boardAdjust',
    'Fix an AUTOMATIC item on his timeline by its key (from boardRead): move it to a better day or time, or give it a clearer label — e.g. a commitment whose due time is when you nudge him, not when the thing happens. The item stays tied to its source; your fix survives recomputation. Always give the reason.',
    { key: z.string(), day: z.string().optional(), at: z.string().optional(), until: z.string().optional(), label: z.string().max(80).optional(), reason: z.string().min(3) },
    async (args) => {
      const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });
      const now = new Date();
      const day = args.day ? parseBoardDay(args.day, now) : undefined;
      if (args.day && !day) return say('day must be YYYY-MM-DD, today, tomorrow or a weekday name.');
      if (!validTime(args.at) || !validTime(args.until)) return say('at/until must be HH:mm.');
      if (!day && !args.at && !args.until && !args.label) return say('nothing to adjust — give day, at, until or label.');
      const b = boardNow();
      const known = [...b.days.flatMap((d) => d.items), ...b.hidden.map((h) => h.item)].some((i) => i.key === args.key && i.source === 'auto');
      if (!known) return say(`No automatic item with key ${args.key} this week — read the board first. (Your own items: revoke and re-add.)`);
      const id = addBoardPatch({ op: 'adjust', target: args.key, day: day ?? null, day_to: null, at: args.at ?? null, until: args.until ?? null, kind: null, label: args.label ?? null, ref: null, reason: args.reason });
      pulse('life', `board: adjusted ${args.key}`);
      return say(`Adjusted ${args.key} (patch #${id}).`);
    },
  );
  const boardHideTool = tool(
    'boardHide',
    'Hide an AUTOMATIC item from his timeline by key — something that is the machine\'s business, not his (a bot reminder), or noise for that day. It is not deleted: the page lists hidden items with your reason. Prefer adjust when the item is real but wrong.',
    { key: z.string(), reason: z.string().min(3) },
    async (args) => {
      const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });
      const b = boardNow();
      if (!b.days.flatMap((d) => d.items).some((i) => i.key === args.key && i.source === 'auto')) return say(`No visible automatic item with key ${args.key} — read the board first.`);
      const id = addBoardPatch({ op: 'hide', target: args.key, day: null, day_to: null, at: null, until: null, kind: null, label: null, ref: null, reason: args.reason });
      pulse('life', `board: hid ${args.key}`);
      return say(`Hidden ${args.key} (patch #${id}).`);
    },
  );
  const boardRevokeTool = tool(
    'boardRevoke',
    'Undo one of your board patches by its number (an add, an adjust, a hide): the automatic item returns to its default, or your added item leaves the board.',
    { patch: z.number() },
    async (args) => {
      const ok = revokeBoardPatch(args.patch);
      if (ok) pulse('life', `board: revoked #${args.patch}`);
      return { content: [{ type: 'text' as const, text: ok ? `Patch #${args.patch} revoked.` : `No active patch #${args.patch}.` }] };
    },
  );

  const pendingFindingsTool = tool(
    'pendingFindings',
    'List pending operator-gated PROPOSALS (changes to the bot\'s own code/prompts queued by the nightly rewrite — plus any legacy findings). Never act on one; point the user at /proposals.',
    {},
    async () => {
      const rows = pendingFindings(chatId).map((f) => `#${f.id} [${f.kind}] ${f.body}`);
      return { content: [{ type: 'text' as const, text: rows.join('\n') || '(none pending)' }] };
    },
  );

  const resolveFindingTool = tool(
    'resolveFinding',
    'Resolve a pending proposal: "applied" if the user implemented it, "dismissed" if they declined it, "delivered" for a legacy reminder you surfaced.',
    { id: z.number(), status: z.enum(['delivered', 'dismissed', 'applied']), note: z.string().optional() },
    async (args) => {
      resolveFinding(args.id, args.status, args.note);
      return { content: [{ type: 'text' as const, text: `#${args.id} → ${args.status}.` }] };
    },
  );

  /**
   * DESIGN PROPOSALS — the channel to the developer (docs/DECISIONS.md, Ideas
   * measured). A conversation that concludes the SYSTEM should change — "the
   * morning routine no longer works for me", "make a ledger so checks log
   * instead of waking you" — becomes a row with evidence, not a worker and a
   * file. Only a developer session (proposalCli) decides, lands or verifies.
   */
  const listDesignProposalsTool = tool(
    'listDesignProposals',
    'List DESIGN proposals — changes to how the system works, open between the bot and its developer. Read these BEFORE proposing: if the user raises something a row already covers, add evidence or amend it rather than opening another. Use `all` to include decided ones.',
    { all: z.boolean().optional() },
    async (args) => {
      const rows = args.all ? listDesignProposals([...PROPOSAL_STATUSES]) : listDesignProposals();
      return { content: [{ type: 'text' as const, text: rows.map(proposalLine).join('\n') || '(no design proposals open)' }] };
    },
  );
  const showDesignProposalTool = tool(
    'showDesignProposal',
    'The whole design proposal: problem, design, decision, evidence trail.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text' as const, text: renderProposal(args.id) ?? `no proposal #${args.id}` }] }),
  );
  const proposeDesignTool = tool(
    'proposeDesign',
    'Open a DESIGN proposal for the developer: a change to how the system works (not a one-file fix — that is proposeChange territory for the night). State the PROBLEM as observed, the design if one was discussed, which invariant or milestone it serves, and a verify command if the change would be observable. Then add evidence (addProposalEvidence) citing the messages that raised it. Never implement it; the developer decides.',
    {
      title: z.string(),
      problem: z.string().describe('What is wrong, as observed — with numbers where you have them'),
      body: z.string().optional().describe('The design, markdown; omit if only the problem is clear yet'),
      cites: z.string().optional().describe('e.g. "I9, I12, M3"'),
      verify: z.string().optional().describe('A read-only command that prints something once the change has shipped'),
    },
    async (args) => {
      const id = createDesignProposal({ ...args, actor: 'day' });
      return { content: [{ type: 'text' as const, text: `design proposal #${id} opened. Add the evidence that raised it (addProposalEvidence, kind message with ref msg#…).` }] };
    },
  );
  const addProposalEvidenceTool = tool(
    'addProposalEvidence',
    'Attach evidence to a design proposal: a message (ref "msg#14320"), a measured number (kind measure), an episode, a friction row, or a note. Evidence accrues on the SAME row across conversations — that is what makes the proposal more than an opinion.',
    {
      id: z.number(),
      kind: z.enum(['message', 'episode', 'friction', 'measure', 'note']),
      ref: z.string().optional(),
      text: z.string(),
    },
    async (args) => {
      const eid = addProposalEvidence({ proposalId: args.id, actor: 'day', kind: args.kind, ref: args.ref, text: args.text });
      return { content: [{ type: 'text' as const, text: `evidence #${eid} on proposal #${args.id}` }] };
    },
  );
  const amendDesignProposalTool = tool(
    'amendDesignProposal',
    'Change a design proposal\'s text — a perspective that moved, a section the conversation added. The note says WHAT changed and why; the old text stays reachable as an amend row. Prefer appendBody for additions.',
    {
      id: z.number(),
      note: z.string(),
      appendBody: z.string().optional(),
      body: z.string().optional(),
      problem: z.string().optional(),
      cites: z.string().optional(),
      verify: z.string().optional(),
    },
    async (args) => {
      const { id, note, ...changes } = args;
      const ok = amendDesignProposal(id, changes, 'day', note);
      return { content: [{ type: 'text' as const, text: ok ? `#${id} amended` : `no proposal #${id}` }] };
    },
  );

  /**
   * READ THE FOCUS SET ON DEMAND (Charter I7 — retrievable, not remembered).
   *
   * The set is also injected into this prompt today, which is the problem this
   * tool exists to retire. That injection is ~20k characters of the most
   * volatile text in the system — a probe sweep runs every 15 minutes and
   * rewrites it — sitting at the front of the cached prefix, so the concierge
   * re-caches its whole conversation on essentially every turn (I12; 3.07M
   * cache writes on 2026-08-02, about $19 of that day's $24 concierge spend).
   *
   * Injection cannot simply be deleted, though: the concierge ACTS on this set,
   * where a worker only carried it. So the tool lands first and the injection
   * stays, and every call is counted — when the counter shows the concierge
   * reaching for it by habit, the injected copy goes and the prompt keeps only
   * what a session can hold still. Removing the surface and hoping the tool got
   * used would risk a concierge that quietly stops volunteering focus items at
   * all, which is the one thing the set exists to prevent.
   */
  const readFocusTool = tool(
    'readFocus',
    'Read the CURRENT focus set — the ranked list of what the user is waiting on, with tiers, bands, each item\'s last verified state and anything that MOVED. Call it whenever you are about to act on, answer about, or re-tier the set, and any time your copy might be stale (a pulse has fired, a worker has finished, several turns have passed). It is a cheap local read, not a network call — prefer it over trusting what you remember.',
    {},
    async () => {
      bumpRetrieval('focus', 'set');
      const lines = mergedFocusLines(chatId, focusLines(chatId));
      // The set's own coverage, stated every time it is read.
      //
      // Two different messages depending on which way it leans, and both are
      // actionable: items WITH a ref are one find() from everything the system
      // knows; items WITHOUT one are either a ref nobody set or a node the
      // graph is missing, and the day is the only thing that can tell which.
      // Reported here rather than in a report because this is where someone is
      // already looking at the set.
      const set = listCommitments(chatId).filter((c) => c.focus > 0);
      const linked = set.filter((c) => c.ref).length;
      const coverage = set.length
        ? `\n\n[${linked}/${set.length} item(s) point at an entity. ` +
          (linked
            ? `Follow a "graph:" pointer with find() before answering from this line alone — the line is a label, the node is what the system has actually learned.`
            : `None do yet.`) +
          (linked < set.length
            ? ` For the ${set.length - linked} without one: set it with updateCommitment(action:"focus", ref:"domain/id") when the graph knows the thing, and say so plainly when it does not — a focus item with no node is the graph missing a concept, which is worth more than a silent gap.`
            : '') +
          ']'
        : '';
      return {
        content: [
          {
            type: 'text' as const,
            text:
              (lines.join('\n') ||
                '(the focus set is empty — build it with commit(..., focus: 1, focusBand: …, checkCmd: …))') + coverage,
          },
        ],
      };
    },
  );

  /**
   * THE STORY'S DOOR (round 11, P2b). The level-0 block in the prompt names
   * readStory("<domain>") on every pointer line; this is the call it names.
   * Three days of real use showed the block alone could not move the day —
   * the narrative behind it lived in story.md, a file no tool here could
   * open, so the pointer was a dead end. A story is a render of the graph:
   * reading one counts as a graph reach in the episode log (friction.ts),
   * which is the drill-through number the round turns on.
   */
  const readStoryTool = tool(
    'readStory',
    'Open one domain\'s story — the few hundred words the night keeps current over that domain\'s graph, every claim carrying a [[ref]] you can find(). The pointer line in "The story" names it: follow it BEFORE answering a question about that domain, and before dispatching work into it — the line you saw is the first sentence, the story is the rest. Scope is a domain name ("affiliate-app", "paperwork") or "root". Local read, no network.',
    { scope: z.string().describe('A domain name, e.g. "affiliate-app", or "root".') },
    async (args) => {
      const r = readStory(args.scope);
      if ('text' in r) {
        bumpRetrieval('story', args.scope);
        return { content: [{ type: 'text' as const, text: r.text }] };
      }
      noteMiss('story', 'readStory', args.scope, view.key);
      return { content: [{ type: 'text' as const, text: r.problem }] };
    },
  );

  return createSdkMcpServer({
    // Never deferred behind tool search (2026-08-27): with ~30 tools the CLI
    // deferred these schemas, and the concierge spent 104 ToolSearch calls in
    // seven days loading its OWN core tools (send, commit, observe …) — a model
    // round-trip per load. Loaded, they sit in a prefix that is now cached: a
    // stable ~10k-token read in exchange for a model call. In-process servers
    // connect instantly, so the startup block this implies costs nothing.
    alwaysLoad: true,
    name: 'bot',
    version: '1.0.0',
    instructions: 'Tools to manage the bot: threads, routing, the knowledge base (root + tree), commitments, and findings.',
    tools: [
      listThreads, readThread, dispatchTask, stopWorker, newThread, switchThread, renameThread, updateBrief, findThreadTool, setThreadMode, closeThread,
      digestSource, readNote, writeNote, removeNote, noteIdeaTool, recordBehavior, buildObserveTool(view.key), ...buildModuleTools(view.key),
      searchMessagesTool, readMessageTool, findPastWorkTool, locateThreadTrace, sendVoiceTool,
      commitTool, listCommitmentsTool, updateCommitmentTool, readFocusTool, readStoryTool, resetThreadTool,
      pendingFindingsTool, resolveFindingTool,
      ledgerHeadsTool, ledgerLogTool, ledgerAckTool,
      lifeDoneTool, lifeStateTool, lifeTuneTool,
      boardReadTool, boardAddTool, boardAdjustTool, boardHideTool, boardRevokeTool,
      listDesignProposalsTool, showDesignProposalTool, proposeDesignTool, addProposalEvidenceTool, amendDesignProposalTool,
    ],
  });
}
