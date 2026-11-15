import { config } from './config.js';
import {
  allFindings,
  dreamFootprint,
  growAt,
  listCommitments,
  openFriction,
  recentDreams,
  recentFocusChanges,
  recentObservations,
  recentRetrievalEpisodes,
} from './db.js';
import { loadGraph } from './entities.js';

/**
 * A LENS — one list of rows, each pointing at the graph.
 *
 * ## Why one shape and not six panels
 *
 * The run ledger already proved the interaction: a list on the left, and
 * hovering a row lights what that row touched. Everything else the system knows
 * wants exactly that and had none of it — the focus set, the observation inbox,
 * the friction ledger and the night's own reports were all readable only by
 * opening the database by hand. Six bespoke panels would be six places to fix
 * the next time the halo changes, so a lens is a SHAPE, and a source is a
 * function that produces rows in it.
 *
 * ## The part that matters more than the UI
 *
 * A store with no refs renders as a visibly dead list. That is the point, and
 * it is the argument for building it this way: **I4 says everything carries
 * refs, and until now nothing enforced it.** `retrieval_episodes` shipped
 * earlier the same day recording `find→neighbours→openLoops` and not one node
 * id — it could not have been drawn, and nothing caught that until a lens was
 * asked for. Making the visualization mandatory makes the invariant
 * load-bearing: a source either produces refs or it looks broken on a screen
 * someone reads every day.
 *
 * ## Three tones, because a halo asserts three different things
 *
 * The ledger paints every touched node the same, and that conflates facts that
 * are not alike:
 *
 *   - `changed` — this row EDITED the node (a write, a night, a run).
 *   - `read` — this row LOOKED AT it (a retrieval, a focus item's pointer). A
 *     node someone consulted is not a node someone rewrote.
 *   - `missing` — this row named something the graph does not have. There is
 *     nothing to light, which is exactly the finding: 44 of 50 observations
 *     carry an unresolved name. Those ride in `ghosts` and are drawn beside the
 *     row instead of on the graph, so "the graph is missing a concept" becomes
 *     something you can see rather than something you can query.
 */

export type LensTone = 'changed' | 'read' | 'missing';

export interface LensRow {
  /** Unique within the lens; the client keys and hovers on it. */
  id: string;
  title: string;
  subtitle?: string;
  /** Right-aligned stamp — usually a time. */
  when?: string;
  /** Entity ids to light. */
  refs: string[];
  /** Names this row used that resolve to NOTHING — drawn as chips, not halos. */
  ghosts?: string[];
  /** Coarser highlight for rows that can only name a domain (friction reads). */
  domains?: string[];
  tone: LensTone;
  /** Small key/value chips under the title. */
  tags?: string[];
}

export interface Lens {
  name: string;
  title: string;
  /** One line: what this list is, and what hovering a row means. */
  hint: string;
  rows: LensRow[];
  /** Rows whose refs are empty — stated, never hidden. */
  blind: number;
}

const ago = (iso: string): string => {
  const ms = Date.now() - Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(0, m)}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

/** THE FOCUS SET — what the user is waiting on, and where it lives in the graph. */
function focusLens(chatId: number): Lens {
  const set = listCommitments(chatId)
    .filter((c) => c.focus > 0)
    .sort((a, b) => a.focus - b.focus || a.due_at.localeCompare(b.due_at));
  const rows: LensRow[] = set.map((c) => ({
    id: `focus-${c.id}`,
    title: c.label,
    subtitle: c.body.split('\n')[0],
    when: c.last_checked_at ? ago(c.last_checked_at) : 'never checked',
    refs: c.ref ? [c.ref] : [],
    tone: 'read',
    tags: [
      `tier ${c.focus}`,
      ...(c.focus_band ? [c.focus_band] : []),
      c.check_cmd ? 'auto-checked' : 'manual',
      ...(c.ref ? [] : ['no graph ref']),
    ],
  }));
  const linked = rows.filter((r) => r.refs.length).length;
  return {
    name: 'focus',
    title: 'Focus',
    hint:
      `${linked}/${rows.length} point at an entity. Hover to light it. ` +
      'An item with no ref is either one nobody set or a thing the graph has no node for — and the second is the more interesting half.',
    rows,
    blind: rows.length - linked,
  };
}

