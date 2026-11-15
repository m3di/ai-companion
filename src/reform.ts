import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { extractUsage } from './claude.js';
import { episodeProjects, episodesByProject, recordBotSession, saveUsage, searchChatMessages } from './db.js';
import { DATA_FILE, ENTITY_KINDS, EDGE_RELS, type Diagnostic, formatDiagnostics, lintText, renderRecords, toRow, VIEW_FILE } from './entities.js';
import { stripLoneSurrogates } from './format.js';

/**
 * THE REFORMER (round 8) — "a mechanism to put it in shape: reads each domain
 * entirely and reads all retrievable resources and entities like messages,
 * episodes, workers, and then writes the formal knowledge shape" (Mehdi).
 *
 * One domain per pass, evidence-complete. Evidence is gathered in CODE rather
 * than by giving the model tools: the gathering is deterministic and cheap, the
 * writing is the only part that needs judgment, and a model that cannot wander
 * cannot quietly reform a domain from half the record. Same bargain distill.ts
 * already makes.
 *
 * The output is LINTED before it lands. Attempt 1 generates the file; every
 * later attempt REPAIRS only the records that failed, spliced back by id. A
 * domain that never comes clean keeps its previous file — a half-formal domain
 * is worse than a prose one, because everything downstream would compute on it
 * as if it were true.
 */

