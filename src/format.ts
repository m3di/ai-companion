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
]);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    default: {
      const detail = JSON.stringify(input);
      return { summary: name, detail: detail.length > 300 ? detail.slice(0, 300) + '…' : detail };
    }
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