/**
 * THE OBSERVATION INBOX — what the day saw, and what it could not place.
 *
 * The only lens where the EMPTY half is the payload. An observation whose refs
 * resolved is ordinary bookkeeping; one carrying unresolved names is the day
 * reaching for a node that does not exist (M1's whole premise), and there has
 * never been a way to look at those without a SQL client.
 */
function observationsLens(): Lens {
  const rows: LensRow[] = recentObservations(200).map((o) => ({
    id: `obs-${o.id}`,
    title: o.text.replace(/\s+/g, ' ').slice(0, 200),
    subtitle: o.evidence ? `evidence: ${o.evidence.replace(/\s+/g, ' ').slice(0, 160)}` : undefined,
    when: ago(o.created_at),
    refs: o.refs,
    ghosts: o.unresolved,
    // A row that placed nothing is a MISSING row even if it is also unfolded:
    // the tone answers "what does this say about the graph", not "what state is
    // this row in".
    tone: o.refs.length ? 'read' : 'missing',
    tags: [o.source, ...(o.folded_at ? [`folded: ${o.outcome ?? 'yes'}`] : ['unfolded'])],
  }));
  const ghosts = new Set(rows.flatMap((r) => r.ghosts ?? []));
  return {
    name: 'observations',
    title: 'Inbox',
    hint:
      `${rows.length} observation(s); ${ghosts.size} distinct name(s) resolve to nothing. ` +
      'Grey chips are those: the day reached for a node the graph does not have, which is the signal that a concept is missing.',
    rows,
    blind: rows.filter((r) => !r.refs.length).length,
  };
}

/**
 * THE FRICTION LEDGER — where memory failed whoever was using it.
 *
 * Node-level refs are not available here and never will be: a `bypass` row is
 * someone reading a FILE because the API could not answer, so the finest thing
 * it can name is the domain they opened. That is a real answer rather than a
 * missing one, and it is why `domains` exists on the row alongside `refs` —
 * lighting a whole hull is the honest resolution of "somewhere in here".
 */
function frictionLens(): Lens {
  const known = new Set([...loadGraph().entities.values()].map((e) => e.domain));
  const rows: LensRow[] = openFriction().map((f) => {
    // Signatures look like `read:paperwork/_map.md`, `search:core-api/…`,
    // `shell:…`, or `entities.find:miss` — the part before the first slash of
    // the target is the domain, when there is one.
    const target = f.signature.includes(':') ? f.signature.slice(f.signature.indexOf(':') + 1) : '';
    const domain = target.split('/')[0] ?? '';
    return {
      id: `fric-${f.id}`,
      title: f.signature,
      subtitle: f.detail?.replace(/\s+/g, ' ').slice(0, 200),
      when: ago(f.last_at),
      refs: [],
      domains: known.has(domain) ? [domain] : [],
      tone: f.kind === 'bypass' || f.kind === 'missing_concept' ? 'missing' : 'read',
      tags: [f.kind, `${f.hits}x`, ...(f.session_key ? [f.session_key] : [])],
    };
  });
  return {
    name: 'friction',
    title: 'Friction',
    hint:
      `${rows.length} open. A bypass is someone who had a question and read a file instead — the API could not answer it. ` +
      'These light a whole domain, not a node: the finest thing a file read can name is the folder it opened.',
    rows,
    blind: rows.filter((r) => !r.domains?.length).length,
  };
}

/** RETRIEVAL EPISODES — one question, and the path memory took to answer it. */
function episodesLens(): Lens {
  const rows: LensRow[] = recentRetrievalEpisodes(100).map((e) => ({
    id: `ep-${e.id}`,
    title: e.trigger,
    subtitle: e.path || '(never reached the graph)',
    when: ago(e.started_at),
    refs: e.refs ? (JSON.parse(e.refs) as string[]) : [],
    tone: e.outcome === 'bypassed' || e.outcome === 'no-reach' ? 'missing' : 'read',
    tags: [
      e.actor,
      `${e.steps} graph step(s)`,
      ...(e.tree ? [`${e.tree} tree read(s)`] : []),
      ...(e.bypasses ? [`${e.bypasses} bypass`] : []),
      e.outcome ?? 'running',
    ],
  }));
  return {
    name: 'episodes',
    title: 'Questions',
    hint:
      'One row per question asked of memory, with the path it walked. A row marked bypassed is a question the graph could not serve — ' +
      'that is what the night is meant to restructure away.',
    rows,
    blind: rows.filter((r) => !r.refs.length).length,
  };
}

