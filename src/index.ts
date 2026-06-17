import { config } from './config.js';
import { registerDispatch } from './dispatch.js';
import { runDream } from './dream.js';
import { initKnowledge } from './knowledge.js';
import { TelegramAdapter } from './transport/telegram.js';

// Prepare the git-tracked knowledge base (and migrate any legacy SQLite notes
// into it on first run).
initKnowledge();

// The chat surface is chosen here and nowhere else. Swap TelegramAdapter for
// another ChatAdapter (e.g. Slack) and the rest of the app is unchanged.
const adapter = new TelegramAdapter();
registerDispatch(adapter);

await adapter.start();

// Nightly: run the dream reflection for each allowed chat so dream-records
// accumulate on their own. `grow` stays operator-triggered (/grow) — it can
// touch many notes, so a human kicks it off and reviews the result.
let nightly: NodeJS.Timeout | undefined;
const NIGHTLY_HOUR = Number(process.env.NIGHTLY_HOUR ?? 4);
function armNightly(): void {
  if (!Number.isFinite(NIGHTLY_HOUR) || config.allowedChatIds.size === 0) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(NIGHTLY_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  nightly = setTimeout(
    async () => {
      for (const chatId of config.allowedChatIds) {
        try {
          await runDream(adapter, chatId);
        } catch (e) {
          console.error('[nightly] dream failed', e);
        }
      }
      armNightly(); // re-arm for the next night
    },
    next.getTime() - now.getTime(),
  );
}
armNightly();
if (config.allowedChatIds.size) console.log(`[companion] nightly dream scheduled ~${NIGHTLY_HOUR}:00`);

const shutdown = () => {
  console.log('\n[companion] stopping…');
  if (nightly) clearTimeout(nightly);
  void adapter.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
