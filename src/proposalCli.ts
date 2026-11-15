import { readFileSync } from 'node:fs';
import { config } from './config.js';
import {
  addProposalEvidence,
  amendDesignProposal,
  createDesignProposal,
  listDesignProposals,
  mergeDesignProposals,
  PROPOSAL_STATUSES,
  type EvidenceKind,
} from './db.js';
import { decideProposal, landProposal, proposalLine, renderProposal, verifyLandedProposals } from './proposals.js';

/**
 * The developer's end of the proposal channel. The bot opens, evidences and
 * amends; only this moves a row past `open`.
 *
 *   npx tsx src/proposalCli.ts                       # open / accepted / landed, newest first
 *   npx tsx src/proposalCli.ts list --all            # every status
 *   npx tsx src/proposalCli.ts show <id>             # the whole proposal, as markdown
 *   npx tsx src/proposalCli.ts new "<title>" --problem "<why>" [--body-file f.md] [--cites "I9, M3"] [--verify "<cmd>"]
 *   npx tsx src/proposalCli.ts evidence <id> "<text>" [--kind measure|message|episode|friction|note] [--ref "msg#14320"]
 *   npx tsx src/proposalCli.ts amend <id> "<note>" [--append-file f.md | --body-file f.md] [--verify "<cmd>"] [--cites ".."]
 *   npx tsx src/proposalCli.ts accept <id> "<verdict>" --invariant ".." --milestone ".." --deletes ".." --measure ".."
 *   npx tsx src/proposalCli.ts reject <id> "<verdict>" --invariant ".." --milestone ".." --deletes ".." --measure ".."
 *   npx tsx src/proposalCli.ts land <id> <commit-or-ref>
 *   npx tsx src/proposalCli.ts merge <from> <into> "<note>"
 *   npx tsx src/proposalCli.ts verify               # run every landed row's check now
 *
 * accept / reject append the row to the Charter's "Ideas measured" table and
 * post an event the concierge sees, so the next conversation about the same
 * thing adds evidence instead of re-proposing.
 */

const argv = process.argv.slice(2);
const flags: Record<string, string | true> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--')) {
      flags[k] = v;
      i++;
    } else flags[k] = true;
  } else pos.push(a);
}
const str = (k: string): string | undefined => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
const need = (k: string): string => {
  const v = str(k);
  if (!v) {
    console.error(`--${k} is required`);
    process.exit(2);
  }
  return v;
};
const chatId = [...config.allowedChatIds][0];
const cmd = pos[0] ?? 'list';
const id = Number(pos[1]);

switch (cmd) {
  case 'list': {
    const rows = flags.all ? listDesignProposals([...PROPOSAL_STATUSES]) : listDesignProposals();
    console.log(rows.length ? rows.map(proposalLine).join('\n') : 'no design proposals' + (flags.all ? '' : ' open'));
    break;
  }
  case 'show': {
    const md = renderProposal(id);
    if (!md) {
      console.error(`no proposal #${pos[1]}`);
      process.exit(1);
    }
    console.log(md);
    break;
  }
  case 'new': {
    const title = pos[1];
    if (!title) {
      console.error('new "<title>" --problem "<why>"');
      process.exit(2);
    }
    const body = str('body-file') ? readFileSync(str('body-file')!, 'utf8') : str('body');
    const nid = createDesignProposal({ title, problem: need('problem'), body, cites: str('cites'), verify: str('verify'), actor: 'developer' });
    console.log(`#${nid} opened`);
    break;
  }
  case 'evidence': {
    const text = pos[2];
    if (!id || !text) {
      console.error('evidence <id> "<text>"');
      process.exit(2);
    }
    const eid = addProposalEvidence({ proposalId: id, actor: 'developer', kind: (str('kind') as EvidenceKind) ?? 'note', ref: str('ref'), text });
    console.log(`evidence #${eid} on #${id}`);
    break;
  }
  case 'amend': {
    const note = pos[2];
    if (!id || !note) {
      console.error('amend <id> "<note>" [--append-file f] [--body-file f] [--verify cmd] [--cites ..]');
      process.exit(2);
    }
    const ok = amendDesignProposal(
      id,
      {
        appendBody: str('append-file') ? readFileSync(str('append-file')!, 'utf8') : str('append'),
        body: str('body-file') ? readFileSync(str('body-file')!, 'utf8') : undefined,
        verify: str('verify'),
        cites: str('cites'),
        title: str('title'),
        problem: str('problem'),
      },
      'developer',
      note,
    );
    console.log(ok ? `#${id} amended` : `no proposal #${id}`);
    break;
  }
  case 'accept':
  case 'reject': {
    const verdict = pos[2];
    if (!id || !verdict) {
      console.error(`${cmd} <id> "<verdict>" --invariant --milestone --deletes --measure`);
      process.exit(2);
    }
    const r = decideProposal(
      id,
      cmd === 'accept' ? 'accepted' : 'rejected',
      { invariant: need('invariant'), milestone: need('milestone'), deletes: need('deletes'), measure: need('measure') },
      verdict,
      { chatId },
    );
    if (!r.ok) {
      console.error(`#${id} is not an open proposal`);
      process.exit(1);
    }
    console.log(`#${id} ${cmd}ed${r.charter ? '; row appended to docs/CHARTER.md "Ideas measured"' : '; CHARTER table not found — add the row by hand'}`);
    break;
  }
  case 'land': {
    const ref = pos[2];
    if (!id || !ref) {
      console.error('land <id> <commit-or-ref>');
      process.exit(2);
    }
    console.log(landProposal(id, ref, chatId) ? `#${id} landed as ${ref}` : `#${id} is not an accepted proposal`);
    break;
  }
  case 'merge': {
    const into = Number(pos[2]);
    const note = pos[3] ?? '';
    if (!id || !into) {
      console.error('merge <from> <into> "<note>"');
      process.exit(2);
    }
    console.log(mergeDesignProposals(id, into, 'developer', note) ? `#${id} merged into #${into}` : 'merge refused (missing, same, or already merged)');
    break;
  }
  case 'verify': {
    const res = await verifyLandedProposals(chatId);
    console.log(res.length ? res.map((r) => `#${r.p.id} ${r.verdict} — ${r.p.title}`).join('\n') : 'nothing landed to verify');
    break;
  }
  default: {
    console.error(`unknown command "${cmd}"; statuses: ${PROPOSAL_STATUSES.join(' → ')}`);
    process.exit(2);
  }
}
