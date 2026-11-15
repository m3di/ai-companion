/**
 * THE LEDGER'S TWO CONTRACTS — design proposal #1 (2026-10-30).
 *
 * 1. A check may emit JSON: `{ "head": {...}, "detail": {...}? }`. The head is
 *    the item's structured state, overwritten each run; the detail, when
 *    present, is appended to the item's log. The check OWNS the shape, and
 *    with it the responsibility for its own stability — it emits the counter
 *    it wants compared and omits the timestamp it does not, which is strictly
 *    better than `scrub()` guessing which bytes are volatile. Plain text
 *    output keeps the old hash-diff contract untouched.
 *
 * 2. The wake is a PREDICATE over the head, authored per item, instead of the
 *    hardwired hash-diff. The grammar is deliberately tiny and total — it
 *    cannot throw, hang, or reach anything but the head (I8: a check may never
 *    block its own repair; the same reason check commands are allowlisted).
 *
 *      expr    := clause ( ("&&" | "||") clause )*
 *      clause  := path op literal
 *      path    := ident ( "." ident )*
 *      op      := == | != | >= | <= | > | <
 *      literal := number | "string" | 'string' | true | false | null
 *
 *    `&&` binds tighter than `||`. No parentheses, no arithmetic, no function
 *    calls — if a wake rule needs those, the check should compute the field.
 */

export interface CheckEmission {
  head: Record<string, unknown>;
  detail?: unknown;
}

/** Parse a check's stdout as a ledger emission, or undefined when it is plain text. */
export function parseEmission(raw: string): CheckEmission | undefined {
  const t = raw.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const o = JSON.parse(t) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const head = (o as { head?: unknown }).head;
    if (!head || typeof head !== 'object' || Array.isArray(head)) return undefined;
    const detail = (o as { detail?: unknown }).detail;
    return detail === undefined ? { head: head as Record<string, unknown> } : { head: head as Record<string, unknown>, detail };
  } catch {
    return undefined;
  }
}

type Literal = number | string | boolean | null;
interface Clause {
  path: string[];
  op: '==' | '!=' | '>=' | '<=' | '>' | '<';
  value: Literal;
}
/** Disjunction of conjunctions. */
export type Predicate = Clause[][];

export const LOG_MODE = 'log';

const CLAUSE = /^\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?|"[^"]*"|'[^']*'|true|false|null)\s*$/;

/** Compile a wake expression. Returns the predicate, or the reason it is invalid. */
export function parsePredicate(expr: string): { ok: true; pred: Predicate } | { ok: false; error: string } {
  const t = expr.trim();
  if (!t) return { ok: false, error: 'empty expression' };
  if (t === LOG_MODE) return { ok: false, error: '"log" is a mode, not a predicate' };
  const pred: Predicate = [];
  for (const disj of t.split('||')) {
    const conj: Clause[] = [];
    for (const part of disj.split('&&')) {
      const m = CLAUSE.exec(part);
      if (!m) return { ok: false, error: `cannot read "${part.trim()}" — expected: field op literal (e.g. consecutive_fails >= 3, status == "red")` };
      const lit = m[3]!;
      const value: Literal =
        lit === 'true' ? true : lit === 'false' ? false : lit === 'null' ? null : /^["']/.test(lit) ? lit.slice(1, -1) : Number(lit);
      conj.push({ path: m[1]!.split('.'), op: m[2] as Clause['op'], value });
    }
    pred.push(conj);
  }
  return { ok: true, pred };
}

function lookup(head: unknown, path: string[]): unknown {
  let cur: unknown = head;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function compare(a: unknown, op: Clause['op'], b: Literal): boolean {
  if (op === '==') return a === b;
  if (op === '!=') return a !== b;
  if (typeof a !== 'number' || typeof b !== 'number' || Number.isNaN(a)) return false; // ordering only over numbers; anything else is false, never a throw
  return op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : a < b;
}

/** Total: a missing field compares as undefined, which satisfies only `!=`. */
export function evalPredicate(pred: Predicate, head: unknown): boolean {
  return pred.some((conj) => conj.every((c) => compare(lookup(head, c.path), c.op, c.value)));
}

/**
 * What a changed head does, by mode. NULL mode = wake on ANY change (the old
 * contract, over the head instead of the scrubbed text). 'log' = never. Any
 * other string is a predicate that must hold on the NEW head.
 */
export function shouldWake(mode: string | null, changed: boolean, head: unknown): { wake: boolean; error?: string } {
  if (mode === LOG_MODE) return { wake: false };
  if (!mode) return { wake: changed };
  const p = parsePredicate(mode);
  if (!p.ok) return { wake: false, error: p.error };
  return { wake: evalPredicate(p.pred, head) };
}

/** Validate a watchMode as authored: 'log', a predicate, or empty to clear. */
export function validateWatchMode(mode: string | undefined): string | undefined {
  const t = mode?.trim();
  if (!t || t === LOG_MODE) return undefined;
  const p = parsePredicate(t);
  return p.ok ? undefined : p.error;
}