const SYSTEM = `You convert one DOMAIN of a knowledge base from prose into a formal ENTITY GRAPH.

You are given every file the domain currently has, plus the raw evidence behind it: chat messages, work-session recaps, and the domain's own notes. Your output is the complete new \`entities.md\` for this domain — a stream of records — and NOTHING else. No prose around it, no fences, no explanation.

## The record format (a restricted grammar — a parser rejects anything else)

\`\`\`
---
id: <domain>/<kebab-name>
kind: <one of: ${ENTITY_KINDS.join(' | ')}>
aka: ["#2830", "the tracker_code bug", "CSV reuse"]
facts:
  - one timeless assertion per line
edges:
  <one of: ${EDGE_RELS.join(' | ')}>: [other/entity-id]
probe: <a deterministic command with SMALL, STABLE output>
closed_when: <regex over the probe output meaning "this is finished">
actor: <who must act NEXT — "mehdi" if it is his ball, else the person's name; it MUST match a person entity in \`people/\`>
dormant: true
goal: true
chain: [msg#4908, episode#2347, "repo:path/file.ts:61", "https://github.com/…"]
note: one optional short line of prose that genuinely does not fit above
---
\`\`\`

## The rules that decide whether your output is accepted

1. **FACTS NEVER BECOME FALSE.** That is the whole test — not "does it mention a date or a status", but "could this sentence ever stop being true?"
   - PERMANENT, so it is a fact: "tracker_code is globally unique across clients" · "report_ingest_mode was dropped, replaced by ClientReport" · "shipped in PR #91, merged to main 2026-07-05" · "Fibery epic #2772, created 2026-07-20". Completed history and absolute dates are FINE — they are anchors, and they never change.
   - PERISHABLE, so it is rejected: "the fix is in progress" · "#2830 is open, nobody is on it" · "blocked on Sami" · "~3 weeks left" · "next step is the rebase" · "as of today it is still present". Present-tense status and time measured FROM NOW both go stale the moment nobody rewrites them.
   State comes from the \`probe\`, never from you. If a sentence tells you where something stands RIGHT NOW, it is not a fact — write the probe that answers it instead.
2. **NEVER WRITE \`state:\` OR \`state_at:\`.** Those belong to the prober alone. Write the \`probe\` that will answer the question; the machine fills in the answer.
3. **EVERY ENTITY NEEDS A \`chain\`.** Message ids, episode ids, files, PR urls — the route back to the full story. An entity with no route back is a dead end and is rejected. Take the ids from the evidence you were given; never invent one.
4. **EDGE TARGETS MUST RESOLVE** to an id you define in THIS file, or one from the explicit list of already-existing entities if you were given one. No dangling references, no cycles in \`blocks\`.
   Other domains are mostly NOT reformed yet, so they have no entities to point at — \`[[ops-tool/_map]]\` is a prose note key, not an entity id, and an edge to it is rejected. When something here relates to an un-reformed domain, say so in \`note\` or put the pointer in \`chain\`; do not invent an edge for it.
5. **IDS ARE STABLE NAMES**, not descriptions: \`affiliate-app/tracker-code-uniqueness\`, not \`affiliate-app/the-bug-we-found-in-july\`.

## What to make an entity

Discovered THINGS and ACTIVITIES: a system, a component, a constraint, a task, a PR, a person, a process and its steps, a decision, a project. If the prose says a thing exists, it is an entity. If the prose describes how something WORKS, that is a \`fact\` on the entity it is about.

- **Prefer FEWER, BIGGER entities.** One entity per real thing. Do not split a component into five records because the prose had five sentences about it.
- **A process becomes steps with \`blocks\` edges**, and its outcome carries \`goal: true\`. That is what lets the machine compute the critical path — which the prose currently maintains by hand and gets wrong.
- **\`actor\` is who must move NEXT.** Use "mehdi" only when it is genuinely his move; this is what puts an item at the top of his focus list, so a wrong one is expensive.
- **\`dormant: true\` for work that is real but deliberately PARKED** — sunsetting, deferred, "hands-off operationally", an idea nobody has picked up. It stays in the index and stays probed; it just stops competing for attention. A dormant entity must NOT name an \`actor\`: if someone is moving it, it is not parked. Use this rather than leaving a shelved project looking like today's work.
- **A probe must be COPIED FROM THE RECIPES BELOW.** It runs outside the sandbox, so only these command shapes are accepted. Anything else — including a shorthand you invent — is rejected.

## Probe recipes (use these verbatim, substituting the id)

\`\`\`
# a Fibery task's state — the standard probe for anything tracked in Fibery
~/Projects/brain-fibery/scripts/fibery show Task 2830 --json | jq -r .state
closed_when: (Archived|Done|Completed|Rejected)
# The states this Fibery actually uses are Idea, To Do, Planning, Next Cycle,
# In Progress, In Review, For Testing, Tested, On Hold, Archived. ARCHIVED is
# the terminal one — use the closed_when above verbatim.

# a GitHub PR — state plus whether review is settled
gh pr view 3181 --repo acme/core-api --json state,reviewDecision -q '.state+" "+.reviewDecision'
closed_when: (MERGED|CLOSED)

# a PR's CI
gh pr checks 3181 --repo acme/core-api --json name,state -q '.[]|.name+" "+.state'

# a constraint or leak that should DISAPPEAR from the code when it is fixed
cd ~/Projects/affiliate-app && grep -rc "tracker_code" vue/src/import.ts
closed_when: ^0$

# whether a file/branch exists yet
cd ~/Projects/affiliate-app && git branch -r --list 'origin/fix/*'
\`\`\`

Allowed command prefixes, and nothing else: \`gh\` · \`git\` · \`grep\` · \`rg\` · \`ls\` · \`cat\` · \`test\` · \`jq\` · \`~/Projects/brain-fibery/scripts/fibery\`, optionally after a \`cd <path> &&\`.

If no command can answer it, OMIT \`probe\` and give \`status: open\` (or \`n/a\` for something that is not a loop at all, like a person or a system).

## What NOT to carry over

The prose maps carry a lot of dead state: closed watches, "LEFT UNDONE" lines, dated statuses, progress narration. Do not translate that into facts. If it describes an OPEN loop, it becomes an entity with a probe. If it describes a finished one, it becomes an entity with \`status: closed\` only when something still depends on it — otherwise drop it; the traces keep the history.

Be thorough about COVERAGE (every real thing in the domain gets a record) and ruthless about STATE (none of it belongs in your output).`;

