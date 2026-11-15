import { useEffect, useRef } from 'react';
import type { Centroid } from './Atlas';
import type { DomainStyle } from './palette';
import type { Privacy } from './privacy';
import type { DomainSummary } from './types';

/**
 * The domain names — as real buttons, floating over the canvas.
 *
 * They were canvas text at first, which made them beautiful and dead: a name you
 * navigate by has to be clickable, hoverable and cursor-aware, and re-inventing
 * those three things on a canvas is exactly the low-level work this project is
 * trying not to do. So the blobs stay painted and the names became DOM.
 *
 * They still have to track clusters that move every frame, and one React render
 * per frame for ten labels would be absurd. The positions are therefore written
 * straight to `style.transform` inside a requestAnimationFrame loop — React owns
 * the buttons, the loop owns where they are.
 */
export function DomainLabels({
  fg,
  centroids,
  domains,
  styles,
  onStage,
  openDomain,
  onPick,
  privacy,
  mono = false,
}: {
  fg: React.RefObject<any>;
  centroids: React.RefObject<Map<string, Centroid>>;
  domains: DomainSummary[];
  styles: Map<string, DomainStyle>;
  onStage: Set<string>;
  openDomain: string | null;
  onPick: (d: string) => void;
  privacy: Privacy;
  /** Drop the domain hue — the run ledger reads one question, not twelve. */
  mono?: boolean;
}) {
  const els = useRef(new Map<string, HTMLButtonElement | null>());

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = fg.current;
      if (g?.graph2ScreenCoords) {
        for (const [d, el] of els.current) {
          const c = centroids.current?.get(d);
          if (!el) continue;
          if (!c || !onStage.has(d)) {
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
            continue;
          }
          // A cluster pushed to the rim is mostly off-screen BY DESIGN — that is
          // what keeps the middle for the open domain. Its name still has to be
          // reachable, so the label is CLAMPED into the frame for as long as any
          // part of the cluster is on screen, and only disappears once the whole
          // thing has left. Hiding it with its centroid meant the neighbours you
          // are meant to navigate to were the first names to go.
          const mid = g.graph2ScreenCoords(c.x, c.y);
          const rim = g.graph2ScreenCoords(c.x + c.r, c.y);
          const rs = Math.abs(rim.x - mid.x);
          const W = window.innerWidth;
          const H = window.innerHeight;
          const onScreen = mid.x + rs > 0 && mid.x - rs < W && mid.y + rs > 0 && mid.y - rs < H;
          if (!onScreen) {
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
            continue;
          }
          const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
          const x = clamp(mid.x, 66, W - 66);
          // Above the cluster where there is room, otherwise pinned inside the
          // top edge — never over the header or under the bottom of the window.
          // 104, not 74: the element is anchored by its BOTTOM edge and is two
          // lines tall, so a smaller floor slides the name itself up behind the
          // header and leaves only the count showing.
          const y = clamp(mid.y - rs - 10, 104, H - 26);
          el.style.opacity = openDomain === d ? '0.5' : '1';
          el.style.pointerEvents = openDomain === d ? 'none' : 'auto';
          el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fg, centroids, onStage, openDomain]);

  return (
    <div className="domain-labels">
      {domains.map((d) => {
        const st = styles.get(d.domain);
        // A private domain keeps its position and its click target and loses
        // everything else — including the counts, which are content: "12 open"
        // over a masked name still says how much is going on in someone's
        // paperwork case.
        const priv = privacy.isPrivate(d.domain);
        return (
          <button
            key={d.domain}
            ref={(el) => {
              els.current.set(d.domain, el);
            }}
            className="domain-label"
            // COLOURLESS IN THE LEDGER. The hue names the domain, which is a
            // second dimension nobody is reading while a run is being examined
            // — and the labels were the last coloured thing left on the field.
            style={{ color: mono ? 'hsl(0 0% 100% / 0.42)' : st ? `hsl(${st.hue} 60% 80%)` : undefined }}
            onClick={() => onPick(d.domain)}
            title={priv ? 'private — hidden in this browser' : `${d.domain} — ${d.open} open of ${d.entities}${d.criticalPath ? `\ncritical path: ${d.criticalPath.join(' → ')}` : ''}`}
          >
            <span className="name">{privacy.label(d.domain)}</span>
            <span className="count">{priv ? 'private' : `${d.open} open · ${d.entities}`}</span>
          </button>
        );
      })}
    </div>
  );
}
