import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { noteMiss } from './friction.js';
import { bumpRetrieval, recordOutbound } from './db.js';
import { getNote, listNotes, upsertNote } from './knowledge.js';
import { escapeHtml } from './format.js';
import { CONTROL_SLOT, type RunningView } from './sessions.js';
import type { Buttons } from './transport/types.js';

interface PendingAsk {
  key: string;
  slot: number;
  chatId: number;
  questions: { question: string; header?: string; options: string[] }[];
  answers: (string | undefined)[];
  messageIds: (number | undefined)[];
}

/** Pending tg_ask questions, keyed by a short id carried in callback_data.
 *  A question does NOT hold its turn open — the turn ends after posting and the
 *  answer arrives as a fresh turn (like a typed reply), so this map only lives
 *  between posting the buttons and the last one being tapped. */
const askPending = new Map<string, PendingAsk>();
/** Quick-reply payloads: button id -> text + the session key to run it against. */
const quickReplies = new Map<string, { text: string; key: string }>();

let seq = 0;
const nextId = () => (++seq).toString(36);

export interface AskResolution {
  question: string;
  chosen: string;
  messageId?: number;
  /** True once EVERY question in this ask has an answer — time to re-invoke. */
  complete: boolean;
  chatId?: number;
  slot?: number;
  /** The prompt to resume the session with, present only when complete. */
  prompt?: string;
}

/** Record one button tap. Fills that question's answer; when the whole ask is
 *  answered, returns the resume prompt so the caller re-invokes the session. */
export function resolveAsk(id: string, qIdx: number, oIdx: number): AskResolution | null {
  const p = askPending.get(id);
  if (!p) return null;
  const q = p.questions[qIdx];
  if (!q) return null;
  const chosen = q.options[oIdx] ?? '(unknown)';
  p.answers[qIdx] = chosen;
  const complete = p.answers.every((a) => a !== undefined);
  const res: AskResolution = { question: q.question, chosen, messageId: p.messageIds[qIdx], complete };
  if (complete) {
    askPending.delete(id);
    res.chatId = p.chatId;
    res.slot = p.slot;
    const lines = p.questions.map((qq, i) => `- ${qq.header ? `${qq.header}: ` : ''}${qq.question} → ${p.answers[i]}`);
    res.prompt = `[USER ANSWERED] The question(s) you posted have been answered:\n${lines.join('\n')}\n\nContinue with these answers.`;
  }
  return res;
}

/** Drop any pending asks for a session — called when a fresh turn begins, so a
 *  typed answer supersedes the buttons and a late tap can't double-resume. */
export function clearPendingAsks(key: string): void {
  for (const [id, p] of askPending) if (p.key === key) askPending.delete(id);
}

/** Pop the text + target session behind a quick-reply button, if still live. */
export function takeQuickReply(id: string): { text: string; key: string } | undefined {
  const entry = quickReplies.get(id);
  if (entry !== undefined) quickReplies.delete(id);
  return entry;
}

