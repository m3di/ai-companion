import { readFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';

export type ClaudeEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'result'; ok: boolean; error?: string };

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
 * edits take effect immediately.
 */
export async function* askClaude(opts: {
  prompt: string;
  resume?: string;
}): AsyncGenerator<ClaudeEvent> {
  const append = readSystemPrompt();

  const stream = query({
    prompt: opts.prompt,
    options: {
      resume: opts.resume,
      cwd: config.workingDir,
      permissionMode: config.permissionMode,
      ...(config.model ? { model: config.model } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
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
          yield { kind: 'tool', name: block.name };
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
