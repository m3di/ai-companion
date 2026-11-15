import { renderAudit, runAudit } from './audit.js';
import { config } from './config.js';

/**
 * The night's health audit, on demand.
 *
 * The audit exists so the machine's own discomfort reaches someone. Wiring it
 * only into the nightly would have left it reaching one reader, once a day,
 * inside a report — and the thing it is defending against is precisely a
 * failure nobody looks at. So it is also a command.
 *
 *   npx tsx src/auditCli.ts
 *
 * Run it at the start of a working session, before deciding what to build:
 * every input reports whether or not it fired, so this is the fastest honest
 * answer to "is anything actually broken right now, and is the last few days'
 * work being used?" It runs the suite and the typecheck, so give it a minute.
 */

const chatId = [...config.allowedChatIds][0];
if (chatId === undefined) {
  console.error('no allowed chat id configured — the proposal queue is per-chat');
  process.exit(2);
}
const lines = await runAudit(chatId);
console.log(renderAudit(lines));

const fired = lines.filter((l) => l.fired);
console.log(`\n${fired.length ? `${fired.length} of ${lines.length} inputs want attention` : `all ${lines.length} inputs clean`}`);
// A red suite means every measurement above it is suspect, so say so with the
// exit code too — this is the one thing worth failing a script on.
process.exit(lines.find((l) => l.input === 'test suite')?.fired ? 1 : 0);