export interface ReformResult {
  domain: string;
  ok: boolean;
  text?: string;
  errors?: string;
  attempts: number;
  costUsd: number;
  entities: number;
}

/** Everything on disk for a domain — the reform reads it ALL, by design. */
function domainFiles(domain: string): Array<{ name: string; text: string }> {
  const dir = join(config.knowledgeDir, domain);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'entities.md')
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
}

/**
 * Pull the raw record behind the domain: the messages that discussed it and the
 * work sessions that touched it. This is the half the prose maps were written
 * FROM, and re-reading it is what lets the reform recover chain ids the prose
 * dropped — an entity is only as good as its route back.
 */
function evidenceFor(chatId: number, domain: string, terms: string[]): string {
  const parts: string[] = [];

  const seen = new Set<number>();
  const hits: string[] = [];
  for (const term of terms) {
    for (const m of searchChatMessages(chatId, term, 12)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      hits.push(`msg#${m.id} [${m.created_at}] ${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  }
  if (hits.length) parts.push(`## Chat messages mentioning this domain (ids are chain anchors)\n${hits.slice(0, 60).join('\n')}`);

  // Episodes are keyed by PROJECT DIRECTORY ("affiliate-app", "Core-API"), which
  // is not the vocabulary a knowledge domain uses. Matching the search terms
  // directly found nothing at all — the reform was silently running on prose
  // alone, which is exactly the blindness it exists to fix. So resolve domain →
  // project by fuzzy name match first.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = norm(domain);
  const projects = episodeProjects()
    .filter((p) => {
      const n = norm(p.project);
      return n === wanted || n.includes(wanted) || wanted.includes(n);
    })
    .map((p) => p.project);

  const eps: string[] = [];
  for (const term of projects) {
    for (const e of episodesByProject(term, 12)) {
      const recap = e.recap ? (JSON.parse(e.recap) as { headline?: string; openLoops?: string[]; followUp?: string }) : undefined;
      eps.push(
        `episode#${e.id} [${e.started_at}] ${e.project}: ${recap?.headline ?? e.title ?? '(no recap)'}` +
          (recap?.openLoops?.length ? `\n   left open: ${recap.openLoops.join('; ')}` : '') +
          (recap?.followUp ? `\n   follow-up: ${recap.followUp}` : ''),
      );
    }
  }
  if (eps.length) parts.push(`## Work sessions touching it (ids are chain anchors)\n${[...new Set(eps)].slice(0, 40).join('\n')}`);

  return parts.join('\n\n') || '(no message or session evidence found for this domain)';
}

/** Search terms for a domain: its own name plus its note keys, which are the
 *  vocabulary the prose already decided matters. */
function termsFor(domain: string, files: Array<{ name: string }>): string[] {
  const fromFiles = files.filter((f) => f.name !== '_map.md').map((f) => f.name.replace(/\.md$/, '').replace(/-/g, ' '));
  return [domain.replace(/-/g, ' '), ...fromFiles].slice(0, 8);
}

async function askModel(prompt: string, chatId: number): Promise<{ text: string; costUsd: number }> {
  let text = '';
  let costUsd = 0;
  for await (const m of query({
    prompt: stripLoneSurrogates(prompt),
    options: {
      systemPrompt: SYSTEM,
      allowedTools: [],
      disallowedTools: ['Bash', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissionMode: 'bypassPermissions',
      settingSources: [],
      ...(config.reformModel ? { model: config.reformModel } : {}),
    },
  }) as AsyncIterable<any>) {
    if (m.session_id) recordBotSession(String(m.session_id), 'reform');
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) if (b.type === 'text' && b.text) text += b.text;
    } else if (m.type === 'result') {
      const usage = extractUsage(m);
      if (usage) {
        saveUsage(`${chatId}:reform`, usage);
        costUsd += usage.costUsd;
      }
      if (m.subtype !== 'success') throw new Error(String(m.subtype ?? 'error'));
    }
  }
  return { text, costUsd };
}

/**
 * Strip what a model wraps around the file despite being told not to: a
 * ```-fence, and — seen on a real retry — a line of narration before the first
 * record ("Looking at the errors, I need to fix…"). Both are presentation, not
 * content, and failing a whole domain over them wastes the entire pass.
 */
function unfence(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1]!.trim();
  const first = t.split('\n').findIndex((l) => l.trim() === '---');
  return first > 0 ? t.split('\n').slice(first).join('\n').trim() : t;
}

/** A record block in a draft: a `---` fence and everything up to the next one. */
interface Block {
  start: number; // 1-indexed line of the fence
  end: number; // 1-indexed last line
  text: string;
  id: string;
}

function splitRecords(text: string): Block[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (l.trim() === '---') starts.push(i + 1);
  });
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! - 1 : lines.length;
    const body = lines.slice(start - 1, end);
    return { start, end, text: body.join('\n'), id: body.find((l) => /^id:\s/.test(l))?.replace(/^id:\s*/, '').trim() ?? '' };
  });
}

