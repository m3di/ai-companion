import { run } from '@grammyjs/runner';
import { config } from './config.js';
import { primeRouter } from './router.js';
import { createBot } from './telegram.js';

const bot = createBot();
const me = await bot.api.getMe();

await bot.api
  .setMyCommands([
    { command: 'bot', description: 'Manage threads & memory (the concierge)' },
    { command: 'new', description: 'Start another thread' },
    { command: 'sessions', description: 'Show the thread keyboard' },
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

const runner = run(bot);

const shutdown = () => {
  console.log('\n[companion] stopping…');
  if (runner.isRunning()) void runner.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
