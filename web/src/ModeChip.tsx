import { useCallback, useState } from 'react';

/**
 * THE STATE OF THE MACHINE — and the door into it.
 *
 * The bot is in exactly one of three states and until now the page could not
 * say which. A still graph read as a dead one; a sedated bot looked identical
 * to a working one; and the only way to sedate it was a terminal, which means
 * the operator had to leave the surface they were operating from.
 *
 * ## Reading it, and opening it, are the same control
 *
 * A separate indicator and toggle can disagree — the badge says LIVE while the
 * button has already fired. One control cannot: it shows the state it changes.
 *
 * The alternative on the table was making the runs panel itself the door, so
 * that opening the ledger sedated the bot. That is worse, and the reason is
 * worth keeping: reading last night's work from a phone would then silently
 * stop the bot answering, and nothing on screen would distinguish "I opened a
 * panel" from "the day is suspended". Grey has to mean THE BOT IS SEDATED, or
 * it means nothing. So the ledger opens read-only while live, and this is the
 * only way through.
 *
 * ## Exiting is where the cost is
 *
 * Entering is cheap and reversible. Leaving is not, and the fork depends
 * entirely on whether anything was written:
 *
 *   - nothing written — one click, no question. A read-only look at the graph
 *     should never cost a dialog, or the operator learns to avoid looking.
 *   - something written — keep or discard, asked plainly, with the count. KEEP
 *     resets the concierge's context, and that is stated on the button rather
 *     than in a footnote, because it is the actual consequence.
 */

export type Mode = 'live' | 'dreaming' | 'debug';

export interface ModeState {
  mode: Mode;
  /** `writes` comes from the SERVER, counted off journal ids. The first version
   *  derived it here by filtering runs on `started_at >= since` — two different
   *  time formats, one with a space where the other has a `T` — so it matched
   *  nothing and the exit dialog offered to wake the bot with "nothing was
   *  written" over three real writes. */
  debug: { reason: string; since: string; snapshot: string; baselineWriteId: number; writes: number } | null;
  dream: { scope: string; since: string; pid: number } | null;
  /**
   * A night that has not been folded yet.
   *
   * The fourth fact, and the only one that holds the day while `mode` reads a
   * perfectly ordinary `live`. Without it on the page the operator sees LIVE,
   * messages the bot, is refused, and has nothing on screen that explains why.
   */
  owed: { boundary: string; overdueMin: number; last?: { boundary: string; how: string } } | null;
}

const LABEL: Record<Mode, string> = { live: 'LIVE', dreaming: 'DREAMING', debug: 'DEBUG' };