const REPAIR_SYSTEM = `You are FIXING individual records in a knowledge-base entity file. You are given only the records that failed validation, each with its exact errors.

Return ONLY the corrected records, in the same order, each opening with a \`---\` fence. Keep every \`id\` exactly as it is. Change nothing except what the errors demand — every other record in the file already passed and is not your concern.

${SYSTEM.slice(SYSTEM.indexOf('## The rules that decide'))}`;

/**
 * REPAIR, don't regenerate.
 *
 * The first design re-asked for the WHOLE file on every retry, and it did not
 * converge: a real run went 25 errors → 4 → 14. Regenerating 60 records to fix
 * 4 rewrites the 56 that were already correct, and reintroduces different
 * mistakes in them. Sending only the failing records keeps the passing ones
 * literally untouched, so each pass can only improve — and it costs a fraction,
 * since the retry carries four records instead of six hundred lines.
 */
async function repairRecords(
  draft: string,
  errors: Diagnostic[],
  chatId: number,
): Promise<{ text: string; costUsd: number } | undefined> {
  const blocks = splitRecords(draft);
  const failing = new Map<string, { block: Block; msgs: string[] }>();
  for (const e of errors) {
    const b = blocks.find((x) => e.line >= x.start && e.line <= x.end) ?? blocks.find((x) => x.id === e.id);
    if (!b) return undefined; // an error outside any record — repair cannot target it
    if (!failing.has(b.id)) failing.set(b.id, { block: b, msgs: [] });
    failing.get(b.id)!.msgs.push(e.message);
  }
  if (!failing.size) return undefined;

  const prompt = [...failing.values()]
    .map((f) => `## Record \`${f.block.id}\` — errors:\n${f.msgs.map((m) => `- ${m}`).join('\n')}\n\nIts current text:\n${f.block.text}`)
    .join('\n\n');

  let text = '';
  let costUsd = 0;
  for await (const m of query({
    prompt: stripLoneSurrogates(`${prompt}\n\nReturn the ${failing.size} corrected record(s), \`---\`-fenced, ids unchanged.`),
    options: {
      systemPrompt: REPAIR_SYSTEM,
      allowedTools: [],
      disallowedTools: ['Bash', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissionMode: 'bypassPermissions',
      settingSources: [],
      ...(config.reformModel ? { model: config.reformModel } : {}),
    },
  }) as AsyncIterable<any>) {
    if (m.session_id) recordBotSession(String(m.session_id), 'reform');
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) if (b.type === 'text' && b.text) text += b.text;
    } else if (m.type === 'result') {
      const usage = extractUsage(m);
      if (usage) {
        saveUsage(`${chatId}:reform`, usage);
        costUsd += usage.costUsd;
      }
      if (m.subtype !== 'success') throw new Error(String(m.subtype ?? 'error'));
    }
  }

  // Splice by ID, never by position: a reply that drops or reorders a record
  // must not silently overwrite a different one.
  const fixed = new Map(splitRecords(unfence(text)).map((b) => [b.id, b.text]));
  const merged = blocks.map((b) => fixed.get(b.id) ?? b.text);
  return { text: merged.join('\n'), costUsd };
}

