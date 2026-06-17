import { primeRouter } from './router.js';
import { createBot } from './telegram.js';
import { TelegramAdapter } from './transport/telegram.js';

// The chat surface is chosen here and nowhere else. Swap this line for another
// ChatAdapter (e.g. Slack) and the rest of the app is unchanged.
const adapter = new TelegramAdapter(createBot());

// Warm the router subprocess at boot so the first real route isn't slow.
void primeRouter();

await adapter.start();

const shutdown = () => {
  console.log('\n[companion] stopping…');
  void adapter.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
