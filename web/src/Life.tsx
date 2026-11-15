import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * THE LIFE PAGE — the week as the day session wants Mehdi to see it
 * (proposal #7, reshaped by his feedback on 2026-11-13).
 *
 * Today is one dominant line, left to right; items sit on it at their time,
 * saying what is coming next. The other six days are thinner lines with fewer
 * labels. What is on the line is the BOARD: an automatic layer (dated
 * commitments, chores coming due, the work block) that is always there, with
 * the day session's patches over it — added, moved, relabelled, hidden — each
 * carrying a reason you can hover. Hidden items are listed, never dropped.
 *
 * Tier 3 — sessions (a trip, an paperwork step) — shape the days without
 * sitting on an hour, so they are bullets beside the line, and the days they
 * cover carry a mark.
 *
 * LOOK, DON'T EDIT. Logging and planning stay sentences to the bot; the
 * retired quest system recorded why (making the schedule became the task).
 */

type Kind = 'appointment' | 'work' | 'chore' | 'reminder' | 'note';
interface BoardItem {
  key: string;
  day: string;
  at: string;
  until?: string;
  kind: Kind;
  label: string;
  ref?: string;
  tier?: 1 | 2;
  source: 'auto' | 'day';
  why: string;
  adjusted?: { patch: number; reason: string };
}
interface Board {
  now: string;
  today: string;
  days: Array<{ date: string; workday: boolean; items: BoardItem[] }>;
  spans: Array<{ key: string; label: string; from: string; to: string; why: string; patch: number }>;
  hidden: Array<{ item: BoardItem; reason: string; patch: number }>;
  noData: string[];
}
interface Item {
  id: string;
  label: string;
  tier: 1 | 2;
  days: number;
  weight: number;
  last: string | null;
  fresh: number | null;
  due: string | null;
  overdue: boolean;
}
interface LifeData {
  now: string;
  target: number;
  threshold: number;
  health: number | null;
  coverage: number;
  items: Item[];
  events: Array<{ item: string; at: string; source: string }>;
  board: Board;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fromDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
const dayStart = (d: Date, off = 0) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + off);
  return x;
};
const ago = (iso: string, now: Date) => {
  const h = (now.getTime() - new Date(iso).getTime()) / 3_600_000;
  return h < 1 ? 'just now' : h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};
const minutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h! * 60 + m!;
};

/** The visible hour window: 07:00–24:00, widened if something sits outside it. */
function windowFor(items: BoardItem[]): [number, number] {
  let lo = 7 * 60;
  let hi = 24 * 60;
  for (const i of items) {
    lo = Math.min(lo, Math.floor(minutes(i.at) / 60) * 60);
    if (i.until) hi = Math.max(hi, minutes(i.until));
  }
  return [lo, hi];
}

interface Tip {
  x: number;
  y: number;
  body: ReactNode;
}
type Hover = { show: (e: React.MouseEvent, body: ReactNode) => void; hide: () => void };

