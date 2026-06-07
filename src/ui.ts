import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { type Context, InlineKeyboard } from 'grammy';
import { z } from 'zod';
import { escapeHtml } from './format.js';

interface AskEntry {
  resolve: (choice: string) => void;
  options: string[];
  question: string;
  messageId?: number;
}

/** Pending tg_ask questions, keyed by a short id carried in callback_data. */
const askPending = new Map<string, AskEntry>();
/** Quick-reply payloads: button id -> text to re-send as the user's next turn. */
const quickReplies = new Map<string, string>();

let seq = 0;
const nextId = () => (++seq).toString(36);

/** Resolve a tg_ask from a button tap. Returns details for the UI, or null. */
export function resolveAsk(
  id: string,
  idx: number,
): { question: string; chosen: string; messageId?: number } | null {
  const entry = askPending.get(id);
  if (!entry) return null;
  askPending.delete(id);
  const chosen = entry.options[idx] ?? '(unknown)';
  entry.resolve(chosen);
  return { question: entry.question, chosen, messageId: entry.messageId };
}

/** Pop the text behind a quick-reply button, if still live. */
export function takeQuickReply(id: string): string | undefined {
  const text = quickReplies.get(id);
  if (text !== undefined) quickReplies.delete(id);
  return text;
}

const INSTRUCTIONS = `You reach the user through a Telegram chat. Your normal reply text is shown to them rendered as Markdown. In addition, you have two tools to compose the Telegram UI directly — use them to present information in whatever shape fits best.

- telegram · send — deliver a message written in raw Telegram HTML, optionally with inline buttons. Use it when plain prose can't express the layout: an expandable detail section <blockquote expandable>…</blockquote>, a spoiler <tg-spoiler>…</tg-spoiler>, code <pre><code>…</code></pre>, a link button to a PR/file, or a compact menu.
- telegram · ask — pose a question with tappable options and wait for the answer. Use it to branch on a decision instead of guessing (which file, which branch, proceed or not).

Rules:
- For an ordinary answer, just reply normally. Do NOT also send the same text via 'send' — that double-posts. Use 'send' for the things prose can't do.
- Telegram HTML allows ONLY these tags: b, i, u, s, a (with href), code, pre, blockquote, blockquote expandable, tg-spoiler. No tables, divs, headings, lists, or styles. Escape literal < > & as &lt; &gt; &amp;.
- Keep a single message under ~4000 characters; send several if needed.
- Buttons come in rows. A button either opens a url, or carries a 'reply' string that is sent back to you as the user's next message when tapped (great for menus and follow-ups).
- Be inventive with presentation, but keep it readable on a phone.`;

/** Build the per-session Telegram UI tool server passed into a query(). */
export function buildUiServer(ctx: Context, chatId: number, threadId?: number) {
  const thread = threadId !== undefined ? { message_thread_id: threadId } : {};
  const send = tool(
    'send',
    "Send a richly formatted Telegram message (raw Telegram HTML) with optional inline buttons. Use when prose can't express the layout you want.",
    {
      html: z
        .string()
        .describe(
          'Message body as Telegram HTML. Allowed tags: b, i, u, s, a(href), code, pre, blockquote, blockquote expandable, tg-spoiler. Escape < > & as entities. Max ~4000 chars.',
        ),
      buttons: z
        .array(
          z.array(
            z.object({
              text: z.string().describe('Button label'),
              url: z.string().optional().describe('Open this URL when tapped'),
              reply: z
                .string()
                .optional()
                .describe('When tapped, this text is sent back to you as the user next message'),
            }),
          ),
        )
        .optional()
        .describe('Rows of inline buttons; each button is a URL link or a quick-reply'),
    },
    async (args) => {
      const keyboard = new InlineKeyboard();
      let hasButtons = false;
      for (const row of args.buttons ?? []) {
        for (const b of row) {
          hasButtons = true;
          if (b.url) keyboard.url(b.text, b.url);
          else if (b.reply) {
            const id = nextId();
            quickReplies.set(id, b.reply);
            keyboard.text(b.text, `qr:${id}`);
          } else {
            keyboard.text(b.text, 'noop');
          }
        }
        keyboard.row();
      }
      try {
        await ctx.api.sendMessage(chatId, args.html, {
          parse_mode: 'HTML',
          ...thread,
          ...(hasButtons ? { reply_markup: keyboard } : {}),
        });
        return { content: [{ type: 'text' as const, text: 'Message delivered.' }] };
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text' as const, text: `Failed to send (likely invalid HTML): ${m}` }],
          isError: true,
        };
      }
    },
  );

  const ask = tool(
    'ask',
    'Ask the user a question with tappable options. Blocks until they choose, then returns the chosen option text. Use to branch on a decision instead of guessing.',
    {
      question: z.string(),
      options: z.array(z.string()).min(1).max(8).describe('Up to 8 short button labels'),
    },
    async (args) => {
      const id = nextId();
      const keyboard = new InlineKeyboard();
      args.options.forEach((opt, i) => {
        keyboard.text(opt.slice(0, 64), `ask:${id}:${i}`);
        if (i % 2 === 1) keyboard.row();
      });
      const msg = await ctx.api.sendMessage(chatId, `❓ <b>${escapeHtml(args.question)}</b>`, {
        parse_mode: 'HTML',
        ...thread,
        reply_markup: keyboard,
      });
      const choice = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          askPending.delete(id);
          resolve('(user did not answer in time)');
        }, 10 * 60 * 1000);
        askPending.set(id, {
          resolve: (c) => {
            clearTimeout(timeout);
            resolve(c);
          },
          options: args.options,
          question: args.question,
          messageId: msg.message_id,
        });
      });
      return { content: [{ type: 'text' as const, text: choice }] };
    },
  );

  return createSdkMcpServer({
    name: 'telegram',
    version: '1.0.0',
    instructions: INSTRUCTIONS,
    tools: [send, ask],
  });
}
