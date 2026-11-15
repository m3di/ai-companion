import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { config } from './config.js';
import { polish, type RawWord } from './polish.js';
import { allowed, currentMode, debugState, debugWriteCount, dreamState, enterDebug, exitDebug, refusal } from './mode.js';
import {
  clearSession,
  decideProposal,
  getProposal,
  openProposals,
  reopenProposal,
  runProposals,
  runWriteRows,
  sessionKey,
  setProposalRun,
} from './db.js';
import { nightOwed, settleTonight } from './night.js';
import { LENS_NAMES, lens } from './lens.js';
import { requestDreamCancel, lifeItems, lifeLogBetween, lifeParams, boardCommitments, boardPatches } from './db.js';
import { buildLifeView } from './life.js';
import { buildBoard } from './board.js';
import { toUtcDb } from './commitments.js';
import { CONTROL_SLOT } from './sessions.js';
import { ask as agentAsk, interruptTurn, reset as agentReset } from './debugAgent.js';
import { getTurn, type LiveTurn, onTurn, runningTurn } from './agentTurns.js';
import { closeGardenRun, openGardenRun } from './gardenRun.js';
import { previewRevert, revertRun } from './revert.js';
import { recentRuns } from './runs.js';
import { vitals } from './vitals.js';
import { callModule } from './modules.js';
import { onPulse, type Pulse, recentPulses } from './pulse.js';

/**
 * THE ATLAS SERVER — the graph, seen and alive (docs/history/plans/atlas-visualization.md).
 *
 * One rule governs this whole file, and it is the reason the Atlas is worth
 * building beyond the picture: **it reads the knowledge through
 * `callModule('entities', …)` and nothing else.** No `loadGraph()`, no SQL, no
 * private helper that reaches around the boundary. If the dashboard needs
 * something the module cannot answer, that is a missing function — recorded in
 * the friction ledger like any agent's grep, and added because a caller demanded
 * it. A UI with a back door would make the API look complete while proving
 * nothing.
 *
 * The one concession is `resultCap`: the module layer caps results to protect an
 * AGENT's context window, and a renderer is not an agent. That cap belongs to
 * the caller, so the Atlas passes a large one and every agent keeps the small
 * default.
 *
 * Bound to loopback, read-only, no auth. It is a window onto one person's
 * machine, and it stays that way until it isn't.
 */

const HOST = '127.0.0.1';
/** A renderer asked for the whole graph; ~150 nodes is ~70KB of JSON. */
const RENDER_CAP = 5_000_000;

/** Ask the knowledge API a question, and fail loudly rather than silently. */
async function ask(fn: string, args: unknown[] = []): Promise<unknown> {
  const r = await callModule('entities', fn, args, 'atlas', RENDER_CAP);
  if (!r.ok) throw new Error(r.error ?? `entities.${fn} failed`);
  return r.value;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * The live feed.
 *
 * Server-sent events rather than a socket: the traffic is strictly one-way, the
 * browser reconnects on its own, and it needs no dependency at either end. The
 * ring buffer replays first so a page opened mid-sweep is not blank, and the
 * client dedupes on `seq`.
 */
/** Read a JSON body, capped — an operator endpoint still must not be a way to
 *  exhaust the bot's memory with one request. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve_) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve_(JSON.parse(raw || '{}') as Record<string, unknown>);
      } catch {
        resolve_({});
      }
    });
    req.on('error', () => resolve_({}));
  });
}

function stream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (p: Pulse) => {
    // A slow or dead client must never apply backpressure to the prober.
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(p)}\n\n`);
  };
  for (const p of recentPulses(80)) send(p);
  const off = onPulse(send);
  // Some proxies and every idle NAT will drop a quiet stream; a comment frame
  // costs nothing and keeps it open.
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(': beat\n\n');
  }, 25_000);
  const close = () => {
    off();
    clearInterval(beat);
    if (!res.writableEnded) res.end();
  };
  req.on('close', close);
  req.on('error', close);
}

/**
 * Stream one agent turn: the whole answer so far, then the rest as it arrives.
 *
 * Closes itself when the turn ends. An SSE channel for a finished turn would
 * hold a connection open forever for a thing that will never speak again, and
 * the client would have no way to know the difference between "still thinking"
 * and "over".
 */
function turnStream(req: IncomingMessage, res: ServerResponse, runId: number, t: LiveTurn): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (ev: unknown) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  // The replay is one event, not a re-run of every delta: a client joining a
  // turn that is already 4000 characters in wants the text, not 4000 frames.
  // The proposal rides in the replay: it is the one thing on screen the
  // operator must ACT on, and losing it to a reconnect would leave a plan
  // waiting with no way to say yes to it.
  send({ kind: 'replay', text: t.text, steps: t.steps, status: t.status, reached: t.reached, proposal: t.proposal });
  if (t.status !== 'running') {
    res.end();
    return;
  }
  const off = onTurn(runId, (ev) => {
    send(ev);
    if (ev.kind === 'done' || ev.kind === 'error') close();
  });
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(': beat\n\n');
  }, 25_000);
  const close = () => {
    off();
    clearInterval(beat);
    if (!res.writableEnded) res.end();
  };
  req.on('close', close);
  req.on('error', close);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