export function Life({ tick = 0 }: { tick?: number }) {
  const [data, setData] = useState<LifeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/life')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: LifeData) => alive && (setData(d), setErr(null)))
        .catch((e: Error) => alive && setErr(e.message));
    load();
    // A fallback only: life and board writes arrive as 'life' pulses on the
    // Atlas stream and bump `tick`, so a change shows within a second.
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tick]);

  const show = (e: React.MouseEvent, body: ReactNode) => setTip({ x: e.clientX, y: e.clientY, body });
  const hide = () => setTip(null);

  if (err) return <div className="life"><p className="life-empty">Could not load /api/life — {err}</p></div>;
  if (!data) return <div className="life"><p className="life-empty">loading…</p></div>;
  const b = data.board;
  const now = new Date(b.now);

  return (
    <div className="life" onMouseLeave={hide}>
      <header className="life-head">
        <div>
          <h1>Life</h1>
          <p className="muted">
            What is coming, as the day session sees it.{' '}
            <span className="legend">
              <i className="mk auto" /> automatic <i className="mk day" /> placed by the day <i className="mk auto fixed" /> fixed by the day
            </span>
          </p>
        </div>
      </header>

      {/* One row of widgets, then the lines at full width. The row is where
          more state lands later — sensors around the house, the IoT layer —
          without ever narrowing the timeline. */}
      <section className="life-widgets">
        <Sessions board={b} />
        <House data={data} />
      </section>

      <section className="life-top">
        <DayLine day={b.days[0]!} board={b} now={now} big show={show} hide={hide} />
      </section>

      <section className="life-week">
        {b.days.slice(1).map((d) => (
          <DayLine key={d.date} day={d} board={b} now={now} show={show} hide={hide} />
        ))}
      </section>

      {b.hidden.length > 0 && (
        <details className="life-hidden">
          <summary>hidden by the day session ({b.hidden.length})</summary>
          <ul>
            {b.hidden.map((h) => (
              <li key={h.patch}>
                <span className="muted">{WEEKDAY[fromDate(h.item.day).getDay()]} {h.item.at}</span> {h.item.label} — <span className="muted">{h.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Behind data={data} show={show} hide={hide} />

      {tip && (
        <div className="life-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          {tip.body}
        </div>
      )}
    </div>
  );
}

/** Greedy label rows: each label goes in the first row where it does not overlap the one before it. */
function placeLabels(items: BoardItem[], x: (i: BoardItem) => number, rows: number): Array<number | null> {
  const ends: number[] = Array(rows).fill(-Infinity);
  return items.map((i) => {
    const left = x(i) - 6;
    const width = i.label.length * 6.6 + 54;
    for (let r = 0; r < rows; r++) {
      if (left > ends[r]! + 8) {
        ends[r] = left + width;
        return r;
      }
    }
    return null;
  });
}

function DayLine({ day, board, now, big, show, hide }: { day: Board['days'][number]; board: Board; now: Date; big?: boolean } & Hover) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const date = fromDate(day.date);
  const isToday = day.date === board.today;
  const [lo, hi] = windowFor(board.days.flatMap((d) => d.items));
  const xOf = (t: string) => ((Math.min(Math.max(minutes(t), lo), hi) - lo) / (hi - lo)) * w;
  const points = day.items.filter((i) => i.kind !== 'work');
  const work = day.items.filter((i) => i.kind === 'work');
  const rows = big ? 3 : 1;
  const lanes = placeLabels(points, (i) => xOf(i.at), rows);
  const nowM = now.getHours() * 60 + now.getMinutes();
  const spans = board.spans.filter((s) => s.from <= day.date && s.to >= day.date);
  const ticks = Array.from({ length: Math.floor((hi - lo) / 180) + 1 }, (_, k) => lo + k * 180);
  const base = big ? 34 : 16;

  const tipFor = (i: BoardItem) => (
    <>
      <b>{i.label}</b>
      <br />
      {i.at}
      {i.until ? `–${i.until}` : ''} · {i.kind}
      {i.tier ? ` · tier ${i.tier}` : ''}
      <br />
      <span className="muted">
        {i.source === 'day' ? 'placed by the day: ' : 'automatic: '}
        {i.why}
      </span>
      {i.adjusted && (
        <>
          <br />
          <span className="muted">fixed by the day: {i.adjusted.reason}</span>
        </>
      )}
    </>
  );

  return (
    <div className={`dayline ${big ? 'big' : ''}`}>
      <div className="dl-head">
        <span className="dl-date">
          {isToday ? 'Today' : WEEKDAY[date.getDay()]}{' '}
          <span className="muted">{isToday ? `${WEEKDAY[date.getDay()]} ${date.getDate()}` : date.getDate()}</span>
        </span>
        {!day.workday && <span className="muted small">off</span>}
        {spans.map((s) => (
          <span
            key={s.key}
            className="dl-span"
            onMouseMove={(e) => show(e, (<><b>{s.label}</b><br />{s.from} → {s.to}<br /><span className="muted">{s.why}</span></>))}
            onMouseLeave={hide}
          >
            <i className="key session" />
            {s.label}
          </span>
        ))}
      </div>
      <div className="dl-body" ref={ref} style={{ height: base + rows * 24 + (big ? 20 : 4) }}>
        <div className="line" style={{ bottom: base }} />
        {work.map((i) => (
          <div
            key={i.key}
            className={`workseg ${i.adjusted ? 'fixed' : ''}`}
            style={{ left: xOf(i.at), width: Math.max(2, xOf(i.until ?? i.at) - xOf(i.at)), bottom: base - (big ? 5 : 3) }}
            onMouseMove={(e) => show(e, tipFor(i))}
            onMouseLeave={hide}
          >
            {big && <span>work</span>}
          </div>
        ))}
        {points.map((i, k) => {
          const lane = lanes[k];
          const past = isToday && minutes(i.at) < nowM;
          const cls = `mk ${i.source === 'day' ? 'day' : 'auto'} ${i.adjusted ? 'fixed' : ''} k-${i.kind}${i.tier ? ` t${i.tier}` : ''}`;
          return (
            <div key={i.key} className={`pt ${past ? 'past' : ''}`} style={{ left: xOf(i.at), bottom: base }} onMouseMove={(e) => show(e, tipFor(i))} onMouseLeave={hide}>
              {lane !== null && <span className="stem" style={{ height: 10 + lane * 24 }} />}
              {lane !== null && (
                <span className="lbl" style={{ bottom: 12 + lane * 24 }}>
                  <span className="lbl-t">{i.at}</span> {i.label}
                </span>
              )}
              <i className={cls} />
            </div>
          );
        })}
        {isToday && nowM >= lo && nowM <= hi && (
          <div className="nowmk" style={{ left: ((nowM - lo) / (hi - lo)) * w, bottom: base - 14 }}>
            <span>now {hhmm(now)}</span>
          </div>
        )}
        {big &&
          ticks.map((t) => (
            <span key={t} className="hr" style={{ left: ((t - lo) / (hi - lo)) * w }}>
              {pad(Math.floor(t / 60) % 24)}
            </span>
          ))}
      </div>
    </div>
  );
}

function Sessions({ board }: { board: Board }) {
  return (
    <div className="tile">
      <span className="k">sessions · tier 3</span>
      {board.spans.length === 0 ? (
        <span className="muted small">none open. A trip or a move the day session opens shows here.</span>
      ) : (
        <ul className="bullets">
          {board.spans.map((s) => (
            <li key={s.key} title={s.why}>
              <i className="key session" />
              <b>{s.label}</b>
              <span className="muted small">
                {' '}
                {WEEKDAY[fromDate(s.from).getDay()]} {fromDate(s.from).getDate()} → {WEEKDAY[fromDate(s.to).getDay()]} {fromDate(s.to).getDate()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function House({ data }: { data: LifeData }) {
  const low = data.health !== null && data.health < data.threshold;
  return (
    <div className="tile">
      <span className="k">house health</span>
      {data.health === null ? (
        <span className="v muted">no data yet</span>
      ) : (
        <>
          <span className="v">
            {pct(data.health)}
            {low && (
              <span className="status crit">
                <i className="ico">⚠</i> below {pct(data.threshold)}
              </span>
            )}
          </span>
          <div className="life-meter" role="img" aria-label={`house health ${pct(data.health)}`}>
            <div className={`fill ${low ? 'low' : ''}`} style={{ width: `${data.health * 100}%` }} />
            <div className="tick" style={{ left: `${data.threshold * 100}%` }} />
            <div className="tick target" style={{ left: `${data.target * 100}%` }} />
          </div>
        </>
      )}
      {data.board.noData.length > 0 && <span className="muted small">never logged: {data.board.noData.join(', ')}</span>}
    </div>
  );
}

function Behind({ data, show, hide }: { data: LifeData } & Hover) {
  const now = new Date(data.now);
  const cols = Array.from({ length: 7 }, (_, k) => dayStart(now, k - 7));
  const cell = (id: string, d: Date) => {
    const e = dayStart(d, 1).getTime();
    return data.events.filter((x) => x.item === id && new Date(x.at).getTime() >= d.getTime() && new Date(x.at).getTime() < e);
  };
  return (
    <section className="life-behind">
      <h2>
        Last week <span className="muted">done, by day</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th />
            {cols.map((d) => (
              <th key={d.toISOString()}>
                {WEEKDAY[d.getDay()]} {d.getDate()}
              </th>
            ))}
            <th className="muted">last</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((i) => (
            <tr key={i.id}>
              <th>
                <i className={`dot t${i.tier}`} /> {i.label}
              </th>
              {cols.map((d) => {
                const hits = cell(i.id, d);
                return (
                  <td
                    key={d.toISOString()}
                    onMouseMove={(e) =>
                      hits.length ? show(e, (<><b>{i.label}</b><br />{hits.map((h) => `${hhmm(new Date(h.at))} (${h.source})`).join(' · ')}</>)) : hide()
                    }
                    onMouseLeave={hide}
                  >
                    {hits.length > 0 && (
                      <>
                        <i className={`dot t${i.tier}`} />
                        {hits.length > 1 && <span className="n">{hits.length}</span>}
                      </>
                    )}
                  </td>
                );
              })}
              <td className="muted small last">{i.last ? ago(i.last, now) : 'never'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
