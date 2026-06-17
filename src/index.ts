import { primeRouter } from './router.js';
import { createBot } from './telegram.js';

// createBot() wires the handlers and returns the chat adapter. The transport is
// the only chat-surface dependency the app entry point has — swapping Telegram
// for another ChatAdapter is a change behind createBot, nothing here.
const adapter = createBot();

// Warm the router subprocess at boot so the first real route isn't slow.
void primeRouter();

await adapter.start();

const shutdown = () => {
  console.log('\n[companion] stopping…');
  void adapter.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