/** Serve the built client, falling back to index.html so the URL can hold the
 *  current view (`/#/core-api/…` is a deep link worth being able to paste). */
function serveStatic(root: string, urlPath: string, res: ServerResponse): void {
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
  let file = join(root, rel);
  if (!rel || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('The Atlas client is not built yet — run `npm run atlas:build`.');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // The client is rebuilt constantly while this thing is being developed, and
    // a cached index.html pins the browser to a hashed bundle that no longer
    // exists in the build. Ten minutes were spent debugging an interaction that
    // had already been fixed, in a bundle the browser refused to let go of.
    'cache-control': 'no-store, must-revalidate',
  });
  createReadStream(file).pipe(res);
}

export interface AtlasHandle {
  port: number;
  url: string;
  stop: () => void;
}

/**
 * Start the Atlas. Returns null when no port is configured, so the bot runs
 * exactly as before unless someone asked for this.
 */
export function startAtlas(port = Number(process.env.ATLAS_PORT ?? 0)): AtlasHandle | null {
  if (!port) return null;
  const clientRoot = resolve(new URL('.', import.meta.url).pathname, '..', 'web', 'dist');

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
    const path = url.pathname;

    void (async () => {
      try {
        /**
         * WRITES. The server binds 127.0.0.1 and nothing else, which is the
         * whole security argument — there is no auth here and there should not
         * be a second one pretending otherwise. These exist because an operator
         * driving a gardening pass from the page needs to START one and UNDO
         * one; everything else the page does stays read-only.
         *
         * Guarded by the work state, not by a role: writing the graph from a
         * dashboard while the day is live would put an operator's experiment in
         * front of the concierge mid-conversation. In debug, nothing else is
         * running, which is exactly when this is safe.
         */
        if (req.method === 'POST' && path.startsWith('/api/')) {
          const body = await readBody(req);

          /**
           * THE DOOR, and the one POST that is not gated on being through it.
           *
           * Sedating the bot obviously cannot require the bot to be sedated.
           * It does require not being mid-dream — `enterDebug` refuses there
           * itself, and this reports the refusal rather than throwing a 500.
           */
          if (path === '/api/mode') {
            const want = String(body.mode ?? '');
            try {
              if (want === 'debug') {
                const d = enterDebug(String(body.reason ?? 'from the Atlas'));
                return json(res, { mode: currentMode(), debug: d });
              }
              if (want === 'live') {
                const report = exitDebug({ rollback: body.rollback === true });
                // The same reset `/live` does in chat. Keeping writes moved the
                // memory under a context built on the old one — and a door that
                // skips this because it happens to be a web page would leave
                // the concierge answering from a picture the graph no longer
                // supports, which is the failure the reset exists to prevent.
                if (report?.contextReset) {
                  for (const chatId of config.allowedChatIds) {
                    clearSession(sessionKey(chatId, CONTROL_SLOT));
                  }
                }
                return json(res, { mode: currentMode(), report: report ?? null });
              }
            } catch (e) {
              return json(res, { error: e instanceof Error ? e.message : String(e) }, 409);
            }
            return json(res, { error: 'mode must be "debug" or "live"' }, 400);
          }

          /**
           * TAKE THE NIGHT BACK — ungated, for the same reason the door is.
           *
           * A night is mandatory now, so it can stand between the operator and
           * something urgent. Requiring debug to cancel it would be circular:
           * `debug-enter` is one of the few things a dream does NOT permit.
           */
          /**
           * THE POLISH (src/polish.ts): the body's take, rewritten by the cheap
           * model into the text he meant. Writes nothing but a usage row, so it
           * is not gated on the work state; a model call, so it is the one POST
           * the Atlas serves while live besides the operator's questions.
           */
          if (path === '/api/polish') {
            const raw = Array.isArray(body.raw) ? (body.raw as RawWord[]) : [];
            const previous = typeof body.previous === 'string' ? body.previous : '';
            if (!raw.length) return json(res, { error: 'raw is empty' }, 400);
            const chatId = [...config.allowedChatIds][0] ?? 0;
            try {
              return json(res, await polish(chatId, raw, previous));
            } catch (e) {
              return json(res, { error: e instanceof Error ? e.message : String(e) }, 502);
            }
          }
          if (path === '/api/night/cancel') {
            const why = String(body.reason ?? '').trim();
            if (!why) return json(res, { error: 'a reason is required — a night given up on without one is unreadable a week later' }, 400);
            // Two things can be cancelled and the operator means the same thing
            // by both: give me the day back. A pass in flight is asked to stop
            // and unwind itself; a night that is merely OWED is settled here and
            // now, because otherwise the answer to "I need it now" would be "a
            // fold will start within the minute — cancel that one instead".
            if (requestDreamCancel(why)) return json(res, { ok: true, stopped: 'a running pass' });
            if (nightOwed()) {
              settleTonight('cancelled', why);
              return json(res, { ok: true, stopped: 'the owed night' });
            }
            return json(res, { error: 'nothing to cancel — no pass is running and no night is owed' }, 409);
          }

          /**
           * ASKING is not gated on debug; CHANGING is.
           *
           * `/api/agent/ask` runs read-only while the bot is live — the agent
           * refuses its own writes at the write path — so a question costs the
           * day nothing. Everything below this line moves the graph directly
           * from the page and still needs the machine sedated.
           */
          if (path === '/api/agent/ask' || path === '/api/agent/interrupt' || path === '/api/agent/reset') {
            // handled below; no debug requirement
          } else if (!allowed('operator-write')) {
            return json(res, { error: refusal('operator-write') }, 409);
          }
          if (path === '/api/run/open') {
            const b = await openGardenRun({
              trigger: body.trigger === 'prompt' ? 'prompt' : 'linter',
              prompt: String(body.prompt ?? ''),
              limit: Number(body.limit) || 8,
            });
            return json(res, b);
          }
          if (path === '/api/run/close') {
            return json(res, closeGardenRun(Number(body.runId), Number(body.rotBefore) || 0, String(body.outcome ?? '')));
          }
          if (path === '/api/agent/ask') {
            /**
             * RETURNS AS SOON AS THE RUN EXISTS, not when the turn ends.
             *
             * It used to hold the request open for the whole turn, and the
             * comment here defended that as "the honest shape" — the client
             * shows it is thinking. It was honest and it was blind: forty
             * seconds of a spinner, then everything at once. Now the id comes
             * back immediately and the turn is watched through
             * `/api/agent/turn/:id/stream`, so the answer is read as it is
             * written and the nodes light as they are reached.
             *
             * The turn itself is deliberately NOT awaited here. Its result is
             * already recorded — the run row, the writes, the answer — so
             * nothing depends on this handler seeing it land.
             */
            return await new Promise<void>((done) => {
              let opened = false;
              agentAsk(String(body.prompt ?? ''), (runId) => {
                opened = true;
                json(res, { runId });
                done();
              }).catch((e) => {
                const message = e instanceof Error ? e.message : String(e);
                // A refusal — live, dreaming, a stuck run — happens BEFORE the
                // run is opened, so there is no turn to stream it through and
                // this response is the only place it can be reported.
                if (!opened) {
                  json(res, { error: message }, 409);
                  done();
                }
              });
            });
          }
          /**
           * APPROVE A PLAN — which is just another turn, deliberately.
           *
           * The alternative was to execute the proposal's steps directly from
           * here, and it is worse in the way that matters: the steps are PROSE,
           * written for a person to judge, and a server that executed them
           * would need them to be machine-readable ops — a second write path
           * around `record()`, with its own bugs and no journal.
           *
           * So approval is sent back into the same session as a message. The
           * agent proposed it one turn ago and still has it in context; it
           * carries it out through the normal write path, inside its own run,
           * revertible one write at a time like anything else.
           */
          if (path === '/api/proposal/decide') {
            const id = Number(body.id);
            const p = getProposal(id);
            if (!p) return json(res, { error: `no proposal #${id}` }, 404);
            if (p.status !== 'open') return json(res, { error: `proposal #${id} was already ${p.status}` }, 409);

            if (body.approve !== true) {
              decideProposal(id, 'discarded');
              return json(res, { ok: true, status: 'discarded' });
            }
            // Claimed BEFORE the turn starts, so a double click cannot run the
            // plan twice — the second call finds it already applied.
            if (!decideProposal(id, 'applied')) {
              return json(res, { error: `proposal #${id} was decided by someone else` }, 409);
            }
            /**
             * Approving from a LIVE bot sedates it, with the plan as the
             * reason. The alternative was to refuse and tell the operator to go
             * and flip a switch first — but clicking apply IS the decision, and
             * making them perform the prerequisite by hand only creates a
             * window in which they forget why they sedated it. The session is
             * recorded like any other and they still choose keep-or-discard on
             * the way out.
             */
            let sedatedForThis = false;
            if (!allowed('operator-write')) {
              try {
                enterDebug(`applying proposal #${id}: ${p.summary}`.slice(0, 200));
                sedatedForThis = true;
              } catch (e) {
                reopenProposal(id);
                return json(res, { error: e instanceof Error ? e.message : String(e) }, 409);
              }
            }
            const steps = (JSON.parse(p.steps) as string[]).map((s) => `- ${s}`).join('\n');
            const approval =
              `APPROVED — proposal #${id}. Carry out exactly this, nothing more:\n\n${p.summary}\n${steps}\n\n` +
              `Make the writes now through record(), each with a reason. Then say in one or two lines what you actually did, and name anything you decided to leave alone.`;
            return await new Promise<void>((done) => {
              let opened = false;
              agentAsk(approval, (runId) => {
                opened = true;
                // Now the link exists: this proposal, carried out by that run.
                setProposalRun(id, runId);
                json(res, { ok: true, status: 'applied', runId, sedated: sedatedForThis });
                done();
              }).catch((e) => {
                if (!opened) {
                  // The plan was never carried out, so it must not be left
                  // marked as though it had been — this table is a record of
                  // consent, not of intent.
                  reopenProposal(id);
                  json(res, { error: e instanceof Error ? e.message : String(e) }, 409);
                  done();
                }
              });
            });
          }
          if (path === '/api/agent/interrupt') {
            const t = runningTurn();
            if (!t) return json(res, { error: 'no turn is running' }, 404);
            return json(res, { runId: t.runId, stopped: interruptTurn() });
          }
          if (path === '/api/agent/reset') {
            agentReset();
            return json(res, { ok: true });
          }
          if (path === '/api/run/revert') {
            const runId = Number(body.runId);
            return json(res, revertRun(runId, runWriteRows(runId), String(body.reason ?? 'reverted from the Atlas')));
          }
          return json(res, { error: 'no such endpoint' }, 404);
        }

        if (path === '/api/stream') return stream(req, res);

        /**
         * ONE TURN, WATCHED.
         *
         * Separate from `/api/stream` because they are different kinds of
         * thing. That one is the machine's ambient activity: lossy by design,
         * a dropped frame costs an animation. This is an answer being written,
         * where a dropped fragment costs a sentence out of the middle and the
         * reader cannot tell. So it replays the whole buffer on connect and
         * only then goes live, which makes a reconnect mid-turn seamless
         * rather than a hole.
         */
        if (path.startsWith('/api/agent/turn/') && path.endsWith('/stream')) {
          const runId = Number(path.split('/')[4]);
          const t = getTurn(runId);
          if (!t) return json(res, { error: `no live turn #${runId}` }, 404);
          return turnStream(req, res, runId, t);
        }
        if (path.startsWith('/api/agent/turn/')) {
          const t = getTurn(Number(path.split('/')[4]));
          return t ? json(res, t) : json(res, { error: 'no such turn' }, 404);
        }
        // What is running right now, for a page that arrives mid-turn.
        if (path === '/api/agent/running') return json(res, runningTurn() ?? null);

        if (path === '/api/graph') return json(res, await ask('graph'));

        if (path.startsWith('/api/entity/')) {
          const id = decodeURIComponent(path.slice('/api/entity/'.length));
          // Four questions, asked in parallel, each one a real function in the
          // catalog. If the modal ever needs a fifth, it gets added there.
          const [card, neighbours, stats, blockers, trace] = await Promise.all([
            ask('find', [id]),
            ask('neighbours', [id]),
            ask('stats', [id]),
            ask('blockers', [id]),
            ask('trace', [id]),
          ]);
          if (!card) return json(res, { error: `no entity "${id}"` }, 404);
          return json(res, { card, neighbours, stats, blockers, trace });
        }

        /**
         * THE LENSES — every context store, in the shape the ledger proved.
         *
         * One route and one payload for all of them, because the alternative
         * is six endpoints that drift apart. A lens either produces refs or it
         * says how many rows it could not (I4, made load-bearing: a store with
         * no refs renders as a visibly dead list).
         */
        if (path.startsWith('/api/lens/')) {
          const l = lens(path.slice('/api/lens/'.length));
          if (!l) return json(res, { error: 'no such lens', lenses: LENS_NAMES }, 404);
          return json(res, l);
        }

        // The work state, in one shape for every reader. `mode` is the answer
        // to "what is this thing doing"; `debug` and `dream` are the two ways
        // it can be doing something other than the day.
        if (path === '/api/mode') {
          const d = debugState();
          return json(res, {
            mode: currentMode(),
            // `writes` rides WITH the session rather than being derived by the
            // client from timestamps in two different formats, which is how the
            // exit dialog came to report "nothing was written" over three.
            debug: d ? { ...d, writes: debugWriteCount() } : null,
            dream: dreamState() ?? null,
            // The fourth fact, and the only one that holds the day while `mode`
            // reads an ordinary `live`: a night that has not been folded yet.
            owed: nightOwed() ?? null,
          });
        }
        // THE RUN LEDGER — what each attempt asked for and what it actually
        // changed. This is the surface that makes a PROMPT reviewable rather
        // than only a graph: nine writes are nine rows, but "this instruction
        // produced those nine and touched these six nodes" is a judgement about
        // the instruction.
        if (path === '/api/runs') {
          return json(
            res,
            recentRuns(Number(url.searchParams.get('limit') ?? 20)).map((r) => ({ ...r, proposals: runProposals(r.id) })),
          );
        }
        if (path === '/api/vitals') return json(res, vitals());
        // THE LIFE VIEW (proposal #7) — a render over life_items/life_log, the
        // same maths the concierge reads.
        if (path === '/api/life') {
          const now = new Date();
          const params = lifeParams();
          const from = new Date(now);
          from.setHours(0, 0, 0, 0);
          from.setDate(from.getDate() - 7);
          const evs = lifeLogBetween(toUtcDb(from), toUtcDb(new Date(now.getTime() + 60_000)));
          return json(res, { ...buildLifeView(lifeItems(), evs, params, now), board: buildBoard(boardCommitments(), lifeItems(), boardPatches(), now) });
        }
        // Plans waiting on the operator. A page opened after the proposing turn
        // scrolled away still finds them.
        if (path === '/api/proposals') return json(res, openProposals());
        if (path.startsWith('/api/run/') && path.endsWith('/revert-preview')) {
          return json(res, previewRevert(Number(path.split('/')[3])));
        }
        if (path === '/api/domains') return json(res, await ask('domains'));
        if (path === '/api/health') return json(res, await ask('health'));

        if (path.startsWith('/api/')) return json(res, { error: 'no such endpoint' }, 404);
        return serveStatic(clientRoot, path, res);
      } catch (e) {
        console.error('[atlas]', e);
        json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
      }
    })();
  });

  // A bind failure is reported in words, not as an unhandled 'error' event
  // that takes the whole bot down mid-boot (2026-11-08). The Atlas is optional;
  // the day is not — so the bot runs on without it and says why.
  server.once('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.error(`[atlas] port ${port} is already in use — is another bot or CLI serving the Atlas? running without it`);
    else console.error('[atlas] could not listen:', e);
  });
  server.listen(port, HOST);
  const url = `http://${HOST}:${port}`;
  console.log(`[atlas] ${url}`);
  return { port, url, stop: () => server.close() };
}
