import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from './config.js';
import { pulse } from './pulse.js';
import { noteToolCall } from './friction.js';
import { buildModuleTools, catalogSection, MODULE_TOOL_NAMES } from './moduleTools.js';
import { extractUsage } from './claude.js';
import { beginDream } from './mode.js';
import { settleTonight } from './night.js';
import {
  addCommitment,
  chatTimelineBetween,
  clearSession,
  chatTimelineCountBetween,
  dbNow,
  deferCommitment,
  episodesInWindow,
  episodesInWindowCount,
  eventsSince,
  getCard,
  getMessageById,
  getSession,
  searchChatMessages,
  closeRetrievalEpisode,
  lastDreamCoveredTo,
  unfiledTurns,
  openRetrievalEpisode,
  latestContextInfo,
  listCommitments,
  listSessions,
  pendingFindings,
  postEvent,
  recentDreams,
  recentGrows,
  rescopeCommitment,
  resolveCommitment,
  setFocusFields,
  foldObservation,
  debugSessionsSince,
  pendingObservations,
  resolveFinding,
  setFindingVerify,
  retrievedKeys,
  saveDream,
  saveDreamFinding,
  saveGrow,
  saveUsage,
  sessionKey,
  setSessionStatus,
  topRetrievals,
  addProposalEvidence,
  amendDesignProposal,
  createDesignProposal,
  listDesignProposals,
  mergeDesignProposals,
  PROPOSAL_STATUSES,
} from './db.js';
import {
  archiveTreeForReconstruction,
  knowledgePath,
  linkHealth,
  listNotes,
  moveNote,
  deleteNote,
  rebuildIndex,
  restoreArchivedTree,
  rootBudget,
  restoreFile,
  rootContext,
  rootSection,
  snapshotNotes,
} from './knowledge.js';
import { CONTROL_SLOT } from './sessions.js';
import { fmtLocal, parseLocalWhen, toUtcDb } from './commitments.js';
import { chunkRaw, stripLoneSurrogates, toTelegramMarkdown } from './format.js';
import type { ChatTransport } from './transport/types.js';
import { harvestAll } from './harvest.js';
import { proposalLine, renderProposal } from './proposals.js';
import { distillPending } from './distill.js';
import { checkCommandAllowed } from './focus.js';
import { renderAudit, runAudit } from './audit.js';
import { plan, renderPlan, skipPacket } from './gardener.js';
import { parkUnanswered } from './silence.js';
import { applyStoryRewrite, storyWorklist } from './storyTree.js';
import { deleteUnstampedDoorDecisions, listStoryNodes, stampDoorDecisions } from './db.js';
import { decideDoor, doorsBlock, offerDoors } from './doors.js';
import { datedBlock, datedForPass, decideDated, offerDated } from './dated.js';
import { deleteUnstampedDatedVerdicts, stampDatedVerdicts } from './db.js';

/**
 * The REWRITE OPERATOR — the one background mind that maintains this
 * companion's memory (round 5; replaced dream+grow and defrag). One operation,
 * `rewrite(memory, evidence)`, at two frequencies:
 *  - 'nightly': reflect over the day's window AND act in the same context —
 *    rewrite touched domain maps + the root's volatile lines, keep every node
 *    bounded and true, file reminders as commitments, distill + archive idle
 *    threads, queue operator-gated proposals. Journaled to `dreams`
 *    (the night report) + `grows` (the file change-log).
 *  - 'reconstruction' (/defrag): archive the whole tree and rebuild it — root
 *    first — from understanding; restore wholesale on failure.
 * Sandbox: the toolset is the boundary — file tools inside the knowledge dir
 * plus narrow bot-memory tools; no shell, no subagents, no web. Code/prompts
 * stay operator-gated (proposals), never self-applied.
 */

/**
 * THE NIGHT'S ONE NAME FOR ITSELF.
 *
 * It had two. The module tools were built with `'nightly'`, while the tool log
 * and the retrieval episode used `${chatId}:operator` — so a pass recorded its
 * PATH under one session and resolved its REFS under another. The first real
 * night after episodes shipped proved it: dream #71 logged
 * `health→find→find→unconfirmed→confirm→…` across 11 steps and attached zero
 * entity ids, because `noteRetrievalRefs('nightly', …)` looked for an open
 * episode under a key nobody had opened one under.
 *
 * The lesson is the session's own, three times over now: a thing that names
 * itself twice will eventually be two things. `cycleCli`'s `isNight` already
 * accepts both spellings, which is exactly how the split survived unnoticed.
 */
const NIGHT_SESSION = 'nightly';

export type RewriteScope = 'nightly' | 'reconstruction';

const IDLE_ARCHIVE_DAYS = 7;

// Max local episodes the nightly summarises before building the digest. The
// queue is already bounded (only new / grown-by-6-turns bursts), so a normal
// day is a handful; the cap only guards against a backlog after downtime.
const LOCAL_DISTILL_CAP = 30;

// Timeline caps (proven in rounds 1-4: user text carries the learnings).
const TIMELINE_LIMIT = 400;
const USER_CAP = 700;
const BOT_CAP = 300;

const SHARED_RULES = `Rules:
- Ground everything in the evidence and the files — never invent facts; never delete knowledge you cannot replace (leads make deletion safe: the traces hold every detail).
- Work ONLY in your working directory with the provided tools, yourself — no subagents. Never touch the bot's source or prompts — a code/prompt change is a PROPOSAL (proposeChange), strictly operator-gated.
- Do not edit index.md (generated). [[links]] must resolve when you finish ([[folder/_map]] is a valid target; root.md may carry links but is never a link target).
- root.md is structure, NOT a note: no frontmatter; exact sections ## How to behave / ## Domains / ## Global facts / ## Now; HARD CAP ~10k chars.`;

const TREE_REGIME = `THE TREE (your working directory — file tools + moveNote/deleteNote): DOMAIN MAPS + LEADS + rare depth notes — a semantic INDEX over the traces (message log, session transcripts, Fibery, git/PRs hold every detail; the tree holds understanding).
- Each domain folder's _map.md IS the knowledge: a 60-second briefing (what the domain is; the source of truth OUTSIDE this KB; the roster with one-phrase states; the arc; recurring lessons), ending in a LEADS list — one-liners with action verbs + keywords + where to dig.
- DEFAULT ACTION for new knowledge: amend the domain's map — a briefing line or a lead. NEVER create a note for a task, bug, or PR; that history compresses to a lead.
- FACTS, NOT STATE. The tree carries what stays true after the work closes: a constraint ("tracker_code is globally unique across clients"), a mechanism, a decision and its reason, where the source of truth lives. It does NOT carry the state of work — "filed as #2830", "not done yet", "next step is the rebase" — because the tracker, GitHub and the FOCUS SET all move without telling the file, so state written here is wrong within days and lies with confidence. A work item earns a NAME and a POINTER in the map ("tracker_code uniqueness → [[#2830]]") and nothing more. When you find status prose silted into a map, that is the push-down: keep the durable sentence, move the open loop onto a focus item, delete the rest.
- A DEPTH NOTE is the exception (≤1-2 per domain): only cold-operational content needed live at a terminal (access paths + exact commands, a dangerous mechanism + verify steps).
- A discovered SYSTEM or standing area gets its own domain folder — map first.
- Maps may end with an "## Open possibilities" section — dated one-line ideas jotted by the day's agents. AGE THEM: fold what matured into the briefing or a commitment, delete what stayed cold for weeks; at most a handful per map.

THE RETRIEVABILITY BAR — how much to write, exactly. Write the CONCLUSION plus enough handles that everything you left out can be fetched on demand; never the transcript. A note passes the bar when a future agent holding only that note can reconstruct the full context from the traces WITHOUT you having written it down. So every non-obvious claim carries its way back: \`readMessage #N\` ids for what the user said or pasted (search the log for them — they are exact and free), a grep keyword for a file or memo, a thread/session to dig, the outside source of truth. A note that states a conclusion with no route back is a dead end the moment it goes stale; a note that copies the whole source is silt. Prefer three ids and a sentence over three paragraphs.

THE SHAPE THAT WORKS — a domain is at its best as a short _map.md (framing · players · the two-part process · the ONE critical path · dated status · links to depth notes · a Retrieval line · Leads), plus a few TOPIC-scoped depth notes, each opening with the readMessage ids for its own subject. Readable, minimal, retrievable. Move the other domains toward it as their evidence warrants — reshape a domain when the day gives you real reason to touch it, not all at once.`;

const ROOT_REGIME = `THE ROOT (root.md): the always-on core — the concierge is injected with the WHOLE root every turn; workers get only ## How to behave. Edit directly with file tools.
- ## How to behave: one line per habit — the general principle as an instruction + terse dated provenance. Evidence bar: an explicit user correction earns a habit at once; an inferred pattern needs the same friction on two different days. MERGE near-duplicates, generalize wording, retire habits whose reason disappeared. Habits change rarely.
- ## Global facts: standing, truly-global facts only; silted per-topic state moves to a domain map.
- ## Domains: one line per domain folder — keep it matching the tree.
- ## Now: rewrite it EVERY pass — a few volatile lines only (active focus, key open commitments). This is the section that churns. When a bullet's truth depends on a watched item, name it as "commitment #N" (that exact phrasing) so a resolved watcher can be caught. If the digest flags an ORPHANED WATCHER, that bullet's keeper is gone — reconfirm it from fresh evidence or delete it.

PUSH DOWN, EVERY PASS — the root is an ATTENTION SURFACE, not a store. Its job is to make a fresh agent ask the right question and know which map answers it; the answer itself belongs in the map. So every pass, before you add anything: find the lines that have SILTED — a bullet that grew specifics (ticket numbers, states, per-project detail, a habit that is really domain knowledge) — MOVE that detail into the owning _map.md and leave behind at most a keyword-bearing pointer with its [[link]]. A root line should be the shortest thing that still makes someone open the right file. Trimming words is not push-down; relocating content is.
The whole file stays under its cap — it is a per-turn context tax paid on EVERY concierge turn. Going over does not error: the injector truncates the TAIL, and the tail is ## Now — the most volatile section, silently gone. If the budget line says you are over, pushing detail down is not optional, and shrinking the file is the pass's FIRST job, not its last.`;

