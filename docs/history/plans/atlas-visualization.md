# The Atlas — the graph, seen and alive

_Written 2026-07-31, parked deliberately. Mehdi's ask: "visualize the new graph
structure on a very nice interactive live dashboard … the full graph and
different domains as a big picture, small circles clustered around each other,
lines connecting them … zoomable and draggable … going inside a cluster reveals
labels and rearranges the nodes … clicking a node opens a modal with the data
point, its stats and relations … light effect around nodes / travelling light
through connections as function calls happen … no low-level implementation, high
level libraries configured."_

This is a **spec, not a round**. It is written now so it survives out of context
and can be picked up at any time. It is sequenced AFTER the insight pass that
fixes the target shape of the graph + API + tests, because the Atlas renders
that shape and should not be built against a shape we are about to change.

---

## Why this is worth building (and why it isn't just a toy)

Rounds 8 and 9 turned memory into a typed graph with a callable API. Both rounds
were validated by prose and by SQL. Neither has ever been **looked at**. Three
things follow:

1. **A graph you cannot see is a graph you cannot audit.** Orphans, hairballs,
   a domain with one entity and forty edges, a `relates-to` swamp where
   `blocks` was meant — these are one glance in a layout and an afternoon in
   SQL. The Atlas is the fastest QA instrument we can build for round 8's shape.
2. **The dashboard is a client of the module API, and therefore a test of it.**
   Rule: the Atlas reads through `callModule('entities', …)` and nothing else —
   never raw SQL, never `loadGraph()`. If the Atlas needs data the module cannot
   answer, that is a **friction signal of exactly the kind round 9 exists to
   capture**, and it gets recorded in the friction ledger like any agent's grep.
   The API is not allowed a private back door for its own UI.
3. **The live layer makes the system's own attention visible.** Which entities
   the night pass actually touches, which functions the day actually calls,
   where a probe flipped a status — currently knowable only by reading tables.
   Watching it move is how we find out whether the flywheel is spinning or
   idling.

Non-goal: this is **not** a control panel. Read-only in v1. It is an
observation surface, in the same spirit as round 6's harvest — the machine made
watchable, not drivable. (Actions on a node are noted as a v3 possibility; they
would go through the module API as calls, not through a private mutation path.)

---

## The material we are drawing

Measured 2026-07-31, on live data:

| | count |
|---|---|
| entities | 153 |
| edges | 233 |
| domains | 10 (`core-api` 38, `affiliate-app` 28, `client-onboarding` 28, `paperwork` 15, `launchpad` 13, `personal` 11, `reference` 8, `ops-tool` 5, `reporting` 4, `fibery` 3) |
| edge relations | 10, closed vocabulary |
| kinds | 10, closed vocabulary |

**This is a small graph, and that decides the stack.** 153 nodes is three orders
of magnitude below where WebGL/GPU layout engines start earning their
complexity. What matters at this scale is not throughput but *interaction
quality*: readable labels, smooth level-of-detail transitions, per-node effects,
hit-testing on hover. Choose the library that is best at those, and let it be a
canvas.

Growth assumption: hundreds, not hundreds of thousands. Even at 5k entities the
recommended stack holds. If we ever pass ~50k, swap the renderer only — the data
contract below is renderer-agnostic on purpose.

### Node model

Every entity is a node, carrying (from `entities.find` / `Card`):

`id · domain · kind · status(open|closed|n/a) · state + state_at · actor ·
dormant · goal · facts[] · edges{rel: id[]} · chain[] · probe? · note?`

Visual encoding (the whole point is that these are already typed — no invented
taxonomy):

- **cluster / hue** ← `domain` (10 domains → 10 hues)
- **radius** ← degree, with `goal` nodes a size class of their own
- **fill** ← `status`: open = saturated, closed = drained, `n/a` = outline only
- **ring** ← `actor === 'Mehdi'` (this is the focus-tier-1 signal; it should be
  visible without opening anything)
