import { useEffect, useState } from 'react';
import { LOCK, MASK, type Privacy } from './privacy';
import type { Detail } from './types';

/**
 * One entity, in full.
 *
 * Every field here comes from a separate function in the knowledge API —
 * `find`, `neighbours`, `stats`, `blockers`, `trace` — because that is the rule
 * the Atlas is built to prove. `state` is shown as *what the probe last saw*,
 * with its age, and is never editable: the prober owns it, and the linter
 * rejects a file that disagrees.
 *
 * A node in a private domain opens to a curtain instead of its card. The reveal
 * is per-opening and never sticky: navigating away and back asks again. That
 * friction IS the feature — the thing being defended against is a second pair
 * of eyes on the screen right now, and a reveal that outlived the modal would
 * quietly undo the setting one click at a time.
 */
export function Modal({
  id,
  onClose,
  onGo,
  privacy,
}: {
  id: string;
  onClose: () => void;
  onGo: (id: string) => void;
  privacy: Privacy;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setD(null);
    setErr(null);
    setRevealed(false);
    let live = true;
    fetch(`/api/entity/${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => live && (j.error ? setErr(j.error) : setD(j)))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [id]);

  const c = d?.card;
  const age = d?.stats?.stateAgeDays;
  const curtain = privacy.isPrivate(id) && !revealed;
  /** A link OUT of this card to somewhere private: masked, still navigable. */
  const linkLabel = (target: string) => (privacy.isPrivate(target) ? `${LOCK} ${privacy.nodeLabel(target)}` : target.split('/').pop());

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose}>
          ✕
        </button>
        {curtain ? (
          <div className="curtain">
            <h2>
              {LOCK} {MASK}
            </h2>
            <p className="muted">
              This node is in a domain you marked private in this browser. Its name, state and facts are hidden — the
              graph still shows where it sits and what it connects to.
            </p>
            <button className="reveal" onClick={() => setRevealed(true)}>
              Show the content
            </button>
            <p className="muted small">Hidden again as soon as you close this.</p>
          </div>
        ) : (
          <>
        {err && <p className="warn">{err}</p>}
        {!d && !err && <p className="muted">reading…</p>}
        {c && (
          <>
            <h2>{c.id}</h2>
            <div className="chips">
              <span className={`chip ${c.status}`}>{c.status}</span>
              <span className="chip">{c.kind}</span>
              <span className="chip">{c.domain}</span>
              {c.actor && <span className="chip actor">on {c.actor}</span>}
              {c.dormant && <span className="chip">dormant</span>}
              {c.goal && <span className="chip goal">goal</span>}
              {c.aka.map((a) => (
                <span key={a} className="chip aka">
                  {a}
                </span>
              ))}
            </div>

            {c.state !== undefined && (
              <section className="state-block">
                <h3>What the probe last saw</h3>
                <pre>{c.state || '(nothing)'}</pre>
                <p className="muted">
                  {c.state_at ?? 'never'}
                  {age !== undefined && ` · ${age} day${age === 1 ? '' : 's'} ago`}
                  {c.probe && ` · ${c.probe}`}
                </p>
              </section>
            )}

            {c.facts.length > 0 && (
              <section>
                <h3>Facts</h3>
                <ul>
                  {c.facts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </section>
            )}

            {c.note && (
              <section>
                <h3>Note</h3>
                <p>{c.note}</p>
              </section>
            )}

            {d.blockers.length > 0 && (
              <section>
                <h3>In the way</h3>
                <ul>
                  {d.blockers.map((b) => (
                    <li key={b.id}>
                      <button className="link" onClick={() => onGo(b.id)}>
                        {privacy.isPrivate(b.id) ? `${LOCK} ${MASK}` : b.id}
                      </button>{' '}
                      <span className="muted">
                        {privacy.isPrivate(b.id) ? 'private' : `${b.status}${b.state ? ` · ${b.state}` : ''}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {d.neighbours.length > 0 && (
              <section>
                <h3>Relations</h3>
                {Object.entries(
                  d.neighbours.reduce<Record<string, typeof d.neighbours>>((acc, n) => {
                    const k = `${n.rel} ${n.direction === 'out' ? '→' : '←'}`;
                    (acc[k] ??= []).push(n);
                    return acc;
                  }, {}),
                ).map(([rel, ns]) => (
                  <div key={rel} className="rel">
                    <span className="rel-name">{rel}</span>
                    <span>
                      {ns.map((n) => (
                        <button key={n.id + n.direction} className="link" onClick={() => onGo(n.id)}>
                          {linkLabel(n.id)}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            )}

            {d.stats && (
              <section>
                <h3>Position</h3>
                <div className="stats">
                  <span>degree {d.stats.degree}</span>
                  <span>open blockers {d.stats.openBlockers}</span>
                  {d.stats.hopsToGoal !== undefined && <span>{d.stats.hopsToGoal} hop(s) to a goal</span>}
                  <span>{d.stats.domainOpen} open in {c.domain}</span>
                  {d.stats.byRelation.map((r) => (
                    <span key={r}>{r}</span>
                  ))}
                </div>
              </section>
            )}

            {d.trace.length > 0 && (
              <section>
                <h3>The route back</h3>
                <ul className="trace">
                  {d.trace.map((t) => (
                    <li key={t}>{/^https?:/.test(t) ? <a href={t} target="_blank" rel="noreferrer">{t}</a> : t}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
          </>
        )}
      </div>
    </div>
  );
}