const NIGHTLY_SYSTEM = `You are the nightly REWRITE OPERATOR of this companion bot — its one background mind. While the user sleeps you consume the day's evidence (digest below: the root, thread cards, the day's events, open commitments, retrieval counters, and the chronological conversation timeline) and REWRITE the memory so tomorrow's system is smaller and truer. You reflect and act in the same context: notice what the day taught, then make the files and ledgers say it.

0. THE MACHINE'S OWN HEALTH (the audit block at the top of the digest) — READ IT FIRST, before a word of the day's content. It reports the system's own discomfort: the test suite, the typecheck, probe coverage and clock, checks that could not answer, the friction ledger, whether the knowledge API was called at all, and the observation inbox. EVERY input is listed whether or not it fired, because "nothing to report" and "nobody looked" are different answers and the whole point of the block is to keep them apart.
- A RED SUITE OR TYPECHECK OUTRANKS EVERYTHING. It means the measurements below it are suspect, and you cannot fix it — the bot's source is not yours to touch. Queue ONE proposal naming the failing test and its output, and OPEN the night report with it so Mehdi sees it at breakfast. The suite was red for three days in July with nobody told; that is the failure this exists to end.
- A FROZEN CLOCK IS A FAILURE, NOT A QUIET DAY. Probes not run in hours, or checks that never answer, mean the state you are reading is old however confident it looks. Say so in the report and name the entities.
- ZERO API CALLS IS A FINDING ABOUT THE API. An empty friction ledger next to zero calls does not mean the tools are good; it means nobody reached for them. Do not read the pair as health.
- These lines are EVIDENCE, not a checklist to echo. Act on what fired; mention the rest only if it changes what you conclude.

Your surfaces:
1. ${TREE_REGIME}
2. ${ROOT_REGIME}
3. THREAD LIFECYCLE (listThreads / archiveThread): the digest lists ARCHIVE CANDIDATES — threads idle >${IDLE_ARCHIVE_DAYS} days with no open commitment. For EACH: distill any durable residue FIRST (a lead on its domain's map — most one-shot threads have none; their traces remain searchable), then archiveThread(slot, observation) with a one-line closing observation. A thread flagged near its context limit will auto-compact (oldest detail dies first) — anything durable still only in that thread must land in the tree TONIGHT.
4. COMMITMENTS (listCommitments / commit / updateCommitment): keep the prospective table TRUE — mark done what the day unblocked, drop dead entries, record what the day parked on a person/event/time that nobody recorded (with howToCheck). When the day earns the user a REMINDER, commit it directly: when = the local time it should fire ("HH:mm" next occurrence or "YYYY-MM-DD HH:mm"; use "08:00" for morning-brief-time delivery), body = what to say, written as you'd say it to them. Respect any reminder preferences stated in the root — but the judgment is yours: critical/time-sensitive trumps "no reminders"; noise never does. Never touch the 'morning-brief'/'morning-routine' system rows. (The 'nightly-pipeline' row is gone: the fold is a DEBT the day waits on, not a scheduled commitment — you cannot move or disable it from here.)
5. THE FOCUS SET (the same table — a focus item is a commitment with a tier): the ONE surface the user reads to see what is open. Two jobs tonight.
- COMPLETENESS. Every open loop the day put through his hands belongs here: a task filed for him, a PR he opened, a bug he hit and did not fix, work a session left undone. Having it in Fibery or GitHub does NOT count — those hold the work item; this holds the fact that HE touched it and it has not closed. The day's local-work block is where the misses hide. Sweep it and add what is missing with commit(..., focus: N).
- TIERING. Tier 1 is what he would want interrupted for; higher tiers ride along quietly and speak up only when their check moves. HOW MANY TIERS IS YOURS TO DECIDE AND IT FOLLOWS THE SET — do not impose bands the items do not have, and do not flatten genuinely different situations into one. Re-tier every pass: what someone picked up moves up, what went quiet moves down, and unfocus is only for what stopped mattering — never for what merely got quiet, since a set that drops its quiet items is how things disappear.
- ATTACH A checkCmd wherever a command can answer the item. That is what makes a large set affordable: the checker verifies it out of process every few minutes and wakes the concierge only on a diff, so completeness costs almost nothing while silence costs nothing at all. An item with no machine check is one only a person can move — flag it as such and prefer giving it one.
6. PROPOSALS (proposeChange / pendingProposals / setProposalCheck / resolveProposal): where a fix genuinely needs the bot's code or prompts changed, queue ONE self-contained proposal naming the file — never apply it. ALWAYS give it a 'verify' command, and give one to any pending row that lacks it (setProposalCheck); a proposal that cannot name what would prove it done is not a proposal yet. Triage on the VERDICT the audit already ran, not on the body: 'shipped' means resolve it "applied" and NEVER report it as a live bug; 'NEVER CHECKED' means you cannot tell it from stale, so say so rather than repeating it as fact. On 2026-08-06 all five pending rows were already fixed and the report opened by calling them live — including one whose success was in the evidence directly above it.
   DESIGN proposals (listDesignProposals / proposeDesign / addProposalEvidence / amendDesignProposal / mergeDesignProposals) are the larger kind — how the SYSTEM works, decided by the developer, never by you. Your job on them is evidence: when tonight's friction or the day's record bears on an open row, attach it (a row that keeps gathering evidence is how the developer knows it is real); two rows about one thing get merged; and when the ledger shows a systemic failure no habit line can fix and no one-file change covers, open one with the problem as observed.
7. BEHAVIOR: diff the day's interaction friction against ## How to behave (the user repeating themselves, correcting the system, clumsy handoffs). Explicit corrections and twice-seen friction earn a habit line (general principle, never the incident).
8. LOCAL WORK (in the digest): the half of Mehdi's work this system never used to see — sessions he ran himself at a terminal, harvested and summarised. Until now your only evidence was this chat, so the tree learned only what he happened to narrate here. Treat these as first-class evidence of what he actually worked on.
9. GARDENING (gardenPlan): the graph's SHAPE, prepared. Call it once. Each packet carries the offending text, the candidates and the exact record() call, so a fix costs you a few lines instead of a survey of the graph. Do the ones the evidence settles and SKIP the rest — an unsure fix is worse than an untouched node, and skipping is the expected outcome for most packets on most nights. One or two landed per night compounds; a sweep does not.
- WHAT THEY ARE: a compressed recap per work burst — headline, steps, what was left undone. They are SUMMARIES, not transcripts. Trust them for SUBJECT (what he worked on, roughly how far it got); do NOT treat their wording as quotable fact, and never invent detail they do not contain.
- WHAT TO DO WITH THEM: the tree regime is unchanged — the default action is a LEAD or a briefing line on the domain's map, never a note per session. A week of work on one topic is one lead, not seven. If local work reveals a whole area the tree has no domain for, that is a new domain folder (map first).
- "LEFT UNDONE" and "OPEN LOOPS" are the highest-value lines in the block: real work he opened that nobody surfaced. Each one is a FOCUS ITEM (surface 5) — commit it with howToCheck, a checkCmd if a command can answer it, and a tier. Note that a session marked "done" still has open loops: finishing what he set out to do and handing off three new things are both true at once, and the handed-off ones are exactly what goes missing.
- WHAT NOT TO DO: do not narrate his week back to him, do not build a work log, and do not let volume from one noisy project distort the tree. Projects differ enormously in weight — a handful of shallow sessions in a side project earns at most one line, while sustained work earns a map. Weigh by depth and recurrence, not by episode count.
9. RETRIEVAL COUNTERS (in the digest): attention data. What's read often should be excellent and near the surface; what was never read in weeks is a decay candidate (fold into a lead or delete).
10. THE FULL MESSAGE LOG (readMessage / searchMessages): the digest's timeline is a SAMPLE, not the record — every message is capped (${USER_CAP} chars for the user) and marked […cut], and the window itself may be capped. The cut part is often the substantive part: a pasted document, a spec, a wall of facts about the user's life. NEVER fold a truncated line into the tree from its head alone — readMessage(#id) first. And before you conclude a topic is new, or write a fact you are unsure the chat already covered, searchMessages the whole history (it is ranked full-text, so search the words the USER would use, not your own).

11. THE ENTITY GRAPH (callModule / evalInModule on the 'entities' module — catalog at the end of this prompt): the OTHER memory, and as of tonight you are the one who maintains it. The tree above holds understanding in prose; the graph holds the same knowledge as typed records — one per entity, each with timeless \`facts\`, edges to other entities, and a \`state\` that a command re-derives every fifteen minutes. It was built once and then went three days without a single write while 303 messages went past, because nothing could write it. That is the hole you are closing.
- READ IT BEFORE YOU WRITE PROSE. For each domain the day actually touched, call \`openLoops(domain)\` and \`find(ref)\` on the entities the day named. This costs a subprocess, not a context window, and it is how you find out what the system already believes before you narrate over it.
- CONTRADICTION IS THE POINT. Where what you just read in the day's evidence disagrees with a stored fact — a different count, a name that is not in the list, a mechanism described differently, a decision since reversed — do NOT silently prefer either one. That gap is the most valuable thing you will find all night, because it is the only signal that memory has drifted from the world. Correct it with \`record({op:'correct-fact', ...}, reason)\`, and say so in the report.
- The proving case, so the shape is concrete: a fact read "Core-API hosts network clients Tailspin, Wingwallet, Lumenlab, Fabrikam, Adatum" long after every one of those names had been replaced. No probe covers a client list, no command answers it, and nothing in the system could ever have noticed. If the day's material had mentioned the real clients and you had read the entity first, one call fixes it.
- WHAT YOU MAY WRITE: correct-fact / add-fact / drop-fact (timeless truths only), observe (what YOU saw that no command can answer — a hold lifted, a plan abandoned), note, goal (the entity IS the outcome a plan is for — set on the outcome, never the plan), dormant (park work that is real but not competing for attention, or revive it), edge, drop-edge (a relation that was never true or stopped being), mint (a genuinely new entity — needs at least one fact AND a chain pointing back to the trace), move (the entity is filed in the WRONG DOMAIN — \`{op:'move', id, to}\` relocates it and drags every inbound edge along; the domain is the id's prefix, so this is the ONLY way to correct where a thing belongs). Every write REQUIRES a reason naming the evidence, and is journalled under it. Say what you saw, not what you did.
- WHAT YOU MAY NOT WRITE: \`state\`, \`state_at\`, \`status\`. The prober owns those. There is no op for them and there will not be one.
- CONFIRM WHAT HELD. When you read an entity's facts against the day's real material and find nothing wrong, call \`confirm(ref)\`. It writes no file and cannot fail; it records that someone actually looked, which is the only thing separating "checked recently" from "written once and never read again". Call it on everything you read, not only on what changed.
- ASK ABOUT WHAT NOBODY CHECKS. Once per pass, call \`unconfirmed()\` and pick AT MOST ONE fact that has gone unverified longest and that you have no evidence about either way. Put it in the night report as a plain question for Mehdi. One per night — a list of ten gets answered zero times.
- Nothing here is a licence to invent. The same conservatism applies as everywhere else: correct what the evidence contradicts, confirm what it supports, and leave alone what the day says nothing about.

12. THE OBSERVATION INBOX (the digest block · foldObservation): what the DAY saw and had no way to write. Each row was captured at the moment of seeing, by the agent that saw it, with its entity refs already RESOLVED — so folding one is a compare and a write, not an inference. THIS IS YOUR FIRST GRAPH JOB, before you read a line of the timeline: the inbox is the day's own account of what changed, and the timeline is the raw material you would otherwise have to reconstruct it from.
- FOLD EVERY ROW, and call foldObservation(id, outcome) on each — including the ones that need no graph write, with the reason ("already true", "too vague to place", "that is state, the prober owns it"). An unfolded row comes back tomorrow, so silence is not a decision; it is a growing queue.
- READ THE ENTITY FIRST, then write. An observation is a claim, not a fact: check it against what the entity already says and against the day's evidence. Where they disagree, that is the contradiction case above (surface 11) and it is the most valuable thing in the block.
- A ROW THAT RESOLVED TO NOTHING is the day reaching for a node that does not exist. Two honest answers: mint the entity if the evidence supports one (it needs at least one timeless fact), or fold it with the reason if it is genuinely not an entity. Do NOT invent a node from a single vague line — a missing node named twice in a week is a real signal, named once is not.
- The unrecognized NAMES on a row are the same signal one level down: a name the day used that the graph does not answer to. If an existing entity is plainly what was meant, an \`aka\` is the cheapest fix in the system.

13. YOUR OWN LAST REPORT (the digest block): the one surface where YOU are the source. Every pass makes promises to itself — "I'll do that next pass", "keep an eye on this", "skipping these eight tonight" — and until now none of them reached the next pass: the report went to the chat and the journal, and nothing read it back. So the same intention could be formed nightly and acted on never.
- You get ONE report, last night's. Reconcile it the way you reconcile the day's OPEN LOOPS: each forward-looking line is already durable (a focus item, a commitment, a graph fact — leave it), still worth doing (FILE IT NOW; this is its last showing), or dead (say so in one line and drop it).
- Do NOT continue last night's narrative, re-summarise it, or treat its prose as evidence about the world. It is a record of what a previous pass INTENDED, not a source of facts — the graph and the tree are the sources. A promise kept in prose is a promise lost.

14. WHAT LEFT NO TRACE (the digest block, near the top): every message from MEHDI in this window that produced no observation, no commitment and no graph write. Read it BEFORE the timeline — it is the same content, already filtered to where a miss can hide.
- WHY IT EXISTS: you have been told for weeks that every open loop the day put through his hands belongs in the focus set, and on 2026-08-16 you read past four messages about signing and sending Iris's documents — one of them "I will sign the forms today and send her scans" — and filed none. The day had looked paperwork/form-signing up an hour before and kept nothing either. The next morning a worker reported the set faithfully: "waiting on Bram, not you". Nobody was lying; nothing had been written down.
- A QUESTION IS EVIDENCE. "Which documents am I supposed to sign?" is not only a request for an answer — it is the fact that he HAS documents to sign, arriving in the shape of a question. First-person obligations ("I will", "I'm going to", "should I", "which do I need to") are the highest-value lines in the block and the ones that have actually been lost.
- VERDICT ON EACH, one line: already tracked / filed now (with tier + checkCmd where a command can answer it) / genuinely nothing. Silence is not a verdict — an unjudged row comes back tomorrow, exactly like an unfolded observation.
- A row marked "it READ" is the sharpest case in the system: retrieval worked, the day found the right node to answer him, and memory still did not move.

14b. WHAT MEHDI DATED (the digest block, right after 14 · datedVerdict): his messages that name a DAY or a TIME. This is the third kind of thing a day produces, beside facts and open loops: a PLAN BOUND TO A DATE. It is not durable knowledge and it is not something he must still do, so rule 14 lets it go as "genuinely nothing" — and on 2026-10-03 it let a whole departure day go (checkout, film, flight, all agreed in the chat); the next morning offered sightseeing.
- WHY A COMMITMENT: you clear the concierge's transcript tonight. Tomorrow's concierge opens with a snapshot that holds the commitments due that day and NOTHING else from before. A plan agreed today for a named day reaches tomorrow morning only as a commitment due that day, body = the plan as you would say it to him, fired at the hour it is useful.
- VERDICT ON EACH ROW via datedVerdict: committed (give the id) / tracked (give the id already due that day) / declined (why nothing dated needs to reach that morning). A bare time ("18:25") names no day by itself — read the turns around it. Silence is not a verdict — an unjudged row comes back tomorrow, marked carried.

15. THE STORY (storyWorklist / storyRewrite): the narrative render over the graph — a budgeted root story over one sub-story per domain, and the first memory a fresh session meets. The root story is INJECTED into every concierge turn as level 0, above one POINTER LINE per domain built from that domain story's FIRST SENTENCE and ending in readStory("<domain>"), which opens the rest. The day never reaches for a memory it must query (228 of 246 episodes reached nothing); the story is how what you know ARRIVES, so its quality is what decides whether the graph is read at all.
- LEAD WITH THE GAP. A domain story's first sentence is its pointer — the only line of it a turn sees unasked. Make it the sentence that names what a fresh session would not know and would be wrong without; the details follow it.
- NO NAVIGATION IN THE TEXT. Never write "drill down", "see story.md" or any pointer into a story — the block adds the readStory pointers mechanically, and a hand-written one goes stale the day the surface moves (it did).
- IT IS A RENDER. Every claim carries a [[full-entity-id]]; the tool REFUSES text over budget, with an unresolvable ref, or with no ref at all. Do not negotiate with the refusal — cut, or fix the graph.
- A fact you want to narrate and CANNOT connect is the finding, not an inconvenience: a missing edge or entity. File it (surface 11), then narrate.
- REWRITE BOTTOM-UP, children before root, so the root compresses stories that are already current. The worklist is already in that order.
- Do not narrate what the graph does not hold, however vividly the day's timeline suggests it. The graph first, then the story — never the other way.
- A NOTE IS NOT IN THE GRAPH. The worklist lists a domain's notes beneath its entities; a note whose subject the graph holds no entity for is a FOLD CANDIDATE — mint it via record() with the note as chain, then narrate the entity. The story narrates the GRAPH, so prose the graph does not hold stays invisible to the day's level 0 (a boiler note sat two nights beside a personal story that read as clean).

Survey first (the digest + Glob/Read + listThreads + the graph), then rewrite. Be conservative about FACTS, not structure. A quiet day is a fine answer: change nothing, say so briefly.

END your output with a concise NIGHT REPORT (it is journaled and shown to the user): anything the health audit found that Mehdi must act on (FIRST, if the suite or typecheck is red), what the day taught (ranked by impact), what you rewrote and why, how many observations you folded and what they changed, lifecycle/commitment actions, anything proposed, any GRAPH corrections (what the entity said, what it says now, on what evidence), and at most one open question from \`unconfirmed()\`. No padding, no process narration.`;