- **opacity** ← `dormant` (deliberately nobody's move ≠ closed; it must read as
  *parked*, not *done*)
- **glyph** ← `kind`, small, only at close zoom
- **edge style** ← `rel`: `blocks`/`blocked-by` heavy and directed (they are
  normalized as inverses, so draw ONE arrow, never two); `part-of`/`owned-by`
  structural and short (they should pull the layout); `relates-to` faint and
  weak (it must not dominate the spring forces or everything hairballs)

### Live event model

Two kinds of pulse, sourced from things that already exist:

- **call pulse** — a `callModule` / `evalInModule` completed. Payload: module,
  fn, args, ms, ok, and `refs[]`: any entity ids the call touched (arguments
  that resolve to an entity, plus ids present in the result). Renders as a halo
  on each referenced node and a light travelling along the edges between them.
  A call with no entity refs pulses its **module node** instead (the `modules`
  domain is itself in the graph — calls are visible as motion in that cluster).
- **state pulse** — a row in `entity_changes`. Renders as a slow bloom on the
  node; a `status_flip` is louder and recolours the node in place, because that
  is the event that actually reshapes the graph.

Optional third: **friction pulse** — a row in the friction ledger, drawn as a
red flare wherever the agent went around the API. Cheap, and it makes the
round-9 premise visible.

Note for implementation: `module_use` is an **aggregate** (upsert with `hits`),
not an event stream. The live layer needs a bus, not a table read — see below.

---

## Stack recommendation

> Everything below is "install and configure". No custom force solver, no
> hand-written canvas draw loop, no WebSocket protocol design.

**Renderer — `react-force-graph-2d`** (wraps `force-graph`, which wraps
`d3-force` + canvas). It is chosen because it ships, as configuration, nearly
every feature in the ask:

- `linkDirectionalParticles` / `emitParticle()` — **the travelling light through
  connections is a built-in.** This single prop is the reason to pick this
  library over anything else; elsewhere it is a custom shader.
- `nodeCanvasObject` — per-node custom paint (halo, ring, glyph, label) as a
  callback, no render loop to own.
- `zoom` / `zoomToFit` / `centerAt` with a duration arg — animated camera moves
  for free; drag-to-pan and wheel-zoom are default behaviour.
- `d3Force('…')` accessors + `d3ReheatSimulation()` — per-relation link strength
  and the re-layout-on-expand behaviour.
- `onNodeClick` / `onNodeHover` / `onBackgroundClick` — the interaction surface.
- 3D twin (`react-force-graph-3d`) shares the same API if we ever want it. Do
  not start there; 2D is more readable and labels actually work.

**Clustering — `d3-force` + `d3-polygon` hulls.** Domain grouping is already
given by the data (no community detection needed, though
`graphology-communities-louvain` is the drop-in if we ever want *discovered*
clusters to compare against *declared* domains — that comparison is itself an
interesting audit). Cluster cohesion = a per-domain `forceX/forceY` toward a
domain anchor, anchors placed on a circle; hulls drawn from `d3.polygonHull` in
the same `onRenderFramePre` hook.

**Shell — Vite + React + TypeScript**, in `web/` at the repo root, built to
static assets. Zero relationship to the bot's runtime except the HTTP boundary.

**Transport — SSE, not Socket.IO.** One-way server→client, one endpoint,
`EventSource` is a browser built-in with automatic reconnect, and it needs no
dependency on either side. Socket.IO would be a dependency and a protocol for a
feature we do not have (client→server messages). Revisit only if v3 actions
land.

**Server — `node:http`, ~100 lines, in `src/atlas.ts`.** Bound to `127.0.0.1`,
started from `index.ts` behind `ATLAS_PORT`. No Express. Serves the built `web/`
assets and four endpoints.

**Styling / modal — Tailwind + Radix Dialog**, or nothing at all if that feels
heavy; the modal is one component.

### Alternatives considered

