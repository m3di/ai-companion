import { run } from '@grammyjs/runner';
import { config } from './config.js';
import { primeRouter } from './router.js';
import { createBot } from './telegram.js';

const bot = createBot();
const me = await bot.api.getMe();

await bot.api
  .setMyCommands([
    { command: 'sessions', description: 'List your threads, tap to switch' },
    { command: 'new', description: 'Start another thread' },
    { command: 'bot', description: 'Manage threads & memory (the concierge)' },
    { command: 'pin', description: 'Keep messages in the current thread (toggle)' },
    { command: 'auto', description: 'Turn auto-routing on/off' },
    { command: 'close', description: 'Close the current thread' },
    { command: 'history', description: 'Reopen a closed thread' },
    { command: 'cancel', description: 'Stop the current thread’s turn' },
    { command: 'cwd', description: 'Show or set the working directory' },
    { command: 'status', description: 'Current session info' },
  ])
  .catch(() => {});

console.log(`[companion] working dir: ${config.workingDir}`);
console.log(`[companion] default permission mode: ${config.permissionMode}`);
console.log(
  config.allowedChatIds.size
    ? `[companion] allowed chats: ${[...config.allowedChatIds].join(', ')}`
    : '[companion] no allowed chats yet — message the bot to learn your chat ID',
);
console.log(`[companion] @${me.username} polling (concurrent runner)`);

// Warm the router subprocess at boot so the first real route isn't slow.
void primeRouter();

let runner = run(bot);

// Stall-watchdog: the long-poll can silently die (the process stays "polling"
// but stops consuming updates, so messages pile up at Telegram). Every minute,
// check the pending-update backlog; if it's stuck above zero across consecutive
// checks, the poller has stalled — restart it. getWebhookInfo doesn't conflict
// with getUpdates, so this is a safe, in-process self-heal.
let stalls = 0;
const watchdog = setInterval(async () => {
  try {
    const info = await bot.api.getWebhookInfo();
    const pending = info.pending_update_count ?? 0;
    if (pending > 0) {
      stalls += 1;
      if (stalls >= 2) {
        console.warn(`[watchdog] poll stalled (${pending} pending) — restarting runner`);
        try {
          if (runner.isRunning()) await runner.stop();
        } catch {
          /* ignore */
        }
        runner = run(bot);
        stalls = 0;
      }
    } else {
      stalls = 0;
    }
  } catch {
    /* getWebhookInfo failed (transient network) — ignore */
  }
}, 60_000);

const shutdown = () => {
  console.log('\n[companion] stopping…');
  clearInterval(watchdog);
  if (runner.isRunning()) void runner.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