/**
 * THE NIGHTS — every fold, what it changed in the graph, and where in the tree.
 *
 * `dreams` and `grows` are ONE LENS and not two, because they are one event:
 * a pass writes the report and the change-log microseconds apart in the same
 * function, and they join exactly on `created_at` (verified 1:1 across the
 * live table). Two panels would have shown the same night twice and made the
 * operator correlate them by timestamp — which is the manual join this whole
 * surface exists to abolish.
 *
 * Two granularities on one row, deliberately, because a fold works on two
 * stores at once: `refs` are the ENTITIES it wrote (joined on the pass window),
 * `domains` are the tree files it edited. A night that changed prose and no
 * nodes looks different from one that changed nodes and no prose, and that
 * difference is the M5 convergence story made visible.
 */
function nightsLens(chatId: number): Lens {
  const rows: LensRow[] = recentDreams(chatId, 60).map((d) => {
    const refs = dreamFootprint(d.covers_to ?? null, d.created_at);
    const grow = growAt(chatId, d.created_at);
    let domains: string[] = [];
    let files = 0;
    if (grow?.changes) {
      try {
        const ch = JSON.parse(grow.changes) as Array<{ path?: string }>;
        files = ch.length;
        domains = [...new Set(ch.map((c) => (c.path ?? '').split('/')[0]).filter(Boolean))] as string[];
      } catch {
        // A malformed change-log is not a reason to lose the night.
      }
    }
    // THE REPORT'S CONCLUSION, NOT ITS OPENING.
    //
    // The first line is always the agent narrating its plan — "I'll start with
    // the mandatory first jobs…" — so heading the row with it made all sixty
    // nights read identically. The NIGHT REPORT is written LAST by
    // construction, so the tail is the part that says what the night decided.
    const lines = d.report
      .split('\n')
      .map((l) => l.replace(/^[#>*\s]+/, '').trim())
      // Drop what `rewritePass` APPENDS after the fact — the root-budget
      // warning and the orphan-map guard are the code talking, not the night,
      // and they are the literal last lines whenever they fire.
      .filter((l) => l.length > 40 && !l.startsWith('\u26A0'));
    const head = lines.at(-1) ?? lines[0] ?? '(no report)';
    return {
      id: `night-${d.id}`,
      title: `#${d.id} — ${head.slice(0, 160)}`,
      subtitle: d.covers_from ? `covers ${d.covers_from} → ${d.covers_to} UTC` : undefined,
      when: ago(d.created_at),
      refs,
      domains,
      tone: 'changed',
      tags: [
        `${refs.length} node(s)`,
        `${files} file(s)`,
        ...(refs.length === 0 && files === 0 ? ['changed nothing'] : []),
      ],
    };
  });
  const quiet = rows.filter((r) => !r.refs.length).length;
  return {
    name: 'nights',
    title: 'Nights',
    hint:
      `${rows.length} fold(s); ${quiet} wrote no graph node at all. Hover to light what a night changed. ` +
      'Nodes come from the write journal over the pass window; domains are the tree files the same pass edited.',
    rows,
    blind: quiet,
  };
}

/**
 * FINDINGS — what the night wants changed in the BOT, not in the memory.
 *
 * The one lens that is mostly blind by nature, and it is kept honest rather
 * than made to look busy: a finding is usually a proposal about `src/`, and
 * `src/` is not in the graph. Where a body names a real entity id it is
 * linked — by EXACT full-id match, never by fuzzy resemblance. That is the
 * same rule the focus ref follows and for the same reason, except that a full
 * `domain/slug` occurring verbatim in prose is unambiguous where a bare label
 * is not: 6 of 32 findings name one, and inventing links for the other 26
 * would be worse than showing them dark.
 */
function findingsLens(chatId: number): Lens {
  const ids = [...loadGraph().entities.keys()];
  const rows: LensRow[] = allFindings(chatId, 200).map((f) => ({
    id: `find-${f.id}`,
    title: f.body.replace(/\s+/g, ' ').slice(0, 180),
    subtitle: f.verify ? `verify: ${f.verify.slice(0, 140)}` : 'unfalsifiable — nothing but a human can tell this from stale',
    when: ago(f.created_at),
    refs: ids.filter((id) => f.body.includes(id)),
    tone: f.status === 'pending' ? 'missing' : 'changed',
    tags: [
      f.kind,
      f.status,
      ...(f.verdict ? [f.verdict] : []),
      ...(f.dream_id ? [`night #${f.dream_id}`] : []),
    ],
  }));
  const open = rows.filter((r) => r.tone === 'missing').length;
  return {
    name: 'findings',
    title: 'Findings',
    hint:
      `${rows.length} finding(s), ${open} still open. These are proposals about the BOT, not the memory — most point at code, ` +
      'so most are dark here. A row lights up only where its text names a real entity id outright.',
    rows,
    blind: rows.filter((r) => !r.refs.length).length,
  };
}


/**
 * MOVEMENTS — what the machine noticed change under a watched item.
 *
 * The cheapest lens in the set, and the one that proves the design: it stores
 * no refs of its own and never will. A movement is about the thing being
 * WATCHED, so its pointer is the focus item's pointer, joined at read time.
 * Storing a copy would be the authored version of a derivable fact (I2) and
 * would go stale the instant the item was re-pointed.
 *
 * The consequence is worth stating plainly rather than hiding: this lens is as
 * dark as the focus set is, and it lights up on its own as refs get filled in.
 * A panel whose blindness has ONE upstream cause is better than five panels
 * each blind for a different reason.
 */
function movementsLens(): Lens {
  const rows: LensRow[] = recentFocusChanges(200).map((m) => {
    const before = (m.before ?? '').replace(/\s+/g, ' ').slice(0, 70);
    const after = (m.after ?? '').replace(/\s+/g, ' ').slice(0, 70);
    return {
      id: `move-${m.id}`,
      title: m.label,
      subtitle: m.observation?.trim()
        ? m.observation.replace(/\s+/g, ' ').slice(0, 180)
        : `${before || '(nothing)'}  →  ${after || '(nothing)'}`,
      when: ago(m.created_at),
      refs: m.ref ? [m.ref] : [],
      tone: 'read',
      tags: [
        m.source,
        ...(m.band ? [m.band] : []),
        m.consumed_at ? 'seen by the concierge' : 'unread',
        ...(m.ref ? [] : ['item has no graph ref']),
      ],
    };
  });
  const linked = rows.filter((r) => r.refs.length).length;
  const unread = rows.filter((r) => r.tags?.includes('unread')).length;
  return {
    name: 'movements',
    title: 'Movements',
    hint:
      `${rows.length} change(s) detected under watched items; ${unread} not yet read by the concierge. ` +
      `${linked} point at an entity — this lens carries no refs of its own, it borrows the focus item's, so it lights up exactly as fast as the focus set does.`,
    rows,
    blind: rows.length - linked,
  };
}

export const LENS_NAMES = ['focus', 'observations', 'friction', 'episodes', 'nights', 'findings', 'movements'] as const;
export type LensName = (typeof LENS_NAMES)[number];

export function lens(name: string): Lens | undefined {
  const chatId = [...config.allowedChatIds][0] ?? 0;
  switch (name) {
    case 'focus':
      return focusLens(chatId);
    case 'observations':
      return observationsLens();
    case 'friction':
      return frictionLens();
    case 'episodes':
      return episodesLens();
    case 'nights':
      return nightsLens(chatId);
    case 'findings':
      return findingsLens(chatId);
    case 'movements':
      return movementsLens();
    default:
      return undefined;
  }
}
