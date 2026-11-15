/**
 * THE URL IS THE VIEW.
 *
 * The first cut faked history: one sentinel entry, re-pushed after every pop,
 * and a hand-written ladder deciding what "back" meant. It worked and it was
 * wrong — the browser had no idea where you were, so forward did nothing, a
 * reload lost your place, and no view in the Atlas could be sent to anyone.
 * Every one of those is the same bug: state the browser cannot see.
 *
 * So the view lives in the address bar and nowhere else:
 *
 *   /                          the sky
 *   /domain/core-api            one domain
 *   /runs                      the run ledger, with the graph as its evidence
 *   /?details=people%2Fmehdi   a node open, over any of the above
 *
 * ## Why /runs carries no domain
 *
 * In the ledger the graph is EVIDENCE, not the subject: you open a domain to
 * look more closely at what a run touched, then leave it, and none of that is a
 * place anyone would want to link to or come back to. Putting it in the URL
 * would make every glance a history entry and turn Back into an undo of your
 * own looking. So while /runs is the route, the open domain is runtime state —
 * kept for as long as you stay, dropped when you leave. Camera and domain
 * behave the same way here, which is the point.
 *
 * Back and forward then need no ladder at all: they are whatever the browser
 * already does with a list of URLs, and every step a person took is a step they
 * can retrace.
 *
 * ## Why the camera is NOT in here
 *
 * A `?moved` flag was tried and removed the same evening. The idea was that
 * panning or zooming should be a place you could come back to, which meant
 * detecting that a person had moved the camera — and the only signal available
 * is a zoom event that the app's OWN `zoomToFit` fires too. Telling them apart
 * needed a baseline recorded after each automatic fit, the fit is animated so
 * the baseline lands on a timer, and the engine's settle re-fits seconds later:
 * the check then read a stale baseline, concluded the person had moved the
 * camera, pushed a history entry, and re-rendered into another fit. The graph
 * started drifting on its own a few seconds after every interaction.
 *
 * The lesson is worth more than the feature: a state derived by guessing which
 * of two indistinguishable events happened will always be wrong sometimes, and
 * a feedback loop is what "sometimes" looks like. Zoom and pan are now purely a
 * camera, owned by nobody but the person moving it — which is also what round
 * 10's Atlas work already decided about navigation, and this quietly broke.
 */

export interface View {
  /** The open domain, or null for the sky. Ignored while `runs` is on. */
  domain: string | null;
  /** The entity whose modal is open, over whatever else is on screen. */
  details: string | null;
  /** The run ledger: the panel is the stage and the graph is its evidence. */
  runs: boolean;
  /**
   * A context lens (`focus`, `observations`, `friction`, `episodes`), or null.
   *
   * Routed exactly like /runs and for the same reason: the panel is the stage,
   * the graph is evidence for the row under the pointer, and an open domain is
   * runtime state rather than a place worth linking to. Sharing the shape means
   * sharing the argument — one route per view, back and forward are whatever
   * the browser already does.
   */
  lens: string | null;
  /**
   * The life page (proposal #7): upkeep tiers on a 7-day timeline. A page, not
   * a lens — a lens is rows lighting the graph, and a day is not a row. It
   * covers the stage; the graph keeps running underneath.
   */
  life: boolean;
}

export const SKY: View = { domain: null, details: null, runs: false, lens: null, life: false };

export function parse(loc: { pathname: string; search: string } = window.location): View {
  const path = decodeURIComponent(loc.pathname);
  const m = /^\/domain\/(.+?)\/?$/.exec(path);
  const q = new URLSearchParams(loc.search);
  const l = /^\/lens\/([a-z]+)\/?$/.exec(path);
  return {
    domain: m ? m[1]! : null,
    details: q.get('details'),
    runs: /^\/runs\/?$/.test(path),
    lens: l ? l[1]! : null,
    life: /^\/life\/?$/.test(path),
  };
}

export function href(v: View): string {
  const path = v.life
    ? '/life'
    : v.runs
    ? '/runs'
    : v.lens
      ? `/lens/${encodeURIComponent(v.lens)}`
      : v.domain
        ? `/domain/${encodeURIComponent(v.domain)}`
        : '/';
  return v.details ? `${path}?details=${encodeURIComponent(v.details)}` : path;
}

export function same(a: View, b: View): boolean {
  return a.domain === b.domain && a.details === b.details && a.runs === b.runs && a.lens === b.lens && a.life === b.life;
}
