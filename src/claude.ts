import { readFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config, type PermissionMode } from './config.js';
import { stripLoneSurrogates } from './format.js';

export type ClaudeEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown> }
  | { kind: 'result'; ok: boolean; error?: string };

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal },
) => Promise<
  { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string }
>;

function readSystemPrompt(): string {
  try {
    return readFileSync(config.systemPromptPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Runs one user turn against Claude Code and yields normalized events.
 * Pass `resume` (a session id) to continue an existing conversation; omit it
 * to start a fresh session. The system prompt file is read on every call so
 * edits take effect immediately. `canUseTool` gates tool execution.
 */
export async function* askClaude(opts: {
  prompt: string;
  resume?: string;
  canUseTool?: CanUseTool;
  permissionMode?: PermissionMode;
  mcpServers?: Record<string, unknown>;
  cwd?: string;
  abortController?: AbortController;
  // Extra context appended to the work-thread system prompt (shared memory).
  appendContext?: string;
  // Concierge mode: a custom string system prompt + a tool allowlist, replacing
  // the Claude Code preset so it runs lean and focused on bot management.
  concierge?: { systemPrompt: string; allowedTools: string[] };
}): AsyncGenerator<ClaudeEvent> {
  const append = stripLoneSurrogates(
    readSystemPrompt() +
      (opts.appendContext ? `\n\n## Shared memory (applies across all threads)\n${opts.appendContext}` : ''),
  );

  const stream = query({
    // Guard against a lone UTF-16 surrogate (e.g. from a sliced emoji in the
    // assembled context) making the request body invalid JSON.
    prompt: stripLoneSurrogates(opts.prompt),
    options: {
      resume: opts.resume,
      cwd: opts.cwd ?? config.workingDir,
      // The built-in AskUserQuestion needs an interactive frontend we don't
      // have here — it silently no-ops ("tool hiccup"). Remove it so the model
      // falls back to our telegram askUserQuestion tool, which renders buttons.
      disallowedTools: ['AskUserQuestion'],
      ...(opts.abortController ? { abortController: opts.abortController } : {}),
      permissionMode: opts.permissionMode ?? config.permissionMode,
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers as never } : {}),
      ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(opts.concierge
        ? { systemPrompt: opts.concierge.systemPrompt, allowedTools: opts.concierge.allowedTools, settingSources: [] }
        : { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append } }),
    },
  });

  // The SDK message shapes are a discriminated union; we narrow by `type` and
  // normalize into our own events, so we keep this loop loosely typed.
  for await (const msg of stream as AsyncIterable<any>) {
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      yield { kind: 'session', sessionId: msg.session_id };
    } else if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          yield { kind: 'text', text: block.text };
        } else if (block.type === 'tool_use') {
          yield { kind: 'tool', name: block.name, input: block.input ?? {} };
        }
      }
    } else if (msg.type === 'result') {
      yield {
        kind: 'result',
        ok: msg.subtype === 'success',
        error: msg.subtype === 'success' ? undefined : String(msg.subtype),
      };
      if (msg.session_id) yield { kind: 'session', sessionId: msg.session_id };
    }
  }
}