const RECONSTRUCTION_SYSTEM = `You are the REWRITE OPERATOR running a rare, deliberate MEMORY RECONSTRUCTION for this companion bot. The old knowledge tree has been ARCHIVED out of your working directory into \`.archive/\` (read it freely; never edit it) — including the old root.md and any legacy identity/ or ideas/ folders. Your working directory is EMPTY (plus the generated index.md). Your job: CONSUME everything — every file under .archive/, plus the history in this prompt — and RECONSTRUCT the memory from understanding, fresh. Do not reshape the old notes; write what you now KNOW.

WHY RECONSTRUCTION, AND WHY DELETION IS SAFE: everything in the old tree was produced by this system from its own work. Every detail already exists in the traces — the message log, session transcripts, Fibery, git/PRs — and the archive stays on disk. Nothing needs preserving verbatim; compression is the whole point. An editor stays in the distribution of what it edits; you are a writer with an empty directory.

THE TARGET SHAPE — three kinds of memory, nothing else:
- THE ROOT: root.md (see regime below) — a new agent must be able to onboard from this file alone.
- DOMAIN MAPS with LEADS: one folder per domain, its _map.md a 60-second briefing ending in leads.
- DEPTH NOTES: rare (≤1-2 per domain), cold-operational only.

${ROOT_REGIME}

${TREE_REGIME}

PROCEDURE — after consuming everything, answer IN ORDER:
1. DOMAINS: how many domains does this system's knowledge actually span — typically 3-8? Name each and its focus. A domain is a standing area of concern — never a task, bug, or PR.
2. THE ROOT: write root.md FIRST (refine at the end if the maps taught you something). Mine .archive/ for behavioral rules (old identity notes, sentences addressed to the system) → ## How to behave with provenance; fold the legacy shared memory (in the evidence, if any) and truly-global facts → ## Global facts; ## Domains from step 1; ## Now = a few volatile lines.
3. Per domain, ONE _map.md — the briefing you'd give a new engineer (~8-15 lines of prose: what it is; the SOURCE OF TRUTH outside this KB — exact repo doc paths, workflow files, tracker hubs; the roster with one-phrase states; the arc; the recurring lessons), ending in its Leads list. Every bug/fix/task/event the old notes narrate compresses to ONE lead line — action verbs + keywords + where to dig. Fold any archived ideas (old ideas/ notes or map "Open possibilities" lines) that still breathe into ## Open possibilities on the relevant map; drop the dead ones.
4. DEPTH NOTES — only what an agent needs LIVE at a terminal where digging first is too slow. Unsure? It's a lead.

ALSO KEEP TRUE (same tools): commitments real and sensibly timed (never touch the 'nightly-pipeline'/'morning-brief' system rows); pending proposals triaged (behavior-shaped ones → a root habit + resolve; genuine code/prompt proposals stay pending).

${SHARED_RULES}
- BAR FOR THE RESULT: the whole tree ≈ root.md + one _map.md per domain + a handful of depth notes. A domain with more than 2 non-map notes is archiving again — compress to leads. A root over its cap is hoarding — compress.

Finish with: the domain list (one line each), what landed in the root's How to behave, proposals triaged, and a short state-of-memory assessment.`;

/** The operator's bot-memory tool server: thread cards + lifecycle, tree
 *  structure ops, commitments, and the proposal queue. */
