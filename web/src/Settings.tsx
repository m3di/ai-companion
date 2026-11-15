import { LOCK, type Privacy } from './privacy';
import type { DomainSummary } from './types';

/**
 * The Atlas's own settings — view state, never graph state.
 *
 * Everything reachable from here is a property of THIS BROWSER's picture of the
 * graph. Nothing in this panel can change what the system believes, what the
 * night reads, or what anyone else sees, and that boundary is the reason the
 * panel can be casual: the worst a wrong click does is hide something from you.
 *
 * The domain list is the whole surface for now, with one operation on each.
 * Others will land beside it; the shape is a row per domain, not a growing pile
 * of global toggles, because almost everything worth setting here is per-domain.
 */
export function Settings({
  domains,
  privacy,
  onClose,
}: {
  domains: DomainSummary[];
  privacy: Privacy;
  onClose: () => void;
}) {
  const hidden = domains.filter((d) => privacy.isPrivate(d.domain)).length;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose}>
          ✕
        </button>
        <h2>Atlas settings</h2>
        <p className="muted">
          These live in this browser only. They change what you SEE — never the graph, the agents, or the night.
        </p>

        <section>
          <h3>
            Domains {hidden > 0 && <span className="muted">· {hidden} hidden</span>}
          </h3>
          <p className="muted">
            A private domain keeps its shape and loses its content: nodes still drawn and still connected, but no
            name, no state, no hover. Open one and the Atlas asks before it shows you anything.
            <br />
            This is a screenshare guard, not security — the data still reaches this browser.
          </p>
          <ul className="domain-settings">
            {domains.map((d) => {
              const priv = privacy.isPrivate(d.domain);
              return (
                <li key={d.domain}>
                  <span className="dname">
                    {priv && <span className="lock">{LOCK}</span>}
                    {d.domain}
                  </span>
                  <span className="muted">
                    {d.open} open · {d.entities}
                  </span>
                  <button className={priv ? 'on' : ''} onClick={() => privacy.toggle(d.domain)}>
                    {priv ? 'private' : 'visible'}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
