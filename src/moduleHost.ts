import { createContext, runInContext } from 'node:vm';
import { SENTINEL } from './moduleProtocol.js';

/**
 * THE MODULE HOST — the child side of the out-of-process boundary (round 9 §1).
 *
 * A knowledge module is code the NIGHT wrote and the DAY calls. That is the
 * whole point of the round, and it is also the risk: agent-written code breaks
 * retrieval for every agent. So a module never runs inside the bot. It gets a
 * fresh process, a request on stdin, one JSON line on stdout, a timeout and an
 * output cap. A module that hangs, leaks, or throws in a way nobody anticipated
 * costs one subprocess — it cannot take the bot with it.
 *
 * Protocol (deliberately dumb, so both ends stay auditable):
 *   argv[2]  absolute path to the module's index.ts
 *   stdin    {"fn": "openLoops", "args": [...]}  |  {"expr": "m.openLoops()..."}
 *   stdout   anything the module logged, then SENTINEL + one JSON envelope
 */

interface Request {
  fn?: string;
  args?: unknown[];
  expr?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Write the envelope and leave — but only once the pipe has actually taken it.
 *
 * `process.stdout.write()` to a PIPE is asynchronous, and `process.exit()` does
 * not flush what is still buffered. Every result under the pipe's ~64KB capacity
 * therefore worked, and the first one over it came back as
 * `Unterminated string in JSON at position 65397` — a corrupt envelope that
 * looks like a module bug and is not. The parent already enforces a timeout and
 * a cap, so waiting for the drain costs nothing and is the difference between a
 * large answer and a mangled one.
 *
 * THE SAFETY NET USED TO RECREATE THE BUG IT WAS GUARDING. It fired at 5s and
 * called `process.exit(0)` regardless of how much of the envelope had been
 * written — so a large result on a busy parent (the Atlas asking for the whole
 * graph while probes run) exited mid-JSON and produced the identical corrupt
 * envelope. It was doing this to about 7% of `entities.graph` calls on
 * 2026-08-06: `Unterminated string in JSON at position 39981`.
 *
 * The parent already owns the deadline — it kills the child at
 * `MODULE_TIMEOUT_MS` and reports a clean "timed out". So this net now sits
 * deliberately BEYOND that, and its only job is to stop an orphaned child
 * living forever if the parent vanished. Whichever way it ends, the parent gets
 * an honest answer instead of a mangled one: a timeout, or the whole envelope.
 */
const DRAIN_CEILING_MS = Number(process.env.MODULE_TIMEOUT_MS ?? 20_000) * 3;

function emit(payload: unknown): never {
  const done = () => process.exit(0);
  // `write` returns false when the buffer is full; the callback fires either
  // way once the data is handed off, so one path covers both.
  process.stdout.write(SENTINEL + JSON.stringify(payload), done);
  setTimeout(done, DRAIN_CEILING_MS).unref();
  return undefined as never;
}

function fail(error: string, started: number): never {
  // The FAILURE is the result; a non-zero exit would hide it.
  return emit({ ok: false, error, ms: Date.now() - started });
}

const started = Date.now();
const entry = process.argv[2];
if (!entry) fail('no module entry given', started);

const raw = await readStdin();
let req: Request;
try {
  req = JSON.parse(raw || '{}') as Request;
} catch (e) {
  fail(`unreadable request: ${e instanceof Error ? e.message : String(e)}`, started);
}

let mod: Record<string, unknown>;
try {
  mod = (await import(entry!)) as Record<string, unknown>;
} catch (e) {
  fail(`module failed to load: ${e instanceof Error ? e.message : String(e)}`, started);
}

try {
  let value: unknown;
  if (req!.expr !== undefined) {
    /**
     * Mehdi's "write inline code over module outputs" — composition without
     * shipping a function for every question anyone might ask.
     *
     * `node:vm` here is a GUARDRAIL, not a sandbox: it keeps an expression from
     * casually reaching `process` or `fs`, and it is honest to say it would not
     * stop code that set out to escape. The actual boundary is the one around
     * this whole file — a short-lived subprocess, a timeout, a capped output —
     * plus the fact that every agent reaching this already has Bash.
     */
    const ctx = createContext({ m: mod, console, JSON, Math, Object, Array, String, Number, Boolean, Date, Map, Set, RegExp });
    value = await runInContext(`(async () => (${req!.expr}))()`, ctx, { timeout: 10_000 });
  } else {
    const fn = mod[req!.fn ?? ''];
    if (typeof fn !== 'function') {
      const known = Object.entries(mod)
        .filter(([, v]) => typeof v === 'function')
        .map(([k]) => k);
      fail(`no exported function "${req!.fn}" — this module exports: ${known.join(', ') || '(nothing callable)'}`, started);
    }
    value = await (fn as (...a: unknown[]) => unknown)(...(req!.args ?? []));
  }
  emit({ ok: true, value: value ?? null, ms: Date.now() - started });
} catch (e) {
  fail(e instanceof Error ? `${e.message}\n${(e.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(e), started);
}