export function buildOperatorServer(chatId: number) {
  const foldTool = tool(
    'foldObservation',
    'Mark ONE queued observation as folded into the graph, saying what you did about it. Call it for every observation in the digest\'s inbox block — including the ones you decided need no graph write, with the reason. An observation left unfolded comes back tomorrow, so silence is not a decision.',
    {
      id: z.number().describe('The #id from the inbox block'),
      outcome: z
        .string()
        .describe('What you did: the record() write you made, or why none was needed ("already true", "too vague to place", "state — the prober owns it")'),
    },
    async ({ id, outcome }) => {
      foldObservation(id, outcome);
      return { content: [{ type: 'text' as const, text: `Observation #${id} folded.` }] };
    },
  );

  const listThreads = tool(
    'listThreads',
    'List the active worker threads: slot, title, brief (its dispatched mission), latest auto-recap, last-active date. Survey before lifecycle decisions.',
    {},
    async () => {
      const rows = listSessions(chatId, 'active').map((t) => {
        const c = getCard(chatId, t.slot);
        const brief = c?.brief ? c.brief.replace(/\s+/g, ' ').slice(0, 200) : '(none)';
        return `slot ${t.slot}: ${t.title} (last active ${t.last_active.slice(0, 10)})\n  brief: ${brief}\n  recap: ${c?.recap ?? '(none)'}`;
      });
      return { content: [{ type: 'text' as const, text: rows.join('\n') || '(no active threads)' }] };
    },
  );

  const archiveThread = tool(
    'archiveThread',
    'Archive an idle thread (out of the concierge\'s attention set; findThread still finds it and a dispatch revives it warm — its session persists). Distill any durable residue into the tree FIRST. The observation is posted to the awareness feed as its closing line.',
    {
      slot: z.number(),
      observation: z.string().describe('One line: what this thread was and how it ended (or "one-shot task, no residue")'),
    },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s || s.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `No active thread at slot ${args.slot}.` }], isError: true };
      }
      setSessionStatus(chatId, args.slot, 'archived');
      postEvent(chatId, 'operator', `archived "${s.title}" — ${args.observation}`);
      return { content: [{ type: 'text' as const, text: `Archived "${s.title}".` }] };
    },
  );

  const move = tool(
    'moveNote',
    'Move/rename a note to a new key (path). Rewrites its frontmatter key, prunes emptied folders, regenerates the index. If the final name changes, update [[links]] that pointed at the old name.',
    {
      from: z.string().describe('Current note key (path without .md)'),
      to: z.string().describe('New key, e.g. "affiliate-app/northwind-mvp"'),
    },
    async ({ from, to }) => {
      try {
        return { content: [{ type: 'text' as const, text: `Moved to "${moveNote(from, to)}".` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Move failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  const del = tool(
    'deleteNote',
    'Delete a note by key. Only for notes whose content you have folded elsewhere or that are truly obsolete — leads make deletion safe, invention does not.',
    { key: z.string().describe('The note key (path without .md)') },
    async ({ key }) => {
      let removed: string | undefined;
      try {
        removed = deleteNote(key);
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: removed
              ? `Deleted "${removed}"${removed === key ? '' : ` (your key "${key}" resolved to this)`}.`
              : `Nothing deleted — no note matches "${key}".`,
          },
        ],
      };
    },
  );

  const listCommitmentsTool = tool(
    'listCommitments',
    'List open commitments (id, mode fire/watch, label, body, how to check, due time).',
    {},
    async () => {
      const rows = listCommitments(chatId).map(
        (c) =>
          `#${c.id} [${c.how_to_check ? 'watch' : 'fire'}${c.focus ? ` · focus tier ${c.focus}${c.focus_band ? ` "${c.focus_band}"` : ''}` : ''}${c.check_cmd ? ' · auto-checked' : ''}] ${c.label} — due ~${fmtLocal(c.due_at)} local${c.recur ? ` (${c.recur})` : ''} · by ${c.created_by}\n   ${c.body.replace(/\n/g, ' ').slice(0, 200)}${c.how_to_check ? `\n   check: ${c.how_to_check}` : ''}${c.check_state ? `\n   last seen: ${c.check_state.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`,
      );
      return { content: [{ type: 'text' as const, text: rows.join('\n') || '(none open)' }] };
    },
  );

  const commitTool = tool(
    'commit',
    'Record a commitment. Without howToCheck: the body fires as a concierge turn at the due time — THE way to file a reminder for the user (write the body as you\'d say it to them; local "HH:mm" = next occurrence, "08:00" for morning delivery). With howToCheck: a watched blocked item, pulse-checked.',
    {
      label: z.string().describe('Short kebab label'),
      when: z.string().describe('Local time: "+4h", "HH:mm", or "YYYY-MM-DD HH:mm"'),
      body: z.string().describe('Self-contained: the reminder/instruction to fire, or what is watched (ids/links)'),
      howToCheck: z.string().optional().describe('Set for watched items: how to check it unblocked'),
      focus: z.number().optional().describe('Put it in the FOCUS set at this tier: 1 = closest to the user, higher = quieter bands. Any open loop the user touched and has not closed belongs in the set at some tier.'),
      focusBand: z.string().optional().describe('Short name for that band, e.g. "your ball" / "waiting on someone" / "tracked, nobody on it"'),
      checkCmd: z.string().optional().describe('A deterministic command with SMALL, STABLE output that answers this item (`gh pr view N --json state`, a fibery state query, a grep count). Attaching one is what makes the item verify itself for free from then on.'),
    },
    async (args) => {
      const at = parseLocalWhen(args.when);
      if (!at) return { content: [{ type: 'text' as const, text: `Could not parse "${args.when}".` }], isError: true };
      if (args.checkCmd && !checkCommandAllowed(args.checkCmd)) {
        return { content: [{ type: 'text' as const, text: `That checkCmd is not allowlisted. Every \`&&\` segment must start with cd/gh/git/grep/rg/ls/cat/test/jq or the brain-fibery script.` }], isError: true };
      }
      const id = addCommitment(chatId, args.label.slice(0, 40), args.body, toUtcDb(at), {
        howToCheck: args.howToCheck,
        createdBy: 'operator',
        focus: args.focus,
        focusBand: args.focusBand,
        checkCmd: args.checkCmd,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Commitment #${id} recorded (due ~${fmtLocal(toUtcDb(at))} local)` +
              (args.focus ? `, in the focus set at tier ${args.focus}` : '') +
              (args.checkCmd ? ', machine check attached (next sweep baselines it)' : '') +
              '.',
          },
        ],
      };
    },
  );

  const updateCommitmentTool = tool(
    'updateCommitment',
    'Update a commitment: "defer" to a new local due time, "rescope" to rewrite what it watches, or close it as "done"/"dropped". RESCOPE is for the common case where part of what a watch covered has landed — narrow howToCheck (and/or body) to what actually remains, rather than leaving stale check text in place or dropping and recreating it.',
    {
      id: z.number(),
      action: z.enum(['defer', 'rescope', 'focus', 'unfocus', 'done', 'dropped']),
      when: z.string().optional(),
      howToCheck: z.string().optional().describe('rescope: the new how-to-check text — what is still open and how to test it'),
      body: z.string().optional().describe('rescope: the new body/what-is-watched, if that changed too'),
      focus: z.number().optional().describe('focus: which tier (1 = closest to the user, higher = quieter). This is how you RE-TIER — the main focus job of a nightly pass.'),
      focusBand: z.string().optional().describe('focus: short name for the band'),
      checkCmd: z.string().optional().describe('focus/rescope: the deterministic command that answers this item'),
      note: z.string().optional(),
    },
    async (args) => {
      if (args.checkCmd && !checkCommandAllowed(args.checkCmd)) {
        return { content: [{ type: 'text' as const, text: 'That checkCmd is not allowlisted (cd/gh/git/grep/rg/ls/cat/test/jq or the brain-fibery script).' }], isError: true };
      }
      if (args.action === 'focus' || args.action === 'unfocus') {
        const item = listCommitments(chatId).find((c) => c.id === args.id);
        if (!item) return { content: [{ type: 'text' as const, text: `No open commitment #${args.id}.` }], isError: true };
        const tier = args.action === 'unfocus' ? 0 : Math.max(1, Math.round(args.focus ?? (item.focus || 1)));
        setFocusFields(args.id, tier, args.focusBand, args.checkCmd);
        return { content: [{ type: 'text' as const, text: tier ? `#${args.id} → focus tier ${tier}.` : `#${args.id} left the focus set.` }] };
      }
      if (args.action === 'rescope') {
        if (args.howToCheck === undefined && args.body === undefined && args.checkCmd === undefined) {
          return { content: [{ type: 'text' as const, text: 'rescope needs `howToCheck`, `body` and/or `checkCmd`.' }], isError: true };
        }
        const ok = rescopeCommitment(args.id, chatId, { howToCheck: args.howToCheck, body: args.body, checkCmd: args.checkCmd });
        return { content: [{ type: 'text' as const, text: ok ? `#${args.id} re-scoped.` : `No open commitment #${args.id}.` }] };
      }
      if (args.action === 'defer') {
        const at = args.when ? parseLocalWhen(args.when) : undefined;
        if (!at) return { content: [{ type: 'text' as const, text: 'defer needs a parseable future `when`.' }], isError: true };
        const ok = deferCommitment(args.id, chatId, toUtcDb(at));
        return { content: [{ type: 'text' as const, text: ok ? `#${args.id} deferred.` : `No open commitment #${args.id}.` }] };
      }
      const ok = resolveCommitment(args.id, chatId, args.action, args.note);
      return { content: [{ type: 'text' as const, text: ok ? `#${args.id} → ${args.action}.` : `No open commitment #${args.id}.` }] };
    },
  );

  const readMessageTool = tool(
    'readMessage',
    'Read ONE logged message in FULL by its #id, untruncated. The timeline in your digest is CAPPED per message — a long paste shows only its head and says how much was cut. Whenever a […cut] line looks like it carried durable content (a document, a spec, facts about the user, anything you are about to fold into the tree from a truncated line), read it FIRST. Folding a stump is how knowledge gets silently lost.',
    { id: z.number().describe('The message id, e.g. 1234 from "#1234" in the timeline') },
    async (args) => {
      const m = getMessageById(chatId, args.id);
      if (!m) return { content: [{ type: 'text' as const, text: `No message #${args.id} in this chat.` }] };
      const slot = Number(m.session_key.split(':')[1]);
      const title = slot === -1 ? 'Concierge' : getSession(chatId, slot)?.title ?? `thread ${slot}`;
      return {
        content: [
          { type: 'text' as const, text: `#${m.id} [${title}] ${m.role} @ ${m.created_at} (${m.content.length} chars)\n\n${m.content}` },
        ],
      };
    },
  );

  const searchMessagesTool = tool(
    'searchMessages',
    'Search the WHOLE message log, beyond tonight\'s window — ranked full-text, stemmed, any-word matching. Use it to check whether something the day raised was already discussed before, and to pull the history behind a topic you are about to write into the tree. Results are truncated and carry #ids for readMessage.',
    {
      term: z.string().describe('Words to look for. Multi-word is fine — matching is per-word, not one literal string.'),
      limit: z.number().optional().describe('Max results (default 15)'),
    },
    async (args) => {
      const rows = searchChatMessages(chatId, args.term, Math.min(args.limit ?? 15, 40)).map((m) => {
        const slot = Number(m.session_key.split(':')[1]);
        const title = slot === -1 ? 'Concierge' : getSession(chatId, slot)?.title ?? `thread ${slot}`;
        const flat = m.content.replace(/\s+/g, ' ');
        const shown = flat.slice(0, 220);
        const more = flat.length > 220 ? ` …[+${flat.length - 220} chars — readMessage(${m.id})]` : '';
        return `#${m.id} [${title}] ${m.role} @ ${m.created_at}: ${shown}${more}`;
      });
      return { content: [{ type: 'text' as const, text: rows.join('\n') || `(no messages matching "${args.term}")` }] };
    },
  );

  const proposeChange = tool(
    'proposeChange',
    'Queue an operator-gated PROPOSAL: a change to the bot\'s own code or prompts (name the file; self-contained). NEVER applied automatically — the user reviews via /proposals. ALWAYS give a `verify` command if one exists: without it nothing can tell this row from a stale one, and on 2026-08-06 every pending proposal was already fixed while the queue still read pending.',
    {
      body: z.string().describe('The proposed change: file, what, why — self-contained'),
      verify: z
        .string()
        .optional()
        .describe(
          'A read-only command that PRINTS SOMETHING once this has shipped and prints NOTHING while it has not — e.g. `grep -l "the new symbol" src/thing.ts`. Same allowlist as a probe (grep/rg/git/gh/test/ls/cat/jq). Omit only if nothing observable would change.',
        ),
    },
    async (args) => {
      if (args.verify && !checkCommandAllowed(args.verify)) {
        return { content: [{ type: 'text' as const, text: `verify command not allowlisted: ${args.verify}` }] };
      }
      const id = saveDreamFinding(chatId, null, 'proposal', args.body, args.verify);
      return {
        content: [
          {
            type: 'text' as const,
            text: args.verify
              ? `Proposal #${id} queued, with a check the audit will re-run every night.`
              : `Proposal #${id} queued WITHOUT a check — nothing will ever notice if it gets fixed. Add one with setProposalCheck if you can name it.`,
          },
        ],
      };
    },
  );

  const pendingProposals = tool(
    'pendingProposals',
    'List pending operator-gated proposals (and any legacy pending findings), each with the last verdict of its own check.',
    {},
    async () => {
      const rows = pendingFindings(chatId).map(
        (f) =>
          `#${f.id} [${f.kind}${f.verdict ? ` · ${f.verdict}${f.verified_at ? ` @ ${f.verified_at}` : ''}` : ' · never checked'}] ${f.body}`,
      );
      return { content: [{ type: 'text' as const, text: rows.join('\n') || '(none pending)' }] };
    },
  );

  /** DESIGN PROPOSALS — the night's end of the developer channel: evidence
   *  from friction, merges of duplicates, never decisions (proposalCli). */
  const listDesignProposalsNight = tool(
    'listDesignProposals',
    'List DESIGN proposals open between the bot and its developer (changes to how the system works). Read before opening one: duplicates get merged, not multiplied. `all` includes decided rows.',
    { all: z.boolean().optional() },
    async (args) => {
      const rows = args.all ? listDesignProposals([...PROPOSAL_STATUSES]) : listDesignProposals();
      return { content: [{ type: 'text' as const, text: rows.map(proposalLine).join('\n') || '(none open)' }] };
    },
  );
  const showDesignProposalNight = tool(
    'showDesignProposal',
    'The whole design proposal with its evidence trail.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text' as const, text: renderProposal(args.id) ?? `no proposal #${args.id}` }] }),
  );
  const proposeDesignNight = tool(
    'proposeDesign',
    'Open a DESIGN proposal when the friction ledger or the day\'s record shows the SYSTEM (not the memory) should change and it is not a one-file fix (that is proposeChange). Problem as observed with numbers; cite the friction rows as evidence right after.',
    { title: z.string(), problem: z.string(), body: z.string().optional(), cites: z.string().optional(), verify: z.string().optional() },
    async (args) => {
      const id = createDesignProposal({ ...args, actor: 'night' });
      return { content: [{ type: 'text' as const, text: `design proposal #${id} opened — now attach the evidence.` }] };
    },
  );
  const addProposalEvidenceNight = tool(
    'addProposalEvidence',
    'Attach evidence to a design proposal: a friction row, a measured number from tonight, an episode, a message, a note. Evidence accrues on the same row night after night.',
    { id: z.number(), kind: z.enum(['message', 'episode', 'friction', 'measure', 'note']), ref: z.string().optional(), text: z.string() },
    async (args) => {
      const eid = addProposalEvidence({ proposalId: args.id, actor: 'night', kind: args.kind, ref: args.ref, text: args.text });
      return { content: [{ type: 'text' as const, text: `evidence #${eid} on #${args.id}` }] };
    },
  );
  const amendDesignProposalNight = tool(
    'amendDesignProposal',
    'Amend a design proposal\'s text (append preferred); the note says what changed and why.',
    { id: z.number(), note: z.string(), appendBody: z.string().optional(), body: z.string().optional(), problem: z.string().optional(), cites: z.string().optional(), verify: z.string().optional() },
    async (args) => {
      const { id, note, ...changes } = args;
      return { content: [{ type: 'text' as const, text: amendDesignProposal(id, changes, 'night', note) ? `#${id} amended` : `no proposal #${id}` }] };
    },
  );
  const mergeDesignProposalsNight = tool(
    'mergeDesignProposals',
    'Fold one OPEN design proposal into another that covers the same thing: evidence moves, the text is kept as an amendment, the source is marked merged. Only for genuine duplicates.',
    { from: z.number(), into: z.number(), note: z.string() },
    async (args) => ({
      content: [{ type: 'text' as const, text: mergeDesignProposals(args.from, args.into, 'night', args.note) ? `#${args.from} merged into #${args.into}` : 'merge refused' }],
    }),
  );

  const gardenPlanTool = tool(
    'gardenPlan',
    'The graph\'s open shape problems, PREPARED: each one already carries the offending text, the candidate targets, and the exact record() call that would fix it. Read this instead of deriving fixes from the graph yourself — that is the whole point, and it is why a pass costs a few lines instead of a survey. Do only the ones the evidence settles; SKIP anything needing information you do not have.',
    { limit: z.number().optional().describe('How many packets to prepare (default 8). A bounded pass leaves a reviewable diff; an unbounded one is indistinguishable from a bad night.') },
    async (args) => {
      const p = plan(args.limit ?? 8);
      return { content: [{ type: 'text' as const, text: renderPlan(p) }] };
    },
  );

  const gardenSkipTool = tool(
    'gardenSkip',
    "Decline a gardening packet DURABLY, so it is not offered again while its evidence is unchanged. Only for the two answers the linter cannot stop firing on: 'reference' (the node is a how-to or a standing lane with no outcome by design — not a plan) and 'unknown' (the evidence does not say what the plan is for; the day will ask when the topic comes up). Anything the evidence settles is fixed with record(), not skipped. The reason says what you READ.",
    {
      code: z.string().describe('The lint code on the packet, e.g. W213.'),
      id: z.string().describe('The entity id the packet named.'),
      decision: z.enum(['reference', 'unknown']),
      reason: z.string().describe('What you read, and why it did not settle the packet.'),
    },
    async (args) => {
      const r = skipPacket({ ...args, actor: 'nightly' });
      return { content: [{ type: 'text' as const, text: r.ok ? `${args.code} ${args.id} declined as ${args.decision}.` : `REFUSED: ${r.problem}` }] };
    },
  );

  const storyWorklistTool = tool(
    'storyWorklist',
    'The dirty story nodes, PREPARED, bottom-up: every domain story before the root, each with its budget, its current text and its material (the domain\'s entities and its notes — fold candidates; for the root, the children\'s stories and the notes filed outside every domain). Rewrite from the material and nothing else — the story is a render of the graph, not a second account of the day.',
    {},
    async () => {
      const items = storyWorklist();
      if (!items.length) return { content: [{ type: 'text' as const, text: '(nothing dirty — the story is current)' }] };
      const text = items
        .map(
          (i) =>
            `=== ${i.id} (scope: ${i.scope}, budget ~${i.budgetTokens} tokens) ===\n` +
            `CURRENT TEXT:\n${i.currentText || '(none yet)'}\n` +
            `MATERIAL:\n${i.material}`,
        )
        .join('\n\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  const storyRewriteTool = tool(
    'storyRewrite',
    'Save one rewritten story node. Refused by mechanism when over budget, when any [[ref]] does not resolve to a live entity or story id, or when there is no ref at all — a claim with no node behind it does not get saved, it gets filed as a missing edge/entity instead.',
    {
      nodeId: z.string().describe('From storyWorklist — "root" or "domain:<name>".'),
      text: z.string().describe('The full replacement narrative. Every claim carries a [[full-entity-id]].'),
    },
    async (args) => {
      const r = applyStoryRewrite(args.nodeId, args.text);
      return {
        content: [
          {
            type: 'text' as const,
            text: r.ok ? `${args.nodeId} saved${r.problem ? ` (${r.problem})` : ''}.` : `REFUSED: ${r.problem}`,
          },
        ],
      };
    },
  );

  const doorDecisionTool = tool(
    'doorDecision',
    'Record the verdict on one door from "Doors the day kept opening": fold (you wrote/extended a reference entity — say which), pointer (you added a line to a domain story — say which), or ignore (say why). Every offered door gets exactly one call; the cycle report counts whether folded paths stop being re-read.',
    {
      path: z.string().describe('The path exactly as listed in the block — a door this pass was shown; anything else is refused with the valid list.'),
      decision: z.enum(['fold', 'pointer', 'ignore']),
      note: z.string().describe('What you did or why not — the entity id, the story node, or the reason.'),
    },
    async (args) => {
      const r = decideDoor(args.path, args.decision, args.note);
      return { content: [{ type: 'text' as const, text: r.ok ? `door ${args.decision}: ${args.path}` : `REFUSED: ${r.problem}` }] };
    },
  );

  const datedVerdictTool = tool(
    'datedVerdict',
    'Record the verdict on one row of "WHAT MEHDI DATED": committed (you filed a commitment due the named day — note = its id), tracked (one already due that day covers it — note = its id), or declined (note = why nothing dated needs to reach that morning). Every offered row gets exactly one call; the cycle report counts offered against judged.',
    {
      messageId: z.number().describe('The msg #id exactly as listed in the block — a row this pass was shown; anything else is refused with the valid list.'),
      decision: z.enum(['committed', 'tracked', 'declined']),
      note: z.string().describe('The commitment id, or the reason.'),
    },
    async (args) => {
      const r = decideDated(args.messageId, args.decision, args.note);
      return { content: [{ type: 'text' as const, text: r.ok ? `dated ${args.decision}: msg #${args.messageId}` : `REFUSED: ${r.problem}` }] };
    },
  );

  const setProposalCheck = tool(
    'setProposalCheck',
    'Give a pending proposal the command that will PROVE it shipped — so the queue stops being a store of claims nothing re-checks.',
    {
      id: z.number(),
      verify: z.string().describe('Read-only command; prints something once shipped, nothing while not.'),
    },
    async (args) => {
      if (!checkCommandAllowed(args.verify)) {
        return { content: [{ type: 'text' as const, text: `not allowlisted: ${args.verify}` }] };
      }
      setFindingVerify(args.id, args.verify);
      return { content: [{ type: 'text' as const, text: `#${args.id} will be checked by: ${args.verify}` }] };
    },
  );

  const resolveProposal = tool(
    'resolveProposal',
    'Resolve a pending proposal/finding: "applied" if this pass absorbed it (e.g. it was really a habit/knowledge), "dismissed" if obsolete or wrong (say why in note).',
    { id: z.number(), status: z.enum(['applied', 'dismissed']), note: z.string().optional() },
    async (args) => {
      resolveFinding(args.id, args.status, args.note);
      return { content: [{ type: 'text' as const, text: `#${args.id} → ${args.status}.` }] };
    },
  );

  return createSdkMcpServer({
    name: 'bot',
    version: '1.0.0',
    instructions: 'The rewrite operator\'s hands: thread cards + lifecycle, tree structure ops, commitments, and the operator-gated proposal queue.',
    tools: [
      listThreads, archiveThread,
      move, del,
      listCommitmentsTool, commitTool, updateCommitmentTool,
      readMessageTool, searchMessagesTool,
      proposeChange, pendingProposals, setProposalCheck, resolveProposal,
      listDesignProposalsNight, showDesignProposalNight, proposeDesignNight, addProposalEvidenceNight, amendDesignProposalNight, mergeDesignProposalsNight,
      gardenPlanTool, gardenSkipTool,
      storyWorklistTool, storyRewriteTool, doorDecisionTool, datedVerdictTool,
      foldTool,
      // Round 10: the night gets the knowledge API — the same one the day has.
      // Until now it was the heaviest reader of memory in the system and the
      // only agent with no way to call it, which is most of why the graph sat
      // unmodified through three days of live work.
      ...buildModuleTools('nightly'),
    ],
  });
}

export const OPERATOR_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'mcp__bot__listThreads',
  'mcp__bot__archiveThread',
  'mcp__bot__moveNote',
  'mcp__bot__deleteNote',
  'mcp__bot__listCommitments',
  'mcp__bot__commit',
  'mcp__bot__updateCommitment',
  'mcp__bot__readMessage',
  'mcp__bot__searchMessages',
  'mcp__bot__proposeChange',
  'mcp__bot__pendingProposals',
  'mcp__bot__setProposalCheck',
  'mcp__bot__gardenPlan',
  'mcp__bot__resolveProposal',
  'mcp__bot__storyWorklist',
  'mcp__bot__storyRewrite',
  'mcp__bot__doorDecision',
  'mcp__bot__datedVerdict',
  'mcp__bot__foldObservation',
  ...MODULE_TOOL_NAMES,
];

