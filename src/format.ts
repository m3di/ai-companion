import telegramifyMarkdown from 'telegramify-markdown';

/** Tools that never mutate state — auto-approved without a permission prompt. */
export const SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoWrite',
  'Task',
  'WebFetch',
  'WebSearch',
  'BashOutput',
  'ListMcpResources',
  'ReadMcpResource',
  // Our own in-process Telegram UI tools — always safe.
  'mcp__telegram__send',
  'mcp__telegram__ask',
  'mcp__telegram__askUserQuestion',
  'mcp__telegram__setMemo',
]);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Drop unpaired UTF-16 surrogates. Slicing message content at a fixed length
 * (e.g. `.slice(0, 260)`) can cut an emoji's surrogate pair in half, leaving a
 * lone surrogate; that can't be encoded as valid JSON, so the API rejects the
 * whole request ("no low surrogate in string"). Strip any high surrogate not
 * followed by a low one, and any low surrogate not preceded by a high one. Apply
 * to any prompt assembled from stored/sliced content before sending it.
 */
export function stripLoneSurrogates(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

function firstLine(s: unknown, max = 64): string {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function basename(p: unknown): string {
  const s = String(p ?? '');
  const parts = s.split('/');
  return parts[parts.length - 1] || s;
}

export interface ToolView {
  /** One-line summary for the activity log. */
  summary: string;
  /** Full detail for the expandable permission prompt (e.g. the command). */
  detail: string;
  /** A subagent spawn — shown distinctly, internals not surfaced. */
  subagent?: boolean;
  /** Skip adding to the activity log (too noisy to be useful). */
  mute?: boolean;
}

/** Maps a raw tool call to a human summary + detail for display. */
export function describeTool(name: string, input: Record<string, unknown>): ToolView {
  switch (name) {
    case 'Bash':
      return { summary: `Bash · ${firstLine(input.command)}`, detail: String(input.command ?? '') };
    case 'Read':
      return { summary: `Read · ${basename(input.file_path)}`, detail: String(input.file_path ?? '') };
    case 'Write':
      return { summary: `Write · ${basename(input.file_path)}`, detail: String(input.file_path ?? '') };
    case 'Edit':
    case 'MultiEdit':
      return { summary: `Edit · ${basename(input.file_path)}`, detail: String(input.file_path ?? '') };
    case 'NotebookEdit':
      return { summary: `Notebook · ${basename(input.notebook_path)}`, detail: String(input.notebook_path ?? '') };
    case 'Glob':
      return { summary: `Glob · ${firstLine(input.pattern)}`, detail: String(input.pattern ?? '') };
    case 'Grep':
      return { summary: `Grep · ${firstLine(input.pattern)}`, detail: String(input.pattern ?? '') };
    case 'Task':
      return {
        summary: `Subagent · ${input.subagent_type ?? 'agent'}: ${firstLine(input.description, 48)}`,
        detail: String(input.prompt ?? input.description ?? ''),
        subagent: true,
      };
    case 'WebFetch':
      return { summary: `Fetch · ${firstLine(input.url, 48)}`, detail: String(input.url ?? '') };
    case 'WebSearch':
      return { summary: `Search · ${firstLine(input.query)}`, detail: String(input.query ?? '') };
    case 'TodoWrite':
      return { summary: 'Plan updated', detail: '', mute: true };
    case 'mcp__telegram__send':
    case 'mcp__telegram__ask':
      // These already produce a visible Telegram message; don't log them too.
      return { summary: name, detail: '', mute: true };
    default: {
      const detail = JSON.stringify(input);
      return { summary: name, detail: detail.length > 300 ? detail.slice(0, 300) + '…' : detail };
    }
  }
}

function capLines(s: string, maxLines = 40, maxChars = 1500): string {
  let lines = s.split('\n');
  let truncated = lines.length > maxLines;
  if (truncated) lines = lines.slice(0, maxLines);
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return truncated ? `${out}\n… (truncated)` : out;
}

function diffBlock(oldStr: string, newStr: string): string {
  const minus = oldStr ? oldStr.split('\n').map((l) => `- ${l}`) : [];
  const plus = newStr ? newStr.split('\n').map((l) => `+ ${l}`) : [];
  return [...minus, ...plus].join('\n');
}

function expandable(diff: string): string {
  return `<blockquote expandable>${escapeHtml(capLines(diff))}</blockquote>`;
}

/**
 * For file-operation tools, build a standalone Telegram-HTML message shown
 * live as the op happens — with an expandable diff for edits/writes. Returns
 * null for non-file tools (those only appear in the status log).
 */
export function fileOpMessage(name: string, input: Record<string, unknown>): string | null {
  const path = (k: string) => `<code>${escapeHtml(String(input[k] ?? ''))}</code>`;
  switch (name) {
    case 'Read': {
      const where = input.offset ? ` <i>(from line ${input.offset})</i>` : '';
      return `📖 <b>Read</b> ${path('file_path')}${where}`;
    }
    case 'Edit':
      return (
        `✏️ <b>Updated</b> ${path('file_path')}\n` +
        expandable(diffBlock(String(input.old_string ?? ''), String(input.new_string ?? '')))
      );
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      const diff = edits
        .map((e) => diffBlock(String(e.old_string ?? ''), String(e.new_string ?? '')))
        .join('\n\n');
      return `✏️ <b>Updated</b> ${path('file_path')} <i>(${edits.length} edits)</i>\n${expandable(diff)}`;
    }
    case 'Write': {
      const added = String(input.content ?? '')
        .split('\n')
        .map((l) => `+ ${l}`)
        .join('\n');
      return `🆕 <b>Created</b> ${path('file_path')}\n${expandable(added)}`;
    }
    case 'NotebookEdit':
      return `✏️ <b>Updated</b> ${path('notebook_path')}`;
    default:
      return null;
  }
}

/** Convert Claude's Markdown answer to a Telegram-safe MarkdownV2 string. */
export function toTelegramMarkdown(text: string): string {
  return telegramifyMarkdown(text, 'escape');
}

/** Split raw text on paragraph/line boundaries into Telegram-sized pieces. */
export function chunkRaw(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}
