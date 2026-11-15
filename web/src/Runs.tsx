import { useEffect, useState } from 'react';
import { useTurn } from './live';
import { LOCK, type Privacy } from './privacy';

/**
 * THE RUN LEDGER — what each attempt asked for, and what it actually changed.
 *
 * The graph shows the RESULT of every edit ever made. It cannot show the thing
 * an operator most needs to judge: whether a particular instruction was a good
 * instruction. Nine writes are nine rows you can review one at a time; *"this
 * prompt, in linter mode, produced those nine and touched these six nodes"* is
 * a judgement about the prompt — and rewording the prompt is how the editing
 * gets better, not reviewing the edits.
 *
 * Open, it takes the left third and the graph becomes EVIDENCE rather than the
 * subject: everything greys out except the run's footprint. That inversion is
 * the whole design. You are no longer looking at the graph and wondering what
 * happened to it; you are reading an attempt and seeing where it landed.
 *
 * Hover a row to see a run's reach. Expand it to hold that reach while you read
 * the writes. Hover a node to pick it out in green; click it to open it. The
 * camera is never moved and the layout never re-runs — a person who arranged
 * the view keeps it, which is the same rule the rest of the Atlas lives by.
 */

interface Run {
  id: number;
  kind: string;
  trigger: string;
  prompt: string;
  codes: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  writes: Array<{ id: number; op: string; entity_id: string; reason: string }>;
  touched: string[];
  read: string[];
}

export type Focus = { active: string[]; accent: string | null } | null;

const OP_COLOR: Record<string, string> = {
  'correct-fact': '#e8a33d',
  'drop-fact': '#c96a6a',
  'add-fact': '#6aa84f',
  mint: '#6fa8dc',
  goal: '#d4b23a',
  dormant: '#7f8fa6',
  retire: '#c96a6a',
  move: '#b07ad6',
  edge: '#5fbfb0',
  'drop-edge': '#8a8a8a',
};

