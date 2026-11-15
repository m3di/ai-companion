import { useCallback, useEffect, useState } from 'react';

/**
 * A CONTEXT LENS — any list the system keeps, with the graph as its evidence.
 *
 * One component for every source, because the run ledger already proved the
 * interaction and six bespoke panels would be six places to fix the next time
 * the halo changes. A lens is a SHAPE (`src/lens.ts`); this draws it.
 *
 * ## What hovering means, and why it is not one thing
 *
 * The ledger paints every touched node identically, which quietly conflates
 * three different claims. Here they are separated:
 *
 *   - `changed` — the row EDITED those nodes.
 *   - `read` — the row LOOKED AT them. Consulting is not rewriting.
 *   - `missing` — the row named something the graph does not have, so there is
 *     NOTHING TO LIGHT. Those are drawn as grey chips on the row itself. It is
 *     the one case where the absence is the payload: 85 distinct names in the
 *     observation inbox resolve to no node, and until this panel existed the
 *     only way to see that was a SQL client.
 *
 * A lens that produces no refs at all renders a visibly dead list, and that is
 * deliberate — it is what makes I4 ("everything carries refs") enforceable
 * rather than aspirational.
 */

export interface LensRow {
  id: string;
  title: string;
  subtitle?: string;
  when?: string;
  refs: string[];
  ghosts?: string[];
  domains?: string[];
  tone: 'changed' | 'read' | 'missing';
  tags?: string[];
}

export interface LensData {
  name: string;
  title: string;
  hint: string;
  rows: LensRow[];
  blind: number;
}

export const LENSES = [
  { name: 'focus', label: 'focus' },
  { name: 'observations', label: 'inbox' },
  { name: 'friction', label: 'friction' },
  { name: 'episodes', label: 'questions' },
  { name: 'nights', label: 'nights' },
  { name: 'findings', label: 'findings' },
  { name: 'movements', label: 'moves' },
] as const;

const ACCENT: Record<LensRow['tone'], string> = {
  changed: '#e8a33d',
  read: '#5fbfb0',
  missing: '#8b93a7',
};

export function Lens({
  name,
  onFocus,
  onEntity,
  onWidth,
}: {
  name: string | null;
  onFocus: (f: { active: string[]; accent?: string } | null) => void;
  onEntity: (id: string) => void;
  onWidth: (w: number) => void;
}) {
  const [data, setData] = useState<LensData | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!name) return;
    fetch(`/api/lens/${name}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(String(d.error)) : (setData(d as LensData), setError(null))))
      .catch((e) => setError(String(e)));
  }, [name]);

  useEffect(() => {
    setData(null);
    setHovered(null);
    setOpen(null);
    load();
  }, [name, load]);

  // Refresh while it is on screen. A lens over live tables that never updates
  // is a screenshot, and the friction ledger in particular moves all day.
  useEffect(() => {
    if (!name) return;
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [name, load]);

  useEffect(() => {
    onWidth(name ? 400 : 0);
  }, [name, onWidth]);

  /**
   * The same ladder the runs panel settled on: hover is the transient probe and
   * always wins; an opened row holds the graph when the pointer is elsewhere.
   * Two panels with different rules for the same gesture would be worse than
   * either rule.
   */
  useEffect(() => {
    if (!name || !data) {
      onFocus(null);
      return;
    }
    const row = data.rows.find((r) => r.id === (hovered ?? open));
    if (!row) {
      onFocus(null);
      return;
    }
    onFocus({ active: row.refs, accent: ACCENT[row.tone] });
  }, [name, data, hovered, open, onFocus]);

  if (!name) return null;

  return (
    <aside className="chrome lens" onMouseLeave={() => setHovered(null)}>
      <header className="lens-head">
        <strong>{data?.title ?? name}</strong>
        {data && (
          <span className="lens-count">
            {data.rows.length} row{data.rows.length === 1 ? '' : 's'}
            {/* Stated, never hidden. A lens that cannot point at the graph is
                reporting a gap in the store, not a gap in the panel. */}
            {data.blind > 0 && (
              <span className="lens-blind" title="rows that point at nothing in the graph">
                {' · '}
                {data.blind} blind
              </span>
            )}
          </span>
        )}
      </header>

      {error && <div className="lens-error">{error}</div>}
      {data && <p className="lens-hint">{data.hint}</p>}
      {!data && !error && <p className="lens-hint">loading…</p>}

      <div className="lens-rows">
        {data?.rows.map((r) => (
          <div
            key={r.id}
            className={`lens-row t-${r.tone}${open === r.id ? ' lens-open' : ''}${r.refs.length ? '' : ' lens-dark'}`}
            onMouseEnter={() => setHovered(r.id)}
            onClick={() => setOpen(open === r.id ? null : r.id)}
          >
            <div className="lens-title">
              <span>{r.title}</span>
              {r.when && <span className="lens-when">{r.when}</span>}
            </div>
            {r.subtitle && <div className="lens-sub">{r.subtitle}</div>}
            {!!r.tags?.length && (
              <div className="lens-tags">
                {r.tags.map((t) => (
                  <span key={t} className="lens-tag">
                    {t}
                  </span>
                ))}
              </div>
            )}
            {!!r.refs.length && (
              <div className="lens-refs">
                {r.refs.map((id) => (
                  <button
                    key={id}
                    className="lens-ref"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEntity(id);
                    }}
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}
            {!!r.ghosts?.length && (
              // Not buttons: there is nothing to open. That is the whole point
              // of drawing them — a name the day used that the graph cannot
              // answer to is a missing concept, and it should look like one.
              <div className="lens-refs">
                {r.ghosts.map((g) => (
                  <span key={g} className="lens-ghost" title="no node in the graph answers to this name">
                    {g}
                  </span>
                ))}
              </div>
            )}
            {!!r.domains?.length && (
              <div className="lens-refs">
                {r.domains.map((d) => (
                  <span key={d} className="lens-domain" title="the finest thing this row can name is a domain">
                    {d}/
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {data && !data.rows.length && <p className="lens-hint">(nothing here)</p>}
      </div>
    </aside>
  );
}