export interface FileChange {
  path: string;
  action: 'A' | 'M' | 'D';
  before: string;
  after: string;
}

/** The knowledge domains a pass rewrote — the hulls the Atlas should light. */
function domainsTouched(changes: FileChange[]): string[] {
  const out = new Set<string>();
  for (const c of changes) {
    const top = c.path.split('/').filter(Boolean)[0];
    if (top && !top.endsWith('.md')) out.add(top);
  }
  return [...out];
}

/** Diff two note snapshots into a per-file change-log. */
export function diffSnapshots(before: Record<string, string>, after: Record<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[path];
    const a = after[path];
    if (b === undefined && a !== undefined) changes.push({ path, action: 'A', before: '', after: a });
    else if (b !== undefined && a === undefined) changes.push({ path, action: 'D', before: b, after: '' });
    else if (b !== a && b !== undefined && a !== undefined) changes.push({ path, action: 'M', before: b, after: a });
  }
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

/**
 * GUARD: restore any domain map deleted while the root still lists its domain.
 *
 * A nightly pass never intends this. On 2026-07-16 one narrated "Rewrote
 * paperwork/_map.md" but its change-log held two deletes and no write — the
 * critical-path domain vanished for 19h until dangling links gave it away the
 * next night. The change-log is truthful; the REPORT is not evidence. So the
 * invariant is checked against the files: a domain the root still points at
 * must have a live map. Returns the keys it put back.
 *
 * Scoped to nightly — a reconstruction legitimately deletes the whole tree.
 */
export function restoreOrphanedMaps(changes: FileChange[]): string[] {
  const domains = rootSection('Domains');
  const restored: string[] = [];
  for (const c of changes) {
    if (c.action !== 'D' || !c.path.endsWith('/_map.md')) continue;
    const key = c.path.slice(0, -3); // e.g. "paperwork/_map"
    if (!domains.includes(`[[${key}]]`)) continue; // domain genuinely retired — allow
    restoreFile(c.path, c.before);
    restored.push(key);
  }
  return restored;
}

/** Threads idle past the cutoff with no open commitment — tonight's archive
 *  candidates (the operator distills residue first, then archives). */
export function archiveCandidates(chatId: number): Array<{ slot: number; title: string; last_active: string }> {
  const cutoff = toUtcDb(new Date(Date.now() - IDLE_ARCHIVE_DAYS * 86_400_000));
  const committed = new Set(
    listCommitments(chatId)
      .map((c) => c.thread_slot)
      .filter((s): s is number => s !== null && s !== undefined),
  );
  return listSessions(chatId, 'active')
    .filter((t) => t.last_active < cutoff && !committed.has(t.slot))
    .map((t) => ({ slot: t.slot, title: t.title, last_active: t.last_active }));
}

/**
 * The observation inbox — what the DAY saw and could not write itself (M1).
 *
 * This block is the reason the night no longer has to re-derive the day. Each
 * row was captured at the moment of seeing, by the agent that saw it, with its
 * entity refs already resolved against the live graph. Folding it is a compare
 * and a write, not an inference over three hundred messages.
 *
 * It prints even when EMPTY, on purpose: "nothing was captured yesterday" is a
 * finding about the day's tools, and it must not be indistinguishable from a
 * block that silently rendered nothing.
 */
function inboxBlock(): string {
  const rows = pendingObservations(60);
  if (!rows.length) {
    return '(empty — nobody captured an observation in this window. If the day clearly changed things, that is a finding about `observe` not being reached for, not a quiet day.)';
  }
  return rows
    .map((o) => {
      const refs = o.refs.length ? o.refs.join(', ') : 'NOTHING IN THE GRAPH — this may be an entity the graph is missing';
      const miss = o.unresolved.length ? `\n    unrecognized names: ${o.unresolved.join(', ')}` : '';
      const ev = o.evidence ? `\n    evidence: ${o.evidence}` : '';
      return `- #${o.id} [${o.source} ${o.created_at.slice(5, 16)}] ${o.text}\n    about: ${refs}${miss}${ev}`;
    })
    .join('\n');
}

/**
 * THE STORY'S DEBT — which narrative nodes the day's writes invalidated.
 *
 * Silent when clean, like the operator block below: most nights the day
 * touched two domains and this is two lines. The material itself is NOT
 * inlined here — the worklist tool carries it — because the digest is already
 * long and the whole point of a prepared worklist is that it is read at the
 * moment of rewriting, not skimmed an hour earlier.
 */
