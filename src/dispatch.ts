import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { config, type PermissionMode } from './config.js';
import { askClaude } from './claude.js';
import { digestFile } from './digest.js';
import { allowed, currentMode, debugState, dreamState, enterDebug, exitDebug, refusal } from './mode.js';
import { nightOwed, settleTonight } from './night.js';
import { runRewrite } from './operator.js';
import { spokenNote, transcribe } from './transcribe.js';
import { memoryCue } from './recall.js';
import { sampleTextFor, speak, voiceChoice, voiceOutStatus } from './speak.js';
import { setVoicePrefs } from './db.js';
import { proposalLine } from './proposals.js';
import {
  addPending,
  clearPending,
  clearSession,
  countPending,
  getCard,
  episodeById,
  episodeStats,
  episodesByProject,
  type EpisodeRow,
  episodesToDistill,
  escalationsToday,
  focusBands,
  focusItems,
  getPrefs,
  beginTurn,
  endTurn,
  getSessionId,
  storedSessionId,
  isCapturing,
  listCommitments,
  listPending,
  listRepos,
  openFocusChanges,
  listSessions,
  logMessage,
  pendingFindings,
  postEvent,
  recentEpisodes,
  recentDreams,
  recentGrows,
  recentMessages,
  queuedTurnCount,
  statsRollup,
  closeRetrievalEpisode,
  isThreadFresh,
  openRetrievalEpisode,
  noteRetrievalHints,
  requestDreamCancel,
  hasRecoveryRows,
  refreshAutoTitle,
  sessionForMessage,
  sessionKey,
  setCapturing,
  saveUsage,
  setRecap,
  setSessionId,
  threadModel,
  listDesignProposals,
} from './db.js';
import { completionDecision, completionReadout } from './completion.js';
import { type Brief, briefMarker, briefRecap, briefWorkerRun } from './brief.js';
import { builtinToolsFor, turnOptions } from './modelChoice.js';
import { noteSessionReplaced, resolveConciergePrompt, resolveWorkerPrompt, settleSnapshot } from './sessionPrompt.js';
import { chunkRaw, describeTool, escapeHtml, fileOpMessage } from './format.js';
import { createCanUseTool, resolvePermission } from './permissions.js';
import {
  attentionSet,
  buildConciergeServer,
  CONCIERGE_TOOLS,
  renderCard,
  resolveConfirm,
  takePendingDispatch,
  takePendingSeed,
  takePendingSwitch,
} from './concierge.js';
import { CONTROL_SLOT, ensureChat, markInterrupted, RunningView, titleOf } from './sessions.js';
import { composeTurnPrompt, consumeHandoff, pendingHandoff, rotateIfDue } from './rotation.js';
import { QUEUE_TTL_MIN, RESTART_SOURCE, restartEventBody, takeRecoveryIfAllowed } from './replay.js';
import { buildUiServer, clearPendingAsks, resolveAsk, takeQuickReply } from './ui.js';
import { buildWorkerServer, WORKER_TOOL_NAMES } from './workerTools.js';
import { addRepos, scanWorkspace } from './workspace.js';
import { fmtLocal } from './commitments.js';
import { noteToolCall } from './friction.js';
import { pulse } from './pulse.js';
import * as lock from './turnLock.js';
import { harvestAll } from './harvest.js';
import { distillEpisodeNow, distillPending } from './distill.js';
import { findWork, resumeHint } from './discovery.js';
import type { ChatAdapter, Inbound, InboundCallback, InboundCommand, InboundMessage } from './transport/types.js';

/** A resolved target: a chat and the session slot a turn should run against. */
interface Target {
  chatId: number;
  slot: number;
  key: string;
}

function targetForSlot(chatId: number, slot: number): Target {
  return { chatId, slot, key: sessionKey(chatId, slot) };
}

// The single chat transport for this process, set in registerDispatch().
let adapter!: ChatAdapter;

/**
 * Wire the dispatcher to a chat adapter: the bot's transport-agnostic core. All
 * grammy/Telegram specifics live behind the ChatAdapter; this module only sees
 * normalized inbound events and the outbound transport.
 */
export function registerDispatch(a: ChatAdapter): void {
  adapter = a;
  a.onEvent(handleEvent);
}

async function handleEvent(e: Inbound): Promise<void> {
  try {
    // THE DAY DOOR. Commands still work — that is how you get back out, and a
    // mode you cannot leave from the same place you entered is a trap (I8).
    // Plain messages do not: nothing may be added to the concierge's context
    // while the machine is being worked on, which is the whole definition of
    // debug mode rather than a side effect of it.
    if (e.kind === 'message' && !allowed('day-turn')) {
      await adapter.send(e.chatId, { text: `🔧 ${refusal('day-turn')}`, format: 'plain' }).catch(() => {});
      return;
    }
    if (e.kind === 'command') await handleCommand(e);
    else if (e.kind === 'message') handleMessage(e);
    else await handleCallback(e);
  } catch (err) {
    console.error('[dispatch] error', err);
  }
}

// --- Turn execution ---------------------------------------------------------

// Per-session turn serialization lives in `turnLock.ts`: it is fifty lines that
// have taken the bot down twice, so it is a named unit with its own tests
// rather than private state here.
// Abort a turn that emits no events for this long — a hung subprocess otherwise
// holds the session lock forever and silently blocks every queued message.
const TURN_IDLE_MS = 20 * 60 * 1000;

/*
 * WHAT A WORKER SEES: a frozen prompt, and its brief once. `workerContext`
 * lived here until 2026-08-28 — the brief appended to the preset system
 * prompt, kept byte-stable since the $86 session of 08-02 (a focus set with
 * wall-clock stamps in the prefix re-wrote 614k cached tokens per call). The
 * preset in front of it moved anyway, per process; the brief now rides in the
 * first turn's [SESSION OPEN] block and the prompt is src/workerPrompt.ts.
 */

/**
 * THE CONTRACT A SESSION IS BUILT UNDER — its tool set and the shape of its
 * injected context, together.
 *
 * A resume is only safe while the world the transcript was written in still
 * exists. When the worker was stripped to its brief, every stored worker
 * session became a 629k-token history of calls to tools that had just been
 * deleted, assembled from surfaces the worker could no longer see. Resuming one
 * pays full price to re-cache a transcript that then actively misleads the
 * model about what it can do.
 *
 * The tool list is HASHED IN rather than described, so changing the tool set is
 * itself the invalidation — nobody has to remember to bump a number or to clear
 * sessions by hand (I9). The literal prefix covers the other half, the shape of
 * the injected context, which no hash can see: bump it when what a turn injects
 * changes materially.
 */
function contractFor(isControl: boolean): string {
  // concierge:2 — 2026-08-27: the volatile state left the system prompt for
  // a one-time session-open snapshot, and the built-in tool set became a
  // configured list. Both change what a transcript was built on.
  // worker:3 — 2026-08-28: the claude_code preset (date, environment, git
  // status per process) gave way to a frozen custom prompt with a one-time
  // session-open snapshot; a transcript built on the preset is not resumed.
  const shape = isControl ? 'concierge:2' : 'worker:3';
  const builtins = isControl ? `|builtin:${config.conciergeBuiltinTools.join(',')}` : '';
  const tools = [...(isControl ? CONCIERGE_TOOLS : WORKER_TOOL_NAMES)].join(',') + builtins;
  return `${shape}/${createHash('sha256').update(tools).digest('hex').slice(0, 8)}`;
}

