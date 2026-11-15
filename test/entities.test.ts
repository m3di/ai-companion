import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { graphOf, lintText } from '../src/entities.js';

/**
 * THE LINT INVARIANTS.
 *
 * Round 8's finding, four times over: every rule stated as an INSTRUCTION to a
 * model decayed or was simply wrong; every rule made MECHANICAL held. These
 * tests are what keeps the mechanical half mechanical — a linter is only a
 * guarantee for as long as something checks the linter.
 */

/** A minimal record that must lint clean; `extra` appends fields. */
function ok(extra = ''): string {
  return `---
id: t/alpha
kind: task
facts:
  - the importer keys rows by external_id
chain: [msg#1]
status: open
${extra}`;
}

const lint = (text: string) => lintText(text, 't');
const messages = (text: string) => lint(text).errors.map((e) => e.message).join('\n');
const clean = (text: string) => assert.deepEqual(lint(text).errors, [], `expected no diagnostics, got:\n${messages(text)}`);
const rejects = (text: string, re: RegExp) => assert.match(messages(text), re);

describe('grammar', () => {
  it('accepts a minimal record', () => {
    clean(ok());
    assert.equal(lint(ok()).entities.length, 1);
  });

  it('refuses content before the first fence', () => rejects(`id: t/alpha\n${ok()}`, /content before the first/));
  it('refuses an unknown field', () => rejects(ok('owner: mehdi'), /unknown field `owner`/));
  it('refuses a duplicate field', () => rejects(ok('kind: pr'), /duplicate field `kind`/));
  it('refuses a non key: value line', () => rejects(ok('just some prose'), /not a `key: value` line/));
  it('refuses an inline value on edges', () => rejects(ok('edges: [t/beta]'), /nested map of relations/));
  it('refuses a bare scalar for a list field', () => rejects(ok('aka: the importer'), /`aka` is a list/));
  it('refuses a list item with no open field', () => rejects(`---\n- orphan\n${ok().slice(4)}`, /list item with no open field/));

  it('parses inline and block lists the same way', () => {
    const inline = lint(ok('aka: [alpha, "the alpha task"]')).entities[0]!;
    const block = lint(ok('aka:\n  - alpha\n  - "the alpha task"')).entities[0]!;
    assert.deepEqual(inline.aka, ['alpha', 'the alpha task']);
    assert.deepEqual(block.aka, inline.aka);
  });

  it('keeps escapes in a double-quoted scalar', () => {
    // Regression: `renderRecords` JSON-quotes any fact containing ": ", so a
    // naive quote-strip turned every inner quote into a literal backslash-quote
    // — the data degrading a little each time it passed through its own view.
    const e = lint(`---
id: t/alpha
kind: task
facts:
  - ${JSON.stringify('Two edits precede sending — add "Employment: full-time"')}
chain: [msg#1]
status: open
`).entities[0]!;
    assert.equal(e.facts[0], 'Two edits precede sending — add "Employment: full-time"');
  });

  it('drops an empty edge relation rather than storing it', () => {
    // `{"relates-to":[]}` in the data and `{}` back out of the view is a
    // difference with no meaning that still breaks the round-trip check.
    const e = lint(ok('edges:\n  relates-to:')).entities[0]!;
    assert.deepEqual(e.edges, {});
  });
});

describe('vocabularies', () => {
  it('refuses an id that is not a kebab path', () => rejects(ok().replace('id: t/alpha', 'id: Alpha Task'), /is not a kebab path/));
  it('refuses an id living outside its domain', () => rejects(ok().replace('id: t/alpha', 'id: other/alpha'), /does not live in its own domain/));
  it('refuses an unknown kind', () => rejects(ok().replace('kind: task', 'kind: epic'), /kind "epic" is not one of/));
  it('refuses an unknown edge relation', () => rejects(ok('edges:\n  causes: [t/alpha]'), /unknown edge relation "causes"/));
  it('refuses an unknown status', () => rejects(ok().replace('status: open', 'status: doing'), /status "doing" is not one of/));
  it('refuses a non-boolean goal', () => rejects(ok('goal: yes'), /goal must be true or false/));

  it('refuses a duplicate id', () => rejects(`${ok()}${ok()}`, /duplicate id/));
  it('refuses redefining an id owned by another domain', () =>
    assert.match(lintText(ok(), 't', ['t/alpha']).errors.map((e) => e.message).join('\n'), /already exists in another domain/));
  it('refuses an edge that resolves to nothing', () => rejects(ok('edges:\n  blocks: [t/ghost]'), /does not resolve to any entity/));
  it('allows an edge into a known other domain', () =>
    assert.deepEqual(lintText(ok('edges:\n  blocks: [other/thing]'), 't', ['other/thing']).errors, []));
});

