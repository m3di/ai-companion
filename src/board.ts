/**
 * THE BOARD — the week as the day session wants Mehdi to see it (proposal #7,
 * reshaped 2026-11-13).
 *
 * Two layers, and the split is the design:
 *
 *  - The AUTOMATIC layer is derived on every read from what the machine already
 *    holds (I2): dated commitments that could be for him, chores coming due
 *    (overdue ones carried into today), and the fixed work block. It is never
 *    stored, so it can never go stale against its sources.
 *  - The DAY layer is the concierge's judgement, stored as PATCHES (`board`
 *    table): add an item, adjust an automatic one (day, time, label), hide one.
 *    Every patch carries a reason. A patch is keyed to the automatic item it
 *    fixes, so it survives recomputation — it improves the default rather than
 *    replacing it, which is what he asked for.
 *
 * Hidden items are reported, never dropped (I10): the page lists them with the
 * reason, so "the bot decided I don't need to see this" is itself visible.
 *
 * Tier 3 — sessions (travel, paperwork, a move) — are SPANS, not points: they
 * have no hour and shape the line without sitting on it. Only the day session
 * can open one (nothing in the machine knows a trip is a trip).
 */

import { fmtLocal } from './commitments.js';
import type { BoardCommitment, BoardPatch, LifeItem } from './db.js';
import { nextDue, WORK_BLOCK, WORKDAYS } from './life.js';

export type BoardKind = 'appointment' | 'work' | 'chore' | 'reminder' | 'note';
export const BOARD_KINDS: BoardKind[] = ['appointment', 'work', 'chore', 'reminder', 'note'];

export interface BoardItem {
  /** Automatic: "<source>:<id>@<day>". Added: "day:<patchId>". */
  key: string;
  day: string;
  /** Local HH:mm. */
  at: string;
  until?: string;
  kind: BoardKind;
  label: string;
  ref?: string;
  tier?: 1 | 2;
  source: 'auto' | 'day';
  /** Why it is here — the automatic rule, or the day session's reason. */
  why: string;
  /** Set when the day session moved or relabelled an automatic item. */
  adjusted?: { patch: number; reason: string };
}

export interface BoardSpan {
  key: string;
  label: string;
  from: string;
  to: string;
  why: string;
  patch: number;
}

export interface Board {
  now: string;
  today: string;
  days: Array<{ date: string; workday: boolean; items: BoardItem[] }>;
  spans: BoardSpan[];
  hidden: Array<{ item: BoardItem; reason: string; patch: number }>;
  /** Chores never logged: no data to place them with, so they are named, not drawn. */
  noData: string[];
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hhmm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dayAt(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}
function utc(dbTime: string): Date {
  return new Date(`${dbTime.replace(' ', 'T')}Z`);
}
export function weekdayOf(day: string): number {
  return dayAt(day).getDay();
}

/** A commitment's body is an instruction to the bot; its first sentence is usually the thing itself. */
export function commitmentTitle(c: BoardCommitment): string {
  const first = c.body.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  const t = first.replace(/^\[[^\]]+\]\s*/, '').replace(/[.!?]$/, '');
  if (t && t.length <= 70) return t;
  return c.label.replace(/[-_]+/g, ' ');
}

/** The default slot for something due on a day but with no hour: after work on a work day, late morning off. */
export function defaultSlot(day: string): string {
  return WORKDAYS.includes(weekdayOf(day)) ? `${pad(WORK_BLOCK.end)}:30` : '11:00';
}

export function autoItems(commitments: BoardCommitment[], items: LifeItem[], now: Date, span = 7): { items: BoardItem[]; noData: string[] } {
  const days = Array.from({ length: span }, (_, i) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    return localDay(d);
  });
  const first = dayAt(days[0]!).getTime();
  const end = dayAt(days.at(-1)!).getTime() + DAY_MS;
  const out: BoardItem[] = [];

  for (const day of days) {
    if (WORKDAYS.includes(weekdayOf(day))) {
      out.push({
        key: `work@${day}`,
        day,
        at: `${pad(WORK_BLOCK.start)}:00`,
        until: `${pad(WORK_BLOCK.end)}:00`,
        kind: 'work',
        label: 'serious work',
        source: 'auto',
        why: 'the fixed work block (Sun–Thu)',
      });
    }
  }

  for (const c of commitments) {
    const step = c.recur === 'daily' ? DAY_MS : c.recur === 'weekly' ? 7 * DAY_MS : 0;
    for (let t = utc(c.due_at).getTime(); t < end; t += step || Infinity) {
      if (t >= first) {
        const d = new Date(t);
        out.push({
          key: `commitment:${c.id}@${localDay(d)}`,
          day: localDay(d),
          at: hhmm(d),
          kind: 'appointment',
          label: commitmentTitle(c),
          ref: `commitment:${c.id}`,
          source: 'auto',
          why: `commitment #${c.id} (${c.label}), due ${fmtLocal(c.due_at)}${c.recur ? `, ${c.recur}` : ''}`,
        });
      }
      if (!step) break;
    }
  }

  const noData: string[] = [];
  for (const i of items) {
    if (!i.last_at) {
      noData.push(i.id);
      continue;
    }
    // Daily basics are a rhythm, not an event: the day session may place one,
    // the automatic layer does not paint teeth on every day.
    if (i.tier === 1 && i.days <= 1) continue;
    const due = nextDue(i, now);
    const overdue = due.getTime() < first;
    const day = overdue ? days[0]! : localDay(due);
    if (!days.includes(day)) continue;
    out.push({
      key: `life:${i.id}@${day}`,
      day,
      at: defaultSlot(day),
      kind: 'chore',
      label: i.label,
      ref: `life:${i.id}`,
      tier: i.tier,
      source: 'auto',
      why: overdue ? `overdue since ${localDay(due)}, carried to today` : i.tier === 2 ? `one half-life (${i.days}d) since last done` : `every ${i.days}d`,
    });
  }
  return { items: out, noData };
}

