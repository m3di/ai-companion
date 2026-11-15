import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addProposalEvidence,
  getDesignProposal,
  listDesignProposals,
  postEvent,
  recordDesignProposalVerdict,
  setDesignProposalStatus,
  type DesignProposalRow,
  type ProposalEvidenceRow,
} from './db.js';
import { checkCommandAllowed, classifyCheck, runCommand } from './focus.js';

/**
 * DESIGN PROPOSALS — the planning half of the loop between the bot and its
 * developer. The store is in db.ts; this is what the three actors do with it.
 *
 *   day        opens one from a conversation, adds evidence, amends
 *   night      opens one from friction, adds evidence, merges duplicates
 *   developer  decides (accept / reject, with the Charter's idea test),
 *              lands, and lets the audit verify
 *
 * The decision WRITES the Charter's "Ideas measured" table — the table is a
 * render of the rows, not something a session remembers to type (I1, I9).
 * Verification is the same mechanism findings use: a read-only command the
 * nightly audit re-runs, with three outcomes (I3), so a landed proposal says
 * shipped or not-yet without anyone re-reading it.
 */

export interface IdeaTest {
  /** Which invariant it serves (or strains). */
  invariant: string;
  /** Which milestone it advances. */
  milestone: string;
  /** What it deletes. */
  deletes: string;
  /** How we will know it worked — the number. */
  measure: string;
}

const CHARTER = resolve(process.cwd(), 'docs/CHARTER.md');

function fence(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Append one row to the Charter's "Ideas measured" table. Returns false when
 *  the table cannot be found — the decision is still recorded in the row. */
export function writeIdeaMeasured(date: string, idea: string, verdict: string, charterPath = CHARTER): boolean {
  let text: string;
  try {
    text = readFileSync(charterPath, 'utf8');
  } catch {
    return false;
  }
  const head = text.indexOf('## Ideas measured');
  if (head < 0) return false;
  const next = text.indexOf('\n## ', head + 1);
  const section = text.slice(head, next < 0 ? text.length : next);
  const lastRow = section.lastIndexOf('\n|');
  if (lastRow < 0) return false;
  const rowEnd = section.indexOf('\n', lastRow + 1);
  const cut = head + (rowEnd < 0 ? section.length : rowEnd);
  const row = `\n| ${date} | ${fence(idea)} | ${fence(verdict)} |`;
  writeFileSync(charterPath, text.slice(0, cut) + row + text.slice(cut));
  return true;
}

export function decideProposal(
  id: number,
  outcome: 'accepted' | 'rejected',
  test: IdeaTest,
  verdict: string,
  opts: { chatId?: number; charterPath?: string } = {},
): { ok: boolean; charter: boolean } {
  const p = getDesignProposal(id);
  if (!p || p.status !== 'open') return { ok: false, charter: false };
  const decision = [
    `**${outcome === 'accepted' ? 'Accepted' : 'Rejected'}${test.milestone ? ` → ${test.milestone}` : ''}.**`,
    verdict.trim(),
    `_(1) Invariant:_ ${test.invariant}`,
    `_(2) Milestone:_ ${test.milestone}`,
    `_(3) Deletes:_ ${test.deletes}`,
    `_(4) Measured by:_ ${test.measure}`,
  ].join(' ');
  setDesignProposalStatus(id, outcome, { decision });
  const charter = writeIdeaMeasured(new Date().toISOString().slice(0, 10), `${p.title} (proposal #${id})`, decision, opts.charterPath);
  if (opts.chatId !== undefined) postEvent(opts.chatId, 'proposal', `design proposal #${id} "${p.title}" ${outcome} by the developer: ${verdict}`);
  return { ok: true, charter };
}

export function landProposal(id: number, ref: string, chatId?: number): boolean {
  const p = getDesignProposal(id);
  if (!p || p.status !== 'accepted') return false;
  setDesignProposalStatus(id, 'landed', { landedRef: ref });
  addProposalEvidence({ proposalId: id, actor: 'developer', kind: 'note', ref, text: `landed as ${ref}` });
  if (chatId !== undefined) postEvent(chatId, 'proposal', `design proposal #${id} "${p.title}" landed (${ref}); its verify runs nightly`);
  return true;
}

/**
 * Run every landed proposal's verify command. Three outcomes (I3): shipped
 * (the row becomes `verified`), not-yet, or the check itself could not run —
 * which is not evidence of anything. A landed row with no verify is blind and
 * is reported as such rather than silently left.
 */
export async function verifyLandedProposals(chatId?: number): Promise<Array<{ p: DesignProposalRow; verdict: string }>> {
  const rows = listDesignProposals(['landed']);
  const out: Array<{ p: DesignProposalRow; verdict: string }> = [];
  for (const p of rows) {
    let verdict: string;
    if (!p.verify?.trim()) verdict = 'unfalsifiable';
    else if (!checkCommandAllowed(p.verify)) verdict = 'broken: verify command not allowlisted';
    else {
      const o = classifyCheck(await runCommand(p.verify), 200);
      verdict = o.kind === 'failed' ? `broken: ${o.detail.slice(0, 80)}` : o.kind === 'unanswered' ? 'not-yet' : 'shipped';
    }
    recordDesignProposalVerdict(p.id, verdict);
    if (verdict === 'shipped') {
      setDesignProposalStatus(p.id, 'verified');
      if (chatId !== undefined) postEvent(chatId, 'proposal', `design proposal #${p.id} "${p.title}" VERIFIED — its own check passes`);
    }
    out.push({ p, verdict });
  }
  return out;
}

export function ageDays(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 86_400_000);
}