function storyBlock(): string {
  // A cheap read of the flags, not the worklist: the digest is assembled on
  // every pass, and the material (a graph load per dirty node) is only worth
  // building at the moment of rewriting — which is the tool's job.
  const items = listStoryNodes().filter((n) => n.dirty);
  if (!items.length) return '';
  const lines = items.map((i) => `- ${i.id}${i.text ? '' : ' (never written)'}`);
  return (
    `## The story is stale — ${items.length} node(s) the day's writes invalidated\n` +
    `${lines.join('\n')}\n` +
    `Call storyWorklist for the material, rewrite each with storyRewrite — children before root. ` +
    `This is a RENDER pass, not a reflection: narrate what the graph holds, ref every claim, and where ` +
    `a thing worth narrating has no node, that is a graph write (surface 11) BEFORE it is a story line.\n\n`
  );
}

/**
 * WHAT THE OPERATOR DID TO THE MACHINE while the day was suspended.
 *
 * A debug session that KEEPS its writes clears the concierge's context on the
 * way out, because the memory moved under a context built on the old one. That
 * is correct and it is invisible: from the night's side the day simply has a
 * hole in it, with graph writes by hands that are not the day's, and nothing
 * saying why. A pass that reconstructs a reason for that will reconstruct the
 * wrong one — so it gets told.
 *
 * Silent when there were none: this is genuinely rare, and a permanent
 * "(no debug sessions)" line would be noise in a digest that is already long.
 */
function operatorBlock(from: string): string {
  const rows = debugSessionsSince(from);
  if (!rows.length) return '';
  const lines = rows.map(
    (r) =>
      `- ${r.since.slice(5, 16)} → ${r.until.slice(5, 16)}${r.reason ? ` — "${r.reason}"` : ''}: ` +
      `${r.writes} graph write(s), ${r.rolled_back ? 'ROLLED BACK' : 'kept'}` +
      (r.context_reset ? ' · MY CONTEXT WAS CLEARED at this point' : ''),
  );
  return (
    `## Operator sessions in this window — the machine was worked ON, not with\n` +
    `${lines.join('\n')}\n` +
    `These writes were made by Mehdi's own hand at the Atlas or a terminal, not by an agent reasoning about the day. ` +
    `Treat them as intended. Where a cleared context left a gap in the timeline, that is the reason — do not infer a quiet day from it. ` +
    `If a kept write contradicts something the day established, THAT is worth surfacing.\n\n`
  );
}

/** Shared evidence blocks: cards, commitments, retrieval counters, link health. */
function stateBlocks(chatId: number): string {
  const cards =
    listSessions(chatId, 'active')
      .map((t) => {
        const c = getCard(chatId, t.slot);
        const line = (c?.brief ?? c?.recap)?.replace(/\s+/g, ' ').slice(0, 160);
        const ctx = latestContextInfo(sessionKey(chatId, t.slot));
        const pct = ctx && ctx.window ? Math.round((ctx.tokens / ctx.window) * 100) : 0;
        const warn = pct >= 50 ? ` ⚠️ context ${pct}% full — will compact soon, distill what matters tonight` : '';
        return `- slot ${t.slot}: ${t.title} (last active ${t.last_active.slice(0, 10)})${line ? ` — ${line}` : ''}${warn}`;
      })
      .join('\n') || '(none)';

  const commitments =
    listCommitments(chatId)
      .map(
        (c) =>
          `- [#${c.id} ${c.how_to_check ? 'watch' : 'fire'}] ${c.label}: ${c.body.replace(/\n/g, ' ').slice(0, 160)}${c.how_to_check ? ` · check: ${c.how_to_check}` : ''} · due ${c.due_at} UTC${c.recur ? ` (${c.recur})` : ''}`,
      )
      .join('\n') || '(none)';

  const hot = topRetrievals(15)
    .map((r) => `- ${r.count}× [${r.kind}] ${r.key} (last ${r.last_at?.slice(0, 10) ?? '?'})`)
    .join('\n');
  const read = retrievedKeys('note');
  const cold = listNotes()
    .filter((n) => !read.has(n.key))
    .map((n) => n.key);
  const retrieval =
    `${hot || '(no retrievals counted yet)'}\n` +
    (cold.length ? `Never retrieved since counting began: ${cold.join(', ')}` : 'Every note has been retrieved at least once.');

  const health = linkHealth();
  const healthBlock = health.length ? health.map((p) => `- ${p}`).join('\n') : '(clean)';

  const proposals =
    pendingFindings(chatId)
      // The verdict rides WITH the body, not in a separate block, because the
      // failure this fixes was the night reading a body and never the row's
      // status. A shipped proposal that still says "pending" three inches from
      // its own proof is how a report opens with bugs that no longer exist.
      .map((f) => `- [#${f.id} ${f.kind} · ${f.verdict ?? 'NEVER CHECKED (no verify command)'}] ${f.body}`)
      .join('\n') || '(none pending)';

  return (
    `## Active threads (cards: brief/recap + last active)\n${cards}\n\n` +
    `## Open commitments (reminders · routines · watched items)\n${commitments}\n\n` +
    `## Retrieval counters (attention data: hot keys + never-read notes)\n${retrieval}\n\n` +
    `## Pending proposals (operator-gated queue — triage)\n${proposals}\n\n` +
    `## Link/name health of the tree (must be clean when you finish)\n${healthBlock}`
  );
}

/** The nightly digest: root + state blocks + archive candidates + the
 *  window's events and chronological timeline. */
/** The window's LOCAL work — sessions Mehdi ran at his own terminal, which
 *  never touched this chat. Recaps only; the transcripts stay on disk. */
function localWorkBlock(from: string, to: string): string {
  const rows = episodesInWindow(from, to, 40);
  if (!rows.length) return '(none in this window)';
  const total = episodesInWindowCount(from, to);
  const omitted = total > rows.length ? `(${total - rows.length} more not shown)\n` : '';
  return (
    omitted +
    rows
      .map((e) => {
        const r = JSON.parse(e.recap) as {
          headline: string;
          topics: string[];
          status: string;
          followUp?: string | null;
          crossProject?: string | null;
        };
        return (
          `- ${e.ended_at.slice(5, 16)} [${e.project}]${e.closed ? '' : ' (still running)'} \u00b7 ${e.turns} turns \u2014 ${r.headline}` +
          (r.topics.length ? `\n    steps: ${r.topics.join(' | ')}` : '') +
          (r.followUp ? `\n    LEFT UNDONE: ${r.followUp}` : '') +
          (r.crossProject ? `\n    also touches: ${r.crossProject}` : '') +
          `\n    status: ${r.status} \u00b7 episode #${e.id}`
        );
      })
      .join('\n')
  );
}

/**
 * Root "Now" bullets rot when the commitment that watched them is resolved:
 * nothing in the day's activity touches the bullet, so the operator — rightly
 * refusing to rewrite what it has no fresh signal for — leaves it standing
 * forever. The only grounded signal that a bullet is orphaned is a SQL fact:
 * it names "commitment #N", and #N is no longer open. We flag exactly that,
 * and only that (a bare "#3181" is a Fibery/PR id, never a commitment), so the
 * operator can reconfirm the bullet from tonight's evidence or retire it.
 */
