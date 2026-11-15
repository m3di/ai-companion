import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { forceCollide, forceX, forceY } from 'd3-force';
import { useGraph, usePulses } from './live';
import { DomainLabels } from './DomainLabels';
import { domainStyles, PULSE_COLOR } from './palette';
import { Modal } from './Modal';
import { Ticker } from './Ticker';
import { Runs } from './Runs';
import { Lens, LENSES } from './Lens';
import { ModeChip, type ModeState } from './ModeChip';
import { Settings } from './Settings';
import { Life } from './Life';
import { LOCK, MASK, usePrivacy } from './privacy';
import { href, parse, same, type View } from './route';
import type { Link, Node, Pulse } from './types';

/**
 * THE ATLAS.
 *
 * Two views, and one modal that is orthogonal to both:
 *
 *   SKY     every domain as a soft blob with a clickable name
 *   DOMAIN  one domain spread out and labelled; the domains it actually
 *           CONNECTS TO pulled in around it, their names on screen and clickable
 *
 * Navigation is by NAME, never by zoom. Zoom and pan are just zoom and pan —
 * they never change what you are looking at, which is what lets you lean into a
 * cluster to read it without the view deciding you meant something by it.
 * Clicking a node opens its modal and does nothing else: no camera move, no
 * re-layout, no view change. The one way back to the sky is the back button.
 *
 * Nothing here computes graph structure. Layout is d3-force through
 * react-force-graph, the travelling lights are that library's directional
 * particles, and every fact on screen came from the knowledge API.
 */

/** How long a pulse stays lit, in ms. */
const PULSE_MS = 2600;
/** The domain the sky is drawn around — see `anchors`. Mirrors `PEOPLE_DOMAIN`
 *  in src/entities.ts, which the lint enforces on the data side. */
const HEART_DOMAIN = 'people';

/**
 * Where a connected neighbour domain sits when one is open.
 *
 * Tuned against the camera, not in the abstract: the view fits the OPEN domain
 * alone, so this radius decides how much of a neighbour survives at the edge of
 * the frame. Too close and its nodes tangle with the domain you came to read;
 * too far and it is gone and unreachable. This puts the blobs just past the
 * frame so a sliver and a name remain.
 */
const NEIGHBOUR_R = 470;
/**
 * Where an unconnected domain goes: still there, still explorable if you zoom
 * out or pan, but nowhere near the middle.
 *
 * Not further, deliberately. Every graph unit here is also a RETURN TRIP — at
 * 1600 the exiled clusters could not get home before the simulation's cooldown
 * cut them off, and the sky came back as one undifferentiated ball of nodes
 * frozen in transit.
 */
const EXILE_R = 1000;
/** Camera moves, in ms. Slow enough to read as a move rather than a cut. */
const CAMERA_MS = 1200;
/** How long the camera keeps tracking the layout after a view change. */
const FOLLOW_MS = 3600;
/** Relations that should pull the layout together, and how hard. */
const PULL: Record<string, number> = {
  'part-of': 1.6,
  'owned-by': 1.2,
  implements: 1.1,
  blocks: 1,
  'tracked-by': 0.7,
  supersedes: 0.7,
  'evidence-for': 0.6,
  'found-in': 0.6,
  'relates-to': 0.25,
  // The weakest pull in the table, and it has to be. 66 of the 284 links are
  // `acted-by`, all converging on a handful of people — at the default 0.5 they
  // stop being spokes and become a gravity well that drags every domain into
  // the middle. The heart must be REACHABLE from everywhere — a long thin
  // spoke, not a short strong one — so it sits in the same weak-association
  // tier as `relates-to` rather than getting a magnitude of its own. NOT tuned
  // by eye: a probe sweep was reheating the simulation every few seconds while
  // this landed, so the sky's settled look still needs a human's judgment.
  'acted-by': 0.25,
};

interface Lit {
  at: number;
  kind: string;
  loud: boolean;
}

export interface Centroid {
  x: number;
  y: number;
  r: number;
}