/** One line per proposal — the glance a session or the audit reads. */
export function proposalLine(p: DesignProposalRow): string {
  const v = p.verdict ? ` · ${p.verdict}` : '';
  return `#${p.id} [${p.status}${v}] ${p.title} — by ${p.created_by}, ${ageDays(p.created_at)}d old, ${p.evidence_count} evidence${p.last_evidence_at ? ` (last ${p.last_evidence_at.slice(0, 10)})` : ''}`;
}

function evidenceLine(e: ProposalEvidenceRow): string {
  return `- ${e.at.slice(0, 16)} ${e.actor} ${e.kind}${e.ref ? ` [${e.ref}]` : ''}: ${e.text}`;
}

/** The whole proposal as markdown — what a developer session reads. */
export function renderProposal(id: number): string | undefined {
  const p = getDesignProposal(id);
  if (!p) return undefined;
  const parts = [
    `# #${p.id} · ${p.title}`,
    `status **${p.status}** · opened by ${p.created_by} ${p.created_at.slice(0, 10)} · updated ${p.updated_at.slice(0, 16)}${p.cites ? ` · cites ${p.cites}` : ''}`,
    p.verify ? `verify: \`${p.verify}\`${p.verdict ? ` → ${p.verdict} @ ${p.verified_at?.slice(0, 16)}` : ' (never run)'}` : 'verify: NONE — nothing can tell this from stale once landed',
    p.decision ? `decision (${p.decided_at?.slice(0, 10)}): ${p.decision}` : '',
    p.landed_ref ? `landed: ${p.landed_ref}` : '',
    p.merged_into ? `merged into #${p.merged_into}` : '',
    '',
    '## Problem',
    p.problem,
    '',
    p.body ? `## Design\n${p.body}` : '',
    '',
    `## Evidence (${p.evidence.length})`,
    p.evidence.length ? p.evidence.map(evidenceLine).join('\n') : '(none — a proposal with no evidence is an opinion)',
  ];
  return parts.filter((x) => x !== '').join('\n');
}

/** For the audit: every input reported whether or not it fired. */
export function designProposalsSummary(): { fired: boolean; text: string } {
  const open = listDesignProposals(['open']);
  const accepted = listDesignProposals(['accepted']);
  const landed = listDesignProposals(['landed']);
  if (!open.length && !accepted.length && !landed.length) return { fired: false, text: 'no design proposals open.' };
  const parts: string[] = [];
  if (open.length) parts.push(`${open.length} OPEN, awaiting a developer's decision (npx tsx src/proposalCli.ts show <id>):\n${open.map(proposalLine).join('\n')}`);
  if (accepted.length) parts.push(`${accepted.length} ACCEPTED, not landed:\n${accepted.map(proposalLine).join('\n')}`);
  if (landed.length) parts.push(`${landed.length} LANDED, verify pending:\n${landed.map(proposalLine).join('\n')}`);
  const stale = open.filter((p) => ageDays(p.created_at) >= 14);
  const blind = landed.filter((p) => !p.verify);
  return { fired: stale.length > 0 || blind.length > 0, text: parts.join('\n\n') };
}
