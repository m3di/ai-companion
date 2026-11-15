/**
 * LIFE UPKEEP — design proposal #7 (accepted 2026-11-13, narrowed to step 1).
 *
 * Tier 1 is the daily basics (a CADENCE: due once an item is that many days
 * old); tier 2 keeps the house ready for tier 1 (a HALF-LIFE: freshness decays
 * as 0.5^(age/half-life), and house health is the weighted mean). Everything
 * here is DERIVED on read from `life_items` + `life_log` — nothing computed is
 * ever stored (I2). An item never logged is left out of the score rather than
 * counted as zero: on day one that would read "house at 0 %", and the first
 * week would be noise the concierge has to explain away.
 */

import { fmtLocal, toUtcDb } from './commitments.js';
import type { LifeItem } from './db.js';

const DAY_MS = 86_400_000;

export function ageDays(lastUtc: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(`${lastUtc.replace(' ', 'T')}Z`).getTime()) / DAY_MS);
}

export function freshness(age: number, halfLife: number): number {
  return Math.pow(0.5, age / halfLife);
}

export interface Tier2Line {
  item: LifeItem;
  /** null when never logged — excluded from health. */
  fresh: number | null;
}

export interface HouseHealth {
  /** null when no tier-2 item has ever been logged. */
  health: number | null;
  lines: Tier2Line[];
  /** Weight of the logged items over all tier-2 weight — how much of the house the score speaks for. */
  coverage: number;
}

export function houseHealth(items: LifeItem[], now: Date): HouseHealth {
  const t2 = items.filter((i) => i.tier === 2);
  const lines = t2.map((item) => ({ item, fresh: item.last_at ? freshness(ageDays(item.last_at, now), item.days) : null }));
  const known = lines.filter((l) => l.fresh !== null && l.item.weight > 0);
  const w = known.reduce((s, l) => s + l.item.weight, 0);
  const all = t2.reduce((s, i) => s + i.weight, 0);
  return {
    health: w > 0 ? known.reduce((s, l) => s + l.item.weight * l.fresh!, 0) / w : null,
    lines,
    coverage: all > 0 ? w / all : 0,
  };
}

export interface Tier1Line {
  item: LifeItem;
  /** Done inside the current cadence window. */
  done: boolean;
  /** Days since last done, or null if never. */
  age: number | null;
}

export function tier1(items: LifeItem[], now: Date): Tier1Line[] {
  return items
    .filter((i) => i.tier === 1)
    .map((item) => {
      const age = item.last_at ? ageDays(item.last_at, now) : null;
      return { item, age, done: age !== null && age < item.days };
    });
}