describe('structural rules', () => {
  it('refuses an empty chain', () => rejects(ok().replace('chain: [msg#1]', 'chain: []'), /chain is empty/));

  it('refuses a chain entry that points at an entity', () => {
    // A real run emitted `chain: [msg#4193, "personal/sideapp-sunset"]` — the
    // record pointing at itself instead of back at a trace.
    rejects(ok().replace('chain: [msg#1]', 'chain: [msg#1, t/alpha]'), /points at an entity, not at a trace/);
  });

  it('refuses a blocks cycle', () => {
    const two = `---
id: t/alpha
kind: task
chain: [msg#1]
status: open
edges:
  blocks: [t/beta]
---
id: t/beta
kind: task
chain: [msg#2]
status: open
edges:
  blocks: [t/alpha]
`;
    rejects(two, /dependency cycle/);
  });

  it('materializes the inverse of blocks in both directions', () => {
    const two = `---
id: t/alpha
kind: task
chain: [msg#1]
status: open
edges:
  blocks: [t/beta]
---
id: t/beta
kind: task
chain: [msg#2]
status: open
`;
    const { errors } = lint(two);
    assert.deepEqual(errors, []);
    // Written from either end, the same dependency must produce the same graph.
    const flipped = two.replace('  blocks: [t/beta]', '').replace('chain: [msg#2]\nstatus: open\n', 'chain: [msg#2]\nstatus: open\nedges:\n  blocked-by: [t/alpha]\n');
    assert.deepEqual(lint(flipped).errors, []);
  });

  it('refuses a probe that is not allowlisted', () => rejects(ok('probe: curl https://example.com'), /not allowlisted/));
  it('accepts an allowlisted probe with a closed_when', () =>
    clean(`---
id: t/alpha
kind: pr
facts:
  - the importer keys rows by external_id
chain: [msg#1]
probe: gh pr view 1 --repo o/r --json state -q .state
closed_when: (MERGED|CLOSED)
`));
  it('refuses a hand-written status alongside a probe', () =>
    rejects(ok('probe: gh pr view 1 --json state'), /status is derived from the probe/));
  it('refuses closed_when without a probe', () => rejects(ok('closed_when: (MERGED)'), /closed_when has no meaning without a probe/));
  it('refuses an unparseable closed_when', () =>
    rejects(ok().replace('status: open', 'probe: gh pr view 1 --json state\nclosed_when: (MERGED'), /not a valid regex/));
  it('refuses state without state_at', () => rejects(ok('state: MERGED'), /state and state_at must appear together/));
  it('refuses dormant next to an actor', () => rejects(ok('dormant: true\nactor: mehdi'), /cannot also name the person moving it/));
});

/**
 * THE FACT LINTER — the rule with the worst track record and the highest cost.
 *
 * Both halves are load-bearing and the false-POSITIVE half is the expensive one:
 * two complete reform runs (~$5 and 25 minutes each) were thrown away because
 * the linter rejected permanently-true history. Every string below is real
 * output from those runs.
 */
