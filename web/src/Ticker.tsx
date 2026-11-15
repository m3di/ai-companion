import { useEffect, useState } from 'react';
import { PULSE_COLOR } from './palette';
import { LOCK, NODE_MASK, type Privacy } from './privacy';
import type { Pulse } from './types';

/**
 * The activity ticker.
 *
 * Motion alone says something happened; it never says WHAT. Ten lines of text in
 * the corner is the difference between a screensaver and an instrument — and
 * when the system is idle it simply stays still, which is itself the reading.
 *
 * It COLLAPSES, because it sits over the top-right of the graph and the graph
 * is the thing you came for. Collapsed it keeps one line — a live dot in the
 * newest pulse's colour and the count — so folding it away never costs you the
 * one thing the ticker is for: knowing whether the system is doing anything.
 * The choice is remembered, like the privacy settings, because a person who
 * wants the canvas clear wants it clear tomorrow too.
 *
 * It is also the loudest leak a private domain has. A pulse's `text` is written
 * for a human — "probing paperwork/renewal-case" — so masking the ref buttons
 * and leaving the sentence would have been theatre. A pulse that TOUCHES a
 * private domain loses its text entirely; the row stays, because the fact that
 * something is happening is not the secret.
 */
const KEY = 'atlas.ticker-collapsed';

export function Ticker({ pulses, onEntity, privacy }: { pulses: Pulse[]; onEntity: (id: string) => void; privacy: Privacy }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(KEY) === '1');
  useEffect(() => {
    localStorage.setItem(KEY, collapsed ? '1' : '0');
  }, [collapsed]);
  // Refs and domains are the reliable signal; the text scan is the backstop for
  // a pulse that named an entity in prose without carrying it as a ref.
  const touchesPrivate = (p: Pulse) =>
    (p.refs ?? []).some(privacy.isPrivate) ||
    (p.domains ?? []).some(privacy.isPrivate) ||
    [...privacy.domains].some((d) => p.text.includes(`${d}/`));
  if (collapsed) {
    return (
      <button className="chrome ticker collapsed" onClick={() => setCollapsed(false)} title="show the activity feed">
        <span className="dot" style={{ background: PULSE_COLOR[pulses[0]?.kind ?? ''] ?? '#4a5568' }} />
        <span className="muted">{pulses.length ? `${pulses.length} recent` : 'quiet'}</span>
        <span className="chev">▾</span>
      </button>
    );
  }

  return (
    <aside className="chrome ticker">
      <header className="bar">
        <span className="muted">activity</span>
        <button className="fold" onClick={() => setCollapsed(true)} title="minimize (the graph is the point)">
          ▴
        </button>
      </header>
      {pulses.length === 0 && <p className="muted">nothing has happened yet — the feed is live</p>}
      {pulses.slice(0, 12).map((p) => {
        const priv = touchesPrivate(p);
        return (
          <div key={p.seq} className={`row${p.loud ? ' loud' : ''}`}>
            <span className="dot" style={{ background: PULSE_COLOR[p.kind] ?? '#fff' }} />
            <time>{p.at.slice(11, 19)}</time>
            <span className="kind">{p.kind}</span>
            <span className="text">
              {priv ? (
                <span className="muted">
                  {LOCK} {NODE_MASK}
                </span>
              ) : (
                <>
                  {p.text}
                  {(p.refs ?? []).slice(0, 3).map((id) => (
                    <button key={id} className="ref" onClick={() => onEntity(id)}>
                      {privacy.nodeLabel(id)}
                    </button>
                  ))}
                </>
              )}
            </span>
          </div>
        );
      })}
    </aside>
  );
}
