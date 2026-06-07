import { config } from './config.js';
import { createBot } from './telegram.js';

const bot = createBot();

console.log(`[companion] working dir: ${config.workingDir}`);
console.log(`[companion] permission mode: ${config.permissionMode}`);
console.log(
  config.allowedChatIds.size
    ? `[companion] allowed chats: ${[...config.allowedChatIds].join(', ')}`
    : '[companion] no allowed chats yet — message the bot to learn your chat ID',
);

bot.start({
  onStart: (me) => console.log(`[companion] @${me.username} polling for messages`),
});

const shutdown = () => {
  console.log('\n[companion] stopping…');
  void bot.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
