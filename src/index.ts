import { registerDispatch } from './dispatch.js';
import { TelegramAdapter } from './transport/telegram.js';

// The chat surface is chosen here and nowhere else. Swap TelegramAdapter for
// another ChatAdapter (e.g. Slack) and the rest of the app is unchanged.
const adapter = new TelegramAdapter();
registerDispatch(adapter);

await adapter.start();

const shutdown = () => {
  console.log('\n[companion] stopping…');
  void adapter.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