- **Cosmograph / cosmos.gl** — GPU force layout, built for 10⁵–10⁶ nodes.
  Genuinely the right answer at scale and the "WebGL magic" the ask gestures at,
  but at 153 nodes it buys throughput we do not need in exchange for weaker
  per-node customisation and label handling. Keep as the escape hatch.
- **Sigma.js + graphology** — excellent ecosystem, best-in-class community
  detection and graph algorithms. Loses on the effects: edge particles need a
  custom WebGL program, which is precisely the low-level work the ask excludes.
- **Cytoscape.js** — strong for structured/hierarchical layouts and rich
  styling; weaker organic force aesthetics, and its animation story for
  travelling pulses is manual.
- **D3 raw** — maximum control, and the most low-level implementation of the
  four. Rejected on the same rule.

---

## The data contract

Served by `src/atlas.ts`, produced ONLY through `callModule('entities', …)`.

```
GET  /api/graph              → { nodes: Node[], links: Link[], domains: DomainSummary[], generatedAt }
GET  /api/entity/:id         → { card: Card, blockers: Line[], criticalPaths: [], trace: string[], neighbours: Line[] }
GET  /api/domain/:name       → { summary: DomainSummary, nodes: Node[], links: Link[] }
GET  /api/stream             → text/event-stream: `call` | `state` | `friction` | `graph-dirty`
```

`Node` is `Card` minus `facts`/`chain` (the heavy fields — fetched on open, not
on load), plus `degree`. `Link` is `{ source, rel, target }` with inverse pairs
already collapsed.

The whole graph is ~150 nodes ≈ tens of KB, so v1 ships it in one request and
does level-of-detail entirely client-side. `/api/domain/:name` exists for the
day that stops being true; wire the client through it from the start so the
seam is real.

**Module functions the Atlas will need that do not exist yet** (each is a
friction row, and each should be added to `modules/entities` *because the Atlas
demanded it*, which is the intended growth path — never for its own sake):

- `graph()` — the whole index in one call: nodes + collapsed links + per-domain
  rollup. Today this is `domains()` plus a walk, which is exactly the "return
  the data, not an answer" shape the module was written to avoid — so it needs
  its own justification: this ONE caller is a renderer, and a renderer's
  question genuinely is "the whole shape". Mark it as such in its doc so it
  does not become the lazy default for agents.
- `neighbours(ref)` — one hop out, typed by relation. Needed for the modal;
  almost certainly wanted by agents too.
- `stats(ref)` — degree, in/out by relation, distance to nearest goal, age of
  `state_at`. The modal's stats block.

### The pulse bus

`callModule` already records to `module_use`, and probes already write
`entity_changes`. Add a tiny in-process `EventEmitter` in `src/atlas.ts` (or a
`pulse.ts` it owns) that those two paths emit to; the SSE endpoint subscribes,
with a bounded ring buffer (~200 events) replayed on connect so a page opened
mid-flight is not blank. Bounded, lossy, no persistence — if a pulse is dropped
nothing is harmed. Extracting `refs[]` from a call is a small resolver: scan
string args and result ids against the entity index.

---

## The interaction model

Three levels of detail, one continuous zoom, and the same state reachable by
wheel or by click. The rule: **zoom and click must land in the same place**, so
discovery by scrolling and discovery by clicking never disagree.

**L0 — the sky (zoom < 0.6).** Ten domain bubbles, sized by entity count, laid
out by inter-domain edge weight. Entity nodes render as unlabelled dots inside
their hull; only domain names are typeset. Inter-domain links are aggregated
into one weighted ribbon per pair (drawing 233 individual lines at this level is
the hairball we are trying to avoid).

**L1 — a cluster (0.6 ≤ zoom < 2, or click a hull).** The entered domain's
nodes get labels, real edges, and their own force run; other domains collapse to
compact placeholder bubbles at the rim and push outward, so the entered cluster
gets the canvas. **This re-layout is the "rearrangement" in the ask** — it is
`d3ReheatSimulation()` with a changed node set and a new domain anchor, animated
by the simulation's own cooling, plus a `zoomToFit` camera move. Cross-domain
edges stay visible as stubs pointing at the rim bubbles; clicking a stub
navigates there.

