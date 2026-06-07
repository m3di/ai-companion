import { run } from '@grammyjs/runner';
import { config } from './config.js';
import { createBot } from './telegram.js';

const bot = createBot();
const me = await bot.api.getMe();

console.log(`[companion] working dir: ${config.workingDir}`);
console.log(`[companion] default permission mode: ${config.permissionMode}`);
console.log(
  config.allowedChatIds.size
    ? `[companion] allowed chats: ${[...config.allowedChatIds].join(', ')}`
    : '[companion] no allowed chats yet — message the bot to learn your chat ID',
);
console.log(`[companion] @${me.username} polling (concurrent runner)`);

const runner = run(bot);

const shutdown = () => {
  console.log('\n[companion] stopping…');
  if (runner.isRunning()) void runner.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
