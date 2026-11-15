/**
 * WHAT MEHDI DATED — the plan for a day that is not yet today.
 *
 * 2026-10-03, Lisbon. Over twelve turns the concierge and Mehdi agreed the
 * whole of the next day: checkout at 12:00, *The Odyssey* at 11:00, bags, the
 * metro, a flight at 18:25. The one durable trace was a focus item about the
 * ticket, closed the moment the ticket was bought. The night (dream #121)
 * cleared the transcript, read every turn, and wrote: "every one is Lisbon
 * tourist logistics … nothing to file." The next morning, asked for the day's
 * plan, the concierge offered sightseeing — on departure day — and called the
 * Sunday a Saturday.
 *
 * The night was right by its own filing options. A graph fact is timeless and
 * an open loop is something he must still do; "tomorrow is leaving day" is
 * neither. It is a THIRD thing: a plan bound to a date, and the only surface
 * that reaches the next day's concierge is a commitment due that day, because
 * the session-open snapshot lists those and nothing else from before.
 *
 * So, mechanism rather than a prompt plea (I9): the human messages of the
 * window that name a day or a time are handed to the night as a block, each
 * with what the commitments table already holds for the named day, and each
 * must receive a verdict through `datedVerdict` — committed (filed, with the
 * id), tracked (already due that day), or declined (why nothing dated needs
 * to reach that morning). Offered rows are written when the prompt is really
 * sent, verdicts are stamped with the dream that saved, a cancelled pass takes
 * its verdicts with it, and an unjudged statement comes back marked until
 * someone decides — the exact shape door_decisions proved (2026-09-03).
 *
 * The number: `datedTally` — offered, and how many of those got a verdict.
 * The audit fires on a block that was offered and never answered.
 */