/** Match what was said ("vacuumed", "did the dishes") to one item: id, label, then aka, whole-word. */
export function resolveItem(items: LifeItem[], said: string): LifeItem | undefined {
  const s = said.trim().toLowerCase();
  const exact = items.find((i) => i.id === s || i.label.toLowerCase() === s || i.aka.some((a) => a.toLowerCase() === s));
  if (exact) return exact;
  const word = (needle: string) => new RegExp(`\\b${needle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s);
  const hits = items.filter((i) => word(i.id) || i.aka.some((a) => word(a)));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Parse WHEN something was done, in local time, into UTC db form. Past only:
 * empty → now; "-2h" / "-30m" / "-1d"; "yesterday" (same clock time, a day
 * back); "HH:mm" (today, or yesterday if that is still ahead); "YYYY-MM-DD"
 * (noon); "YYYY-MM-DD HH:mm". Undefined if unparseable or in the future.
 */
export function parseDoneWhen(input: string | undefined, now: Date): string | undefined {
  const s = (input ?? '').trim().toLowerCase();
  let d: Date | undefined;
  if (!s || s === 'now' || s === 'just now') d = now;
  else if (s === 'yesterday') d = new Date(now.getTime() - DAY_MS);
  else {
    const rel = s.match(/^-(\d+)\s*(m|min|h|hr|d)$/);
    const hm = s.match(/^(\d{1,2}):(\d{2})$/);
    const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (rel) {
      const n = Number(rel[1]);
      const u = rel[2]![0];
      d = new Date(now.getTime() - n * (u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : DAY_MS));
    } else if (hm) {
      d = new Date(now);
      d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
      if (d > now) d = new Date(d.getTime() - DAY_MS);
    } else if (ymd) {
      d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), ymd[4] ? Number(ymd[4]) : 12, ymd[5] ? Number(ymd[5]) : 0);
    }
  }
  if (!d || Number.isNaN(d.getTime()) || d.getTime() > now.getTime() + 60_000) return undefined;
  return toUtcDb(d);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const ago = (age: number) => (age < 1 ? `${Math.round(age * 24)}h ago` : `${Math.round(age)}d ago`);

/** The concierge's read: tier 1 for today, tier 2 with the gauge. Plain text, for a tool result (I12). */
export function renderLifeState(items: LifeItem[], params: { target: number; threshold: number }, now: Date): string {
  const t1 = tier1(items, now);
  const h = houseHealth(items, now);
  const out: string[] = ['TIER 1 — daily basics'];
  for (const l of t1) {
    const cad = l.item.days === 1 ? 'daily' : `every ${l.item.days}d`;
    out.push(
      `  ${l.done ? '✓' : '·'} ${l.item.id} (${cad})${l.age === null ? ' — never logged' : ` — last ${ago(l.age)}${!l.done ? `, DUE` : ''}`}`,
    );
  }
  const gauge =
    h.health === null
      ? 'no data yet — nothing in tier 2 has been logged'
      : `${pct(h.health)} (target ${pct(params.target)}, act below ${pct(params.threshold)}${h.health < params.threshold ? ' — BELOW THRESHOLD' : ''}; covers ${pct(h.coverage)} of the house by weight)`;
  out.push('', `TIER 2 — house health: ${gauge}`);
  const sorted = [...h.lines].sort((a, b) => (a.fresh ?? -1) - (b.fresh ?? -1));
  for (const l of sorted) {
    out.push(
      `  ${l.item.id} (half-life ${l.item.days}d, w${l.item.weight})` +
        (l.fresh === null ? ' — never logged' : ` — ${pct(l.fresh)} fresh, last ${fmtLocal(l.item.last_at!)}`),
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// THE VIEW MODEL — what the Atlas's /life page draws (proposal #7, visual
// first: Mehdi, 2026-11-13 — "it's the other end of the whole design"). It is
// a RENDER over the same tables and the same maths as `lifeState`, so the
// concierge's number and the picture cannot disagree (I1/I2).
// ---------------------------------------------------------------------------

/** Work week Sun–Thu (Fri & Sat off), as the morning brief has always had it. */
export const WORKDAYS = [0, 1, 2, 3, 4];
/** The fixed serious-work block, local hours. Tunable later; a constant until he asks. */
export const WORK_BLOCK = { start: 10, end: 18 };

export interface LifeEventOut {
  item: string;
  /** ISO, UTC. */
  at: string;
  source: string;
}

export interface LifeSession {
  label: string;
  /** Travel opens two at once: the empty home, and wherever he is. */
  kind: 'absence' | 'presence';
  from: string;
  to: string;
}

export interface LifeViewItem {
  id: string;
  label: string;
  tier: 1 | 2;
  days: number;
  weight: number;
  last: string | null;
  /** Tier 2 only; null when never logged. */
  fresh: number | null;
  /** When it next asks for attention (ISO): tier 1 at its cadence, tier 2 at one half-life. */
  due: string | null;
  overdue: boolean;
}

export interface LifeView {
  now: string;
  target: number;
  threshold: number;
  work: { start: number; end: number; days: number[] };
  health: number | null;
  coverage: number;
  items: LifeViewItem[];
  /** Last 7 local days plus today, oldest first. */
  events: LifeEventOut[];
  /** Today and the next six days: projected health if nothing is done, and what falls due. */
  days: Array<{ date: string; health: number | null; due: string[] }>;
  sessions: LifeSession[];
}

const iso = (utcDb: string) => `${utcDb.replace(' ', 'T')}Z`;

function startOfLocalDay(d: Date, offsetDays = 0): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + offsetDays);
  return x;
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * When an item next asks: one cadence for tier 1, one HALF-LIFE for tier 2
 * (freshness 50%). Never logged → now.
 *
 * Not "when the item crosses the house threshold": the first cut did that, and
 * at 75% it put vacuuming due every 2.9 days and the trash every 1.7 — nearly
 * everything overdue all the time, the 95%-target failure one level down. The
 * threshold is a judgement about the HOUSE (the weighted mean); a single chore
 * is due when half its freshness is gone, which is what a half-life means.
 */
export function nextDue(item: LifeItem, now: Date): Date {
  if (!item.last_at) return now;
  return new Date(new Date(iso(item.last_at)).getTime() + item.days * DAY_MS);
}

export function buildLifeView(
  items: LifeItem[],
  events: Array<{ item_id: string; at: string; source: string }>,
  params: { target: number; threshold: number },
  now: Date,
  opts: { sessions?: LifeSession[] } = {},
): LifeView {
  const h = houseHealth(items, now);
  const viewItems: LifeViewItem[] = items.map((i) => {
    const due = nextDue(i, now);
    return {
      id: i.id,
      label: i.label,
      tier: i.tier,
      days: i.days,
      weight: i.weight,
      last: i.last_at ? iso(i.last_at) : null,
      fresh: i.tier === 2 && i.last_at ? freshness(ageDays(i.last_at, now), i.days) : null,
      due: due.toISOString(),
      overdue: due.getTime() <= now.getTime(),
    };
  });
  const days = Array.from({ length: 7 }, (_, d) => {
    const start = startOfLocalDay(now, d);
    const end = startOfLocalDay(now, d + 1);
    // Daily basics are implicit on every day; a reminder dot is for what is NOT
    // routine — a tier-2 chore crossing the threshold, a haircut coming round.
    const due = items
      .filter((i) => !(i.tier === 1 && i.days <= 1))
      .filter((i) => {
        const t = nextDue(i, now).getTime();
        return d === 0 ? t < end.getTime() : t >= start.getTime() && t < end.getTime();
      })
      .map((i) => i.id);
    return { date: localDate(start), health: houseHealth(items, d === 0 ? now : end).health, due };
  });
  return {
    now: now.toISOString(),
    target: params.target,
    threshold: params.threshold,
    work: { ...WORK_BLOCK, days: WORKDAYS },
    health: h.health,
    coverage: h.coverage,
    items: viewItems,
    events: events.map((e) => ({ item: e.item_id, at: iso(e.at), source: e.source })),
    days,
    sessions: opts.sessions ?? [],
  };
}