/** Run one turn against Claude Code, rendering progress through the view. */
async function runTurn(
  target: Target,
  text: string,
  opts: { visible: boolean; userMsgId?: number; background?: boolean; human?: boolean },
): Promise<void> {
  const { visible, userMsgId, background = false, human = false } = opts;
  const { chatId, slot, key } = target;
  if (userMsgId !== undefined) await adapter.react(chatId, userMsgId, '✍');
  // A fresh turn supersedes any buttons this session was waiting on, so a late
  // tap can't re-invoke it a second time after it already moved on.
  clearPendingAsks(key);

  const isControl = slot === CONTROL_SLOT;
  // The concierge is an all-day session: its whole history re-sends every turn.
  // It is rotated by CONTEXT SIZE at an idle seam (src/rotation.ts) — never by
  // a turn count, which on 2026-08-25 cut a conversation in half — and the
  // new session gets a handoff rendered from the database, in the turn. The
  // nightly clear in the operator is the other, mandatory, clearer.
  // A rotation persists its handoff (pending_handoff); if the turn that was to
  // carry it died first — 2026-08-27: rotated at 09:15, hung, restarted — the
  // next turn on the empty session carries it instead. Consumed only when the
  // NEW session acknowledges, below, so a second death leaves it for a third.
  const handoff = isControl ? (rotateIfDue(chatId, key, human) ?? pendingHandoff(chatId, key)) : undefined;

  // THE CONTROLLER AND THE WATCHDOG COME FIRST, before anything that can block.
  //
  // They used to be created after the whole setup below — `view.begin()` (a
  // Telegram round-trip), the MCP servers, the system prompt. A hang anywhere in
  // that stretch left the session holding `busy` with no controller to abort and
  // no timer to notice, which is precisely the state that swallowed a morning of
  // messages on 2026-08-06. Registering here means every path from this point on
  // is both cancellable and watched.
  const abortController = new AbortController();
  lock.register(key, abortController);

  // Watchdog: abort a turn that goes silent too long (a hung/dead subprocess) so
  // it can't hold the session lock forever. Re-armed on every event.
  let timedOut = false;
  const arm = () =>
    setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, TURN_IDLE_MS);
  let idle = arm();

  const view = new RunningView(adapter, chatId, slot, visible, background);
  await view.begin();
  const canUseTool = createCanUseTool(view);
  const prefs = getPrefs(key);
  const permissionMode = isControl
    ? 'bypassPermissions'
    : (prefs.permissionMode as PermissionMode) ?? config.permissionMode;
  const cwd = prefs.cwd ?? config.workingDir;
  const mcpServers = isControl
    ? { bot: buildConciergeServer(view), telegram: buildUiServer(view) }
    : { telegram: buildUiServer(view), bot: buildWorkerServer(chatId, slot) };
  // The concierge's system prompt is FROZEN for the session (I12): built once
  // when the session opens, reused byte-for-byte after, dropped by every
  // clear. The state it used to carry every turn rides in the first turn as a
  // snapshot instead. src/sessionPrompt.ts explains the 13,573-token reading
  // that forced this. The contract is resolved here (it names the prompt's
  // tool set) and reused for the resume below.
  // A worker's prompt is frozen the same way (src/workerPrompt.ts): the
  // claude_code preset moved per process — date, cwd, git status — and its
  // brief moves into the same one-time snapshot.
  const contract = contractFor(isControl);
  const resolved = isControl
    ? resolveConciergePrompt(chatId, key, contract)
    : resolveWorkerPrompt(chatId, slot, key, contract, cwd);
  const sessionOpen = resolved.sessionOpen;
  const concierge = isControl ? { systemPrompt: resolved.systemPrompt, allowedTools: CONCIERGE_TOOLS } : undefined;
  const workerPrompt = isControl ? undefined : resolved.systemPrompt;
  // Which built-in tools EXIST for this turn (SDK `tools`): the concierge's
  // configured list (default none); a worker keeps the SDK default.
  const builtinTools = builtinToolsFor(isControl, config);
  // Which model, how hard: the concierge on CLAUDE_MODEL at its configured
  // effort; a worker on what its dispatch chose, else the deployment default
  // (src/modelChoice.ts). Recorded on the usage row so the cost line can tell.
  const choice = turnOptions({ isControl, thread: isControl ? undefined : threadModel(chatId, slot), config });
  let ok = true;
  // How this turn ENDED, when it did not simply finish. Rendered into the box
  // rather than sent as a message beside it: a turn owns one message, and a
  // failure detached from the thing that failed is how a run "ended" three
  // messages above the box that still said Thinking.
  let endHeadline: string | undefined;
  let lastText = '';
  const turnStarted = Date.now();
  // Persist that this turn is in flight. Cleared in the `finally` below, on
  // every exit path — so a row that outlives the process is proof the turn was
  // killed rather than finished. See turns_running in db.ts.
  const turnRow = beginTurn(key, chatId, slot, text, human, userMsgId);
  // THE RETRIEVAL EPISODE (M4). The turn is the question's natural boundary:
  // it has a trigger, it has an end, and every graph call in between was made
  // in service of the same thing. Grouping cannot be recovered afterwards from
  // a call log, which is why this lands with M4 rather than after it.
  openRetrievalEpisode(key, concierge ? 'day' : 'worker', text);
  // THE MEMORY CUE (src/recall.ts): under a human message to the concierge,
  // the nodes it names. In the prompt only — the logged message stays what
  // Mehdi wrote, the cue is machinery.
  const cue = concierge && human ? memoryCue(text) : undefined;
  if (cue) noteRetrievalHints(key, cue.refs);
  const promptText = cue ? `${text}\n\n${cue.line}` : text;
  pulse('turn', `${key} started — ${text.slice(0, 60).replace(/\s+/g, ' ')}`, {
    refs: cue?.refs,
    meta: { sessionKey: key, concierge, visible, phase: 'start', cued: cue?.refs.length ?? 0 },
  });
  try {
    const resume = getSessionId(key, contract);
    for await (const ev of askClaude({
      prompt: composeTurnPrompt(handoff, promptText, sessionOpen),
      resume,
      canUseTool: isControl ? undefined : canUseTool,
      permissionMode,
      cwd,
      mcpServers,
      concierge,
      systemPrompt: workerPrompt,
      abortController,
      model: choice.model,
      effort: choice.effort,
      ...(builtinTools ? { tools: builtinTools } : {}),
    })) {
      clearTimeout(idle);
      idle = arm();
      switch (ev.kind) {
        case 'session':
          setSessionId(key, ev.sessionId, contract);
          // The handoff is in this session's transcript now; the row has done its job.
          if (handoff) consumeHandoff(key);
          // The snapshot is NOT settled here — init is not completion; see the
          // turn's finally. But if the SDK answered a resume with a NEW session
          // id, the transcript that exists never saw the snapshot, and the
          // next turn owes one (the frozen prompt itself still holds).
          if (noteSessionReplaced(key, resume, ev.sessionId)) {
            postEvent(
              chatId,
              isControl ? 'concierge' : titleOf(chatId, slot),
              `the SDK replaced the ${isControl ? 'concierge' : 'worker'} session under a resume — session-open snapshot re-sent next turn`,
            );
          }
          break;
        case 'tool': {
          // Round 9: an agent reading the knowledge tree RAW is the system's
          // most honest bug report — a function the memory API does not have,
          // reported by behaviour instead of by self-assessment. Silent and
          // non-blocking; it never changes what the agent is allowed to do.
          noteToolCall(key, ev.name, ev.input);
          const tv = describeTool(ev.name, ev.input);
          if (!tv.mute) view.action(tv.summary, tv.subagent ? '🤖' : '⚙️');
          const opMsg = fileOpMessage(ev.name, ev.input);
          if (opMsg) await view.fileOp(opMsg);
          break;
        }
        case 'text':
          logMessage(key, 'assistant', ev.text);
          lastText = ev.text;
          await view.answer(ev.text);
          break;
        case 'result':
          ok = ev.ok;
          if (ev.usage) saveUsage(key, { ...ev.usage, effortAsked: choice.effort ?? '' });
          if (!ev.ok) endHeadline = `⚠️ <b>Run ended</b> — ${escapeHtml(ev.error ?? 'unknown error')}`;
          break;
      }
    }
  } catch (err) {
    ok = false;
    if (abortController.signal.aborted) {
      endHeadline = timedOut ? '⌛ <b>Timed out</b> — no activity, thread freed' : '🛑 <b>Cancelled</b>';
    } else {
      console.error('[claude] error', err);
      endHeadline = `⚠️ <b>Error</b> — ${escapeHtml(err instanceof Error ? err.message : String(err))}`;
    }
  } finally {
    // The state snapshot is in the transcript only if the turn that carried
    // it ENDED ok; a turn that died after init would otherwise settle a debt it
    // never paid, and every later turn would open a fresh transcript with no
    // state for the rest of the day (src/sessionPrompt.ts).
    if (sessionOpen && ok && !abortController.signal.aborted) settleSnapshot(key);
    endTurn(turnRow);
    // Scored here, in the same `finally` as endTurn, so a turn that threw or
    // was interrupted still records what it reached for. An episode that only
    // closes on success would report the happy path as the whole workload.
    closeRetrievalEpisode(key);
    clearTimeout(idle);
    // the lock is released by enqueueTurn's finally; only the handle goes here
    lock.register(key, new AbortController());
    pulse('turn', `${key} ${ok ? 'finished' : 'failed'} — ${Math.round((Date.now() - turnStarted) / 1000)}s`, {
      loud: !ok,
      meta: { sessionKey: key, concierge, ok, ms: Date.now() - turnStarted, phase: 'end' },
    });
    await view.finish(ok, endHeadline);
    if (userMsgId !== undefined)
      await adapter.react(chatId, userMsgId, abortController.signal.aborted ? '🤔' : ok ? '👍' : '😱');
    if (isControl) {
      applyConciergeMoves(chatId);
    } else {
      // A DISPATCHED worker finished → wake the concierge to decide whether and
      // how to report it. This is no longer the same condition as "was hidden":
      // the worker showed its own box the whole time, and the concierge still
      // owes the user a sentence about what came of it.
      //
      // Once per RUN, not per turn: a steer queues a [GUIDANCE] turn behind
      // this one, and reporting now would say "finished" about a worker that
      // is about to keep going (2026-08-27). The debt carries to the turn that
      // empties the queue; an abort clears it (src/completion.ts).
      const owed = owedReports.get(key);
      const d = completionDecision({
        background: Boolean(background),
        aborted: abortController.signal.aborted,
        queued: queuedTurnCount(key),
        owed: owed !== undefined,
      });
      const runOk = ok && (owed?.ok ?? true);
      if (d.owe) owedReports.set(key, { ok: runOk });
      else owedReports.delete(key);
      if (d.notify) void reportRun(target, view, runOk);
    }
    if (!isControl) {
      // Refresh the auto recap (latest worker state) so "what's it doing?" is
      // answerable without re-reading the thread; and keep the title fresh from
      // Claude Code's free session summary. When the run ends, reportRun()
      // replaces this with the brief's first line — the same artifact the
      // concierge and the box get.
      if (lastText.trim()) {
        const recap = lastText.replace(/\s+/g, ' ').trim().slice(0, 200);
        setRecap(chatId, slot, recap);
        // The recap doubles as this turn's awareness event — already computed,
        // zero LLM cost, and every other context sees it in its next bulletin.
        postEvent(chatId, titleOf(chatId, slot), recap);
      }
      void refreshThreadTitle(chatId, slot);
    }
  }
}

/**
 * Apply the concierge's deferred moves after its reply (so they don't suppress
 * its own output). DISPATCH = run a worker in the background (quiet); the
 * "watch" move (newThread/switchThread with a task) = run the seed visibly, so
 * its progress renders into the one live message the turn owns.
 */