describe('facts are timeless', () => {
  const fact = (f: string) => `---\nid: t/alpha\nkind: task\nfacts:\n  - ${JSON.stringify(f)}\nchain: [msg#1]\nstatus: open\n`;
  const accepts = (f: string) => assert.deepEqual(lint(fact(f)).errors, [], `should accept: ${f}`);
  const refuses = (f: string) => assert.match(messages(fact(f)), /facts are timeless/, `should refuse: ${f}`);

  it('accepts history — a finished event never becomes false', () => {
    accepts('report_ingest_mode was dropped, replaced by a ClientReport row');
    accepts('shipped in PR #91, merged to main by alizshow');
    accepts('epic #2772, created 2026-07-20');
    accepts('merged to main 2026-07-05 after two review rounds');
  });

  it('accepts rules that merely contain status words', () => {
    accepts('a vacancy must stay open for a fixed period');
    accepts('publishing the vacancy starts the statutory waiting window');
    accepts('branches are merged via squash');
    accepts('external_id already exists on Affiliate, with a find-or-create by it');
  });

  it('refuses a present-tense state assertion', () => {
    refuses('the import PR is merged');
    refuses('the migration is blocked');
    refuses('this work is in progress');
  });

  it('refuses now-relative bookkeeping', () => {
    refuses('currently blocked on a review from Nora');
    refuses('waiting on the notary appointment');
    refuses('filed as #2830');
    refuses('next step: split the importer');
  });

  it('refuses time measured from now, and only from now', () => {
    refuses('~3 weeks left on the permit window');
    refuses('the schema changed 2 days ago');
    refuses('the appointment lands next week');
    accepts('the permit window is 3 weeks long'); // a duration, not a countdown
  });
});

/**
 * THE ACTOR JOIN (M0) — the graph's centre.
 *
 * `actor` was a bare string on 56 of 153 entities, naming a person who existed
 * as a `person` entity, joined nowhere. The hub is now DERIVED on every load,
 * which is what keeps it from drifting (Charter I2) — and what these tests hold
 * is that it stays derived: unwritable by hand, and fatal when it dangles.
 */
describe('the actor join', () => {
  const person = (id = 'people/mehdi', kind = 'person') => `---
id: ${id}
kind: ${kind}
facts:
  - engineer at BA
chain: [msg#1]
status: n/a
`;
  /** Two domains, the way the real tree holds them: people in `people/`, work
   *  everywhere else, joined only by the `actor` string. */
  const both = (extra: string, personId = 'people/mehdi', kind = 'person') => {
    const p = lintText(person(personId, kind), personId.split('/')[0]!);
    const t = lintText(ok(extra), 't', [personId]);
    const graph = graphOf([...p.entities, ...t.entities]);
    return { errors: [...p.errors, ...t.errors, ...graph.errors], graph };
  };

  it('derives an edge from the entity to the person it names', () => {
    const { errors, graph } = both('actor: mehdi');
    assert.deepEqual(errors, [], errors.map((e) => e.message).join('\n'));
    assert.deepEqual(
      graph.edges.filter((e) => e.rel === 'acted-by'),
      [{ src: 't/alpha', rel: 'acted-by', dst: 'people/mehdi' }],
    );
  });

  it('does not point a person at themselves', () => {
    const { entities } = lintText(person().replace('status: n/a', 'status: n/a\nactor: mehdi'), 'people');
    assert.deepEqual(graphOf(entities).edges, []);
  });

  it('resolves an actor across domains by basename', () => {
    // The reformer's gate holds one domain's entities and everyone else's bare
    // ids — resolution must work off the id alone or it works on one path only.
    const errs = lintText(ok('actor: mehdi'), 't', ['people/mehdi']).errors;
    assert.deepEqual(errs, [], errs.map((e) => e.message).join('\n'));
  });

  it('refuses an actor that names nobody', () => {
    rejects(ok('actor: ghost'), /actor "ghost" resolves to no entity/);
  });

  it('refuses an ambiguous actor, which is what forces people into one domain', () => {
    assert.match(
      lintText(ok('actor: mehdi'), 't', ['people/mehdi', 'personal/mehdi']).errors.map((e) => e.message).join('\n'),
      /actor "mehdi" is ambiguous/,
    );
  });

  it('refuses an actor that resolves to something that is not a person', () => {
    const { errors } = both('actor: mehdi', 'people/mehdi', 'task');
    assert.match(errors.map((e) => e.message).join('\n'), /is a task, not a person/);
  });

  it('refuses a person filed outside the people domain', () => {
    assert.match(
      lintText(person('t/mehdi'), 't').errors.map((e) => e.message).join('\n'),
      /a person belongs in the people\/ domain/,
    );
  });

  it('refuses acted-by written by hand — a derived relation is not authorable', () => {
    rejects(ok('edges:\n  acted-by: [people/mehdi]'), /unknown edge relation "acted-by"/);
  });
});
