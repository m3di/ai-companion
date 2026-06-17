import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getNote, listNotes, recordOutbound, setMemo, upsertNote } from './db.js';
import { escapeHtml } from './format.js';
import { CONTROL_SLOT, type RunningView } from './sessions.js';
import type { Buttons } from './transport/types.js';

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
- telegram · setMemo — keep this thread labeled and resumable. This chat runs several parallel threads shown as buttons, and an auto-router uses these memos to route messages to the right thread, so an unset memo hurts. EARLY in your first substantive reply in a thread, call setMemo with a short title and a 1-2 line status of what this thread is about; update it after meaningful progress or when the focus shifts. It's cheap and silent — don't ask permission, just keep it current.
- telegram · recallNotes / readNote / saveFinding — a knowledge base of durable findings, shared across all threads, so hard-won answers aren't re-derived. BEFORE substantial digging (mapping a dependency chain, working out how something works), call recallNotes() to check whether a past finding already answers it, then readNote(key) to pull it. AFTER producing a durable, reusable answer — or whenever the user says to save/remember it — call saveFinding(key, summary, content) with the distilled conclusion (key files, names, gotchas; not the play-by-play).

Rules:
- For an ordinary answer, just reply normally. Do NOT also send the same text via 'send' — that double-posts. Use 'send' for the things prose can't do.
- Telegram HTML allows ONLY these tags: b, i, u, s, a (with href), code, pre, blockquote, blockquote expandable, tg-spoiler. No tables, divs, headings, lists, or styles. Escape literal < > & as &lt; &gt; &amp;.
- Keep a single message under ~4000 characters; send several if needed.
- Buttons come in rows. A button either opens a url, or carries a 'reply' string that is sent back to you as the user's next message when tapped (great for menus and follow-ups).
- Be inventive with presentation, but keep it readable on a phone.`;

/** Build the per-session Telegram UI tool server passed into a query(). */
export function buildUiServer(view: RunningView) {
  const { chatId } = view;
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
      const buttons: Buttons = [];
      for (const row of args.buttons ?? []) {
        const r: Buttons[number] = [];
        for (const b of row) {
          if (b.url) r.push({ text: b.text, url: b.url });
          else if (b.reply) {
            const id = nextId();
            quickReplies.set(id, { text: b.reply, key: view.key });
            r.push({ text: b.text, data: `qr:${id}` });
          } else {
            r.push({ text: b.text, data: 'noop' });
          }
        }
        buttons.push(r);
      }
      const prefix = view.slot === CONTROL_SLOT ? '' : `<b>${escapeHtml(view.title)}</b> · `;
      try {
        const ref = await view.transport.send(chatId, {
          text: `${prefix}${args.html}`,
          format: 'tgHtml',
          buttons: buttons.length ? buttons : undefined,
        });
        recordOutbound(chatId, ref.messageId, view.key);
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
    const buttons: Buttons = [];
    optionLabels.forEach((opt, i) => {
      if (i % 2 === 0) buttons.push([]);
      buttons[buttons.length - 1]!.push({ text: opt.slice(0, 64), data: `ask:${id}:${i}` });
    });
    const prefix = view.slot === CONTROL_SLOT ? '' : `<b>${escapeHtml(view.title)}</b> · `;
    const ref = await view.transport.send(chatId, {
      text: `${prefix}❓ <b>${escapeHtml(question)}</b>${body}`,
      format: 'tgHtml',
      buttons,
    });
    recordOutbound(chatId, ref.messageId, view.key);
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
        messageId: ref.messageId,
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

  const setMemoTool = tool(
    'setMemo',
    "Record or update this thread's memo — a short title and a 1-3 line status of what it's about and where it stands. The title labels this thread's button; the memo lets the thread be resumed if context is lost. Call it when the thread's purpose becomes clear or shifts, or after meaningful progress. Cheap and silent — use it freely.",
    {
      title: z.string().describe('Short thread label, ≤4 words (e.g. "Slovenia visa", "scraper bug")'),
      summary: z
        .string()
        .describe('1-3 lines: what this thread is about and its current state / next step'),
    },
    async (args) => {
      setMemo(view.chatId, view.slot, args.title.slice(0, 60), args.summary);
      return { content: [{ type: 'text' as const, text: 'Memo saved.' }] };
    },
  );

  const recallNotes = tool(
    'recallNotes',
    'List the shared knowledge notes (durable findings saved across threads) as an index of key + one-line summary. Call this before substantial digging to check whether a past finding already answers the question; then readNote(key) for the full content.',
    {},
    async () => {
      const notes = listNotes(view.chatId);
      const text = notes.length
        ? notes.map((n) => `- ${n.key} — ${n.summary}`).join('\n')
        : '(no notes yet)';
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  const readNoteTool = tool(
    'readNote',
    'Read the full content of one knowledge note by its key (get keys from recallNotes).',
    { key: z.string() },
    async (args) => {
      const note = getNote(view.chatId, args.key);
      return {
        content: [{ type: 'text' as const, text: note ? note.content : `No note "${args.key}".` }],
      };
    },
  );

  const saveFinding = tool(
    'saveFinding',
    "Persist a durable finding to the shared notes so it isn't re-derived later. Call when you've produced a substantial reusable answer (a mapped dependency chain, a how-it-works writeup) or when the user asks to save/remember something. Distill it: the conclusion plus key specifics (files, names, gotchas), self-contained — not the play-by-play. Reference related notes inline as [[their-key]].",
    {
      key: z.string().describe('Short kebab-case slug, e.g. "affiliate-auth-blast-radius"'),
      summary: z.string().describe('<=12 word index line — the question this answers'),
      content: z.string().describe('Distilled finding: conclusion + key specifics, self-contained'),
    },
    async (args) => {
      upsertNote(view.chatId, args.key.slice(0, 60), args.summary.slice(0, 120), args.content);
      return { content: [{ type: 'text' as const, text: `Saved finding "${args.key}" to notes.` }] };
    },
  );

  return createSdkMcpServer({
    name: 'telegram',
    version: '1.0.0',
    instructions: INSTRUCTIONS,
    tools: [send, ask, askUserQuestion, setMemoTool, recallNotes, readNoteTool, saveFinding],
  });
}
