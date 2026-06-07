import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { InlineKeyboard } from 'grammy';
import { z } from 'zod';
import { escapeHtml } from './format.js';
import type { RunningView } from './sessions.js';

interface AskEntry {
  resolve: (choice: string) => void;
  options: string[];
  question: string;
  messageId?: number;
}

/** Pending tg_ask questions, keyed by a short id carried in callback_data. */
const askPending = new Map<string, AskEntry>();
/** Quick-reply payloads: button id -> text + the session key to run it against. */
const quickReplies = new Map<string, { text: string; key: string }>();

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

/** Pop the text + target session behind a quick-reply button, if still live. */
export function takeQuickReply(id: string): { text: string; key: string } | undefined {
  const entry = quickReplies.get(id);
  if (entry !== undefined) quickReplies.delete(id);
  return entry;
}

const INSTRUCTIONS = `You reach the user through a Telegram chat. Your normal reply text is shown to them rendered as Markdown. In addition, you have two tools to compose the Telegram UI directly — use them to present information in whatever shape fits best.

- telegram · send — deliver a message written in raw Telegram HTML, optionally with inline buttons. Use it when plain prose can't express the layout: an expandable detail section <blockquote expandable>…</blockquote>, a spoiler <tg-spoiler>…</tg-spoiler>, code <pre><code>…</code></pre>, a link button to a PR/file, or a compact menu.
- telegram · ask — pose a single quick question with tappable options and wait for the answer. Use it to branch on one decision instead of guessing (which file, which branch, proceed or not).
- telegram · askUserQuestion — ask up to 4 decisions at once, each option carrying a one-line explanation, rendered as tappable buttons. This is how you ask structured questions here. The built-in AskUserQuestion tool does NOT work in this chat — always use this instead.

Rules:
- For an ordinary answer, just reply normally. Do NOT also send the same text via 'send' — that double-posts. Use 'send' for the things prose can't do.
- Telegram HTML allows ONLY these tags: b, i, u, s, a (with href), code, pre, blockquote, blockquote expandable, tg-spoiler. No tables, divs, headings, lists, or styles. Escape literal < > & as &lt; &gt; &amp;.
- Keep a single message under ~4000 characters; send several if needed.
- Buttons come in rows. A button either opens a url, or carries a 'reply' string that is sent back to you as the user's next message when tapped (great for menus and follow-ups).
- Be inventive with presentation, but keep it readable on a phone.`;

/** Build the per-session Telegram UI tool server passed into a query(). */
export function buildUiServer(view: RunningView) {
  const { api, chatId } = view;
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
            quickReplies.set(id, { text: b.reply, key: view.key });
            keyboard.text(b.text, `qr:${id}`);
          } else {
            keyboard.text(b.text, 'noop');
          }
        }
        keyboard.row();
      }
      const prefix = view.isAttached() ? '' : `<b>${escapeHtml(view.title)}</b> · `;
      try {
        await api.sendMessage(chatId, `${prefix}${args.html}`, {
          parse_mode: 'HTML',
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

  // Pose one question with tappable options (and an Other escape hatch) and
  // block until the user picks. `body` is extra HTML shown under the question.
  const askOne = async (question: string, optionLabels: string[], body = ''): Promise<string> => {
    const id = nextId();
    const keyboard = new InlineKeyboard();
    optionLabels.forEach((opt, i) => {
      keyboard.text(opt.slice(0, 64), `ask:${id}:${i}`);
      if (i % 2 === 1) keyboard.row();
    });
    const prefix = view.isAttached() ? '' : `<b>${escapeHtml(view.title)}</b> · `;
    const msg = await api.sendMessage(
      chatId,
      `${prefix}❓ <b>${escapeHtml(question)}</b>${body}`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
    return new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        askPending.delete(id);
        resolve('(user did not answer in time)');
      }, 10 * 60 * 1000);
      askPending.set(id, {
        resolve: (c) => {
          clearTimeout(timeout);
          resolve(c);
        },
        options: optionLabels,
        question,
        messageId: msg.message_id,
      });
    });
  };

  const ask = tool(
    'ask',
    'Ask ONE quick question with tappable options. Blocks until they choose, then returns the chosen option text. For richer decisions (several questions, or options that need a one-line explanation), use askUserQuestion instead.',
    {
      question: z.string(),
      options: z.array(z.string()).min(1).max(8).describe('Up to 8 short button labels'),
    },
    async (args) => {
      await view.block(
        'asked',
        `❓ <b>${escapeHtml(view.title)}</b> is waiting on a question — tap to answer.`,
      );
      const choice = await askOne(args.question, args.options);
      view.unblock();
      return { content: [{ type: 'text' as const, text: choice }] };
    },
  );

  const askUserQuestion = tool(
    'askUserQuestion',
    'Ask the user up to 4 decisions at once, each with 2-4 explained options, rendered as tappable buttons. Use this to gather requirements or branch on choices instead of guessing. Returns the chosen answers. This is the way to ask structured questions in this chat — the built-in AskUserQuestion tool does not work here.',
    {
      questions: z
        .array(
          z.object({
            question: z.string().describe('The full question, ending with a question mark'),
            header: z.string().optional().describe('Very short label (≤12 chars) for the topic'),
            options: z
              .array(
                z.object({
                  label: z.string().describe('Short choice label (1-5 words, shown on the button)'),
                  description: z.string().optional().describe('One-line explanation of this choice'),
                  preview: z.string().optional(),
                }),
              )
              .min(2)
              .max(4),
            multiSelect: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(4),
    },
    async (args) => {
      await view.block(
        'asked',
        `❓ <b>${escapeHtml(view.title)}</b> is waiting on ${args.questions.length} question${
          args.questions.length === 1 ? '' : 's'
        } — tap to answer.`,
      );
      const answers: string[] = [];
      for (const q of args.questions) {
        const body = q.options
          .map(
            (o, i) =>
              `\n${i + 1}. <b>${escapeHtml(o.label)}</b>${
                o.description ? ` — ${escapeHtml(o.description)}` : ''
              }`,
          )
          .join('');
        const choice = await askOne(q.question, q.options.map((o) => o.label), body);
        answers.push(`${q.header ?? q.question}: ${choice}`);
      }
      view.unblock();
      return { content: [{ type: 'text' as const, text: answers.join('\n') }] };
    },
  );

  return createSdkMcpServer({
    name: 'telegram',
    version: '1.0.0',
    instructions: INSTRUCTIONS,
    tools: [send, ask, askUserQuestion],
  });
}