**L2 — an entity (zoom ≥ 2, or click a node).** Ego network: the node, its
one-hop neighbours labelled by relation, two-hop faded. Everything else drops to
near-zero opacity rather than unmounting, so the transition is a fade, not a
cut. The modal opens alongside.

**Back** — a persistent breadcrumb (`Atlas › core-api › core-api/prober`), plus
Escape, plus the browser back button (levels are URL state: `/#/core-api/…` —
which also makes any view linkable, worth having the first time we want to point
at something in a Telegram message).

**Modal.** Header: id, kind, domain, status chip, actor, dormant/goal flags.
Body: `state` + `state_at` rendered as *what the probe last saw* (never
editable — the file is the source of truth and the probe owns state); facts as
a list; relations grouped by relation type with clickable ids that navigate the
canvas behind the modal; `chain[]` as the route back into traces; `probe` shown
as the command it is. Footer: stats block. v3: actions, and they call module
functions.

**Pulses.** Halo = an expanding, fading ring; travelling light = the library's
directional particles, one emitted per call along each edge between referenced
nodes; status flip = a colour transition plus a brief label. A "recent activity"
ticker in the corner lists the last ~10 pulses in text, because motion alone
does not tell you *what* happened. Everything must degrade gracefully when the
system is idle for hours — no permanent shimmer, no attract-mode.

**Motion discipline.** Every transition ≤ 400ms, easing consistent, and one
"reduce motion" toggle that kills particles and re-layout animation (both for
accessibility and for when we are actually reading the graph rather than
demoing it).

---

## Milestones

Each is independently useful; stopping after any one leaves something working.

1. **Static Atlas.** `/api/graph` + L0/L1 + hulls + drag/zoom. Answers "what
   does the graph look like" — and this is the milestone that does the audit
   work, so it lands first even though it has no live layer.
2. **Depth.** L2 ego view + modal + `/api/entity/:id` + `neighbours`/`stats`.
   Answers "what is this thing, and what does it touch".
3. **Life.** Pulse bus + SSE + halos, particles, ticker. Answers "what is the
   system doing right now".
4. **Polish.** URL state, breadcrumbs, reduce-motion, keyboard nav, an
   `/atlas` command in the bot that replies with the local URL.

Cut lines if time is short: milestone 1 alone is worth the build. Milestone 3
without 2 is a demo, not a tool — do not reorder.

---

## Open questions (decide before implementing, not now)

- **Does the target graph shape change first?** It should. The insight pass
  (dreams / focus / notes / logs from the live nights) may add or drop fields,
  and the Atlas encodes fields visually. Build after, not before.
- **Does the `modules` domain belong in the same canvas as the knowledge
  domains?** It makes call pulses visible with no extra machinery, and modules
  genuinely are entities — but it mixes "what the system knows" with "what the
  system can do". A toggle is the cheap answer; the interesting version is a
  *layer* switch rather than a filter.
- **Time.** A scrubber over `entity_changes` — the graph as it stood a week
  ago, and the flywheel's motion as a replay — is the most valuable thing not in
  this spec. Deliberately out of scope for v1; the data is already being kept,
  so the option stays open.
- **Multi-user.** The Atlas assumes one local operator on `127.0.0.1`. If
  round 7's multi-user candidate ever lands, this needs auth and scoping.

---

## Rules for whoever implements this

1. The Atlas reads the module API and nothing else. A missing answer is a
   friction row, not a raw query.
2. Read-only in v1. No mutation path exists to be tempted by.
3. No custom layout solver, no hand-written render loop, no bespoke socket
   protocol. If a feature seems to need one, that is the signal to check whether
   the library already configures it — every effect in this spec does.
4. Encode only fields that already exist and are already typed. If a visual
   needs a new field, add the field to the grammar first; do not compute a
   private one in the client.
5. `web/` never imports from `src/`. The HTTP contract is the only seam.
