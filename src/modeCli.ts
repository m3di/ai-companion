import { config } from './config.js';
import { currentMode, debugState, dreamState, enterDebug, exitDebug, refusal, snapshots } from './mode.js';
import { clearSession, releaseDreamPhase, requestDreamCancel, sessionKey } from './db.js';
import { describeDebt, nightOwed, settleTonight } from './night.js';
import { CONTROL_SLOT } from './sessions.js';

/**
 * The work state, from a terminal.
 *
 *   npx tsx src/modeCli.ts                    # where are we
 *   npx tsx src/modeCli.ts debug "why"        # suspend the day, snapshot the tree
 *   npx tsx src/modeCli.ts exit               # resume, KEEPING changes
 *   npx tsx src/modeCli.ts exit --rollback    # resume, discarding them
 *   npx tsx src/modeCli.ts clear-dream        # drop a hold a pass never released
 *   npx tsx src/modeCli.ts cancel-dream "why" # stop tonight's fold, roll it back
 *
 * The chat has `/debug` and `/live` for the same thing. Both exist because the
 * two are used at different moments: the chat command when you notice something
 * mid-conversation, this one when you are already in the editor with the bot in
 * another window.
 */

const [cmd, ...rest] = process.argv.slice(2);
const chatId = [...config.allowedChatIds][0];

function show(): void {
  const d = debugState();
  console.log(`mode: ${currentMode().toUpperCase()}`);
  const dr = dreamState();
  if (dr) {
    // Printed ABOVE the session, because it outranks it: a debug session under
    // a running pass is not what the operator can act on right now.
    console.log(`  a ${dr.scope} pass (pid ${dr.pid}) has held the machine since ${dr.since}`);
    console.log(`  nothing else may run until it lands — not a turn, not a sweep, not a gardening prompt.`);
    if (d) console.log(`  (your debug session is intact underneath it and resumes when the pass ends)\n`);
  }
  if (d) {
    console.log(`  since:    ${d.since}`);
    console.log(`  reason:   ${d.reason || '(none given)'}`);
    console.log(`  snapshot: ${d.snapshot}`);
    console.log(`  baseline: entity_writes id ${d.baselineWriteId}`);
    console.log(`\n  exit --rollback discards everything since. exit keeps it and resets the concierge.`);
  } else {
    const s = snapshots();
    console.log(`  the day runs: turns, workers, commitments, probes, the nightly.`);
    if (s.length) console.log(`  ${s.length} old snapshot(s) kept, newest ${s[0]}`);
  }
  // Printed in every state, because it is the one condition that holds the day
  // while the mode reads as a perfectly ordinary LIVE.
  const owed = nightOwed();
  if (owed) {
    console.log(`\n  NIGHT OWED — ${describeDebt(owed)}`);
    console.log(`  Every day activity is held until it lands. cancel-dream "<why>" takes it back.`);
  }
}

switch (cmd) {
  case undefined:
  case 'status':
    show();
    break;

  case 'debug': {
    // Live and dreaming are both "not debug" and only one of them is a door
    // you can open. Saying so beats letting `enterDebug` throw.
    if (currentMode() === 'dreaming') {
      console.error(refusal('debug-enter'));
      process.exit(1);
    }
    if (currentMode() === 'debug') {
      console.log('Already in debug.\n');
      show();
      break;
    }
    const d = enterDebug(rest.join(' '));
    console.log(`DEBUG MODE. The day is suspended; the tree is snapshotted at\n  ${d.snapshot}\n`);
    console.log('Allowed: gardening, an induced dream, every read. Writes pulse to the Atlas as they land.');
    console.log('Forbidden: day turns, workers, commitments, probe/focus sweeps, harvest, distil, the automatic nightly.');
    break;
  }

  /**
   * THE ESCAPE HATCH. A hold that outlives its pass blocks everything — turns,
   * sweeps, the next night, and the operator's own way back in. `dreamPhase()`
   * clears debris on age and boot clears it on restart, but neither helps
   * someone standing in front of a mute bot right now who wants it back.
   */
  case 'wake':
  case 'clear-dream': {
    const dr = dreamState();
    if (!dr) {
      console.log('No pass holds the machine.');
      break;
    }
    releaseDreamPhase();
    console.log(`Cleared the ${dr.scope} hold (claimed ${dr.since} by pid ${dr.pid}).`);
    console.log('If that pass is still running, it will finish and write its report; the day is no longer blocked for it.');
    show();
    break;
  }

  /**
   * TAKE THE NIGHT BACK.
   *
   * The night became mandatory so a day could never start on top of an unfolded
   * one. The cost of that is real and predictable: sooner or later something
   * urgent arrives while a pass is holding the machine, and "wait ten minutes"
   * is the wrong answer to it. This is the right one — the pass stops, its
   * writes are rolled back, the boundary is marked settled, and the day opens.
   *
   * Distinct from `clear-dream`, which drops a hold and lets the pass keep
   * writing. That one is for debris; this one is for a pass that is genuinely
   * running and genuinely in the way.
   */
  case 'cancel-dream': {
    const why = rest.join(' ').trim();
    if (!why) {
      console.error('cancel-dream needs a reason — a night given up on without one is unreadable a week later.');
      process.exit(1);
    }
    const dr = dreamState();
    if (dr) {
      requestDreamCancel(why);
      console.log(`Asked the ${dr.scope} pass (pid ${dr.pid}) to stop: "${why}".`);
      console.log('It checks every couple of seconds, unwinds its own writes, and hands the day back. Watch the Atlas or the chat for the confirmation.');
      break;
    }
    // Nothing running, but the day may still be held by a night that has not
    // started. "One will begin within the minute, cancel that one" is not an
    // answer to somebody who needs the bot now.
    const owed = nightOwed();
    if (!owed) {
      console.log('Nothing to cancel — no pass is running and no night is owed.');
      break;
    }
    settleTonight('cancelled', why);
    console.log(`Night ${owed.boundary} UTC settled as CANCELLED: "${why}". The day is open; its window folds into tomorrow's pass.`);
    break;
  }

  case 'exit':
  case 'live': {
    if (currentMode() === 'dreaming') {
      console.error(refusal('debug-enter'));
      process.exit(1);
    }
    if (currentMode() === 'live') {
      console.log('Already live.');
      break;
    }
    const rollback = rest.includes('--rollback') || rest.includes('--discard');
    let report;
    try {
      report = exitDebug({ rollback });
    } catch (e) {
      console.error(`Could not exit: ${(e as Error).message}`);
      process.exit(1);
    }
    if (!report) break;
    console.log(`LIVE. ${report.writes.length} graph write(s) ${report.rolledBack ? 'ROLLED BACK' : 'kept'}.`);
    for (const w of report.writes) console.log(`  ${w.op.padEnd(13)} ${w.entity_id.padEnd(44)} ${w.actor}`);
    if (report.contextReset && chatId !== undefined) {
      // The graph moved under a context built on the old one. Clearing it is
      // not tidiness: a concierge answering from a picture memory no longer
      // supports is the failure that had it emailing an answered question.
      clearSession(sessionKey(chatId, CONTROL_SLOT));
      console.log('\nConcierge context CLEARED — memory moved under it.');
    } else {
      console.log('\nConcierge context untouched.');
    }
    break;
  }

  default:
    console.error(`unknown command "${cmd}" — try: status | debug "<why>" | exit [--rollback] | clear-dream | cancel-dream "<why>"`);
    process.exit(2);
}