const TITLE: Record<Mode, string> = {
  live: 'The day is running — turns, workers, probes. Click to sedate it and work on the graph.',
  dreaming: 'A rewrite pass has the machine. Nothing else may run until it lands. Click to take the night back.',
  debug: 'The day is suspended and the tree is snapshotted. Click to resume.',
};

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d`;
}

export function ModeChip({
  state,
  connected,
  onChanged,
}: {
  state: ModeState | null;
  /**
   * Whether the live feed is attached.
   *
   * It lives in the DOT, and the mode lives in the label, because they answer
   * two questions that belong side by side: *am I still hearing from the
   * machine* and *what is the machine doing*. They used to be two separate
   * chips both reading "live", which is the same word for two unrelated facts —
   * so one of them always looked redundant and neither said which was which.
   */
  connected: boolean;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState<'enter' | 'exit' | 'night' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mode = state?.mode ?? 'live';
  // Not derived here. The server counts it off journal ids and reports it with
  // the session, so this dialog and `exitDebug` cannot disagree about what
  // leaving costs.
  const writes = state?.debug?.writes ?? 0;

  const owed = state?.owed ?? null;

  const post = useCallback(
    async (body: Record<string, unknown>, url = '/api/mode') => {
      setBusy(true);
      setError(null);
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (j.error) {
          setError(j.error);
          return;
        }
        setAsking(null);
        setReason('');
        onChanged();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return (
    <>
      <button
        className={`mode-chip m-${mode}${owed && mode === 'live' ? ' m-owed' : ''}`}
        title={owed && mode === 'live' ? 'The night has not been folded yet — the day is held until it lands. Click to take it back.' : TITLE[mode]}
        // Dreaming used to be a state you could not click your way out of, and
        // that was right while a fold was merely scheduled: it ends when it
        // ends. It stopped being right the day the fold became MANDATORY —
        // something the day now waits for has to have a way of being given up
        // on, or the first genuinely urgent morning turns a hygiene rule into a
        // bot nobody can reach.
        onClick={() => setAsking(mode === 'debug' ? 'exit' : mode === 'dreaming' || owed ? 'night' : 'enter')}
      >
        <span className={`dot ${connected ? 'on' : 'off'}`} title={connected ? 'live feed attached' : 'reconnecting to the live feed…'} />
        {owed && mode === 'live' ? 'NIGHT OWED' : LABEL[mode]}
        {mode === 'debug' && state?.debug && <span className="chip-sub">{ago(state.debug.since)}</span>}
        {mode === 'dreaming' && state?.dream && <span className="chip-sub">{state.dream.scope}</span>}
        {owed && mode === 'live' && <span className="chip-sub">{ago(`${owed.boundary.replace(' ', 'T')}Z`)} late</span>}
      </button>

      {asking && (
        <div className="mode-sheet" onClick={() => !busy && setAsking(null)}>
          <div className="mode-card" onClick={(e) => e.stopPropagation()}>
            {asking === 'night' ? (
              <>
                <h3>{mode === 'dreaming' ? 'Take the night back?' : 'Skip tonight’s fold?'}</h3>
                <p>
                  {mode === 'dreaming'
                    ? 'A rewrite pass is folding the day into memory. The day is held until it lands — no turns, no workers, no probes.'
                    : 'The night has not been folded yet, so the day has not started. A fold begins within the minute and takes a few minutes.'}
                </p>
                <p>
                  Cancelling stops it and <strong>rolls back everything it wrote</strong>, then opens the day. The window it
                  was going to fold is not lost — tomorrow’s pass covers it too. Do this when something genuinely cannot
                  wait, not to save time.
                </p>
                <input
                  autoFocus
                  value={reason}
                  placeholder="what could not wait"
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && reason.trim() && post({ reason }, '/api/night/cancel')}
                />
                <div className="mode-actions">
                  <button className="ghost" disabled={busy} onClick={() => setAsking(null)}>
                    let it finish
                  </button>
                  {/* Same rule as sedating: a reason is required. This one more
                      so — the night reads its own cancelled boundaries back. */}
                  <button className="danger" disabled={busy || !reason.trim()} onClick={() => post({ reason }, '/api/night/cancel')}>
                    {busy ? 'cancelling…' : 'cancel & roll back'}
                  </button>
                </div>
              </>
            ) : asking === 'enter' ? (
              <>
                <h3>Sedate the bot?</h3>
                <p>
                  The day stops: no turns, no workers, no commitments, no probes, no automatic
                  nightly, and nothing reaches the concierge's context. The tree is snapshotted, so
                  everything from here can be discarded in one move.
                </p>
                <input
                  autoFocus
                  value={reason}
                  placeholder="why you are opening it"
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && reason.trim() && post({ mode: 'debug', reason })}
                />
                <div className="mode-actions">
                  <button className="ghost" disabled={busy} onClick={() => setAsking(null)}>
                    cancel
                  </button>
                  {/* A reason is required, not optional. Every session so far
                      that was opened without one was unreadable a week later,
                      and the night now reads these too. */}
                  <button disabled={busy || !reason.trim()} onClick={() => post({ mode: 'debug', reason })}>
                    {busy ? 'sedating…' : 'sedate'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Wake the bot?</h3>
                {writes === 0 && (
                  <p>
                    Nothing was written. Leaving costs nothing and the concierge's context is
                    untouched.
                  </p>
                )}
                {!!writes && (
                  <p>
                    <strong>
                      {writes} graph write{writes === 1 ? '' : 's'}
                    </strong>{' '}
                    since this session opened. Keeping them resets the concierge's context — memory
                    moved under a context built on the old one.
                  </p>
                )}
                <div className="mode-actions">
                  <button className="ghost" disabled={busy} onClick={() => setAsking(null)}>
                    cancel
                  </button>
                  {!!writes && (
                    <button className="danger" disabled={busy} onClick={() => post({ mode: 'live', rollback: true })}>
                      discard everything
                    </button>
                  )}
                  <button disabled={busy} onClick={() => post({ mode: 'live' })}>
                    {busy ? 'waking…' : writes ? 'keep & reset context' : 'wake'}
                  </button>
                </div>
              </>
            )}
            {error && <div className="mode-error">{error}</div>}
          </div>
        </div>
      )}
    </>
  );
}