export function Atlas() {
  const { graph, error, reload } = useGraph();
  const fg = useRef<any>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  /**
   * The whole of navigation, mirrored from the address bar (see route.ts).
   * Nothing here is a second source of truth: every change goes out to the URL
   * through `go`, and every change from the URL comes back through `popstate`.
   */
  const [view, setView] = useState<View>(() => parse());
  /**
   * The domain opened INSIDE the run ledger.
   *
   * Runtime state, not URL: in /runs the graph is evidence, and opening a
   * domain to look closer is a glance, not a destination. Putting it in the
   * address bar would make every glance a history entry and turn Back into an
   * undo of your own looking. Dropped on leaving the route, deliberately.
   */
  const [stageDomain, setStageDomain] = useState<string | null>(null);
  useEffect(() => {
    if (!view.runs && !view.lens) setStageDomain(null);
  }, [view.runs, view.lens]);
  const evidence = view.runs || !!view.lens;
  const domain = evidence ? stageDomain : view.domain;
  const open = view.details;
  const [hover, setHover] = useState<Node | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [settings, setSettings] = useState(false);
  /**
   * RUN FOCUS — the graph in service of the run ledger.
   *
   * When a run is being read, the graph stops being the subject and becomes the
   * evidence: everything goes grey except the nodes that run touched, and the
   * one under the cursor goes green. `active` is the whole run's footprint,
   * `accent` is the single node being pointed at.
   *
   * In a ref AND in state: the painter needs it every frame without a render,
   * and the layout needs a render to make room for the panel. Keeping both in
   * sync in one setter is cheaper than either alone.
   */
  const [runFocus, setRunFocus] = useState<{ active: string[]; accent: string | null } | null>(null);
  /** How much of the left edge the run panel owns, so the canvas can give it up
   *  rather than draw underneath it — a footprint hidden behind a panel is not
   *  a footprint. Mirrors the width in styles.css. */
  const [panelW, setPanelW] = useState(0);
  const focusRef = useRef<{ active: Set<string>; accent: string | null } | null>(null);
  const setFocus = useCallback((f: { active: string[]; accent: string | null } | null) => {
    focusRef.current = f ? { active: new Set(f.active), accent: f.accent } : null;
    setRunFocus(f);
  }, []);
  /**
   * THE WORK STATE, polled.
   *
   * It drives the CHROME — the chip and the tint on the top bar — and never the
   * graph's colour; see `ledger` below for why those had to come apart.
   */
  const [modeState, setModeState] = useState<ModeState | null>(null);
  const loadMode = useCallback(() => {
    fetch('/api/mode').then((r) => r.json()).then(setModeState).catch(() => {});
  }, []);
  useEffect(() => {
    loadMode();
    const t = setInterval(loadMode, 4000);
    return () => clearInterval(t);
  }, [loadMode]);
  const sedated = (modeState?.mode ?? 'live') === 'debug';
  /**
   * COLOURLESS BELONGS TO THE LEDGER, not to the work state.
   *
   * These were briefly the same flag, on the argument that grey should mean one
   * thing — THE BOT IS SEDATED — rather than "a panel is open". The argument
   * was right about the danger and wrong about the remedy, and using it broke
   * the ledger: read a run while the bot is LIVE and the graph stayed in full
   * colour, so hovering a row highlighted a footprint that was invisible
   * against twelve hues. The one view whose entire purpose is "everything greys
   * out except what this attempt touched" had no grey.
   *
   * So the two facts get two signals, because they ARE two facts:
   *   - grey graph  = you are reading the ledger; the graph is evidence.
   *   - tinted bar  = the bot is sedated; writes are allowed.
   * Neither can be mistaken for the other, and neither has to lie about the
   * other's state.
   */
  const ledger = view.runs || !!view.lens;
  /** The painter needs it every frame without waiting for a render. */
  const ledgerRef = useRef(false);
  ledgerRef.current = ledger;
  /** The node under the cursor or open, which is the only green on screen. */
  const greenRef = useRef<string | null>(null);
  greenRef.current = hover?.id ?? open ?? null;
  const privacy = usePrivacy();

  // Lit nodes and cluster centroids live in refs, not state: a probe sweep lands
  // ~56 pulses in a few seconds and the centroids move every frame — both must
  // cost a frame of canvas, never a React render.
  const lit = useRef(new Map<string, Lit>());
  const centroids = useRef(new Map<string, Centroid>());
  const linkIndex = useRef(new Map<string, Link>());
  /** Wall-clock deadline until which the camera tracks the moving layout. */
  const follow = useRef(0);

  const domains = useMemo(() => (graph ? graph.domains.map((d) => d.domain) : []), [graph]);
  const styles = useMemo(() => domainStyles(domains), [domains]);

  const byId = useMemo(() => {
    const m = new Map<string, Node>();
    for (const n of graph?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [graph]);

  /**
   * Which domains each domain is wired to.
   *
   * This is what makes "a connected domain's name is on screen" a property of
   * the LAYOUT rather than a separate feature: the neighbours are pulled in
   * close, so their labels land in frame on their own.
   */
  const neighbourDomains = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const d of domains) m.set(d, new Set());
    for (const l of graph?.links ?? []) {
      const s = byId.get(typeof l.source === 'string' ? l.source : (l.source as Node).id);
      const t = byId.get(typeof l.target === 'string' ? l.target : (l.target as Node).id);
      if (!s || !t || s.domain === t.domain) continue;
      m.get(s.domain)?.add(t.domain);
      m.get(t.domain)?.add(s.domain);
    }
    return m;
  }, [graph, byId, domains]);

  /** In the sky: everyone. In a domain: it, plus whatever it touches. */
  const onStage = useMemo(() => {
    if (!domain) return new Set(domains);
    return new Set([domain, ...(neighbourDomains.get(domain) ?? [])]);
  }, [domain, domains, neighbourDomains]);

  /** Where each domain's cluster wants to sit. */
  const anchors = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    const bearing = new Map<string, number>();
    // The sky used to be ten clusters on a ring around nothing, and that hole
    // was not a layout choice — it was the graph's, faithfully drawn. `actor`
    // named a person the renderer could not follow, so the node every domain
    // points at was not in the picture. It is now (M0), and it goes in the
    // middle: PEOPLE is what the domains have in common, and a brain drawn
    // around an empty centre is the one thing this view must not show.
    const heart = domains.includes(HEART_DOMAIN) ? HEART_DOMAIN : null;
    const sky = domains.filter((d) => d !== heart);
    sky.forEach((d, i) => bearing.set(d, (i / Math.max(1, sky.length)) * Math.PI * 2 - Math.PI / 2));
    if (heart) bearing.set(heart, 0);
    if (!domain) {
      if (heart) m.set(heart, { x: 0, y: 0 });
      for (const d of sky) {
        const a = bearing.get(d)!;
        m.set(d, { x: Math.cos(a) * 520, y: Math.sin(a) * 520 });
      }
      return m;
    }
    // The open domain takes the middle. Its neighbours ring it at a radius that
    // fits the frame — spaced evenly so two of them cannot stack their labels,
    // but ORDERED by their original bearing, so the sky's spatial memory
    // survives the transition. Everything else is exiled outward.
    m.set(domain, { x: 0, y: 0 });
    const ring = [...(neighbourDomains.get(domain) ?? [])].sort((a, b) => bearing.get(a)! - bearing.get(b)!);
    ring.forEach((d, i) => {
      const a = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2;
      m.set(d, { x: Math.cos(a) * NEIGHBOUR_R, y: Math.sin(a) * NEIGHBOUR_R });
    });
    for (const d of domains) {
      if (m.has(d)) continue;
      const a = bearing.get(d)!;
      m.set(d, { x: Math.cos(a) * EXILE_R, y: Math.sin(a) * EXILE_R });
    }
    return m;
  }, [domains, domain, neighbourDomains]);

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // --- Live pulses ----------------------------------------------------------

  const [lifeTick, setLifeTick] = useState(0);
  const handlePulse = useCallback(
    (p: Pulse) => {
      // The life page has no graph nodes to light; it refetches instead.
      if (p.kind === 'life') setLifeTick((t) => t + 1);
      const now = Date.now();
      const refs = (p.refs ?? []).filter((id) => byId.has(id));
      for (const id of refs) lit.current.set(id, { at: now, kind: p.kind, loud: Boolean(p.loud) });
      // A domain-scoped pulse (a nightly rewrite, an agent grepping a tree
      // folder) lights the whole cluster — dimly, so it reads as weather rather
      // than as an event on any one node.
      if (!refs.length) {
        for (const d of p.domains ?? []) {
          for (const n of byId.values()) if (n.domain === d) lit.current.set(n.id, { at: now, kind: p.kind, loud: false });
        }
      }
      // THE TRAVELLING LIGHT: one particle down each edge between the entities a
      // single call touched. This is the library's own feature, which is exactly
      // why the renderer was chosen — no shader, no animation loop of our own.
      if (!reduceMotion && refs.length > 1) {
        for (let i = 0; i < refs.length; i += 1) {
          for (let j = i + 1; j < refs.length; j += 1) {
            const l = linkIndex.current.get(`${refs[i]}|${refs[j]}`) ?? linkIndex.current.get(`${refs[j]}|${refs[i]}`);
            if (l) fg.current?.emitParticle(l);
          }
        }
      }
    },
    [byId, reduceMotion],
  );

  const { recent, connected } = usePulses(handlePulse);

  // --- Forces ---------------------------------------------------------------

  useEffect(() => {
    if (!graph || !fg.current) return;
    const g = fg.current;
    linkIndex.current = new Map();
    for (const l of graph.links) {
      const s = typeof l.source === 'string' ? l.source : (l.source as Node).id;
      const t = typeof l.target === 'string' ? l.target : (l.target as Node).id;
      linkIndex.current.set(`${s}|${t}`, l);
    }
    g.d3Force('link')?.distance((l: Link) => 26 / (PULL[l.rel] ?? 0.5)).strength((l: Link) => 0.12 * (PULL[l.rel] ?? 0.5));
    g.d3Force('charge')?.strength(-90).distanceMax(600);
    // The clustering forces must be REGISTERED here, empty, and configured
    // later by `.x()`/`.strength()` — never installed fully formed. Registering
    // them with the simulation is what gets them initialized against the node
    // list when force-graph digests the data; handing `d3Force(name, force)` a
    // ready-made force instead leaves them holding no nodes, and then they are
    // silently inert for the rest of the page's life (the graph settles into one
    // ball and no amount of reheating moves it, because a force with no nodes
    // has nothing to pull).
    g.d3Force('x', forceX<Node>());
    g.d3Force('y', forceY<Node>());
    // 'center' drags every node toward the origin and would fight the anchors
    // for exactly the nodes we are trying to push out to the rim.
    g.d3Force('center', null);
    g.d3Force('collide', forceCollide<Node>((n) => 5 + Math.sqrt(n.degree) * 1.6).strength(0.7));
  }, [graph]);

  /** Spread the open domain further than the rest, so its labels have room.
   *  The camera fits that domain, so a wider layout arrives as bigger nodes and
   *  legible names rather than as a smaller cluster. */
  useEffect(() => {
    fg.current?.d3Force('collide')?.radius((n: Node) =>
      domain && n.domain === domain ? 15 + Math.sqrt(n.degree) * 2.2 : 5 + Math.sqrt(n.degree) * 1.6,
    );
  }, [domain, graph]);

  /**
   * Re-anchor for the current view and re-heat.
   *
   * This IS the rearrangement: opening a domain gives it the middle and a weak
   * leash so it can breathe, pulls in the domains it connects to, and pushes the
   * rest away. The animation is the simulation cooling, which is why it looks
   * like the graph decided to move rather than like a transition someone wrote.
   */
  useEffect(() => {
    if (!graph || !fg.current) return;
    const apply = () => {
      const g = fg.current;
      if (!g) return;
      const at = (n: Node, axis: 'x' | 'y') => (anchors.get(n.domain) ?? { x: 0, y: 0 })[axis];
      // The open domain gets a real leash, not a token one. At 0.012 it sprawled
      // far enough to reach the neighbours and the two sets grew into each
      // other; the middle of the screen has to belong to one domain.
      // Everything else is held hard against its anchor so it stays a compact
      // blob out at the rim instead of drifting back in.
      const strength = (n: Node) => (!domain ? 0.14 : n.domain === domain ? 0.05 : 0.9);
      g.d3Force('x')?.x((n: Node) => at(n, 'x')).strength(strength);
      g.d3Force('y')?.y((n: Node) => at(n, 'y')).strength(strength);
      g.d3Force('charge')?.strength((n: Node) => (domain && n.domain === domain ? -220 : -70)).distanceMax(600);
      // Reheating a simulation whose animation loop has been paused does
      // nothing — the loop is what ticks it — so wake it before asking it to move.
      g.resumeAnimation();
      g.d3ReheatSimulation();
    };

    // APPLIED THREE TIMES, ON PURPOSE.
    //
    // `forceX.x()` re-initializes the force against the node list the
    // simulation held when the force was registered. force-graph digests its
    // graphData on its own schedule, so whether that list is populated when this
    // effect runs is a RACE — and the losing side is silent: the anchors are
    // set, they look correct if you inspect them, and they move nothing, because
    // the force is holding zero nodes. Two builds of this file landed on
    // opposite sides of that race and the difference read as "clustering broke".
    // Re-applying is idempotent and costs microseconds, so cover every ordering
    // instead of depending on one.
    apply();
    const raf = requestAnimationFrame(apply);
    const late = setTimeout(apply, 250);
    // Let the camera TRACK the rearrangement rather than guess when it is over.
    follow.current = Date.now() + FOLLOW_MS;
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(late);
    };
  }, [graph, anchors, domain, onStage]);

  // Re-fit once the layout actually settles: the opening fit runs while the
  // graph is still unfolding, and by the time it stops it has outgrown the frame.
  /** What the camera should frame: the open domain, or the whole sky. */
  const frame = useCallback(
    (ms: number) => {
      fg.current?.zoomToFit(ms, domain ? 110 : 70, (n: Node) => (domain ? n.domain === domain : true));
    },
    [domain],
  );

  /**
   * Follow the layout while it moves.
   *
   * A single timed `zoomToFit` has to guess when the rearrangement is finished,
   * and it always guessed wrong: fired early it framed the OLD positions (going
   * back to the sky left half the map off-screen), fired late it arrived as a
   * snap after the nodes had already stopped. Re-fitting on every tick for a
   * couple of seconds removes the guess entirely — the camera and the graph move
   * together, which is what makes it read as one motion instead of a jump.
   */
  const onTick = useCallback(() => {
    if (Date.now() < follow.current) frame(0);
  }, [frame]);

  const settle = useCallback(() => frame(CAMERA_MS), [frame]);

  // --- Navigation -----------------------------------------------------------

  /**
   * Every navigation, in one place: write the URL, mirror it into state.
   *
   * Only things a person chose get here — opening a domain, opening a node,
   * closing one. Panning and zooming deliberately do not: the camera belongs to
   * whoever is moving it, and the one attempt to make it navigation turned the
   * app's own re-fits into fake gestures (see route.ts).
   */
  /**
   * HOW DEEP INTO A CHAIN OF MODALS WE ARE.
   *
   * Opening a node from a node is a step forward, and BACK should be the
   * previous node — the browser gives that for free. Closing is different: it
   * ends the chain, and it must land on the view the chain started FROM. The
   * first cut pushed a details-less URL on close, which looks right and leaves
   * every modal entry sitting behind it, so the next Back re-opened the modal
   * you had just dismissed. Counting the chain lets close rewind past all of
   * it in one `history.go`, which also keeps forward meaningful.
   */
  const modalDepth = useRef(0);

  const go = useCallback(
    (patch: Partial<View>, replace = false) => {
      setView((cur) => {
        const next = { ...cur, ...patch };
        if (same(cur, next)) return cur;
        if (replace) {
          history.replaceState(null, '', href(next));
        } else {
          // A modal opening over a view starts the chain; another over it
          // deepens it. Anything that lands on no modal ends it.
          modalDepth.current = next.details ? modalDepth.current + 1 : 0;
          history.pushState(null, '', href(next));
        }
        return next;
      });
    },
    [],
  );

  /**
   * Close the open modal and return to the view underneath it.
   *
   * Rewinds the whole modal chain rather than pushing a new entry, so a Back
   * after closing goes on past the graph view instead of re-opening what was
   * just dismissed.
   */
  const closeModal = useCallback(() => {
    const depth = modalDepth.current;
    modalDepth.current = 0;
    if (depth > 0) history.go(-depth);
    else go({ details: null });
  }, [go]);

  const back = useCallback(() => go({ domain: null, details: null, runs: false, lens: null, life: false }), [go]);

  /**
   * BACK AND FORWARD, for free.
   *
   * Because the URL holds the view, this handler does not decide what back
   * MEANS — the browser already knows, and every route a person visited is a
   * route they can retrace in either direction. Mouse thumb button, two-finger
   * swipe, Android's system back, a WebView's back: they all arrive here, and
   * none of them needs special-casing.
   *
   * It also does not touch the camera. A domain change re-anchors the layout
   * and the follow loop frames it; anything else is a modal opening or closing,
   * which is not a reason to move the view a person put where they wanted it.
   */
  useEffect(() => {
    const onPop = () => {
      const v = parse();
      // History moved under us, so the chain counter has to be re-derived
      // rather than trusted: a Back out of a modal shortens it, and landing on
      // a view with no modal ends it.
      if (!v.details) modalDepth.current = 0;
      else if (modalDepth.current > 0) modalDepth.current -= 1;
      setView(v);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The first entry has to carry the view too, so a reload or a back into it
  // lands on the same picture rather than on the bare sky.
  useEffect(() => {
    history.replaceState(null, '', href(parse()));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the modal first; it is not a way back to the sky.
      if (e.key === 'Escape') go({ details: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  // --- Painting -------------------------------------------------------------

  /** Soft cluster blobs, painted under the graph. The NAMES are DOM — see
   *  DomainLabels — because a name you can click has to be a real button. */
  const paintBackground = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!graph) return;
      const groups = new Map<string, Node[]>();
      for (const n of graph.nodes) {
        if (n.x === undefined) continue;
        if (!groups.has(n.domain)) groups.set(n.domain, []);
        groups.get(n.domain)!.push(n);
      }
      centroids.current = new Map();
      for (const [d, ns] of groups) {
        const st = styles.get(d);
        if (!st) continue;
        const cx = ns.reduce((s, n) => s + n.x!, 0) / ns.length;
        const cy = ns.reduce((s, n) => s + n.y!, 0) / ns.length;
        const r = Math.max(46, Math.max(...ns.map((n) => Math.hypot(n.x! - cx, n.y! - cy))) + 34);
        // The centroid is still needed whatever the mode — DomainLabels reads
        // it to place every label — so it is computed before the early exit,
        // not inside the drawing.
        centroids.current.set(d, { x: cx, y: cy, r });
        // NO DOMAIN GLOW IN THE RUN LEDGER. The hulls answer "which domain is
        // this region", a second colour dimension nobody is reading while a
        // run is being examined — and the coloured wash under a grey field is
        // exactly what made the green hard to pick out. The sky keeps them.
        if (ledger) continue;
        const focused = domain === d;
        const g = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
        g.addColorStop(0, `hsl(${st.hue} 70% 50% / ${focused ? 0.2 : onStage.has(d) ? 0.13 : 0.05})`);
        g.addColorStop(1, `hsl(${st.hue} 70% 50% / 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    [graph, styles, domain, onStage, ledger],
  );

  const paintNode = useCallback(
    (n: Node, ctx: CanvasRenderingContext2D, scale: number) => {
      const st = styles.get(n.domain);
      if (!st || n.x === undefined) return;
      // Off-domain clusters are turned DOWN, not off: still drawn, still
      // hoverable and clickable if you go to them, but never competing with the
      // domain you opened.
      let dim = !domain ? 1 : n.domain === domain ? 1 : onStage.has(n.domain) ? 0.3 : 0.12;
      const rf = focusRef.current;
      const runs = ledgerRef.current;
      const inRun = rf ? rf.active.has(n.id) : false;
      // A run being read outranks the domain: turned right down unless this run
      // reached it, so the footprint is read against the shape of the whole
      // graph rather than floating in a void.
      if (runs) dim = rf ? (inRun ? 1 : 0.09) : 0.5;
      const green = greenRef.current === n.id;
      const r = (n.goal ? 7 : 3.4) + Math.sqrt(n.degree) * 1.5;

      // The pulse halo: an expanding, fading ring around whatever the system
      // just touched. Drawn first so the node sits on top of its own glow.
      const l = lit.current.get(n.id);
      if (l) {
        const age = (Date.now() - l.at) / PULSE_MS;
        if (age >= 1) lit.current.delete(n.id);
        else {
          const ease = 1 - (1 - age) ** 2;
          ctx.beginPath();
          ctx.arc(n.x, n.y!, r + 3 + ease * (l.loud ? 26 : 13), 0, Math.PI * 2);
          ctx.strokeStyle = (PULSE_COLOR[l.kind] ?? '#fff').replace(')', ` / ${(1 - age) * (l.loud ? 0.95 : 0.5)})`);
          ctx.lineWidth = (l.loud ? 2.4 : 1.3) / scale;
          ctx.stroke();
        }
      }

      // GREEN IS RESERVED FOR THE POINTER. Exactly one node can be green — the
      // one being hovered, pointed at from the ledger, or open — so green never
      // means anything but "this one".
      const isGreen = runs && (green || rf?.accent === n.id);
      if (isGreen) {
        ctx.beginPath();
        ctx.arc(n.x, n.y!, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = 'hsl(140 90% 62% / 0.9)';
        ctx.lineWidth = 2.2 / scale;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y!, r, 0, Math.PI * 2);
      if (runs) {
        // COLOURLESS. Domain hue answers "what kind of thing is this", which is
        // not the question the ledger asks — the question is "did this attempt
        // reach it", and that is binary. Twelve hues gave the field a second
        // dimension nobody reads and left the highlight competing with them.
        // So: white at three strengths. Off, reached, and pointed-at.
        // Reached is a PRESENCE, not a spotlight. At full white every touched
        // node shouted as loudly as the one you were pointing at, and the green
        // had nothing left to be brighter than.
        ctx.fillStyle = isGreen
          ? 'hsl(140 90% 62%)'
          : inRun
            ? 'hsl(0 0% 100% / 0.5)'
            : `hsl(0 0% 100% / ${n.status === 'closed' ? 0.07 : 0.11})`;
        ctx.fill();
      } else if (n.status === 'closed') {
        ctx.fillStyle = `hsl(${st.hue} 18% 42% / ${dim * (n.dormant ? 0.35 : 0.6)})`;
        ctx.fill();
      } else if (n.status === 'n/a') {
        ctx.strokeStyle = `hsl(${st.hue} 40% 60% / ${dim * 0.75})`;
        ctx.lineWidth = 1.2 / scale;
        ctx.stroke();
      } else {
        ctx.fillStyle = `hsl(${st.hue} 80% 62% / ${dim * (n.dormant ? 0.4 : 1)})`;
        ctx.fill();
      }

      // A ring means it is Mehdi's move — focus tier 1, visible without opening
      // anything, which is the whole reason the focus set exists.
      if (!runs && n.actor && n.status === 'open' && !n.dormant) {
        ctx.beginPath();
        ctx.arc(n.x, n.y!, r + 2.6, 0, Math.PI * 2);
        ctx.strokeStyle = `hsl(0 0% 100% / ${dim * 0.85})`;
        ctx.lineWidth = 1.4 / scale;
        ctx.stroke();
      }
      // An entity with no probe has no clock — it can never tell you it moved.
      if (!runs && !n.probed && n.status === 'open') {
        ctx.beginPath();
        ctx.arc(n.x, n.y!, r * 0.34, 0, Math.PI * 2);
        ctx.fillStyle = `hsl(0 0% 8% / ${dim * 0.8})`;
        ctx.fill();
      }
      // The node whose modal is open keeps a marker, so it is findable behind
      // the panel. A marker is not a camera move — the view has not budged.
      if (open === n.id) {
        ctx.beginPath();
        ctx.arc(n.x, n.y!, r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2 / scale;
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Labels appear when there is room: inside the open domain, or on hover.
      // Below 0.35 a label is wider than the gap between two nodes, and a wall
      // of overlapping text says less than no text at all.
      const label = (domain !== null && n.domain === domain) || hover?.id === n.id || open === n.id;
      if (label && scale > 0.35) {
        ctx.font = `${11 / scale}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = `hsl(0 0% 92% / ${dim})`;
        ctx.fillText(privacy.nodeLabel(n.id), n.x, n.y! + r + 10 / scale);
      }
    },
    [styles, domain, onStage, hover, open, privacy],
  );

  if (error) {
    return (
      <div className="fatal">
        <h1>The Atlas cannot read the graph</h1>
        <pre>{error}</pre>
        <button onClick={reload}>Retry</button>
      </div>
    );
  }
  if (!graph) return <div className="fatal"><h1>Reading the graph…</h1></div>;

  return (
    <div className="atlas" style={{ ['--panel' as string]: `${panelW}px` }}>
      {/* THE STAGE. The canvas is not just narrowed, it is MOVED: shrinking it
          alone left the graph starting at x=0 and therefore still underneath the
          panel, which is the bug this wrapper exists to fix. `DomainLabels`
          lives in here too, because it positions from `graph2ScreenCoords` —
          canvas-relative — so it has to share the same origin or every label
          drifts left by the panel's width. */}
      <div className="stage" style={{ left: panelW, width: Math.max(size.w - panelW, 320) }}>
      <ForceGraph2D
        ref={fg}
        width={Math.max(size.w - panelW, 320)}
        height={size.h}
        graphData={graph as any}
        backgroundColor="#07080c"
        nodeRelSize={1}
        nodeCanvasObject={paintNode as any}
        nodePointerAreaPaint={((n: Node, color: string, ctx: CanvasRenderingContext2D, scale: number) => {
          // The hit area is painted in GRAPH units, so in the sky view a node is
          // about four screen pixels across — unhittable with a mouse. Give every
          // node a floor of ~11 real pixels regardless of zoom.
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, Math.max(6 + Math.sqrt(n.degree) * 1.5, 11 / scale), 0, Math.PI * 2);
          ctx.fill();
        }) as any}
        onRenderFramePre={paintBackground as any}
        linkColor={((l: Link) => {
          const s = byId.get(typeof l.source === 'string' ? l.source : (l.source as Node).id);
          const t = byId.get(typeof l.target === 'string' ? l.target : (l.target as Node).id);
          const rf = focusRef.current;
          if (ledgerRef.current) {
            // Any edge TOUCHING a reached node is part of the picture: it is
            // how that node sits in the graph, which is what you are reading.
            // Both-ends is brighter still — often that edge IS what the run did.
            const hit = rf && ((s && rf.active.has(s.id)) || (t && rf.active.has(t.id)));
            const both = rf && s && t && rf.active.has(s.id) && rf.active.has(t.id);
            if (both) return 'hsl(0 0% 100% / 0.34)';
            if (hit) return 'hsl(0 0% 100% / 0.15)';
            return 'hsl(0 0% 100% / 0.03)';
          }
          const shown = !domain || ((s && onStage.has(s.domain)) as boolean) || ((t && onStage.has(t.domain)) as boolean);
          if (!shown) return 'hsl(220 20% 40% / 0.03)';
          return l.rel === 'relates-to' ? 'hsl(220 20% 60% / 0.12)' : 'hsl(220 30% 70% / 0.26)';
        }) as any}
        linkWidth={((l: Link) => {
          const rf = focusRef.current;
          if (rf && ledgerRef.current) {
            const s2 = byId.get(typeof l.source === 'string' ? l.source : (l.source as Node).id);
            const t2 = byId.get(typeof l.target === 'string' ? l.target : (l.target as Node).id);
            if (s2 && t2 && rf.active.has(s2.id) && rf.active.has(t2.id)) return 1.4;
            if ((s2 && rf.active.has(s2.id)) || (t2 && rf.active.has(t2.id))) return 0.8;
          }
          return l.rel === 'blocks' ? 1.4 : 0.6;
        }) as any}
        /* CONTINUOUS FLOW along every edge a reached node owns. The pulse halo
           is a one-shot that fades; this keeps running for as long as the run
           is selected, which is what makes a footprint read as alive rather
           than as a static highlight. */
        linkDirectionalParticles={((l: Link) => {
          const rf = focusRef.current;
          if (!rf || !ledgerRef.current) return 0;
          const s2 = byId.get(typeof l.source === 'string' ? l.source : (l.source as Node).id);
          const t2 = byId.get(typeof l.target === 'string' ? l.target : (l.target as Node).id);
          const hit = (s2 && rf.active.has(s2.id)) || (t2 && rf.active.has(t2.id));
          return hit ? (reduceMotion ? 0 : 1) : 0;
        }) as any}
        linkDirectionalArrowLength={((l: Link) => (l.rel === 'blocks' ? 3.5 : 0)) as any}
        linkDirectionalArrowRelPos={1}
        /* A DRIFT, NOT A STREAM. At the default speed with two particles per
           edge the footprint read as a glitch — fast enough to look like a
           rendering fault rather than a signal. One particle, an order of
           magnitude slower, barely there: the eye should notice it only after
           it has finished reading the shape. */
        linkDirectionalParticleWidth={ledger ? 1.7 : 2.6}
        linkDirectionalParticleColor={() => (ledgerRef.current ? 'hsl(0 0% 100% / 0.42)' : 'hsl(140 90% 72%)')}
        linkDirectionalParticleSpeed={ledger ? 0.0016 : 0.02}
        // Opening a node is JUST opening it. No camera, no re-layout, no view
        // change — you keep the exact picture you were looking at.
        onNodeClick={((n: Node) => go({ details: n.id })) as any}
        onNodeHover={setHover as any}
        onEngineTick={onTick}
        onEngineStop={settle}
        // Long enough for the slowest journey in the layout: a domain returning
        // from exile to its place in the sky. Cutting the simulation off early
        // does not settle the graph, it FREEZES it mid-move.
        cooldownTime={reduceMotion ? 2000 : 15000}
        // More friction and a slower cool than d3's defaults (0.4 / 0.0228).
        // A re-anchor sets every node moving at once, and at the default damping
        // that arrives as a lurch — the nodes are already where they are going
        // before the eye has followed them. This spreads the same rearrangement
        // over a couple of seconds without making it a production.
        d3VelocityDecay={0.5}
        d3AlphaDecay={0.015}
        // Keep painting after the layout settles. force-graph pauses its redraw
        // when the simulation stops and nothing it knows about has changed — but
        // it does not know about the pulse halos (which animate on wall-clock
        // time) or the DOM domain labels (which track the canvas frame by
        // frame). Without this the Atlas goes quietly dead a few seconds after
        // load: the graph is there, the ticker scrolls, and nothing ever lights.
        autoPauseRedraw={false}
        enableNodeDrag
      />

      <DomainLabels
        fg={fg}
        centroids={centroids}
        domains={graph.domains}
        styles={styles}
        onStage={onStage}
        openDomain={domain}
        onPick={(d) => (evidence ? setStageDomain(d) : go({ domain: d, details: null }))}
        privacy={privacy}
        mono={ledger}
      />
      </div>

      {/* The bar carries the work state, so it is legible from anywhere on the
          page without stealing the graph's own colour vocabulary. */}
      {/* An owed night tints the bar like a dream, because to everything on the
          page it IS one: the day is held, waiting for a fold. Distinguishing
          "folding" from "about to fold" is the chip's job, not the bar's. */}
      <header className={`chrome top mode-${modeState?.owed && modeState.mode === 'live' ? 'dreaming' : (modeState?.mode ?? 'live')}`}>
        <nav className="crumbs">
          <button onClick={back} className={domain || view.runs ? '' : 'here'}>
            Atlas
          </button>
          {view.runs && (
            <>
              <span className="sep">›</span>
              <button className={domain ? '' : 'here'} onClick={() => setStageDomain(null)}>
                runs
              </button>
            </>
          )}
          {domain && (
            <>
              <span className="sep">›</span>
              <button className="here">{privacy.label(domain)}</button>
            </>
          )}
        </nav>
        <div className="right">
          {/* FIRST in the row, because it is the only thing here that says what
              the machine is doing rather than what the page is showing. */}
          <ModeChip
            state={modeState}
            connected={connected}
            onChanged={() => {
              loadMode();
              // The tree may have just been restored from a snapshot — the
              // graph on screen is a different graph now.
              reload();
            }}
          />
          {graph.errors.length > 0 && <span className="warn" title={graph.errors.join('\n')}>⚠ {graph.errors.length} lint</span>}
          <label className="toggle">
            <input type="checkbox" checked={reduceMotion} onChange={(e) => setReduceMotion(e.target.checked)} /> calm
          </label>
          {/* In the top bar, not the corner: it was sitting on top of the
              back button, and a control that covers another control is a bug
              however good it looks. */}
          <button className={view.runs ? 'on' : ''} onClick={() => go({ runs: !view.runs, lens: null, life: false, details: null })}>
            runs
          </button>
          {/* Beside `runs` and not in a menu: these are the same kind of view —
              a list on the left, the graph as its evidence — and burying them
              would keep them exactly as unreadable as the database was. */}
          {LENSES.map((l) => (
            <button
              key={l.name}
              className={view.lens === l.name ? 'on' : ''}
              onClick={() => go({ lens: view.lens === l.name ? null : l.name, runs: false, life: false, details: null })}
            >
              {l.label}
            </button>
          ))}
          <button className={view.life ? 'on' : ''} onClick={() => go({ life: !view.life, runs: false, lens: null, details: null })}>
            life
          </button>
          <button onClick={() => setSettings(true)}>settings</button>
          <button onClick={reload}>reload graph</button>
        </div>
      </header>

      {domain && (
        <button
          className="chrome back"
          onClick={() => (evidence ? setStageDomain(null) : back())}
        >
          ← back
        </button>
      )}

      {!view.life && <Ticker pulses={recent} onEntity={(id) => byId.has(id) && go({ details: id })} privacy={privacy} />}
      <Lens
        name={view.lens}
        onFocus={setFocus}
        onEntity={(id) => byId.has(id) && go({ details: id })}
        onWidth={setPanelW}
      />
      <Runs
        shown={view.runs}
        onClose={() => go({ runs: false, lens: null, life: false, details: null })}
        onEntity={(id) => byId.has(id) && go({ details: id })}
        onFocus={setFocus}
        onWidth={setPanelW}
        onModeChanged={loadMode}
        privacy={privacy}
      />

      {view.life && <Life tick={lifeTick} />}

      {hover && !open && !view.life && (
        <div className="chrome peek">
          {privacy.isPrivate(hover.id) ? (
            <>
              <strong>{LOCK} {MASK}</strong>
              <span className="muted">private domain — click to open</span>
            </>
          ) : (
            <>
              <strong>{hover.id}</strong>
              <span className="muted">{hover.kind} · {hover.status}{hover.actor ? ` · on ${hover.actor}` : ''}{hover.dormant ? ' · dormant' : ''}</span>
              {hover.state && <span className="state">{hover.state}</span>}
              {hover.gist && <p>{hover.gist}</p>}
            </>
          )}
        </div>
      )}

      {open && (
        <Modal id={open} onClose={closeModal} onGo={(id) => go({ details: id })} privacy={privacy} />
      )}

      {settings && <Settings domains={graph.domains} privacy={privacy} onClose={() => setSettings(false)} />}
    </div>
  );
}