function applyConciergeMoves(chatId: number): void {
  for (const d of takePendingDispatch(chatId)) {
    const wt = targetForSlot(chatId, d.slot);
    /**
     * A FRESH WORKER FORGETS BEFORE IT STARTS, not after it finishes.
     *
     * Enforced here rather than trusted to whoever set the flag, because the
     * failure this fixes was precisely a policy nobody was in a position to
     * remember at the moment it mattered: the Morning Routine resumed the same
     * session every day and rebuilt its standup sheet from its own previous
     * answer, so a line Mehdi had closed on 08-18 came back on 08-19 looking
     * authoritative while every durable store said otherwise.
     *
     * Before the dispatch, so the worker's first token is written against the
     * brief and the graph and nothing else.
     */
    if (isThreadFresh(chatId, d.slot)) {
      clearSession(wt.key);
      postEvent(chatId, 'concierge', `worker slot ${d.slot} starts fresh — no memory of its previous run`);
    }
    logMessage(wt.key, 'user', d.text, 'machine');
    void enqueueTurn(wt, d.text, { visible: true, background: true });
  }
  const sw = takePendingSwitch(chatId);
  if (sw !== undefined) {
    const seed = takePendingSeed(chatId);
    if (seed && seed.slot === sw) {
      const wt = targetForSlot(chatId, sw);
      logMessage(wt.key, 'user', seed.text, 'machine');
      void enqueueTurn(wt, seed.text, { visible: true });
    }
    // A switch with no task has nothing to run — the worker is reachable by reply.
  }
}

/**
 * Pull Claude Code's free per-session summary (no LLM call) and use it as the
 * thread's title unless it was explicitly renamed. Best-effort.
 */
async function refreshThreadTitle(chatId: number, slot: number): Promise<void> {
  if (slot === CONTROL_SLOT) return;
  const key = sessionKey(chatId, slot);
  const sessionId = storedSessionId(key);
  if (!sessionId) return;
  const cwd = getPrefs(key).cwd ?? config.workingDir;
  try {
    const info = await getSessionInfo(sessionId, { dir: cwd });
    const summary = info?.summary?.trim();
    if (summary && summary.length > 3) refreshAutoTitle(chatId, slot, summary.slice(0, 60));
  } catch {
    /* session file not found / no summary — ignore */
  }
}

/**
 * Wake the concierge after a background worker completes: hand it the worker's
 * result and let it decide whether to notify the user. Runs as a normal
 * (visible) concierge turn, so its reply reaches the chat. Fire-and-forget.
 */
/**
 * Reports deferred until a worker's queue drains — one per run. In memory on
 * purpose: a process death is already handled by restart recovery, which
 * reports every interrupted worker turn itself, so a debt lost with the process
 * is a report that arrives by the other door.
 */
const owedReports = new Map<string, { ok: boolean }>();

/**
 * A worker's run has ended and a report is due: ONE brief, three surfaces.
 * The brief (src/brief.ts) is generated from the thread, then it becomes the
 * thread's recap, the closed box's answer, and what the concierge is woken
 * with. If it cannot be generated, the concierge still gets the readout —
 * the summarizer is a convenience over a report that must arrive (I8).
 */
async function reportRun(worker: Target, view: RunningView, ok: boolean): Promise<void> {
  // The box has already closed on the worker's raw last words; for the seconds
  // the summarizer takes it shows that tail, then the brief replaces it. The
  // recap has the same window. Closing later would delay the box by the same
  // seconds, and a visible close was judged worth the flicker.
  let brief: Brief | undefined;
  try {
    brief = await briefWorkerRun(worker.chatId, worker.key);
  } catch (e) {
    console.error('[brief] generation threw; the readout goes instead', e);
  }
  if (brief) {
    const recap = briefRecap(brief.text);
    if (recap) setRecap(worker.chatId, worker.slot, recap);
    await view.showBrief(brief.text).catch(() => {});
  }
  await notifyCompletion(worker, ok, brief);
}

async function notifyCompletion(worker: Target, ok: boolean, brief?: Brief): Promise<void> {
  const title = titleOf(worker.chatId, worker.slot);
  // The brief is the wake-up; the thread is the source. The readout is only
  // the fallback for a run whose brief could not be generated, and says so.
  const recent = brief
    ? `${briefMarker(worker.slot, brief.firstId, brief.lastId)}\n${brief.text}`
    : `[READOUT — the brief could not be generated for this run; this is the raw tail, and readThread(${worker.slot}) is the source]\n` +
      completionReadout(recentMessages(worker.key, 8), worker.slot);
  const prompt =
    `[SYSTEM EVENT] The background worker "${title}" just ${ok ? 'finished' : 'stopped with an error'}. ` +
    `${brief ? 'Its run, briefed' : 'Its recent activity'}:\n${recent}\n\n` +
    `If this is worth telling the user, deliver ONE concise notice with the telegram send tool — what got done, ` +
    `and offer a sensible next step as an inline reply button if useful. If it's trivial or just an acknowledgement, do nothing. ` +
    `If the worker ended waiting on a person/event/time and didn't record it itself, commit a watched item (commit with howToCheck) so it gets re-checked.`;
  await enqueueTurn(targetForSlot(worker.chatId, CONTROL_SLOT), prompt, { visible: true });
}

/**
 * Run a system-originated concierge turn (a fired commitment, the nightly pipeline
 * reporting in). Same path as notifyCompletion: visible, so the concierge's
 * reply reaches the chat; the concierge decides whether that reply is anything.
 */
export async function runConciergeSystemTurn(chatId: number, text: string): Promise<void> {
  ensureChat(chatId);
  await enqueueTurn(targetForSlot(chatId, CONTROL_SLOT), text, { visible: true });
}


/**
 * BOOT: account for every turn the last process did not finish.
 *
 * A turn that dies with its process leaves no result event, therefore no usage
 * row, therefore nothing at all — and badges are rebuilt from scratch, so an
 * interrupted thread and an idle one look identical. That is how, on
 * 2026-08-02, a `tsx watch` restart killed slot 46 mid-edit and the concierge
 * spent the next 34 minutes telling Mehdi the worker was "actively running".
 *
 * This is the counterpart to rearmWatches(). A watch CAN be re-armed, because
 * `gh run watch` re-attaches to a run that is still going and the external
 * world holds the state. A TURN cannot: its work was half-applied to a working
 * tree and only the repo knows how far it got, so replaying the prompt could
 * redo something destructive. The honest move is therefore to REPORT, not to
 * retry — mark the thread, and hand the concierge the facts (which thread, what
 * it was asked, when it died, what it last said) so it can look at the actual
 * state and tell the user. Judging stays with the concierge; noticing is code.
 */
let recovering = false;
export async function recoverAfterRestart(): Promise<void> {
  // Called at boot AND from the tick: gated by the mode, it leaves the rows in
  // place while the day is not allowed to run (debug, a night owed) and drains
  // them the minute it is. Idempotent once drained. Not re-entrant: a tick
  // must not overlap a boot still fanning out its replays.
  if (recovering) return;
  recovering = true;
  try {
    await recoverOnce();
  } finally {
    recovering = false;
  }
}

async function recoverOnce(): Promise<void> {
  // ONE transaction takes every row the last process left, so a boot that dies
  // mid-recovery cannot see them again: at-most-once by construction. Then the
  // sync half of each enqueue runs before anything is awaited — the first turn
  // takes its lock, the rest are written straight back as fresh queue rows —
  // so a death during the first replayed turn strands only that turn, which
  // the next boot sees as an in-flight human row and replays once more; a row
  // framed as a replay twice is reported instead (src/replay.ts).
  const taken = takeRecoveryIfAllowed();
  if ('refused' in taken) {
    if (hasRecoveryRows()) console.warn(`[dispatch] restart recovery waiting — ${taken.refused}`);
    return;
  }
  const plan = taken.plan;
  for (const q of plan.expired) {
    postEvent(q.chat_id, RESTART_SOURCE, restartEventBody('expired', `queued ${q.created_at} UTC, past the ${QUEUE_TTL_MIN / 60}h bound: ${q.text}`));
  }
  for (const r of plan.replay) {
    if (!config.allowedChatIds.has(r.chatId)) {
      postEvent(r.chatId, RESTART_SOURCE, restartEventBody('dropped', `chat not allowed: ${r.original}`));
      continue;
    }
    postEvent(r.chatId, RESTART_SOURCE, restartEventBody('replayed', `${r.origin}: ${r.original}`));
    void enqueueTurn(targetForSlot(r.chatId, r.slot), r.text, {
      visible: r.visible,
      userMsgId: r.userMsgId,
      background: r.background || undefined,
      human: r.human,
    }).catch((e: unknown) => console.error('[dispatch] replayed turn failed', e));
  }
  if (plan.replay.length) console.warn(`[dispatch] ${plan.replay.length} turn(s) replayed after the last shutdown`);

  // What is REPORTED rather than run: machine turns that were in flight, and
  // a person's turn that was replayed once and died again. Both get a line in
  // the same [INTERRUPTED] batch, so the person hears about it either way.
  const stranded = [...plan.report, ...plan.abandoned];
  if (!stranded.length) return;
  const abandoned = new Set(plan.abandoned.map((t) => t.id));

  const byChat = new Map<number, typeof stranded>();
  for (const t of stranded) {
    markInterrupted(t.session_key);
    postEvent(
      t.chat_id,
      RESTART_SOURCE,
      abandoned.has(t.id)
        ? restartEventBody('abandoned', `${t.prompt_head} (replayed once and died again)`)
        : restartEventBody('killed', `${titleOf(t.chat_id, t.slot)} (started ${t.started_at} UTC)`),
    );
    byChat.set(t.chat_id, [...(byChat.get(t.chat_id) ?? []), t]);
  }
  console.warn(`[dispatch] ${stranded.length} turn(s) were interrupted by the last shutdown`);

  for (const [chatId, turns] of byChat) {
    if (!config.allowedChatIds.has(chatId)) continue;
    const lines = turns.map((t) => {
      const last = recentMessages(t.session_key, 1).find((m) => m.role === 'assistant')?.content ?? '';
      const said = last ? `\n    last thing it said: ${last.replace(/\s+/g, ' ').slice(0, 200)}` : '';
      const where = t.slot === CONTROL_SLOT ? 'you (the concierge)' : `slot ${t.slot} — "${titleOf(chatId, t.slot)}"`;
      if (abandoned.has(t.id)) {
        return `- ${where}, started ${t.started_at} UTC — THE USER'S OWN MESSAGE, replayed once after a restart and died again; not retried. Tell them it did not go through and ask them to resend if it still matters:\n    ${t.prompt_head}`;
      }
      return `- ${where}, started ${t.started_at} UTC\n    it was asked: ${t.prompt_head}${said}`;
    });
    await runConciergeSystemTurn(
      chatId,
      '[INTERRUPTED] The bot process stopped while these turns were still running, so they did NOT finish and nothing reported them:\n' +
        `${lines.join('\n')}\n\n` +
        'They were cut off mid-flight — treat any claim that they completed as false, including your own earlier messages. ' +
        'For each: work out what actually landed by checking the WORLD, not the thread — git log/status in the repo it was working in, the PR, the tracker — since a turn can die after committing and before saying so. ' +
        'Then tell the user in one short message what state each is really in and what you propose. ' +
        'Do NOT silently re-dispatch: a killed turn may have half-applied something, and re-running its instruction could redo it.',
    );
  }
}