import {
  commitmentsDueOnLocalDay,
  datedVerdictsBetween,
  hasOfferedDated,
  humanMessagesBetween,
  humanMessagesById,
  recordDatedVerdict,
  supersedeDatedVerdict,
  undecidedDatedMessageIds,
  type HumanMessageRow,
} from './db.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const WEEKDAY_RE = /\b(?:(next|this|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
const REL_RE = /\b(day after tomorrow|tomorrow|tonight|this (?:evening|afternoon|morning|weekend)|next (?:week|month))\b/i;
const IN_DAYS_RE = /\bin (\d{1,2}) days?\b/i;
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
// Whole month words only: "Skylark 18:25" is an airline and a time, not 18 September.
const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DM_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\b`, 'i');
const MD_RE = new RegExp(`\\b(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
const TIME_RE = /\b([01]?\d|2[0-3]):[0-5]\d\b/;

export interface DatedStatement {
  /** The message id — what `datedVerdict` is called with. */
  id: number;
  /** Local 'YYYY-MM-DD HH:MM' the message was sent. */
  at: string;
  text: string;
  /** The words that made it dated. */
  cue: string;
  /** The local day it names, when one can be resolved; a bare time names none. */
  day: string | null;
  /** Offered on an earlier pass and never judged. */
  carried?: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function localDate(at: string): Date {
  const [day, hm] = at.split(' ');
  const [y, m, d] = day!.split('-').map(Number);
  const [h, mi] = (hm ?? '00:00').split(':').map(Number);
  return new Date(y!, m! - 1, d!, h ?? 0, mi ?? 0, 0, 0);
}

function plusDays(base: Date, n: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

/**
 * The cue and the day a message names, or null when it names neither. Pure:
 * `at` is the LOCAL time the message was sent, which is the "today" every
 * relative word is measured from.
 */
export function datedCue(text: string, at: string): { cue: string; day: string | null } | null {
  const base = localDate(at);
  let m: RegExpMatchArray | null;
  if ((m = text.match(REL_RE))) {
    const w = m[1]!.toLowerCase();
    const day = w === 'day after tomorrow' ? plusDays(base, 2) : w === 'tomorrow' ? plusDays(base, 1) : w.startsWith('next') ? null : isoDay(base);
    return { cue: m[1]!, day };
  }
  if ((m = text.match(IN_DAYS_RE))) return { cue: m[0], day: plusDays(base, Number(m[1])) };
  if ((m = text.match(ISO_RE))) return { cue: m[0], day: `${m[1]}-${m[2]}-${m[3]}` };
  const dmMatch = text.match(DM_RE);
  if ((m = dmMatch) || (m = text.match(MD_RE))) {
    const dm = m === dmMatch;
    const dayNum = Number(dm ? m[1] : m[2]);
    const mon = MONTHS.indexOf((dm ? m[2] : m[1])!.toLowerCase().slice(0, 3));
    if (mon >= 0 && dayNum >= 1 && dayNum <= 31) {
      let y = base.getFullYear();
      // A month-day said in December about January is next year; otherwise this one.
      if (mon < base.getMonth() - 6) y += 1;
      return { cue: m[0], day: `${y}-${pad(mon + 1)}-${pad(dayNum)}` };
    }
  }
  if ((m = text.match(WEEKDAY_RE))) {
    const target = WEEKDAYS.indexOf(m[2]!.toLowerCase());
    let ahead = (target - base.getDay() + 7) % 7;
    // "Sunday" said on a Sunday is next week's; "next Sunday" always is.
    if (ahead === 0 || (m[1]?.toLowerCase() === 'next' && ahead < 7)) ahead = ahead === 0 ? 7 : ahead;
    return { cue: m[0], day: plusDays(base, ahead) };
  }
  if ((m = text.match(TIME_RE))) return { cue: m[0], day: null };
  return null;
}

const CAP = 20;

function toStatements(rows: HumanMessageRow[]): DatedStatement[] {
  const out: DatedStatement[] = [];
  for (const r of rows) {
    const c = datedCue(r.content, r.at);
    if (!c) continue;
    out.push({ id: r.id, at: r.at, text: r.content.replace(/\s+/g, ' ').slice(0, 240), cue: c.cue, day: c.day });
  }
  return out;
}

/** This window's dated statements. Pure read; nothing is offered here. */
export function datedStatements(chatId: number, from: string, to: string): DatedStatement[] {
  return toStatements(humanMessagesBetween(chatId, from, to));
}

/** What a pass is shown: this window's statements plus every earlier one still unjudged. */
export function datedForPass(chatId: number, from: string, to: string): DatedStatement[] {
  const now = datedStatements(chatId, from, to);
  const have = new Set(now.map((s) => s.id));
  const carried = undecidedDatedMessageIds(from).filter((id) => !have.has(id));
  if (carried.length) for (const s of toStatements(humanMessagesById(carried))) now.push({ ...s, carried: true });
  return now.slice(-CAP);
}

const HEADER =
  `## WHAT MEHDI DATED — statements naming a day or a time (the plan for a day that is not yet today)\n` +
  `Tomorrow's concierge opens with NO memory of this conversation. Its session-open snapshot lists the commitments due that day and nothing else from before — so a plan agreed today for a named day reaches tomorrow ONLY as a commitment due that day. ` +
  `On 2026-10-03 a whole departure day (checkout, a film, a flight) was agreed in the chat, judged "transient logistics", and the morning offered sightseeing. ` +
  `For EACH row call datedVerdict(messageId, decision, note): ` +
  `COMMITTED — you filed a commitment due the named day, at the hour the plan is useful (morning for a day plan, earlier for a departure), its body the agreed plan as you would say it to him; note = the commitment id. ` +
  `TRACKED — a commitment already due that day covers it; note = its id. ` +
  `DECLINED — nothing dated needs to reach that morning; note = why (a time inside today that has passed, a question with no plan behind it). ` +
  `Under each row is what the commitments table already holds for the named day. Decide EVERY row — an undecided one comes back tomorrow, marked carried.\n`;

const BLOCK_CHAR_CAP = 3200;

/** The digest section, pure — empty when the day named no day. */
export function datedBlock(chatId: number, from: string, to: string, rows: DatedStatement[] = datedForPass(chatId, from, to)): string {
  if (!rows.length) return '';
  const lines = rows.map((s) => {
    const due = s.day ? commitmentsDueOnLocalDay(chatId, s.day) : [];
    const held = s.day
      ? due.length
        ? due.map((c) => `#${c.id} ${c.label} ${c.at} (${c.status})`).join(' · ')
        : 'NOTHING due that day'
      : 'a time, no day resolved — the day is in the conversation around it';
    return (
      `- [msg #${s.id}, ${s.at}] "${s.text}"` +
      `\n  cue: ${s.cue} → ${s.day ?? '?'}${s.carried ? ' — offered on an earlier pass, STILL UNDECIDED' : ''}` +
      `\n  table holds for ${s.day ?? 'that day'}: ${held}`
    );
  });
  let cut = 0;
  while (HEADER.length + lines.join('\n').length > BLOCK_CHAR_CAP && lines.length > 1) {
    lines.shift();
    cut++;
  }
  return HEADER + lines.join('\n') + (cut ? `\n(truncated: ${cut} older row(s) above the cap)` : '') + '\n\n';
}

let offeredThisPass = new Set<number>();

/** Record what the night is about to be SHOWN — once the prompt is really sent. Idempotent per message. */
export function offerDated(rows: DatedStatement[]): Set<number> {
  offeredThisPass = new Set(rows.map((s) => s.id));
  for (const s of rows) if (!hasOfferedDated(s.id)) recordDatedVerdict(s.id, 'offered', `${s.cue} → ${s.day ?? '?'}`);
  return offeredThisPass;
}

export type DatedDecision = 'committed' | 'tracked' | 'declined';

export function decideDated(messageId: number, decision: DatedDecision, note: string): { ok: true } | { ok: false; problem: string } {
  if (!offeredThisPass.has(messageId)) {
    const valid = [...offeredThisPass];
    return { ok: false, problem: `msg #${messageId} was not offered this pass. Valid: ${valid.length ? valid.map((i) => `#${i}`).join(', ') : '(none — the block was empty)'}` };
  }
  supersedeDatedVerdict(messageId);
  recordDatedVerdict(messageId, decision, note);
  return { ok: true };
}

export interface DatedTally {
  offered: number;
  committed: number;
  tracked: number;
  declined: number;
  /** Decided by a pass that never saved. */
  unlanded: number;
}

/** The cycle's DATED line. Only stamped verdicts count, as with doors. */
export function datedTally(from: string, to: string): DatedTally {
  const rows = datedVerdictsBetween(from, to);
  const landed = rows.filter((r) => r.dream_id !== null);
  const count = (d: string) => landed.filter((r) => r.decision === d).length;
  return {
    offered: count('offered'),
    committed: count('committed'),
    tracked: count('tracked'),
    declined: count('declined'),
    unlanded: rows.filter((r) => r.dream_id === null && r.decision !== 'offered').length,
  };
}
