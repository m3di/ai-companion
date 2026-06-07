import { type Context, InlineKeyboard } from 'grammy';
import { describeTool, escapeHtml, SAFE_TOOLS } from './format.js';

type Decision = 'allow' | 'always' | 'deny';
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Pending approvals keyed by a short id carried in callback_data. */
const pending = new Map<string, (d: Decision) => void>();

/** Per-chat set of tool names the user chose to always allow this session. */
const autoAllow = new Map<number, Set<string>>();

let seq = 0;
const nextId = () => (++seq).toString(36);

function allowedFor(chatId: number): Set<string> {
  let set = autoAllow.get(chatId);
  if (!set) {
    set = new Set();
    autoAllow.set(chatId, set);
  }
  return set;
}

export function resetAutoAllow(chatId: number): void {
  autoAllow.delete(chatId);
}

/**
 * Resolve a pending approval from a button tap. Returns true if it matched a
 * live request. Called by the bot's callback_query handler.
 */
export function resolvePermission(data: string): boolean {
  const [kind, id] = data.split(':');
  if (!id) return false;
  const resolve = pending.get(id);
  if (!resolve) return false;
  pending.delete(id);
  resolve(kind === 'a' ? 'allow' : kind === 'A' ? 'always' : 'deny');
  return true;
}

/**
 * Build a canUseTool callback bound to a chat. Safe/read-only tools and
 * session-approved tools pass through silently; everything else prompts the
 * user with inline Allow / Always / Deny buttons and waits for the tap.
 */
export function createCanUseTool(ctx: Context, chatId: number) {
  const approved = allowedFor(chatId);

  return async (
    toolName: string,
    input: Record<string, unknown>,
    { signal }: { signal: AbortSignal },
  ): Promise<PermissionResult> => {
    if (SAFE_TOOLS.has(toolName) || approved.has(toolName)) return { behavior: 'allow' };

    const id = nextId();
    const { detail, summary } = describeTool(toolName, input);
    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `a:${id}`)
      .text('⛔ Deny', `d:${id}`)
      .row()
      .text(`♾️ Always allow ${toolName}`, `A:${id}`);

    const shown = detail || summary;
    const prompt = await ctx.reply(
      `🔐 <b>${escapeHtml(toolName)}</b> wants to run:\n` +
        `<blockquote expandable>${escapeHtml(shown)}</blockquote>`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );

    const decision = await new Promise<Decision>((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        resolve('deny');
      }, APPROVAL_TIMEOUT_MS);
      const settle = (d: Decision) => {
        clearTimeout(timeout);
        resolve(d);
      };
      pending.set(id, settle);
      signal.addEventListener('abort', () => {
        pending.delete(id);
        settle('deny');
      });
    });

    if (decision === 'always') approved.add(toolName);

    const verdict =
      decision === 'deny'
        ? '⛔ Denied'
        : decision === 'always'
          ? `♾️ Always allowing ${escapeHtml(toolName)}`
          : '✅ Allowed';
    await ctx.api
      .editMessageText(
        chatId,
        prompt.message_id,
        `${verdict} · <b>${escapeHtml(toolName)}</b>`,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});

    if (decision === 'deny') {
      return { behavior: 'deny', message: `User denied ${toolName} via Telegram.` };
    }
    return { behavior: 'allow' };
  };
}