export function Runs({
  shown,
  onClose,
  onEntity,
  onFocus,
  onWidth,
  onModeChanged,
  privacy,
}: {
  /** Owned by the ROUTE now — /runs is the ledger, and open-ness is not a
   *  preference the panel keeps to itself. */
  shown: boolean;
  onClose: () => void;
  onEntity: (id: string) => void;
  onFocus: (f: Focus) => void;
  /** How much left edge this panel is taking, so the canvas can yield it. */
  onWidth: (px: number) => void;
  /** Applying a plan can sedate the bot, so the chrome must re-read the state. */
  onModeChanged: () => void;
  privacy: Privacy;
}) {
  /**
   * The turn being watched, if one is running.
   *
   * Held as an id rather than an object because `useTurn` owns the subscription
   * — the panel says WHICH turn, and the hook says what it is doing. Cleared
   * only when a new one starts, so the last answer stays readable after it
   * lands rather than vanishing at the moment it becomes useful.
   */
  const [liveRunId, setLiveRunId] = useState<number | null>(null);
  const live = useTurn(liveRunId);
  const [runs, setRuns] = useState<Run[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [accent, setAccent] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<'live' | 'dreaming' | 'debug'>('live');

  // ASKING is free; WRITING needs the bot sedated. The controls have to know
  // which, because an input that looks live and 409s on submit is worse than
  // one that says plainly what it can and cannot do.
  useEffect(() => {
    if (!shown) return;
    const load = () => fetch('/api/mode').then((r) => r.json()).then((m) => setMode(m.mode)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [shown]);

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.error) setNotice(j.error);
      return j;
    } catch (e) {
      setNotice(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  // Report the width the canvas must give up. Measured against the same rule
  // as the stylesheet rather than hard-coded twice — and re-measured on resize,
  // because 34vw is a different number on a different window.
  useEffect(() => {
    if (!shown) {
      onWidth(0);
      return;
    }
    const measure = () => onWidth(Math.min(430, window.innerWidth * 0.34));
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      onWidth(0);
    };
  }, [shown, onWidth]);

  useEffect(() => {
    if (!shown) return;
    let alive = true;
    const load = () =>
      fetch('/api/runs?limit=25')
        .then((r) => r.json())
        .then((r: Run[]) => alive && setRuns(r))
        .catch(() => {});
    load();
    // Polled, not streamed: a ledger changes a few times an hour at most, and
    // an SSE channel for it would be machinery in front of a list.
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // `live?.status` is in here so a landed turn shows up in the ledger at once
    // rather than up to five seconds later — the row is the durable record and
    // the gap between the two reads as a bug.
  }, [shown, live?.status]);

  /**
   * WHAT THE GRAPH SHOWS — one ladder, highest match wins.
   *
   *   1. HOVER — the transient probe. Always wins, always ends with the
   *      pointer, so glancing at another attempt never costs you your place.
   *   2. THE OPEN TURN — the conversation you are in. It holds the graph from
   *      the moment you ask until you close the card, which is the fix for the
   *      thing that made this feel broken: the footprint appeared while the
   *      agent worked and then vanished the instant it finished, so the answer
   *      arrived with an empty graph beside it and the only way back was to go
   *      hunting for the row it had just written.
   *   3. EXPANSION — the row you opened to read. The fallback once the turn's
   *      card is dismissed.
   *
   * Expansion sits BELOW the open turn deliberately: while you are in a
   * conversation, opening an old row is reading, not switching. Close the card
   * and expansion takes the graph back.
   */
  useEffect(() => {
    if (!shown) {
      onFocus(null);
      return;
    }
    const byId = (id: number | null) => (id === null ? undefined : runs.find((r) => r.id === id));

    const under = byId(hovered);
    if (under) {
      onFocus({ active: under.touched, accent });
      return;
    }
    if (live) {
      // Once it lands, the ledger's row is the authoritative footprint — it
      // counts every entity the turn's calls touched, where `reached` only sees
      // ids that appeared in tool ARGUMENTS. While it runs, `reached` is all
      // there is, and it grows call by call.
      const settled = byId(live.runId);
      onFocus({ active: settled?.touched.length ? settled.touched : live.reached, accent });
      return;
    }
    const open = byId(expanded);
    onFocus(open ? { active: open.touched, accent } : null);
  }, [shown, hovered, expanded, accent, runs, onFocus, live]);

  // Leaving the panel entirely must clear the preview, or the graph stays lit
  // for a row nobody is pointing at any more.
  useEffect(() => () => onFocus(null), [onFocus]);

  // No tab of its own: the way in is the `runs` button in the top bar, which
  // is where every other route switch lives.
  if (!shown) return null;

  return (
    <div className="runs-panel" onMouseLeave={() => setHovered(null)}>
      <div className="runs-head">
        <span>RUNS — what each attempt asked, and did</span>
        <button onClick={onClose} title="Close">
          ×
        </button>
      </div>

      {/* NEW RUN. The instruction is the thing the whole ledger exists to make
          reviewable, so composing one belongs here, above the record of every
          previous one — you write the next prompt while reading what the last
          one did. */}
      <div className="runs-new">
        <textarea
          value={prompt}
          disabled={mode === 'dreaming' || busy}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            mode === 'debug'
              ? 'Tell the gardener what to do with the graph…'
              : mode === 'dreaming'
                ? 'A rewrite pass has the machine — the night is folding the day. Nothing may touch memory until it lands.'
                : // Live is not a locked door any more. Asking is free; only
                  // changing costs the day, and the agent proposes rather than
                  // writes until the bot is sedated.
                  'Ask about the graph — read-only while the bot is live…'
          }
          rows={3}
        />
        <div className="runs-new-actions">
          <button
            disabled={mode === 'dreaming' || busy || !prompt.trim()}
            onClick={async () => {
              const asked = prompt.trim();
              setPrompt('');
              setNotice(null);
              // Returns as soon as the run EXISTS, not when the turn ends — the
              // answer arrives through the stream below, as it is written.
              const t = await post('/api/agent/ask', { prompt: asked });
              if (t?.runId) setLiveRunId(t.runId);
              else if (!t?.error) setPrompt(asked);
            }}
          >
            {live?.status === 'running' ? 'working…' : 'ask'}
          </button>
          <button
            className="ghost"
            disabled={mode === 'dreaming' || busy}
            title="Forget the conversation so far; the next prompt pays for a fresh brief"
            onClick={async () => {
              await post('/api/agent/reset', {});
              setNotice('Session cleared — the next prompt starts fresh.');
            }}
          >
            new session
          </button>
        </div>
        {mode === 'live' && (
          <div className="runs-readonly">
            read-only — it can look at anything and change nothing. A plan it offers can be applied from here.
          </div>
        )}
        {notice && <div className="runs-notice">{notice}</div>}
      </div>

      {/* THE TURN, WHILE IT HAPPENS.
          Above the ledger because it is the present tense: what the agent is
          reaching for and what it is saying, both as they land. The steps sit
          above the answer because they arrive first — the agent reads for
          twenty seconds before it writes a word, and those twenty seconds used
          to be a spinner. */}
      {live && (
        <div className={`turn t-${live.status}`}>
          <div className="turn-head">
            <span>
              <span className="chev">#{live.runId}</span>{' '}
              {live.status === 'running' ? 'working' : live.status === 'error' ? 'failed' : 'done'}
              {live.costUsd ? ` · $${live.costUsd.toFixed(3)}` : ''}
            </span>
            {live.status === 'running' ? (
              // Watching a turn is what makes stopping one necessary: the value
              // of seeing it reach for the wrong node on step two is being able
              // to say so before step nine.
              <button className="ghost" onClick={() => post('/api/agent/interrupt', {})}>
                stop
              </button>
            ) : (
              <button
                className="ghost"
                // It is not only dismissing a card: this turn is HOLDING the
                // graph, and closing is how you hand it back to the ledger.
                title="Close — the graph goes back to the ledger"
                onClick={() => setLiveRunId(null)}
              >
                ×
              </button>
            )}
          </div>

          {!!live.steps.length && (
            <div className="turn-steps">
              {live.steps.map((s, i) => (
                <div
                  key={i}
                  className="turn-step"
                  onMouseEnter={() => setAccent(s.refs[0] ?? null)}
                  onMouseLeave={() => setAccent(null)}
                >
                  {s.step}
                </div>
              ))}
            </div>
          )}

          {live.text && <div className="turn-text">{live.text}</div>}

          {/* THE PLAN, AND THE TWO ANSWERS TO IT.
              This replaces typing "yes please do that" — a message that carried
              no information, since the plan was in the agent's context one turn
              earlier and the only thing it added was consent. Consent is a
              click, and the click is recorded. */}
          {live.proposal && (
            <div className="proposal">
              <div className="proposal-head">proposal #{live.proposal.id}</div>
              <div className="proposal-summary">{live.proposal.summary}</div>
              <ul className="proposal-steps">
                {live.proposal.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <div className="proposal-actions">
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={async () => {
                    await post('/api/proposal/decide', { id: live.proposal!.id, approve: false });
                    setLiveRunId(null);
                  }}
                >
                  discard
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    // Approving OPENS A NEW TURN, which is what we then watch:
                    // the agent carrying out its own plan through the normal
                    // write path, node by node, revertible like anything else.
                    const r = await post('/api/proposal/decide', { id: live.proposal!.id, approve: true });
                    if (r?.runId) setLiveRunId(r.runId);
                    // Applying may have sedated the bot; the chip and the
                    // composer both key off mode, so they have to be told.
                    if (r?.sedated) onModeChanged();
                  }}
                >
                  {mode === 'debug' ? 'apply' : 'sedate & apply'}
                </button>
              </div>
            </div>
          )}
          {live.status === 'running' && !live.text && <div className="turn-wait">reading the graph…</div>}
          {live.error && <div className="turn-error">{live.error}</div>}
        </div>
      )}

      <div className="runs-list">
        {!runs.length && <div className="runs-empty">No runs yet. A gardening pass records one.</div>}
        {runs.map((r) => {
          // A run that touched a private domain loses its prompt and its
          // reasons — those are written for a human and name the work directly.
          // The row stays: that an attempt happened is not the secret.
          const hidden = r.touched.some(privacy.isPrivate);
          const isOpen = expanded === r.id;
          return (
            <div key={r.id} className={`run${r.ended_at ? '' : ' run-live'}${isOpen ? ' run-open' : ''}`}>
              {/* ONE hit target for the whole row, with a chevron that says so.
                  Splitting the click between a header strip and the prompt text
                  left no way to tell what was clickable — the row is the
                  control, so the whole row takes the click and shows it. */}
              <button
                className="run-row"
                onMouseEnter={() => setHovered(r.id)}
                onClick={() => {
                  setExpanded(isOpen ? null : r.id);
                  setAccent(null);
                }}
                aria-expanded={isOpen}
              >
                <span className="chev">{isOpen ? '▾' : '▸'}</span>
                {/* The prompt is TEXT, not a label: it is the thing you copy
                    into the next attempt, so it must be selectable. Making the
                    whole row a button took that away — the chevron and the meta
                    line carry the click, the prompt does not. */}
                <span className="run-main">
                  <span className="run-meta">
                    <span className="run-id">#{r.id}</span>
                    <span className={`run-trigger t-${r.trigger}`}>{r.trigger}</span>
                    <span className="run-count" title={`${r.touched.length} node(s) touched`}>
                      {r.writes.length}w · {r.touched.length}n
                    </span>
                  </span>
                </span>
              </button>
              <div
                className="run-prompt"
                onMouseEnter={() => setHovered(r.id)}
                onDoubleClick={() => {
                  setExpanded(isOpen ? null : r.id);
                  setAccent(null);
                }}
                title="Select to copy. Double-click to expand."
              >
                {hidden ? LOCK : r.prompt}
              </div>

              {isOpen && !hidden && (
                <div className="run-body">
                  {r.writes.map((w) => (
                    <div
                      key={w.id}
                      className="run-write"
                      onMouseEnter={() => setAccent(w.entity_id)}
                      onMouseLeave={() => setAccent(null)}
                    >
                      <div className="run-write-top">
                        <span className="op" style={{ color: OP_COLOR[w.op] ?? '#999' }}>
                          {w.op}
                        </span>
                        <button className="node" onClick={() => onEntity(w.entity_id)}>
                          {w.entity_id}
                        </button>
                      </div>
                      <div className="why">{w.reason}</div>
                    </div>
                  ))}
                  {!r.writes.length && <div className="why">Changed nothing — a question, answered.</div>}
                  {/* READ but not written: the reasoning, as distinct from the
                      result. An agent that read six nodes to justify changing
                      one reached for all seven, and the six are why. */}
                  {!!r.read?.length && (
                    <div className="run-read">
                      <div className="run-outcome-label">read ({r.read.length})</div>
                      {r.read.map((id) => (
                        <button
                          key={id}
                          className="node"
                          onMouseEnter={() => setAccent(id)}
                          onMouseLeave={() => setAccent(null)}
                          onClick={() => onEntity(id)}
                        >
                          {id}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* The skip is the tell. A gardener that fixes everything it
                      is shown is a gardener that is guessing, so the outcome
                      gets as much room as the writes. */}
                  {r.outcome && (
                    <div className="run-outcome">
                      <div className="run-outcome-label">answer</div>
                      {r.outcome}
                    </div>
                  )}
                  {/* Undo THIS attempt, not the whole session. Debug's rollback
                      is whole-tree and cannot pick one run out of five. */}
                  {!!r.writes.length && (
                    <button
                      className="run-revert"
                      disabled={mode !== 'debug' || busy}
                      onClick={async () => {
                        const out = await post('/api/run/revert', { runId: r.id, reason: 'reverted from the Atlas' });
                        if (out) {
                          setNotice(
                            out.blocked
                              ? `Stopped at write #${out.blocked.writeId} (${out.blocked.op} ${out.blocked.entityId}): ${out.blocked.problem}. ${out.reverted} undone before it.`
                              : `Reverted ${out.reverted} write(s).`,
                          );
                        }
                      }}
                    >
                      revert this run
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