/**
 * Reform ONE domain. `outDir` sends the result to a staging tree instead of the
 * live one — which is how this gets iterated on before any real migration.
 */
export async function reformDomain(
  chatId: number,
  domain: string,
  opts: { outDir?: string; knownIds?: string[] } = {},
): Promise<ReformResult> {
  const files = domainFiles(domain);
  if (!files.length) return { domain, ok: false, errors: 'no files in that domain', attempts: 0, costUsd: 0, entities: 0 };

  const terms = termsFor(domain, files);
  const evidence = evidenceFor(chatId, domain, terms);
  const current = files.map((f) => `### ${f.name}\n${f.text}`).join('\n\n');
  const known = opts.knownIds?.length
    ? `\n\nEntities that ALREADY EXIST in other domains (you may point edges at these, and must NOT redefine them):\n${opts.knownIds.join('\n')}`
    : '';

  const base =
    `DOMAIN: ${domain}\n\n## The domain's current files (prose — this is what you are replacing)\n${current}\n\n${evidence}${known}\n\n` +
    `Write the complete new \`${domain}/entities.md\`. Records only.`;

  let costUsd = 0;
  let lastErrors = '';
  let lastDiagnostics: Diagnostic[] = [];
  let body = '';
  // Attempt 1 GENERATES; every later attempt REPAIRS only the failing records.
  // Regenerating the whole file to fix a few records does not converge — a real
  // run went 25 errors → 4 → 14, because rewriting the 56 correct records
  // reintroduced different mistakes in them.
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt === 1) {
      const { text, costUsd: c } = await askModel(base, chatId);
      costUsd += c;
      body = unfence(text);
    } else {
      const repaired = await repairRecords(body, lastDiagnostics, chatId);
      if (!repaired) break; // nothing targetable — stop rather than burn a pass
      costUsd += repaired.costUsd;
      body = repaired.text;
    }
    const { entities, errors } = lintText(body, domain, opts.knownIds ?? []);
    lastDiagnostics = errors;
    if (!errors.length) {
      const dir = join(opts.outDir ?? config.knowledgeDir, domain);
      mkdirSync(dir, { recursive: true });
      // DATA first, VIEW second. The model authors records because it is good at
      // that and the diagnostics are good; what LANDS is rows, so retrieval can
      // filter before anything reaches a prompt and a schema change stays a code
      // edit instead of a re-reform.
      writeFileSync(join(dir, DATA_FILE), `${entities.map(toRow).join('\n')}\n`);
      writeFileSync(join(dir, VIEW_FILE), renderRecords(entities));
      return { domain, ok: true, text: body, attempts: attempt, costUsd, entities: entities.length };
    }
    lastErrors = formatDiagnostics(errors);
    // A bare count is useless for tuning the rules — the question is always
    // WHICH rule is firing, and whether it is firing correctly. Group by the
    // message's leading phrase so a run prints its failure shape, not its size.
    const byClass = new Map<string, number>();
    for (const e of errors) {
      const cls = e.message.split(/[:—(]/)[0]!.trim().slice(0, 60);
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    }
    const shape = [...byClass.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${n}× ${c}`)
      .join(' · ');
    console.warn(`[reform] ${domain} attempt ${attempt}: ${errors.length} lint error(s) — ${shape}`);

  }
  return { domain, ok: false, errors: lastErrors, attempts: 4, costUsd, entities: 0, text: body };
}
