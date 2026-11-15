/**
 * INDUCE THE NIGHT FROM A SHELL.
 *
 *   npx tsx src/dreamCli.ts             # fold now, report to stdout
 *   npx tsx src/dreamCli.ts <chatId>    # for a specific chat
 *
 * The induced fold is the operator's main "did that change help?" instrument,
 * and until now its only trigger lived inside the bot process (Telegram
 * /dream). Working ON the machine means the operator is usually in a shell,
 * not a chat — and a change to the night's own machinery is exactly the change
 * you want to watch land from outside the process that runs it on schedule.
 *
 * Why this door is safe to have: it adds NO second write path. It calls the
 * same `runRewrite` the scheduled pass and /dream call, and the dream-phase
 * lock lives in the DATABASE with the holder's pid — the 08-05 double-nightly
 * happened precisely because the guard was a module variable that an induced
 * pass in its own process could not see. A second process is legal because the
 * lock was built for one. The gates are consulted, never forced: a machine
 * already dreaming refuses here with the same words it refuses everywhere.
 */
import { config } from './config.js';
import { allowed, currentMode, refusal } from './mode.js';
import { runRewrite } from './operator.js';
import type { ChatTransport, MessageRef, OutgoingMessage } from './transport/types.js';

/** The pass narrates to a chat; from a shell, the chat is stdout. The report
 *  also lands in the `dreams` journal regardless of transport. */
const consoleTransport: ChatTransport = {
  async send(chatId: number, msg: OutgoingMessage): Promise<MessageRef> {
    console.log(msg.text);
    return { chatId, messageId: 0 };
  },
  async edit(): Promise<void> {},
  async delete(): Promise<void> {},
  async react(): Promise<void> {},
  async typing(): Promise<void> {},
  async sendVoice(chatId: number, path: string): Promise<MessageRef> {
    console.log(`[voice] ${path}`);
    return { chatId, messageId: 0 };
  },
};

async function main(): Promise<void> {
  const argChat = Number(process.argv[2]);
  const chatId = Number.isFinite(argChat) && argChat !== 0 ? argChat : [...config.allowedChatIds][0];
  if (!chatId) {
    console.error('No chat id: ALLOWED_CHAT_IDS is empty and none was given. Usage: npx tsx src/dreamCli.ts [chatId]');
    process.exit(1);
  }

  // A polite pre-check with the right words; the REAL lock is the phase claim
  // inside runRewrite, which cannot race (it is one DB insert).
  if (!allowed('dream')) {
    console.error(refusal('dream'));
    process.exit(1);
  }

  const mode = currentMode();
  console.log(`Inducing a nightly fold (mode: ${mode}${mode === 'debug' ? ' — the session survives the pass' : ''}, chat ${chatId})…`);

  const out = await runRewrite(consoleTransport, chatId, 'nightly');

  if (out.outcome === 'refused') {
    // runRewrite already narrated who holds the machine.
    process.exit(1);
  }
  const dream = out.journalId ? ` Dream #${out.journalId} — read it with /dreams ${out.journalId}, or cycleCli.` : '';
  console.log(`Pass finished: ${out.outcome}, ${out.changes} file change(s).${dream}`);
  process.exit(out.outcome === 'folded' || out.outcome === 'quiet' ? 0 : 1);
}

void main();