const INSTRUCTIONS = `You reach the user through a Telegram chat. Your normal reply text is shown to them rendered as Markdown. In addition, you have two tools to compose the Telegram UI directly — use them to present information in whatever shape fits best.

- telegram · send — deliver a message written in raw Telegram HTML, optionally with inline buttons. Use it when plain prose can't express the layout: an expandable detail section <blockquote expandable>…</blockquote>, a spoiler <tg-spoiler>…</tg-spoiler>, code <pre><code>…</code></pre>, a link button to a PR/file, or a compact menu.
- telegram · ask — pose a single quick question with tappable options, then END your turn. The answer comes back as your next turn (it does NOT block). Use it to branch on one decision instead of guessing (which file, which branch, proceed or not).
- telegram · askUserQuestion — ask up to 4 decisions at once, each option carrying a one-line explanation, rendered as tappable buttons; then END your turn — the answers arrive as your next turn. This is how you ask structured questions here. The built-in AskUserQuestion tool does NOT work in this chat — always use this instead.
- telegram · recallNotes / readNote / saveFinding — the system's shared knowledge TREE: one _map per domain (a 60-second briefing ending in LEADS — what to do, keywords, where to dig) plus a few depth notes. It is an INDEX over the traces, not an archive: it holds conclusions and pointers, while the detail lives in the message log, session transcripts, git and Fibery. BEFORE substantial digging (mapping a dependency chain, working out how something works), call recallNotes() and read your domain's _map — it often names the gotcha, the exact command, or the dead end someone already hit. AFTER producing a durable, reusable conclusion — or whenever the user says to save/remember it — call saveFinding(key, summary, content) with the distilled result (key files, names, gotchas; not the play-by-play); the nightly rewrite folds it into the right map.

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
      const prefix = view.slot === CONTROL_SLOT ? '' : `🔧 <b>${escapeHtml(view.title)}</b> · `;
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

  // Post one or more questions as tappable options and RETURN — the turn ends,
  // and each answer arrives as a fresh turn (like a typed reply) rather than
  // blocking the thread open. `body` is extra HTML shown under a question.
  const postAsk = async (
    questions: { question: string; header?: string; options: string[]; body?: string }[],
  ): Promise<void> => {
    const id = nextId();
    const messageIds: (number | undefined)[] = [];
    for (let q = 0; q < questions.length; q++) {
      const { question, options, body } = questions[q]!;
      const buttons: Buttons = [];
      options.forEach((opt, o) => {
        if (o % 2 === 0) buttons.push([]);
        buttons[buttons.length - 1]!.push({ text: opt.slice(0, 64), data: `ask:${id}:${q}:${o}` });
      });
      const prefix = view.slot === CONTROL_SLOT ? '' : `🔧 <b>${escapeHtml(view.title)}</b> · `;
      const counter = questions.length > 1 ? ` <i>(${q + 1}/${questions.length})</i>` : '';
      const ref = await view.transport.send(chatId, {
        text: `${prefix}❓ <b>${escapeHtml(question)}</b>${counter}${body ?? ''}`,
        format: 'tgHtml',
        buttons,
      });
      recordOutbound(chatId, ref.messageId, view.key);
      messageIds.push(ref.messageId);
    }
    askPending.set(id, {
      key: view.key,
      slot: view.slot,
      chatId,
      questions: questions.map((q) => ({ question: q.question, header: q.header, options: q.options })),
      answers: new Array(questions.length).fill(undefined),
      messageIds,
    });
  };

  const END_TURN =
    'END YOUR TURN now — do not keep working, waiting, or guessing. The answer(s) will arrive as your next turn, and you continue from there.';

  const ask = tool(
    'ask',
    'Ask ONE quick question with tappable options, then END YOUR TURN. The chosen option arrives as your next turn (like a typed reply) — it does NOT block or return the answer inline. For richer decisions (several questions, or options needing a one-line explanation), use askUserQuestion.',
    {
      question: z.string(),
      options: z.array(z.string()).min(1).max(8).describe('Up to 8 short button labels'),
    },
    async (args) => {
      await view.block(
        'asked',
        `❓ <b>${escapeHtml(view.title)}</b> is waiting on a question — tap to answer.`,
      );
      await postAsk([{ question: args.question, options: args.options }]);
      return { content: [{ type: 'text' as const, text: `Question posted to the user as tappable buttons. ${END_TURN}` }] };
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
      await postAsk(
        args.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => o.label),
          body: q.options
            .map((o, i) => `\n${i + 1}. <b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ''}`)
            .join(''),
        })),
      );
      const n = args.questions.length;
      return {
        content: [{ type: 'text' as const, text: `Posted ${n} question${n === 1 ? '' : 's'} to the user as tappable buttons. ${END_TURN}` }],
      };
    },
  );

  const recallNotes = tool(
    'recallNotes',
    'List the shared knowledge notes (durable findings saved across threads) as an index of key + one-line summary. Call this before substantial digging to check whether a past finding already answers the question; then readNote(key) for the full content.',
    {},
    async () => {
      const notes = listNotes();
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
      const note = getNote(args.key);
      if (note) bumpRetrieval('note', note.key);
      // A miss is friction on the API that exists today: the agent has just
      // stated, unprompted and precisely, what it expected memory to hold.
      else noteMiss('knowledge', 'readNote', args.key, view.key);
      return {
        content: [{ type: 'text' as const, text: note ? note.content : `No note "${args.key}".` }],
      };
    },
  );

  const saveFinding = tool(
    'saveFinding',
    "Persist a durable finding to the shared notes so it isn't re-derived later. Call when you've produced a substantial reusable answer (a mapped dependency chain, a how-it-works writeup) or when the user asks to save/remember something. Distill it: the conclusion plus key specifics (files, names, gotchas), self-contained — not the play-by-play. Reference related notes inline as [[their-key]].",
    {
      key: z.string().describe('kebab-case PATH key placing the note in the tree, e.g. "work/affiliate/auth-blast-radius" — match where similar notes live (see recallNotes)'),
      summary: z.string().describe('<=12 word index line — the question this answers'),
      content: z.string().describe('Distilled finding: conclusion + key specifics, self-contained'),
    },
    async (args) => {
      let landed: string;
      try {
        landed = upsertNote(args.key, args.summary.slice(0, 120), args.content);
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
      const note = landed === args.key ? '' : ` — NOTE: your key "${args.key}" normalized to this`;
      return { content: [{ type: 'text' as const, text: `Saved finding "${landed}" to notes${note}.` }] };
    },
  );

  return createSdkMcpServer({
    // Never deferred behind tool search — see buildConciergeServer (2026-08-27).
    alwaysLoad: true,
    name: 'telegram',
    version: '1.0.0',
    instructions: INSTRUCTIONS,
    tools: [send, ask, askUserQuestion, recallNotes, readNoteTool, saveFinding],
  });
}
