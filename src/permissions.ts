import { getPrefs } from './db.js';
import { describeTool, escapeHtml, SAFE_TOOLS } from './format.js';
import { CONTROL_SLOT, type RunningView } from './sessions.js';
import type { Buttons } from './transport/types.js';

type Decision = 'allow' | 'always' | 'deny';
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Pending approvals keyed by a short id carried in callback_data. */
const pending = new Map<string, { settle: (d: Decision) => void; key: string }>();

/** Per-session set of tool names the user chose to always allow. */
const autoAllow = new Map<string, Set<string>>();

let seq = 0;
const nextId = () => (++seq).toString(36);

function allowedFor(key: string): Set<string> {
  let set = autoAllow.get(key);
  if (!set) {
    set = new Set();
    autoAllow.set(key, set);
  }
  return set;
}

export function resetAutoAllow(key: string): void {
  autoAllow.delete(key);
}

/**
 * Resolve a pending approval from a button tap. Returns true if it matched a
 * live request. Called by the bot's callback_query handler.
 */
export function resolvePermission(data: string): boolean {
  const [kind, id] = data.split(':');
  if (!id) return false;
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.settle(kind === 'a' ? 'allow' : kind === 'A' ? 'always' : 'deny');
  return true;
}

/** Release any approvals a session is currently blocked on (e.g. switched to auto). */
export function clearPendingApprovals(key: string): void {
  for (const [id, entry] of pending) {
    if (entry.key === key) {
      pending.delete(id);
      entry.settle('allow');
    }
  }
}

/**
 * Build a canUseTool callback bound to one session's live view. Safe/read-only
 * and session-approved tools pass through silently; everything else prompts with
 * inline Allow / Always / Deny buttons and waits for the tap. A blocked
 * background session surfaces a badge + one-line notice via the view.
 */
export function createCanUseTool(view: RunningView) {
  const approved = allowedFor(view.key);

  return async (
    toolName: string,
    input: Record<string, unknown>,
    { signal }: { signal: AbortSignal },
  ): Promise<PermissionResult> => {
    if (SAFE_TOOLS.has(toolName) || approved.has(toolName)) return { behavior: 'allow' };
    // Read the mode live, so switching a thread to auto mid-turn stops the
    // prompts immediately (unsticks a stalled background worker).
    const mode = getPrefs(view.key).permissionMode;
    if (mode === 'auto' || mode === 'bypassPermissions') return { behavior: 'allow' };

    const id = nextId();
    const { detail, summary } = describeTool(toolName, input);
    const keyboard: Buttons = [
      [
        { text: '✅ Allow', data: `a:${id}` },
        { text: '⛔ Deny', data: `d:${id}` },
      ],
      [{ text: `♾️ Always allow ${toolName}`, data: `A:${id}` }],
    ];

    const shown = detail || summary;
    await view.block(
      'needsPerm',
      `❗ <b>${escapeHtml(view.title)}</b> needs permission for <b>${escapeHtml(toolName)}</b> — tap to review.`,
    );
    const prefix = view.slot === CONTROL_SLOT ? '' : `🔧 <b>${escapeHtml(view.title)}</b> · `;
    const prompt = await view.transport.send(view.chatId, {
      text:
        `${prefix}🔐 <b>${escapeHtml(toolName)}</b> wants to run:\n` +
        `<blockquote expandable>${escapeHtml(shown)}</blockquote>`,
      format: 'tgHtml',
      buttons: keyboard,
    });

    const decision = await new Promise<Decision>((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        resolve('deny');
      }, APPROVAL_TIMEOUT_MS);
      const settle = (d: Decision) => {
        clearTimeout(timeout);
        resolve(d);
      };
      pending.set(id, { settle, key: view.key });
      signal.addEventListener('abort', () => {
        pending.delete(id);
        settle('deny');
      });
    });

    view.unblock();
    if (decision === 'always') approved.add(toolName);

    const verdict =
      decision === 'deny'
        ? '⛔ Denied'
        : decision === 'always'
          ? `♾️ Always allowing ${escapeHtml(toolName)}`
          : '✅ Allowed';
    await view.transport.edit(prompt, {
      text: `${verdict} · <b>${escapeHtml(toolName)}</b>`,
      format: 'tgHtml',
    });

    if (decision === 'deny') {
      return { behavior: 'deny', message: `User denied ${toolName} via Telegram.` };
    }
    return { behavior: 'allow' };
  };
}