function orphanedWatchers(chatId: number): string {
  const root = rootContext();
  const now = root.split('## Now')[1] ?? '';
  const openIds = new Set(listCommitments(chatId).map((c) => c.id));
  const orphaned = [...now.matchAll(/commitments?\s+#(\d+)/gi)]
    .map((m) => Number(m[1]))
    .filter((id, i, a) => a.indexOf(id) === i && !openIds.has(id));
  if (!orphaned.length) return '';
  return (
    `\n\n## Orphaned watchers in root's ## Now (grounded flag — act on these)\n` +
    orphaned
      .map(
        (id) =>
          `- A ## Now bullet leans on commitment #${id}, which is NO LONGER OPEN (done/dropped/gone). Its watcher can no longer keep it true. Reconfirm the bullet from tonight's evidence, or RETIRE it.`,
      )
      .join('\n')
  );
}

function buildNightlyDigest(chatId: number, from: string, to: string): { digest: string; messages: number } {
  const candidates =
    archiveCandidates(chatId)
      .map((c) => `- slot ${c.slot}: ${c.title} (idle since ${c.last_active.slice(0, 10)})`)
      .join('\n') || '(none tonight)';

  const events =
    eventsSince(chatId, from, 60)
      .map((e) => `${e.created_at.slice(5, 16)} [${e.source}] ${e.body}`)
      .join('\n') || '(quiet)';

  const titleFor = (key: string): string => {
    const slot = Number(key.split(':')[1]);
    if (slot === -1) return 'Concierge';
    return getSession(chatId, slot)?.title ?? `thread ${slot}`;
  };
  const total = chatTimelineCountBetween(chatId, from, to);
  const rows = chatTimelineBetween(chatId, from, to, TIMELINE_LIMIT);
  // A cut must be RETRIEVABLE, not just marked. A bare "…[cut]" reads as "the
  // rest was more of the same", so a long paste — a document, a wall of
  // personal facts — silently lost everything past the cap with no way back.
  // Naming readMessage(#id) turns every truncation into a door.
  const cut = (s: string, n: number, id: number) => {
    const flat = s.replace(/\s+/g, ' ');
    return flat.length > n
      ? `${flat.slice(0, n)} …[cut ${flat.length - n} chars — readMessage(${id}) for the FULL text]`
      : flat;
  };
  // A capped window must SAY it's capped — a silent gap reads as a quiet day.
  const omitted =
    total > rows.length
      ? `(NOTE: this window held ${total} messages; the EARLIEST ${total - rows.length} are omitted here — do not assume the omitted part was quiet.)\n`
      : '';
  const timeline =
    omitted +
    rows
      .map(
        (m) =>
          `#${m.id} [${titleFor(m.session_key)}] ${m.role === 'user' ? 'You' : 'Bot'}: ${cut(m.content, m.role === 'user' ? USER_CAP : BOT_CAP, m.id)}`,
      )
      .join('\n');

  const digest =
    `## Window\nThis rewrite covers activity from ${from} to ${to} (UTC).\n\n` +
    `## Root — the always-on core (rewrite its ## Now; keep the rest true)\n` +
    `[BUDGET: ${rootBudget().chars} of ${rootBudget().cap} chars used. Going over does not error — it silently truncates the TAIL, which is ## Now. If you add lines here, cut at least as many.]\n` +
    `${rootContext() || '(root.md not built yet — build it)'}\n\n` +
    `${stateBlocks(chatId)}\n\n` +
    // Placed ABOVE the inbox and the timeline, because a promise you read after
    // an hour of the day's content is a promise you skim.
    `${lastNightBlock(chatId)}` +
    `${unfiledBlock(from, to)}` +
    `${datedBlock(chatId, from, to)}` +
    `## The observation inbox — what the day SAW (fold every row, then foldObservation)\n${inboxBlock()}\n\n` +
    `${storyBlock()}` +
    `${doorsBlock(from, to)}` +
    `${operatorBlock(from)}` +
    `## Archive candidates (idle >${IDLE_ARCHIVE_DAYS}d, no open commitment — distill residue, then archiveThread)\n${candidates}` +
    `${orphanedWatchers(chatId)}\n\n` +
    `## The window's events (awareness feed)\n${events}\n\n` +
    `## Mehdi's LOCAL work this window (harvested from his own terminal sessions — NOT this chat, NOT the fleet)\n${localWorkBlock(from, to)}\n\n` +
    `## Conversation timeline — chronological, the way the user experienced it; [thread] = where each message ran\n${timeline}`;
  return { digest, messages: rows.length };
}

/**
 * WHAT THE DAY HEARD AND NEVER WROTE DOWN.
 *
 * The night is already told, in capitals, that every open loop the day put
 * through Mehdi's hands belongs in the focus set. It has been told that for
 * weeks, and on 2026-08-16 it read straight past four separate messages about
 * signing and sending Iris's documents — including "I will sign the forms
 * today and send her scans" — and filed none of them. The concierge had looked
 * `paperwork/form-signing` up an hour earlier and written nothing either. The
 * next morning a worker faithfully reported the focus set, which still said the
 * whole thread was "waiting on Bram, not you".
 *
 * The instruction to catch that already existed. What did not exist was a way
 * to stop asking the night to FIND the needles in a hundred-message timeline.
 *
 * So this hands them over. Mechanical, cheap, and derived from the episode log
 * rather than from any agent's account of itself: user-initiated turns that
 * produced no observation, no commitment and no graph write. On the window that
 * missed the signing thread it is nineteen rows against eighty-six turns —
 * small enough to read one at a time, which is the only thing that makes a
 * judgement possible at all.
 *
 * Same three-way reconciliation as the OPEN LOOPS block below it and the night
 * report above it, because that shape is the one that keeps working: a row is
 * already tracked, or it is a live loop to file NOW, or it is genuinely
 * nothing. Silence is not one of the three.
 */
const UNFILED_CAP = 25;

function unfiledBlock(from: string, to: string): string {
  const rows = unfiledTurns(from, to, UNFILED_CAP);
  if (!rows.length) return '';
  const lines = rows
    .map((r) => {
      const refs = (JSON.parse(r.refs || '[]') as string[]).join(', ');
      return `- [turn #${r.id}, ${r.started_at}] "${r.trigger.replace(/\s+/g, ' ').slice(0, 220)}"` +
        (refs ? `\n    it READ: ${refs} — and recorded nothing about them` : '');
    })
    .join('\n');
  return (
    `## WHAT MEHDI SAID THAT LEFT NO TRACE — ${rows.length} turn(s) (read these before the timeline)\n` +
    `Each of these is a message from HIM that produced no observation, no commitment and no graph write. ` +
    `That is not automatically wrong — plenty of talk is just talk — but it is where a missed open loop necessarily hides, ` +
    `because a loop that got recorded is not on this list.\n` +
    `For EACH: it is (1) already tracked — say so and move on; (2) a real open loop — commit it to the focus set NOW with a tier, ` +
    `and a checkCmd if a command can answer it; or (3) genuinely nothing durable. Say which, in one line each. Do not skip silently.\n` +
    `Pay particular attention to first-person obligations — "I will…", "I'm going to…", "should I…", "which do I need to…" — ` +
    `those are facts about HIS state arriving in the shape of a question, and they are the ones that have been lost.\n` +
    `A line marked "it READ" means the day looked a node up to answer him and then kept nothing: the retrieval worked and the memory still did not move.\n${lines}\n\n`
  );
}

/**
 * LAST NIGHT'S REPORT — the one thing the night wrote that nothing read back.
 *
 * Every pass ends by narrating what it did and, repeatedly, what it INTENDS:
 * "I'll skip these eight edges tonight", "compress it on the next pass", "keep
 * an eye on that". None of it reached the next pass. The digest carried root,
 * the graph, the focus set, the inbox, the events and the timeline — every
 * durable store — and the report went to Telegram and the journal, both of
 * which are read by a human and by nothing else. So the night could form an
 * intention every single night and never once act on one.
 *
 * ## Why exactly ONE, and why framed as a reconciliation
 *
 * The temptation is to hand over the last week of reports, and that is the
 * wrong instinct twice. It costs the window, and worse, it makes the night's
 * own prose a store it answers to — which is the failure root.md already had
 * (I1: prose is a render, not a home).
 *
 * One report, framed exactly like the OPEN LOOPS block that already works
 * three paragraphs below: every forward-looking line is either already in the
 * durable store, or it will not happen. That turns the report from a memory
 * into a FUNNEL — an intention survives one night on prose and then has to
 * become a focus item, a commitment or a graph fact to survive a second. If it
 * did not survive being asked directly about it, it was not an intention.
 */
const LAST_REPORT_CAP = 6000;

export function lastNightBlock(chatId: number): string {
  const [last] = recentDreams(chatId, 1);
  if (!last) return '';
  const body =
    last.report.length > LAST_REPORT_CAP
      ? `${last.report.slice(0, LAST_REPORT_CAP)}\n…[cut ${last.report.length - LAST_REPORT_CAP} chars]`
      : last.report;
  return (
    `## YOUR OWN LAST REPORT — night #${last.id}, ${last.created_at}${last.covers_from ? ` (covered ${last.covers_from} → ${last.covers_to})` : ''}\n` +
    `Read this for the promises in it, not the summary. Every forward-looking line — "I'll do X next pass", "keep an eye on Y", "skipped for now" — is in one of three states, and you decide which tonight:\n` +
    `  1. ALREADY DURABLE — it is a focus item, a commitment, or a fact in the graph. Nothing to do; do not re-file it.\n` +
    `  2. STILL WORTH DOING — then FILE IT NOW (focus item with a checkCmd where a command can answer it, or a graph fact). This block is the last time it will be shown to you.\n` +
    `  3. NO LONGER WORTH DOING — say so in one line tonight, and let it go.\n` +
    `An intention that stays in prose does not survive: this is the ONLY report you are given, so anything left here is gone tomorrow.\n\n${body}\n\n`
  );
}

/** The reconstruction evidence: full reflection history + current state. */
function buildReconstructionEvidence(chatId: number): string {
  const dreams =
    recentDreams(chatId, 100)
      .reverse()
      .map((d) => `### Night report #${d.id} — ${d.created_at}${d.covers_from ? ` (covers ${d.covers_from} → ${d.covers_to})` : ''}\n${d.report}`)
      .join('\n\n') || '(no night reports recorded)';
  const grows =
    recentGrows(chatId, 50)
      .reverse()
      .map((g) => {
        const first = g.summary.split('\n').find((l) => l.trim()) ?? '';
        return `- change-log #${g.id} (${g.created_at}): ${first.slice(0, 200)}`;
      })
      .join('\n') || '(none)';

  return (
    `${stateBlocks(chatId)}\n\n` +
    `## Change-log history (what past passes changed)\n${grows}\n\n` +
    `## Full night-report history — the system's own reflections, oldest first\n${dreams}`
  );
}

export interface RewriteOutcome {
  ran: boolean;
  journalId?: number;
  changes: number;
  /**
   * What actually became of the pass.
   *
   * `ran` could not carry this: a FAILED pass has run (three times, in fact)
   * and a QUIET one has not, yet the two need opposite treatment now that the
   * night is a debt — a quiet window settles it, a failure must leave it owed
   * so the retry happens. One boolean cannot say which, and guessing wrong in
   * the "failed" direction blocks the day forever.
   */
  outcome: 'folded' | 'quiet' | 'failed' | 'cancelled' | 'refused';
}

/** Thrown by the pass when the operator has asked for the night back. */
class DreamCancelled extends Error {
  constructor(readonly why: string) {
    super(`the pass was cancelled: ${why}`);
  }
}

/**
 * ONE PASS AT A TIME — the whole reason `runRewrite` is a wrapper.
 *
 * On 2026-08-05 two nightly passes overlapped (dreams #52 and #53). Both read
 * `lastDreamCoveredTo` before either reached `saveDream`, so both got the same
 * window start (`2026-08-04 00:30:30`), built the same digest from the same
 * PENDING observation inbox, and folded it twice: `core-api/ci-robustness-38`
 * was minted under two ids, and observations #19, #20 and #22 were written to
 * the graph twice over.
 *
 * The window and the inbox are both only marked consumed at the END of a pass,
 * so two passes that overlap ANYWHERE duplicate everything between them. The
 * pass is not idempotent and cannot cheaply be made so — a lock is the honest
 * shape. A refusal is loud (event + chat) because a silently-dropped nightly
 * is the failure mode the Charter's I8 exists to prevent.
 *
 * It was a MODULE VARIABLE, and a module variable is not a lock. The scheduled
 * nightly runs inside the bot; an induced `/dream` from `npx tsx` runs in its
 * own process; neither could see the other's flag, so the exact overlap this
 * comment describes was still reachable from the door the operator uses most.
 * The phase now lives in the database — where the work state and the open run
 * had to go for the same reason — and claiming it is the same act as entering
 * the DREAMING state, which is what blocks the day for the pass's duration.
 */

/** Run one rewrite pass. Nightly: windowed, skips a quiet window; journal +
 *  change-log on success (the window only advances then). Reconstruction:
 *  archive → rebuild → restore on failure. Refuses while another pass runs. */
export async function runRewrite(
  transport: ChatTransport,
  chatId: number,
  scope: RewriteScope,
): Promise<RewriteOutcome> {
  const claim = beginDream(scope);
  // For the cancel path: the door verdicts this pass recorded go with the tree.
  const passStartedAt = dbNow();
  if (!claim.ok) {
    const msg = `${scope} rewrite REFUSED — ${claim.held} already holds the machine; nothing was written`;
    console.warn(`[operator] ${msg}`);
    postEvent(chatId, 'operator', msg);
    await transport.send(chatId, { text: `🌙 ${msg}.`, format: 'plain' }).catch(() => {});
    return { ran: false, changes: 0, outcome: 'refused' };
  }

  // The operator's cancel arrives as a flag on the phase row — possibly from
  // another process — so it has to be POLLED. Two seconds is fast enough that
  // "urgent" means what it says, and slow enough to be free next to a pass
  // that runs for minutes.
  const abort = new AbortController();
  const watch = setInterval(() => {
    // Proof of life rides the cancel poll — the pass is already checking in
    // every two seconds, and a heartbeat on a separate timer would be a second
    // thing to keep alive. Without it the hold expired ~45 minutes into every
    // real fold (dreams #71-#73 ran 3.8h-5.9h) and the machine reported `live`
    // while the night was still writing.
    claim.beat();
    if (claim.cancelled()) abort.abort();
  }, 2000);

  try {
    const out = await rewritePass(transport, chatId, scope, abort);
    // A quiet window settles the night exactly as a folded one does: the pass
    // ran, looked, and found nothing to fold. A FAILURE deliberately does not,
    // so the debt stands and the next tick tries again.
    if (scope === 'nightly' && out.outcome !== 'failed') {
      settleTonight(out.outcome === 'quiet' ? 'quiet' : 'dreamt', out.journalId ? `dream #${out.journalId}` : undefined);
    }
    return out;
  } catch (e) {
    const why = claim.cancelled();
    if (!why) throw e;
    // THE ESCAPE HATCH, and the part that makes it honest: a fold stopped
    // halfway has rewritten some of the tree and not the rest, and the next
    // night would fold on top of that. Put it back.
    let rolled = 'rolled back';
    try {
      claim.rollback();
      deleteUnstampedDoorDecisions(passStartedAt);
      deleteUnstampedDatedVerdicts(passStartedAt);
    } catch (re) {
      rolled = `NOT rolled back (${re instanceof Error ? re.message : String(re)})`;
    }
    // Settled, not retried. The operator cancelled because they needed the day,
    // and a night that re-fires 60 seconds later has not been cancelled at all.
    if (scope === 'nightly') settleTonight('cancelled', why);
    const msg = `${scope} pass CANCELLED — ${why}. The tree was ${rolled}; the night counts as settled and the day is open.`;
    console.warn(`[operator] ${msg}`);
    postEvent(chatId, 'operator', msg);
    pulse('operator', msg, { loud: true });
    await transport.send(chatId, { text: `🌙 ${msg}`, format: 'plain' }).catch(() => {});
    return { ran: false, changes: 0, outcome: 'cancelled' };
  } finally {
    clearInterval(watch);
    claim.release();
  }
}

async function rewritePass(
  transport: ChatTransport,
  chatId: number,
  scope: RewriteScope,
  abort: AbortController,
): Promise<RewriteOutcome> {
  const isNightly = scope === 'nightly';
  const to = dbNow();
  const from = isNightly ? (lastDreamCoveredTo(chatId) ?? '1970-01-01 00:00:00') : undefined;

  let prompt: string;
  let freshOpenLoops = '';
  if (isNightly) {
    // Refresh local work BEFORE reading it. Until now the operator saw only the
    // episodes Mehdi happened to /distill by hand — a live session he never
    // closed was invisible. Harvest the day's sessions, then summarise the new
    // and materially-grown ones (live included) so the digest reflects what he
    // actually did, not just what he narrated in this chat.
    try {
      harvestAll();
      const local = await distillPending(chatId, LOCAL_DISTILL_CAP);
      if (local.distilled || local.failed) {
        console.log(`[nightly] local work: distilled ${local.distilled}, failed ${local.failed}, $${local.costUsd.toFixed(2)}`);
      }
      // The night's own harvest is the richest intake the focus set gets: these
      // are loops Mehdi opened at his own terminal, which reach no other surface
      // unless he happened to mention them in this chat.
      freshOpenLoops = local.openLoops
        .map((l) => `- [${l.project}, session #${l.episodeId}] ${l.loop}`)
        .join('\n');
    } catch (e) {
      console.error('[nightly] local-work refresh failed (continuing with what is stored)', e);
    }
    // THE AUDIT RUNS BEFORE THE SKIP CHECK, and that ordering is the point.
    // A quiet chat day is not a quiet MACHINE day: the suite went red on
    // 2026-07-28 and stayed red for three days, and a pass that skips on an
    // empty window would have told nobody on every one of them. The machine's
    // health does not depend on whether Mehdi typed anything.
    const audit = await runAudit(chatId);
    const alarms = audit.filter((a) => a.fired);

    const { digest, messages } = buildNightlyDigest(chatId, from!, to);
    if (messages === 0) {
      const health = alarms.length
        ? `\n\nBut the machine is not quiet:\n${renderAudit(alarms)}`
        : '\n\nThe machine checked itself and found nothing wrong.';
      await transport
        .send(chatId, { text: `🌙 Nothing new since the last rewrite (${from} → ${to} UTC). Skipped.${health}`, format: 'plain' })
        .catch(() => {});
      return { ran: false, changes: 0, outcome: 'quiet' };
    }
    prompt = stripLoneSurrogates(
      `## THE MACHINE'S OWN HEALTH — read this FIRST, before any of the day's content\n` +
        `(Every input is listed whether or not it found anything: "nothing to report" and "nobody looked" are different, and this block exists to keep them apart.)\n${renderAudit(audit)}\n\n` +
        `Digest of the window's activity and the memory's current state:\n\n${digest}\n\n` +
        (freshOpenLoops
          ? `OPEN LOOPS from tonight's freshly summarised local sessions — things his own work OPENED and did not close:\n${freshOpenLoops}\n\n` +
            `Reconcile these against the focus set (surface 5) before anything else: each one is either already an open focus item, already closed (check it), or missing — and missing is the failure this list exists to catch. Add what is missing at the tier its situation deserves, with a checkCmd wherever a command can answer it.\n\n`
          : '') +
        `The knowledge base is your working directory (index.md is generated — do not edit it). Survey, then rewrite per your instructions. End with the NIGHT REPORT.`,
    );
  } else {
    prompt = stripLoneSurrogates(
      `${buildReconstructionEvidence(chatId)}\n\n` +
        `The OLD tree has been archived to \`.archive/\` inside your working directory (including the old root.md and any legacy identity/ or ideas/ folders) — read every file in it (plus the history above), then RECONSTRUCT the memory fresh per your instructions. Write \`root.md\` FIRST, then the domain maps. End with the domain list + summary.`,
    );
  }

  const before = snapshotNotes();
  // The night's pass is the single most interesting thing the system does, and
  // until now it was invisible while it ran — a gap of several minutes with no
  // outward sign, then a report. Bracketing it makes the Atlas show the machine
  // thinking, which is the whole point of watching it during a dream.
  pulse('operator', `${scope} rewrite started`, { meta: { scope, chatId, phase: 'start' } });
  if (!isNightly) archiveTreeForReconstruction();

  // The doors are OFFERED here, not in the digest builder: the digest is built
  // before the quiet-window skip, and an offer nobody read is not an offer.
  // Idempotent per window, so a failed pass re-rendering it does not double-count.
  if (isNightly) offerDoors(from!, to);
  // The dated statements are offered on the same terms (src/dated.ts).
  if (isNightly) offerDated(datedForPass(chatId, from!, to));
  // SILENCE → DORMANT, mechanically, before the model reads anything: a plan
  // asked about in the flow enough times with no answer stops competing for
  // attention. Journalled like any write; one message from Mehdi revives it.
  if (isNightly) {
    for (const p of parkUnanswered({ chatId, actor: 'nightly' })) {
      pulse('operator', `parked ${p.id} by silence: asked ${p.asked}×, no answer`, { refs: [p.id], meta: { scope, chatId, phase: 'park' } });
    }
  }

  const attempt = async (): Promise<string> => {
    let report = '';
    // The night is one long question, and it belongs in the workload too — it
    // is the heaviest reader of the graph, and M9 optimizing only for the day
    // would tune the shape against a third of its traffic.
    openRetrievalEpisode(NIGHT_SESSION, 'night', `${scope} rewrite`);
    for await (const m of query({
      prompt,
      options: {
        cwd: knowledgePath(),
        // The catalog is appended at RUN time, not built into the constant: a
        // module-level `${catalogSection()}` would load and typecheck every
        // knowledge module during import, on every process start.
        systemPrompt: isNightly ? `${NIGHTLY_SYSTEM}\n\n${catalogSection()}` : RECONSTRUCTION_SYSTEM,
        mcpServers: { bot: buildOperatorServer(chatId) },
        allowedTools: OPERATOR_TOOLS,
        // The toolset IS the sandbox: no shell, no subagents (a Task subagent
        // would carry shell access — the hole grow #3 escaped through), no web.
        disallowedTools: ['Bash', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'NotebookEdit', 'AskUserQuestion'],
        permissionMode: 'bypassPermissions',
        settingSources: [],
        // The operator's way out. Without it a cancel could only be honoured
        // between tool calls, and a pass spends most of its minutes inside one.
        abortController: abort,
        ...(config.model ? { model: config.model } : {}),
      },
    }) as AsyncIterable<any>) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text) report += b.text;
          // THE NIGHT'S BIGGEST BLIND SPOT, closed at one call site.
          //
          // `noteToolCall` was wired only into the dispatch loop, so the single
          // heaviest reader of the knowledge tree — this pass, every night —
          // produced no bypass rows at all. The round-9 ledger then reported
          // health because nothing was recorded, not because nothing was wrong
          // (docs/history/plans/round-10-one-memory.md §5). The same call also pulses,
          // which turns a dream from a several-minute silence between two
          // events into something watchable while it thinks.
          if (b.type === 'tool_use' && b.name) noteToolCall(NIGHT_SESSION, String(b.name), (b.input ?? {}) as Record<string, unknown>);
        }
      } else if (m.type === 'result') {
        const usage = extractUsage(m);
        if (usage) saveUsage(`${chatId}:${isNightly ? 'operator' : 'defrag'}`, usage);
        if (m.subtype !== 'success') throw new Error(String(m.subtype ?? 'error'));
      }
    }
    closeRetrievalEpisode(NIGHT_SESSION);
    return report;
  };

  // Unattended nightly runs retry transient blips; a reconstruction is manual
  // and destructive-ish, so it runs once and restores on failure.
  const MAX_ATTEMPTS = isNightly ? 3 : 1;
  let report = '';
  let ok = true;
  let lastErr = '';
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      report = await attempt();
      ok = true;
      break;
    } catch (e) {
      // A cancel is not a transient blip, and retrying one would mean the
      // operator pressed stop and watched the pass start again — twice.
      if (abort.signal.aborted) throw new DreamCancelled('the operator asked for the night back');
      ok = false;
      lastErr = e instanceof Error ? e.message : String(e);
      console.warn(`[operator] ${scope} attempt ${i}/${MAX_ATTEMPTS} failed: ${lastErr}`);
      if (i < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
  // The SDK can also end cleanly on an abort; the flag is the authority.
  if (abort.signal.aborted) throw new DreamCancelled('the operator asked for the night back');

  let changes: FileChange[] = [];
  let journalId: number | undefined;
  if (ok) {
    rebuildIndex();
    changes = diffSnapshots(before, snapshotNotes());
    if (isNightly) {
      const restored = restoreOrphanedMaps(changes);
      const budget = rootBudget();
      if (budget.over > 0) {
        report += `\n\n\u26A0\uFE0F ROOT OVER BUDGET: root.md is ${budget.chars} chars against a ${budget.cap} cap — the last ${budget.over} are being silently cut from every concierge turn, and the tail is ## Now. Compress it on the next pass.`;
        postEvent(chatId, 'operator', `root over budget: ${budget.chars}/${budget.cap} chars — tail of ## Now is being truncated`);
      }
      if (restored.length) {
        rebuildIndex();
        changes = diffSnapshots(before, snapshotNotes());
        // Into the report, so it lands in the journal, the chat, AND the next
        // night's digest — the pass that did it must see that it did it.
        report += `\n\n⚠️ GUARD: restored ${restored.join(', ')} — deleted while the root still lists the domain. Whatever this pass believed it rewrote there did NOT happen; re-check that node.`;
        postEvent(chatId, 'operator', `guard: restored orphaned map(s) ${restored.join(', ')}`);
      }
    }
    const summary = report.trim() || '(no report)';
    // Journal + change-log. The nightly's window advances ONLY here — a failed
    // pass leaves it unsaved so the next night re-covers it.
    if (isNightly) {
      journalId = saveDream(chatId, summary, from, to);
      stampDoorDecisions(journalId, to);
      stampDatedVerdicts(journalId, to);
      saveGrow(chatId, summary, JSON.stringify(changes));
      postEvent(chatId, 'operator', `nightly rewrite #${journalId}: ${changes.length} file change(s)`);
      pulse('operator', `nightly rewrite #${journalId} — ${changes.length} file change(s)`, {
        loud: true,
        domains: domainsTouched(changes),
        meta: { scope, journalId, changes: changes.length, phase: 'end' },
      });
    } else {
      const growId = saveGrow(chatId, `[reconstruction] ${summary}`, JSON.stringify(changes));
      postEvent(chatId, 'operator', `memory reconstructed: ${changes.length} file change(s) — see change-log #${growId}`);
    }
  } else {
    report = `(${scope} rewrite failed after ${MAX_ATTEMPTS} attempt(s): ${lastErr})`;
    // A failed reconstruction must not leave an empty brain.
    if (!isNightly) restoreArchivedTree();
  }

  await transport
    .send(chatId, {
      text: isNightly
        ? `🌙 <b>Nightly rewrite</b>${journalId !== undefined ? ` · report #${journalId}` : ''} · <i>covers ${from} → ${to} UTC</i>:`
        : '🧹 <b>Reconstruction</b> — the memory, rebuilt fresh from understanding:',
      format: 'tgHtml',
    })
    .catch(() => {});
  for (const piece of chunkRaw(report.trim() || '(the rewrite produced no report)')) {
    await transport
      .send(chatId, { text: toTelegramMarkdown(piece), format: 'tgMarkdownV2' })
      .catch(() => transport.send(chatId, { text: piece, format: 'plain' }).catch(() => {}));
  }
  if (ok) {
    const counts = (['A', 'M', 'D'] as const).map((a) => changes.filter((c) => c.action === a).length);
    const [add, mod, del] = counts;
    const summary =
      [add && `+${add} new`, mod && `~${mod} edited`, del && `−${del} removed`].filter(Boolean).join(', ') ||
      'no file changes';
    const afterHealth = linkHealth();
    const healthLine = afterHealth.length ? `\n⚠️ Link report still has ${afterHealth.length} issue(s).` : '';
    const list = changes.length
      ? `\n<blockquote expandable>${changes.map((c) => `${c.action} ${c.path}`).join('\n')}</blockquote>`
      : '';
    await transport
      .send(chatId, { text: `✅ ${summary}${healthLine}${list}`, format: 'tgHtml' })
      .catch(() => {});
  }

  // THE SLEEP CLEAR (mandatory, nightly only). The night is the one moment the
  // memory is authoritative: the day's conversation has just been folded into
  // the root and the tree. A concierge that keeps resuming across the boundary
  // answers from a stale transcript instead of the memory the night just wrote
  // — and never exercises the retrieval paths, so a gap in the tree stays
  // invisible. Clearing forces it to re-onboard from what was actually written.
  // Runs even when the rewrite failed: a stale session is the worse state.
  if (isNightly) {
    clearSession(sessionKey(chatId, CONTROL_SLOT));
    postEvent(chatId, 'operator', 'concierge context cleared for the new day — it re-onboards from root + tree');
  }
  return { ran: true, journalId, changes: changes.length, outcome: ok ? 'folded' : 'failed' };
}
