import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyCheck } from '../src/focus.js';

/**
 * A CHECK HAS THREE OUTCOMES, AND ONLY A VALUE MAY BECOME STATE (Charter I3).
 *
 * The gate is load-bearing in a way that is easy to miss: `runCommand` ignores
 * exit codes on purpose, because a non-zero exit is a real answer from
 * `gh pr checks` (8 while pending) and `grep` (1 on no match). So a tool that
 * FAILED arrives at the classifier looking exactly like one that succeeded, and
 * whatever this pattern does not catch is written into the graph as truth.
 *
 * Every string below is one the live system actually stored. They are pinned
 * here rather than described because the failure mode is a near-miss: the first
 * version of the list spelled out `jq: error`, which does not match
 * `jq: parse error`, and three entities spent 2026-08-02 flapping between their
 * real state and a parse error — each flip rewriting a system prompt and
 * invalidating a cache prefix (I12).
 */

const ran = (output: string) => classifyCheck({ ok: true, output }, 120);

describe('a check that could not answer', () => {
  it('catches every shape of jq diagnostic, not one spelling of it', () => {
    // Both of these were stored AS state on 2026-08-02.
    for (const out of [
      'jq: parse error: Invalid numeric literal at line 1, column 9',
      'jq: error (at <stdin>:0): Cannot index object with number',
      'jq: Unknown option: --foo',
    ]) {
      assert.equal(ran(out).kind, 'unanswered', out);
    }
  });

  it('catches a Go HTTP transport failure whatever its cause', () => {
    for (const out of [
      'Post "https://api.github.com/graphql": dial tcp: i/o timeout',
      'Get "https://acme.fibery.io/api/commands": TLS handshake timeout',
    ]) {
      assert.equal(ran(out).kind, 'unanswered', out);
    }
  });

  it('catches the sentinel the checks themselves emit', () => {
    assert.equal(ran('TRANSIENT').kind, 'unanswered');
  });

  it('treats silence as no answer rather than as an empty state', () => {
    // The 2026-07-28 outage: an empty string persisted as an entity's state,
    // which then disagreed with its record file and killed every sweep for
    // three days.
    assert.equal(ran('').kind, 'unanswered');
    assert.equal(ran('   \n ').kind, 'unanswered');
  });

  it('separates a command that could not RUN from one that could not ANSWER', () => {
    const r = classifyCheck({ ok: false, output: 'failed to launch: ENOENT' }, 120);
    assert.equal(r.kind, 'failed');
  });
});

describe('a check that answered', () => {
  it('passes real states through untouched', () => {
    // The other half of the invariant, and the reason this cannot be a general
    // "looks like an error" heuristic: these are the actual answers the live
    // probes return, and a gate that swallowed any of them would freeze the
    // state layer exactly as an over-permissive one corrupts it.
    for (const out of ['To Do', 'In Progress', 'For Testing', 'MERGED APPROVED', 'Archived', '0', 'CHANGES_REQUESTED']) {
      const r = ran(out);
      assert.equal(r.kind, 'value', out);
      assert.equal(r.kind === 'value' && r.value, out);
    }
  });

  it('does not mistake an ordinary word for a tool diagnostic', () => {
    // "error" is a legitimate thing for a state to contain; only the tool's own
    // prefix means the tool failed.
    assert.equal(ran('Error budget exceeded').kind, 'value');
    assert.equal(ran('error-handling-refactor').kind, 'value');
  });
});