/** Serialize turns per session: run now if idle, else queue. */
async function enqueueTurn(
  target: Target,
  text: string,
  opts: { visible: boolean; userMsgId?: number; background?: boolean; human?: boolean },
): Promise<void> {
  const turn = { text, visible: opts.visible, userMsgId: opts.userMsgId, background: opts.background, human: opts.human };
  const ran = await lock.runOrQueue(target.key, turn, (t) =>
    runTurn(target, t.text, { visible: t.visible, userMsgId: t.userMsgId, background: t.background, human: t.human }),
  );
  if (!ran && opts.userMsgId !== undefined) await adapter.react(target.chatId, opts.userMsgId, '👀');
}

/**
 * Resume a session with a fresh turn from an ASYNC external event — a button
 * tap, a watched CI run finishing — instead of blocking a turn open waiting for
 * it. The one door through which "something happened out there" re-enters a
 * conversation, mirroring how a typed reply arrives. Runs now if the session is
 * idle, else queues behind the current turn.
 */
export async function resumeTurn(chatId: number, slot: number, text: string, source: 'human' | 'machine'): Promise<void> {
  const target = targetForSlot(chatId, slot);
  logMessage(target.key, 'user', text, source);
  await enqueueTurn(target, text, { visible: true, human: source === 'human' });
}

// --- Inbound messages -------------------------------------------------------

// Telegram caps a message at 4096 chars and splits a long paste into several
// messages with no "these are one" marker. We coalesce a burst into a single
// prompt: each arrival resets a short debounce; a near-max chunk waits longer.
const COALESCE_MS = 600;
const COALESCE_SPLIT_MS = 2500;
const SPLIT_LEN = 4000;

interface Inbox {
  target: Target;
  texts: string[];
  firstMsgId?: number;
  timer?: NodeJS.Timeout;
}
const inbox = new Map<string, Inbox>();

function bufferMessage(target: Target, text: string, msgId: number): void {
  let buf = inbox.get(target.key);
  if (!buf) {
    buf = { target, texts: [], firstMsgId: msgId };
    inbox.set(target.key, buf);
  }
  buf.texts.push(text);
  if (buf.timer) clearTimeout(buf.timer);
  const wait = text.length >= SPLIT_LEN ? COALESCE_SPLIT_MS : COALESCE_MS;
  buf.timer = setTimeout(() => void flushInbox(target.key), wait);
}

async function flushInbox(key: string): Promise<void> {
  const buf = inbox.get(key);
  if (!buf) return;
  inbox.delete(key);
  if (buf.timer) clearTimeout(buf.timer);
  await submitTo(buf.target, buf.texts.join('\n'), buf.firstMsgId);
}

/** Log the prompt to its thread and run it (always a visible, user-driven turn). */
async function submitTo(target: Target, text: string, firstMsgId?: number): Promise<void> {
  logMessage(target.key, 'user', text, 'human');
  await enqueueTurn(target, text, { visible: true, userMsgId: firstMsgId, human: true });
}

/**
 * Resolve which session a message addresses. Always the concierge.
 *
 * A reply used to be a momentary direct line into a worker. That is gone: a
 * worker no longer sends messages of its own — it renders into one live-updating
 * message — so there is nothing left to reply INTO, and the concierge is the
 * only door in mechanism rather than only in its prompt (I9).
 *
 * The lookup stays because the ROUTES OUTLIVED THE FEATURE. `message_routes`
 * still holds thousands of rows pointing at worker sessions, and replying to any
 * old worker message would have quietly opened a turn on that slot — which,
 * since those sessions no longer resume under the current contract, would have
 * started a brand-new empty worker carrying nothing but its brief, mid-way
 * through a task it had no memory of. Deleting the rows was the alternative, but
 * they are how a reply to a CONCIERGE message is recognised as such, and they
 * are the record of who said what. So the route is read and then deliberately
 * ignored for anything that is not the concierge.
 */
function resolveTarget(chatId: number, replyToMessageId?: number): Target {
  if (replyToMessageId !== undefined) {
    const key = sessionForMessage(chatId, replyToMessageId);
    const slot = key ? Number(key.split(':')[1]) : NaN;
    if (Number.isFinite(slot) && slot !== CONTROL_SLOT) {
      console.log(`[dispatch] reply to slot ${slot}'s message → concierge (workers are not addressable)`);
    }
  }
  return targetForSlot(chatId, CONTROL_SLOT);
}

function handleMessage(e: InboundMessage): void {
  ensureChat(e.chatId);

  // A spoken note: transcribe locally, then re-enter as text. The reaction is
  // the only acknowledgement — a note that takes twenty seconds to transcribe
  // must not look dropped, and must not cost a turn to say "working on it".
  if (e.voice) {
    void adapter.react(e.chatId, e.messageId, '✍');
    void transcribe(e.voice.path).then((r) => {
      if ('problem' in r) {
        console.error(`[dispatch] voice note ${e.messageId} not transcribed: ${r.problem}`);
        void adapter.send(e.chatId, { text: `Could not transcribe that voice note: ${r.problem}`, format: 'plain' }).catch(() => {});
        return;
      }
      console.log(`[dispatch] voice note ${e.messageId}: ${e.voice!.durationSec}s → ${r.text.length} chars in ${r.ms}ms`);
      handleMessage({ ...e, voice: undefined, text: spokenNote(r.text, e.voice!.durationSec) });
    });
    return;
  }

  // Capture mode: queue the message for /process instead of running it. A reply
  // pre-addresses its fragment to that worker; everything else is left for the
  // concierge to triage. Acked with a reaction — no agent turn, no cost.
  if (isCapturing(e.chatId)) {
    let targetKey: string | undefined;
    if (e.replyToMessageId !== undefined) {
      const k = sessionForMessage(e.chatId, e.replyToMessageId);
      if (k && Number(k.split(':')[1]) !== CONTROL_SLOT) targetKey = k;
    }
    addPending(e.chatId, e.messageId, e.text, targetKey);
    void adapter.react(e.chatId, e.messageId, '👀');
    return;
  }

  const target = resolveTarget(e.chatId, e.replyToMessageId);
  bufferMessage(target, e.text, e.messageId);
}

// --- Commands ---------------------------------------------------------------

/**
 * /voice — calibrate the bot's voice by ear.
 *   /voice            what it would sound like now, and the options
 *   /voice samples    the same paragraph in every installed voice
 *   /voice use NAME   pick one
 *   /voice rate 0.9   pace: 1 = as trained, lower = brisker, higher = slower
 *   /voice say TEXT   hear a sentence in the current voice
 */
async function handleVoiceCommand(chatId: number, args: string): Promise<void> {
  const say = (text: string) => adapter.send(chatId, { text, format: 'plain' }).catch(() => {});
  const status = voiceOutStatus();
  if (!status.ready) {
    await say(`I can hear voice notes but cannot speak yet: ${status.problem}`);
    return;
  }
  const [sub, ...rest] = args.trim().split(/\s+/);
  const choice = voiceChoice(chatId);
  switch (sub) {
    case 'samples': {
      await say(`Sending ${status.voices.length} sample(s) — the same generic paragraph in each voice's own language. Pick with /voice use NAME.`);
      for (const v of status.voices) {
        const r = await speak(sampleTextFor(v.language), { voice: v.name, rate: 1.0 });
        if ('problem' in r) await say(`${v.name}: ${r.problem}`);
        else await adapter.sendVoice(chatId, r.path, `${v.name}${v.language ? ` · ${v.language}` : ''} · ${r.seconds}s${v.name === choice.voice ? ' · current' : ''}`).catch((e) => say(`${v.name}: ${e instanceof Error ? e.message : String(e)}`));
      }
      return;
    }
    case 'use': {
      const name = rest[0];
      if (!name || !status.voices.some((v) => v.name === name)) {
        await say(`Which one? ${status.voices.map((v) => v.name).join(', ')}`);
        return;
      }
      const next = setVoicePrefs(chatId, { voice: name });
      const r = await speak(`Okay. From now on this is my voice.`, { voice: next.voice, rate: next.rate });
      if ('problem' in r) await say(`Set to ${next.voice}, but could not speak: ${r.problem}`);
      else await adapter.sendVoice(chatId, r.path, `voice: ${next.voice} · rate ${next.rate}`);
      return;
    }
    case 'rate': {
      const rate = Number(rest[0]);
      if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) {
        await say(`Rate is Piper's length scale: 1 = as trained, 0.85 = brisker, 1.2 = slower. Give a number between 0.5 and 2. Now: ${choice.rate}`);
        return;
      }
      const next = setVoicePrefs(chatId, { rate });
      const r = await speak(`This is the pace at ${rate}.`, { voice: next.voice, rate: next.rate });
      if ('problem' in r) await say(`Rate set to ${rate}, but could not speak: ${r.problem}`);
      else await adapter.sendVoice(chatId, r.path, `voice: ${next.voice} · rate ${next.rate}`);
      return;
    }
    case 'say': {
      const text = rest.join(' ');
      if (!text) {
        await say('Say what? /voice say <text>');
        return;
      }
      const r = await speak(text, { chatId });
      if ('problem' in r) await say(`Could not speak: ${r.problem}`);
      else await adapter.sendVoice(chatId, r.path);
      return;
    }
    default:
      await say(
        `Voice: ${choice.voice} at rate ${choice.rate}. Installed: ${status.voices.map((v) => v.name).join(', ')}.\n` +
          `/voice samples — hear them all · /voice use NAME · /voice rate 0.9 · /voice say <text>`,
      );
  }
}