/**
 * Lay the day session's patches over the automatic layer. Later patches on the
 * same target win; a patch whose target no longer exists (the commitment was
 * done) is simply moot — nothing to fix.
 */
export function applyPatches(auto: BoardItem[], patches: BoardPatch[], days: string[]): Pick<Board, 'spans' | 'hidden'> & { items: BoardItem[] } {
  const last = new Map<string, BoardPatch>();
  for (const p of patches) if (p.target && p.op !== 'add') last.set(p.target, p);

  const items: BoardItem[] = [];
  const hidden: Board['hidden'] = [];
  for (const a of auto) {
    const p = last.get(a.key);
    if (!p) items.push(a);
    else if (p.op === 'hide') hidden.push({ item: a, reason: p.reason, patch: p.id });
    else
      items.push({
        ...a,
        day: p.day ?? a.day,
        at: p.at ?? a.at,
        until: p.until ?? a.until,
        label: p.label ?? a.label,
        adjusted: { patch: p.id, reason: p.reason },
      });
  }
  const spans: BoardSpan[] = [];
  for (const p of patches.filter((x) => x.op === 'add' && x.day)) {
    if (p.day_to) {
      if (p.day_to >= days[0]! && p.day! <= days.at(-1)!) {
        spans.push({ key: `day:${p.id}`, label: p.label ?? '(session)', from: p.day!, to: p.day_to, why: p.reason, patch: p.id });
      }
      continue;
    }
    items.push({
      key: `day:${p.id}`,
      day: p.day!,
      at: p.at ?? defaultSlot(p.day!),
      until: p.until ?? undefined,
      kind: (BOARD_KINDS as string[]).includes(p.kind ?? '') ? (p.kind as BoardKind) : 'note',
      label: p.label ?? '',
      ref: p.ref ?? undefined,
      source: 'day',
      why: p.reason,
    });
  }
  return { items: items.filter((i) => days.includes(i.day)), hidden: hidden.filter((h) => days.includes(h.item.day)), spans };
}

export function buildBoard(commitments: BoardCommitment[], lifeItems: LifeItem[], patches: BoardPatch[], now: Date): Board {
  const auto = autoItems(commitments, lifeItems, now);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    return localDay(d);
  });
  const { items, hidden, spans } = applyPatches(auto.items, patches, days);
  return {
    now: now.toISOString(),
    today: days[0]!,
    days: days.map((date) => ({
      date,
      workday: WORKDAYS.includes(weekdayOf(date)),
      items: items.filter((i) => i.day === date).sort((a, b) => a.at.localeCompare(b.at)),
    })),
    spans,
    hidden,
    noData: auto.noData,
  };
}

/** What the concierge reads before it decides: every item with its key, so a patch can name it. Tool result only (I12). */
export function renderBoard(b: Board): string {
  const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const out: string[] = [];
  for (const d of b.days) {
    out.push(`${d.date} ${W[weekdayOf(d.date)]}${d.date === b.today ? ' (today)' : ''}${d.workday ? '' : ' · off'}`);
    if (!d.items.length) out.push('  (nothing)');
    for (const i of d.items) {
      const tag = i.source === 'day' ? 'DAY' : i.adjusted ? 'auto*' : 'auto';
      out.push(`  ${i.at}${i.until ? `–${i.until}` : ''} [${i.kind}${i.tier ? ` t${i.tier}` : ''}] ${i.label}  · ${tag} key=${i.key}${i.adjusted ? ` (patch #${i.adjusted.patch}: ${i.adjusted.reason})` : ''}`);
    }
  }
  if (b.spans.length) {
    out.push('', 'SESSIONS (tier 3):');
    for (const s of b.spans) out.push(`  ${s.from} → ${s.to} ${s.label} · patch #${s.patch}`);
  }
  if (b.hidden.length) {
    out.push('', 'HIDDEN by you:');
    for (const h of b.hidden) out.push(`  ${h.item.day} ${h.item.at} ${h.item.label} · key=${h.item.key} · patch #${h.patch}: ${h.reason}`);
  }
  if (b.noData.length) out.push('', `NEVER LOGGED (not placed): ${b.noData.join(', ')}`);
  return out.join('\n');
}

/** A day as the concierge says it: YYYY-MM-DD, today, tomorrow, or a weekday name (the next one, today included). */
export function parseBoardDay(s: string, now: Date): string | undefined {
  const t = s.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(now);
  if (t === 'today') return localDay(d);
  if (t === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    return localDay(d);
  }
  const idx = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(t.slice(0, 3));
  if (idx === -1) return undefined;
  d.setDate(d.getDate() + ((idx - d.getDay() + 7) % 7));
  return localDay(d);
}

export function validTime(s: string | undefined): boolean {
  return s === undefined || /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