function expandPath(p: string): string {
  return resolve(p.startsWith('~') ? p.replace(/^~/, homedir()) : p);
}

async function handleCommand(e: InboundCommand): Promise<void> {
  const { chatId, command, args } = e;
  ensureChat(chatId);

  switch (command) {
    case 'start':
      await adapter.send(chatId, {
        text:
          "Hi — I'm your concierge. Just tell me what you need; I spin up worker threads, run the work, and report back. " +
          'To talk to a worker directly, reply to one of its messages.\n\n' +
          '/sessions — your worker threads (status)\n' +
          '/capture — collect notes through the day\n' +
          '/process — triage & fan out what you captured\n' +
          '/cancel — stop all running work\n' +
          '/repos — your workspace repos\n' +
          '/dream — run the nightly rewrite now\n' +
          '/defrag — full-memory reconstruction (rare, manual)\n' +
          '/episodes — work harvested from your local sessions\n' +
          '/find <phrase> — search past work, yours and the bot\'s\n' +
          '/focus — what deserves your attention now (ranked)\n' +
          '/commitments — reminders, routines & watched items\n' +
          '/proposals — code changes I proposed (operator-gated)\n' +
          '/debug — suspend the day to work on the machine; /live to resume\n' +
          '/status — concierge + worker overview',
        format: 'plain',
        removeKeyboard: true,
      });
      return;

    case 'sessions': {
      const att = attentionSet(chatId);
      if (!att.cards.length && !att.activeRest && !att.archived) {
        await adapter.send(chatId, {
          text: "No worker threads yet. Tell me what you need and I'll start one.",
          format: 'plain',
        });
        return;
      }
      const lines = att.cards.map((c) => {
        const mark = c.running ? '🟢' : '•';
        const status = c.recap ?? c.brief?.split('\n')[0];
        return `${mark} <b>${escapeHtml(c.title)}</b>${status ? ` — ${escapeHtml(status.replace(/\s+/g, ' ').slice(0, 140))}` : ''}`;
      });
      const rest = [
        att.activeRest ? `${att.activeRest} idle` : '',
        att.archived ? `${att.archived} archived` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const tail = rest ? `\n<i>${rest} — ask me to find any of them</i>` : '';
      await adapter.send(chatId, {
        text: `🗂 <b>Attention set</b>\n${lines.join('\n') || '(none)'}${tail}\n\n<i>Reply to a worker's message to talk to it.</i>`,
        format: 'tgHtml',
      });
      return;
    }

    case 'cancel': {
      const { aborted, released } = lock.cancelPrefix(`${chatId}:`);
      // "Released" is reported separately and on purpose: a stuck lock with no
      // live turn is exactly the state that used to answer "Nothing is running"
      // while silently swallowing every message behind it.
      const parts = [
        aborted ? `🛑 Stopping ${aborted} running ${aborted === 1 ? 'turn' : 'turns'}…` : '',
        released ? `🔓 Released ${released} stuck session lock${released === 1 ? '' : 's'} — queued messages were dropped; resend.` : '',
      ].filter(Boolean);
      await adapter.send(chatId, { text: parts.join('\n') || 'Nothing is running.', format: 'plain' });
      return;
    }

    case 'voice': {
      await handleVoiceCommand(chatId, args);
      return;
    }

    case 'status': {
      const active = listSessions(chatId, 'active').length;
      const cid = storedSessionId(sessionKey(chatId, CONTROL_SLOT));
      // The turn lock is here because it was the one piece of state that could
      // silently swallow every message, and the only way to see it was reading
      // the source. A lock with `abortable: false` is a turn stuck in setup —
      // /cancel now clears it.
      const locks = lock.lockState().filter((l) => l.key.startsWith(`${chatId}:`));
      const lockLine = locks.length
        ? locks
            .map((l) => `  ${l.key} — ${l.queued} queued${l.abortable ? '' : ', STUCK in setup (run /cancel)'}`)
            .join('\n')
        : '  (idle)';
      await adapter.send(chatId, {
        text:
          `Concierge session: ${cid ?? 'none (starts on next message)'}\n` +
          `Active workers: ${active}\n` +
          `Turn locks:\n${lockLine}\n` +
          `Working dir: ${config.workingDir}`,
        format: 'plain',
      });
      return;
    }

    case 'stats':
      await handleStats(chatId);
      return;

    case 'reset':
      clearSession(sessionKey(chatId, CONTROL_SLOT));
      await adapter.send(chatId, {
        text: '🧹 Cleared the concierge’s context. It’ll re-onboard from the root + thread index on your next message.',
        format: 'plain',
      });
      return;

    // WORK STATE. `/debug` suspends the day; `/live` resumes it, keeping or
    // rolling back whatever the session did to the graph.
    case 'debug': {
      if (currentMode() === 'debug') {
        const d = debugState()!;
        await adapter.send(chatId, { text: `🔧 Already in DEBUG since ${d.since}${d.reason ? ` — "${d.reason}"` : ''}.\nSnapshot: ${d.snapshot}\n/live to resume, /live rollback to discard.`, format: 'plain' });
        return;
      }
      const d = enterDebug(args.trim());
      await adapter.send(chatId, {
        text:
          `🔧 DEBUG MODE. The day is suspended — no turns, no workers, no commitments, no probes, no automatic nightly, and nothing reaches my context.\n` +
          `The tree is snapshotted, so anything done here can be discarded.\n\n` +
          `Still available: gardening (\`npx tsx src/gardenCli.ts\`), an induced /dream, and every read.\n` +
          `Writes light up in the Atlas as they land.\n\n` +
          `/live — resume, KEEPING changes (my context is reset if the graph moved)\n` +
          `/live rollback — resume, DISCARDING everything since ${d.since}`,
        format: 'plain',
      });
      return;
    }

    case 'live': {
      if (currentMode() === 'live') {
        await adapter.send(chatId, { text: 'Already live.', format: 'plain' });
        return;
      }
      const rollback = /rollback|discard|revert/i.test(args);
      let report;
      try {
        report = exitDebug({ rollback });
      } catch (e) {
        await adapter.send(chatId, { text: `Could not exit: ${(e as Error).message}`, format: 'plain' });
        return;
      }
      if (!report) return;
      if (report.contextReset) {
        clearSession(sessionKey(chatId, CONTROL_SLOT));
      }
      const list = report.writes.slice(0, 12).map((w) => `  ${w.op} ${w.entity_id}`).join('\n');
      await adapter.send(chatId, {
        text:
          `▶️ LIVE. ${report.writes.length} graph write(s) ${report.rolledBack ? 'ROLLED BACK — the tree is as it was' : 'kept'}.\n` +
          (list ? `${list}${report.writes.length > 12 ? `\n  …and ${report.writes.length - 12} more` : ''}\n` : '') +
          (report.contextReset ? 'My context was cleared — memory moved under it, so I re-onboard on your next message.' : 'My context is untouched.'),
        format: 'plain',
      });
      return;
    }

    case 'capture': {
      const on = !isCapturing(chatId);
      setCapturing(chatId, on);
      await adapter.send(chatId, {
        text: on
          ? '🟢 Capturing. Drop notes, forwards, and replies all day — they queue silently (👀), no agent runs. Reply to a worker to pre-address a fragment to it. Run /process to fan everything out; /capture again to stop.'
          : `⚪ Capture off. ${countPending(chatId)} item(s) waiting — /process to handle them.`,
        format: 'plain',
      });
      return;
    }

    case 'process':
      await runProcess(chatId);
      return;

    // /dream and /grow are aliases of the one nightly rewrite now.
    case 'dream':
    case 'grow':
      await adapter.send(chatId, {
        text: '🌙 Running the nightly rewrite — one pass that reflects on recent activity and rewrites the memory. A few minutes…',
        format: 'plain',
      });
      void runRewrite(adapter, chatId, 'nightly');
      return;

    /**
     * TAKE THE NIGHT BACK, from the surface the person is actually holding.
     *
     * The night is mandatory now: while one is owed, every day activity is
     * refused. The escape hatch existed only in a terminal and on a web page,
     * which is no escape at all at 8am on a phone — and "open your laptop" is
     * precisely the shape I8 forbids, since the refusal arrives in the chat and
     * the way out has to be reachable from where the refusal was read.
     */
    case 'cancelnight':
    case 'skipnight': {
      const why = args.trim();
      if (!why) {
        await adapter.send(chatId, {
          text: 'Usage: /cancelnight <why> — stops tonight\'s fold, rolls back whatever it wrote, and opens the day. The reason is required: the night reads its own cancelled boundaries back.',
          format: 'plain',
        });
        return;
      }
      const dr = dreamState();
      if (dr) {
        requestDreamCancel(why);
        await adapter.send(chatId, {
          text: `🌙 Asked the ${dr.scope} pass to stop — it unwinds its own writes and hands the day back within a few seconds.`,
          format: 'plain',
        });
        return;
      }
      const owed = nightOwed();
      if (!owed) {
        await adapter.send(chatId, { text: 'Nothing to cancel — no pass is running and no night is owed.', format: 'plain' });
        return;
      }
      settleTonight('cancelled', why);
      await adapter.send(chatId, {
        text: `🌙 Night ${owed.boundary} UTC cancelled — the day is open. Its window is not lost; tomorrow's pass covers it too.`,
        format: 'plain',
      });
      return;
    }

    case 'dreams':
      await handleDreams(chatId, args);
      return;

    case 'defrag':
      await adapter.send(chatId, {
        text: '🧹 Reconstruction — archiving the whole tree and rebuilding it (root first) from understanding, in a fresh context. This takes several minutes…',
        format: 'plain',
      });
      void runRewrite(adapter, chatId, 'reconstruction');
      return;

    case 'grows':
      await handleGrows(chatId, args);
      return;

    case 'episodes':
      await handleEpisodes(chatId, args);
      return;

    case 'find': {
      const q = args.trim();
      if (!q) {
        await adapter.send(chatId, { text: 'Usage: /find <phrase> — searches your local sessions and the bot\'s threads.', format: 'plain' });
        return;
      }
      const { hits, scannedTranscripts } = findWork(chatId, q, 10);
      if (!hits.length) {
        await adapter.send(chatId, { text: `Nothing found for "${q}"${scannedTranscripts ? ' (searched summaries, threads and raw transcripts)' : ''}.`, format: 'plain' });
        return;
      }
      const body =
        `\u{1F50E} "${q}" \u2014 ${hits.length} hit(s)${scannedTranscripts ? ' (incl. raw transcripts)' : ''}\n\n` +
        hits
          .map((h) => {
            const where = h.source === 'thread' ? `bot ${h.project}` : `${h.project}${h.episodeId ? ` \u00b7 /episodes ${h.episodeId}` : ''}`;
            const tag = h.partial ? ` ${h.source} \u00b7 partial` : ` ${h.source}`;
            return `${h.when} [${tag.trim()}] ${where}${h.messageId ? ` \u00b7 msg #${h.messageId}` : ''}\n  ${h.context}`;
          })
          .join('\n\n');
      for (const piece of chunkRaw(body)) await adapter.send(chatId, { text: piece, format: 'plain' });
      return;
    }

    case 'distill': {
      harvestAll();
      const pending = episodesToDistill(1000).length;
      if (!pending) {
        await adapter.send(chatId, { text: 'Nothing to distil — every closed episode already has a recap.', format: 'plain' });
        return;
      }
      const n = Math.min(Number(args) || pending, pending);
      // Detached: a full queue is ~20 minutes and must not hold the command
      // handler open. Progress lands on the live message it just posted.
      void runDistill(chatId, n).catch((e) => console.error('[distill]', e));
      return;
    }

    case 'focus': {
      const items = focusItems(chatId);
      if (!items.length) {
        await adapter.send(chatId, {
          text: 'No focus items yet. Tell the concierge what deserves your attention (e.g. "the PRs I review, and my own work that moved") and it will build the set.',
          format: 'plain',
        });
        return;
      }
      // Grouped by band, ranked inside it: most-recently-moved first, then
      // longest-unchecked. The bands come from the data — a set that is all one
      // thing prints as one list, a spread-out one prints as several — so the
      // quiet, tracked items stay visible without diluting the top band.
      const changedAt = new Map(items.map((c) => [c.id, openFocusChanges(c.id)[0]?.created_at ?? '']));
      const rank = (a: typeof items[number], b: typeof items[number]) => {
        const ca = changedAt.get(a.id) ?? '';
        const cb = changedAt.get(b.id) ?? '';
        if (ca !== cb) return cb.localeCompare(ca);
        return (a.last_checked_at ?? '').localeCompare(b.last_checked_at ?? '');
      };
      const render = (c: typeof items[number]) => {
        const moved = changedAt.get(c.id) ? '🔴' : c.check_cmd ? '👁' : '✋';
        const noisy = escalationsToday(c.id) >= 4 ? ' ⚠️ noisy check' : '';
        const state = (c.check_state ?? '').replace(/\s+/g, ' ').slice(0, 120);
        const checked = c.last_checked_at ? `checked ${fmtLocal(c.last_checked_at)}` : 'never checked';
        return (
          `${moved} <b>#${c.id} ${escapeHtml(c.label)}</b>${noisy}\n` +
          `${escapeHtml(c.body.split('\n')[0]!.slice(0, 200))}\n` +
          (state ? `<i>${escapeHtml(state)}</i>\n` : '') +
          `<i>${c.check_cmd ? 'auto' : 'manual'} · ${checked}</i>`
        );
      };
      const bands = focusBands(chatId);
      const body =
        bands.length <= 1
          ? [...items].sort(rank).map(render).join('\n\n')
          : bands
              .map((b) => `<b>— ${escapeHtml(b.title)} —</b>\n\n${[...b.items].sort(rank).map(render).join('\n\n')}`)
              .join('\n\n');
      await adapter.send(chatId, {
        text: `🎯 <b>Focus set</b> — ${items.length} open loop(s)\n\n${body}\n\n🔴 moved · 👁 auto-checked · ✋ needs you`,
        format: 'tgHtml',
      });
      return;
    }

    // /wakeups stays as a legacy alias for /commitments.
    case 'wakeups':
    case 'commitments': {
      const cs = listCommitments(chatId);
      await adapter.send(chatId, {
        text: cs.length
          ? `⏰ Open commitments (local time):\n${cs
              .map((c) => `#${c.id} ${c.how_to_check ? '👁' : '⏰'} ${c.label} — ${fmtLocal(c.due_at)}${c.recur ? ` (${c.recur})` : ''}`)
              .join('\n')}\n\nAsk the concierge to add, move, or drop one.`
          : 'No open commitments. Ask the concierge to make one (e.g. "remind me at 17:00 to …").',
        format: 'plain',
      });
      return;
    }

    case 'proposals': {
      const ps = pendingFindings(chatId, 'proposal');
      await adapter.send(chatId, {
        text: ps.length
          ? `🛠 Proposals from the nightly reflections — changes to the bot's own code/prompts, never auto-applied:\n\n${ps
              .map((p) => `#${p.id} (${p.created_at.slice(0, 10)})\n${p.body}`)
              .join('\n\n')}\n\nTell the concierge to dismiss any (or implement them yourself and mark them applied).`
          : 'No pending proposals. The nightly dream queues code/prompt suggestions here.',
        format: 'plain',
      });
      const designs = listDesignProposals();
      if (designs.length) {
        await adapter.send(chatId, {
          text: `📐 Design proposals — how the system works, decided by the developer (npx tsx src/proposalCli.ts):\n\n${designs.map(proposalLine).join('\n')}`,
          format: 'plain',
        });
      }
      return;
    }

    case 'repos':
      await handleRepos(chatId, args);
      return;

    case 'digest': {
      if (!args) {
        await adapter.send(chatId, {
          text: 'Usage: /digest <absolute path> — digests a file into the knowledge base.',
          format: 'plain',
        });
        return;
      }
      await adapter.send(chatId, { text: `📥 Digesting ${args} into notes…`, format: 'plain' });
      const res = await digestFile(chatId, expandPath(args));
      await adapter.send(chatId, {
        text: res.error ? `⚠️ ${res.error}` : `✅ Digested into ${res.keys.length} notes:\n${res.keys.join('\n')}`,
        format: 'plain',
      });
      return;
    }

    default:
      // Unknown command — stay quiet (avoids noise from typos / other bots).
      return;
  }
}

/** Triage & fan out everything captured for a chat (the /process batch flow). */
async function runProcess(chatId: number): Promise<void> {
  const items = listPending(chatId);
  if (!items.length) {
    await adapter.send(chatId, {
      text: 'Nothing captured to process. (/capture to start collecting.)',
      format: 'plain',
    });
    return;
  }
  setCapturing(chatId, false);
  clearPending(chatId);

  // Reply-pre-addressed fragments go straight to their worker; the rest go to
  // the concierge to triage and fan out (one batch → many threads).
  const addressed = new Map<string, string[]>();
  const toTriage: string[] = [];
  for (const it of items) {
    if (it.target_key) {
      const arr = addressed.get(it.target_key) ?? [];
      arr.push(it.text);
      addressed.set(it.target_key, arr);
    } else {
      toTriage.push(it.text);
    }
  }

  const routed: string[] = [];
  for (const [key, texts] of addressed) {
    const slot = Number(key.split(':')[1]);
    routed.push(`• ${titleOf(chatId, slot)} ← ${texts.length} item(s)`);
    await submitTo(targetForSlot(chatId, slot), texts.join('\n\n'));
  }

  await adapter.send(chatId, {
    text:
      `📥 Processing ${items.length} item(s).` +
      (routed.length ? `\nRouted directly by reply:\n${routed.join('\n')}` : '') +
      (toTriage.length ? `\nTriaging ${toTriage.length} with the concierge…` : ''),
    format: 'plain',
  });

  if (toTriage.length) {
    const list = toTriage.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const prompt =
      `[PROCESS BATCH] I captured these ${toTriage.length} fragment(s) through the day and pressed /process. ` +
      `Work out what each means and where it belongs.\n\n${list}\n\n` +
      'First present a short fan-out PLAN — fragment(s) → destination (an existing thread by title / a new thread / a note) — with a tappable confirm, and only dispatch after I confirm. ' +
      'Then fan out: dispatchTask to each target thread (you can dispatch several in one turn, composing each brief), and fold standing facts into notes (behavioral corrections via recordBehavior). ' +
      "Cluster related fragments. Flag anything ambiguous instead of guessing, and park whatever needs my input for when I'm back.";
    await submitTo(targetForSlot(chatId, CONTROL_SLOT), prompt);
  }
}

async function handleRepos(chatId: number, arg: string): Promise<void> {
  const fmt = (rs: Array<{ name: string; branch: string | null; conventions: string | null }>): string =>
    rs
      .map((r) => `• ${r.name}${r.branch ? ` (${r.branch})` : ''}${r.conventions ? ` · ${r.conventions}` : ''}`)
      .join('\n');

  if (arg.startsWith('add')) {
    const paths = arg
      .slice(3)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => expandPath(p));
    if (!paths.length) {
      await adapter.send(chatId, { text: 'Usage: /repos add <path> [path…]', format: 'plain' });
      return;
    }
    const added = addRepos(paths);
    await adapter.send(chatId, {
      text: added.length ? `✅ Registered ${added.length}:\n${fmt(added)}` : 'None of those are git repos.',
      format: 'plain',
    });
    return;
  }
  if (arg === 'scan') {
    await adapter.send(chatId, {
      text: `🔎 Scanning ${config.workspaceDir} (this grabs every git repo there)…`,
      format: 'plain',
    });
    const found = scanWorkspace();
    await adapter.send(chatId, {
      text: found.length
        ? `✅ Registered ${found.length} repos:\n${fmt(found)}`
        : `No git repos found under ${config.workspaceDir}.`,
      format: 'plain',
    });
    return;
  }
  const repos = listRepos();
  if (!repos.length) {
    await adapter.send(chatId, {
      text: 'No repos registered. Use /repos add <path…> for your work repos, or /repos scan for everything in your workspace.',
      format: 'plain',
    });
    return;
  }
  const lines = repos.map((r) => `• ${r.name} → ${r.path}${r.branch ? ` (${r.branch})` : ''}`);
  await adapter.send(chatId, { text: `Workspace repos (${repos.length}):\n${lines.join('\n')}`, format: 'plain' });
}

/**
 * Run the distill queue with a LIVE progress line. A long run with no feedback
 * is indistinguishable from a hung one (88 episodes is ~20 minutes), so one
 * message is edited in place rather than going silent until the end.
 *
 * Edits are throttled: Telegram rate-limits edits, and a bar that moves every
 * few seconds reads the same as one that moves every episode.
 */
async function runDistill(chatId: number, n: number): Promise<void> {
  const bar = (done: number, total: number): string => {
    const width = 16;
    const filled = Math.round((done / total) * width);
    return `${'\u2588'.repeat(filled)}${'\u2591'.repeat(width - filled)}`;
  };
  const mins = (sec: number): string => (sec < 60 ? `${sec}s` : `${Math.round(sec / 60)} min`);

  const ref = await adapter.send(chatId, {
    text: `\u{1F9EA} Distilling ${n} episode(s)\n${bar(0, n)} 0/${n}`,
    format: 'plain',
  });

  let lastEdit = 0;
  const render = (p: { done: number; total: number; costUsd: number; etaSeconds: number; latest?: string }): string =>
    `\u{1F9EA} Distilling work episodes\n${bar(p.done, p.total)} ${p.done}/${p.total}` +
    ` \u00b7 $${p.costUsd.toFixed(2)} \u00b7 ~${mins(p.etaSeconds)} left` +
    (p.latest ? `\n\u2192 ${p.latest.slice(0, 110)}` : '');

  const result = await distillPending(chatId, n, (p) => {
    const now = Date.now();
    // Throttle to one edit per ~4s, but always show the final tick.
    if (now - lastEdit < 4000 && p.done < p.total) return;
    lastEdit = now;
    void adapter.edit(ref, { text: render(p), format: 'plain' }).catch(() => {});
  });

  await adapter
    .edit(ref, {
      text:
        `\u2705 Distilled ${result.distilled} episode(s)` +
        (result.failed ? ` \u00b7 ${result.failed} failed (still queued, /distill retries)` : '') +
        ` \u00b7 $${result.costUsd.toFixed(2)}\nSee /episodes.`,
      format: 'plain',
    })
    .catch(() => {});
}

/** Compact a topic list for the one-line summary. Drops trailing parentheticals
 *  (they hold detail, not subject) but NEVER splits on ':' — the substance is
 *  usually after the colon ("applied fix 1: context accounting formula"). */
function topicList(topics: string[], max = 4): string {
  return topics
    .slice(0, max)
    .map((t) => {
      const core = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
      return core.length > 64 ? `${core.slice(0, 63).replace(/[\s,;]+\S*$/, '')}\u2026` : core;
    })
    .join(' \u00b7 ');
}

/**
 * Harvest local Claude Code sessions and show what the system now sees of the
 * work that never came through Telegram (round 6 step 1, BRAIN.md 3.12).
 *
 * The list shows each episode's ARC, not just its title: Claude Code titles a
 * session once at the start and never revisits it, so a burst that opened with
 * a question and ended in a merged PR is filed under the question. The
 * milestones and anchors are what say where it actually went.
 *
 * /episodes            recent work
 * /episodes projects   per-project totals
 * /episodes <project>  one project's history
 * /episodes <id>       one episode's full timeline
 */
async function handleEpisodes(chatId: number, arg: string): Promise<void> {
  const res = harvestAll();
  const a = arg.trim();

  if (a === 'projects') {
    const rows = episodeStats().map(
      (s) => `${String(s.episodes).padStart(3)} ep \u00b7 ${String(s.turns).padStart(4)} turns \u00b7 ${s.project} (${s.first_seen.slice(0, 10)} \u2192 ${s.last_seen.slice(0, 10)})`,
    );
    await adapter.send(chatId, {
      text: rows.length ? `\u{1F4C1} Harvested work by project:\n${rows.join('\n')}` : 'Nothing harvested yet.',
      format: 'plain',
    });
    return;
  }

  // /episodes <id> [redo] — one episode in full. The summary is the point, so
  // if it has none (a live burst the queue withholds, or a fresh harvest) it
  // is generated on the spot rather than showing scaffolding and nothing else.
  const single = /^(\d+)(\s+redo)?$/.exec(a);
  if (single) {
    const id = Number(single[1]);
    const redo = Boolean(single[2]);
    let e = episodeById(id);
    if (!e) {
      await adapter.send(chatId, { text: `No episode #${id}.`, format: 'plain' });
      return;
    }
    if (!e.recap || redo) {
      await adapter.send(chatId, {
        text: `\u{1F9EA} ${redo ? 'Regenerating' : 'No summary yet \u2014 generating'} it now\u2026`,
        format: 'plain',
      });
      const r = await distillEpisodeNow(chatId, id);
      if (!r.ok) {
        await adapter.send(chatId, { text: `Could not summarise: ${r.reason}`, format: 'plain' });
        return;
      }
      e = episodeById(id);
    }
    await adapter.send(chatId, { text: renderEpisodeFull(e!), format: 'plain' });
    return;
  }

  const byProject = a.length > 0;
  const eps = byProject ? episodesByProject(a, 8) : recentEpisodes(8);
  if (!eps.length) {
    const known = episodeStats().map((s) => s.project).join(', ');
    await adapter.send(chatId, {
      text: byProject
        ? `No episodes for "${a}". Known projects: ${known || '(none)'}`
        : 'No episodes harvested yet.',
      format: 'plain',
    });
    return;
  }

  const header = byProject
    ? `\u{1F4DA} ${eps[0]!.project} \u2014 ${eps.length} episode(s)`
    : `\u{1F4DA} Recent work`;
  const body =
    `${header}\n/episodes <id> for detail \u00b7 <id> redo to re-summarise \u00b7 projects for totals\n\n` +
    eps.map(renderEpisodeLine).join('\n\n');
  for (const piece of chunkRaw(body)) {
    await adapter.send(chatId, { text: piece, format: 'plain' });
  }
}

/** The one-line-per-episode listing. THE SUMMARY IS THE CONTENT — the parsed
 *  structure (did / shipped / touched) is a FALLBACK shown only when there is
 *  no summary yet, because on its own it reads as machine exhaust rather than
 *  an account of the work. */
function renderEpisodeLine(e: EpisodeRow): string {
  const head =
    `#${e.id} \u00b7 ${e.started_at.slice(5, 16)} [${e.project}]` +
    `${e.closed ? '' : ' \u25CF live'}${e.distillable ? '' : ' \u{1F512} private'}` +
    ` \u00b7 ${e.turns} turns, ${e.user_prompts} prompts`;

  const recap = e.recap
    ? (JSON.parse(e.recap) as { headline: string; topics: string[]; status: string; followUp?: string | null })
    : null;

  if (recap) {
    return [
      head,
      `  ${recap.headline}`,
      recap.topics.length > 1 ? `  \u00b7 ${topicList(recap.topics)}` : '',
      recap.followUp ? `  \u21BB left: ${recap.followUp}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // No summary — fall back to what was parsed, and say how to get one.
  return [head, `  (no summary \u2014 /episodes ${e.id})`, ...structureLines(e, '  ')].join('\n');
}

/** The deterministic scaffolding: what was parsed straight from the transcript. */
function structureLines(e: EpisodeRow, indent = ''): string[] {
  const ms = JSON.parse(e.milestones) as Array<{ kind: string; detail?: string }>;
  const byKind = new Map<string, number>();
  for (const m of ms) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
  const prs = [...new Set(ms.filter((m) => m.kind === 'PR' && m.detail).map((m) => m.detail!))];
  const branch = ms.find((m) => m.kind !== 'PR' && m.detail)?.detail;
  const did = [...byKind.entries()]
    .filter(([k]) => k !== 'PR')
    .map(([k, n]) => (n > 1 ? `${k} \u00d7${n}` : k))
    .join(', ');
  const ents = (JSON.parse(e.entities) as string[])
    .filter((x) => !x.startsWith('url:') && !x.startsWith('pr:'))
    .slice(0, 4)
    .map((x) => x.split(':').slice(1).join(':'))
    .join(', ');
  return [
    e.title ? `${indent}opened as: ${e.title}` : '',
    did ? `${indent}did: ${did}${branch ? ` \u2014 ${branch.slice(0, 46)}` : ''}` : '',
    prs.length ? `${indent}shipped: ${prs.join(', ')}` : '',
    ents ? `${indent}touched: ${ents}` : '',
  ].filter(Boolean);
}

/** One episode in full: the account first, then the evidence under it. */
function renderEpisodeFull(e: EpisodeRow & { skeleton?: string; cwd?: string }): string {
  const recap = e.recap
    ? (JSON.parse(e.recap) as {
        headline: string;
        topics: string[];
        status: string;
        followUp?: string | null;
        crossProject?: string | null;
      })
    : null;
  const when = `${e.started_at.slice(0, 16)} \u2192 ${e.ended_at.slice(11, 16)}`;
  const out = [
    `\u{1F4DA} #${e.id} \u00b7 ${e.project}${e.git_branch ? ` (${e.git_branch})` : ''}${e.closed ? '' : ' \u00b7 \u25CF still running'}`,
    `${when} \u00b7 ${e.turns} turns, ${e.user_prompts} prompts`,
    '',
  ];
  if (recap) {
    out.push(recap.headline, '');
    for (const t of recap.topics) out.push(`  \u2022 ${t}`);
    out.push('');
    out.push(`status: ${recap.status}${recap.crossProject ? ` \u00b7 also touches ${recap.crossProject}` : ''}`);
    if (recap.followUp) out.push(`left: ${recap.followUp}`);
    out.push('');
  }
  const structure = structureLines(e);
  if (structure.length) out.push(...structure, '');
  out.push(`session ${e.session_id}`, `/episodes ${e.id} redo \u2014 re-summarise`);
  return out.join('\n');
}

/** List recent persisted dreams, or show one in full (/dreams <id>). */
async function handleDreams(chatId: number, arg: string): Promise<void> {
  const dreams = recentDreams(chatId, 20);
  if (!dreams.length) {
    await adapter.send(chatId, { text: 'No dreams saved yet. Run /dream to reflect.', format: 'plain' });
    return;
  }
  const id = Number(arg);
  if (arg && Number.isFinite(id)) {
    const d = dreams.find((x) => x.id === id);
    if (!d) {
      await adapter.send(chatId, { text: `No dream #${id} in the recent list.`, format: 'plain' });
      return;
    }
    const window = d.covers_from && d.covers_to ? `\nCovers: ${d.covers_from} → ${d.covers_to} UTC` : '';
    await adapter.send(chatId, {
      text: `🌙 Dream #${d.id} · ${d.created_at}${d.processed_at ? ' · processed' : ''}${window}`,
      format: 'plain',
    });
    for (const piece of chunkRaw(d.report)) {
      await adapter.send(chatId, { text: piece, format: 'plain' });
    }
    return;
  }
  const lines = dreams.map((d) => {
    const win = d.covers_to ? ` [${d.covers_from?.slice(5, 10) ?? '…'}→${d.covers_to.slice(5, 10)}]` : '';
    const first = (d.report.split('\n').find((l) => l.trim()) ?? '').replace(/[*#_`>]/g, '').slice(0, 56);
    return `#${d.id} · ${d.created_at.slice(0, 16)}${d.processed_at ? ' ✓' : ''}${win} — ${first}`;
  });
  await adapter.send(chatId, {
    text: `🌙 Recent dreams (/dreams <id> for the full report):\n${lines.join('\n')}`,
    format: 'plain',
  });
}

/** List recent grow passes, or show one in full (/grows <id>). */
async function handleGrows(chatId: number, arg: string): Promise<void> {
  const grows = recentGrows(chatId, 20);
  if (!grows.length) {
    await adapter.send(chatId, {
      text: 'No grow passes yet. Run /grow to refine the knowledge base from recent reflections.',
      format: 'plain',
    });
    return;
  }
  const parseChanges = (raw: string): Array<{ action: string; path: string }> => {
    try {
      return JSON.parse(raw) as Array<{ action: string; path: string }>;
    } catch {
      return [];
    }
  };
  const id = Number(arg);
  if (arg && Number.isFinite(id)) {
    const g = grows.find((x) => x.id === id);
    if (!g) {
      await adapter.send(chatId, { text: `No grow #${id} in the recent list.`, format: 'plain' });
      return;
    }
    const changes = parseChanges(g.changes);
    const fileList = changes.length ? changes.map((c) => `${c.action} ${c.path}`).join('\n') : '(no file changes)';
    await adapter.send(chatId, {
      text: `🌱 Grow #${g.id} · ${g.created_at}\nChanges:\n${fileList}`,
      format: 'plain',
    });
    for (const piece of chunkRaw(g.summary)) {
      await adapter.send(chatId, { text: piece, format: 'plain' });
    }
    return;
  }
  const lines = grows.map((g) => {
    const n = parseChanges(g.changes).length;
    const first = (g.summary.split('\n').find((l) => l.trim()) ?? '').replace(/[*#_`>]/g, '').slice(0, 60);
    return `#${g.id} · ${g.created_at.slice(0, 16)} · ${n} change(s) — ${first}`;
  });
  await adapter.send(chatId, {
    text: `🌱 Recent grow passes (/grows <id> for the full log):\n${lines.join('\n')}`,
    format: 'plain',
  });
}

/** Format a token count compactly: 1234 → 1.2K, 4200000 → 4.2M. */
function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

const AREA_ICON: Record<string, string> = {
  Workers: '🔧',
  Concierge: '🎛️',
  Night: '💤',
  Brief: '📝',
  Other: '•',
};

/** The /stats rollup: usage/cost across workers, concierge, and the flywheel. */
async function handleStats(chatId: number): Promise<void> {
  const s = statsRollup(chatId);
  if (s.total.turns === 0) {
    await adapter.send(chatId, {
      text: 'No usage recorded yet. Stats accrue as the bot runs turns (captured from each run).',
      format: 'plain',
    });
    return;
  }
  const cost = (n: number) => `$${n.toFixed(2)}`;
  const head =
    `📊 <b>Stats</b> · all-time (${cost(s.total.costToday)} today)\n` +
    `${s.total.turns} runs · ${fmtTok(s.total.inputTokens)} in / ${fmtTok(s.total.outputTokens)} out · <b>${cost(s.total.costUsd)}</b>`;

  const areaLines = s.byArea
    .map((a) => `${AREA_ICON[a.area] ?? '•'} ${a.area} — ${a.runs} · ${cost(a.costUsd)}`)
    .join('\n');

  const topLines = s.topSessions.length
    ? '\n\n<b>Top sessions</b>\n' +
      s.topSessions
        .map((t) => `${escapeHtml(titleOf(chatId, t.slot))} — ${cost(t.costUsd)} (${t.turns})`)
        .join('\n')
    : '';

  const modelLine = s.models.length ? `\n\nModel: ${escapeHtml(s.models.join(', '))}` : '';

  await adapter.send(chatId, {
    text: `${head}\n\n${areaLines}${topLines}${modelLine}`,
    format: 'tgHtml',
  });
}

// --- Callbacks --------------------------------------------------------------

async function handleCallback(e: InboundCallback): Promise<void> {
  const { chatId, data } = e;

  if (data.startsWith('stop:')) {
    const slot = Number(data.slice('stop:'.length));
    const key = Number.isFinite(slot) ? sessionKey(chatId, slot) : '';
    const held = key ? lock.isBusy(key) : false;
    const aborted = key ? lock.cancel(key) : false;
    // "Nothing running" only when the lock was genuinely free — a held-but-
    // unabortable session now reports that it was freed rather than denying it
    // existed, which is the whole 2026-08-06 lesson in one button.
    await e.answer(aborted ? '🛑 Cancelling…' : held ? '🔓 Freed a stuck lock' : 'Nothing running');
    return;
  }

  // A worker's box is the only handle the user has on it now that replies go to
  // the concierge, so its two buttons are the two things they will actually want:
  // push it on, or ask where it got to. Both reuse machinery that already exists.
  if (data.startsWith('cont:')) {
    const slot = Number(data.slice('cont:'.length));
    if (!Number.isFinite(slot)) return void (await e.answer('Expired'));
    const t = targetForSlot(chatId, slot);
    if (lock.isAbortable(t.key)) return void (await e.answer('Already running'));
    await e.answer('▶️ Continuing…');
    const nudge =
      '[CONTINUE] Pick your task back up from where you stopped. Check the WORLD first — git status/log in your repo, the PR, the tracker — ' +
      'because your last turn may have landed more than it managed to report. If it is genuinely finished, say so in one line and stop.';
    logMessage(t.key, 'user', nudge, 'human');
    void enqueueTurn(t, nudge, { visible: true, background: true, human: true });
    return;
  }

  if (data.startsWith('recap:')) {
    const slot = Number(data.slice('recap:'.length));
    const card = Number.isFinite(slot) ? getCard(chatId, slot) : undefined;
    // A callback answer is a short toast, so this is deliberately the rolling
    // one-liner and not the transcript — "where is it" rather than "what happened".
    const recap = card?.recap?.replace(/\s+/g, ' ').trim();
    await e.answer(recap ? recap.slice(0, 190) : 'No recap yet — it has not finished a turn.');
    return;
  }

  if (data.startsWith('qr:')) {
    const entry = takeQuickReply(data.slice('qr:'.length));
    await e.answer();
    if (entry !== undefined) {
      const [cid, slotStr] = entry.key.split(':');
      const t = targetForSlot(Number(cid), Number(slotStr));
      logMessage(t.key, 'user', entry.text, 'human');
      await enqueueTurn(t, entry.text, { visible: true, human: true });
    }
    return;
  }

  if (data.startsWith('ask:')) {
    const [, id, qStr, oStr] = data.split(':');
    const result = id ? resolveAsk(id, Number(qStr), Number(oStr)) : null;
    await e.answer(result?.chosen ?? 'Expired');
    if (result?.messageId !== undefined) {
      await adapter.edit(
        { chatId, messageId: result.messageId },
        {
          text: `❓ <b>${escapeHtml(result.question)}</b>\n✅ ${escapeHtml(result.chosen)}`,
          format: 'tgHtml',
        },
      );
    }
    // Every question answered → resume the session with all the answers, exactly
    // as a typed reply would (the asking turn already ended).
    if (result?.complete && result.prompt && result.chatId !== undefined && result.slot !== undefined) {
      await resumeTurn(result.chatId, result.slot, result.prompt, 'human');
    }
    return;
  }

  // Concierge destructive-action confirmation (e.g. close a thread).
  if (data.startsWith('cfm:')) {
    const [, id, yes] = data.split(':');
    await e.answer();
    if (id && resolveConfirm(id, yes === '1') && e.messageId !== undefined) {
      await adapter.edit({ chatId, messageId: e.messageId }, { text: yes === '1' ? '✅ Confirmed.' : 'Cancelled.', format: 'plain' });
    }
    return;
  }

  if (data === 'noop') {
    await e.answer();
    return;
  }

  if (resolvePermission(data)) {
    await e.answer();
    return;
  }

  await e.answer('Expired');
}
