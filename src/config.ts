import 'dotenv/config';
import { resolve } from 'node:path';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseChatIds(raw: string | undefined): Set<number> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
}

export const config = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  allowedChatIds: parseChatIds(process.env.ALLOWED_CHAT_IDS),
  workingDir: resolve(process.env.CLAUDE_WORKING_DIR || process.cwd()),
  permissionMode: (process.env.PERMISSION_MODE || 'default') as PermissionMode,
  model: process.env.CLAUDE_MODEL || undefined,
  // Fast, cheap model for the message router (Phase 1). Haiku by default.
  routerModel: process.env.ROUTER_MODEL || 'claude-haiku-4-5-20251001',
  // Routing strategy. 'address' = pure reply-routing (reply→its session, plain→
  // concierge) — deterministic, no classifier. 'classifier' = the legacy Haiku
  // router, kept as a fallback we can flip back to via ROUTING=classifier.
  routing: (process.env.ROUTING || 'address') as 'address' | 'classifier',
  systemPromptPath: resolve(process.env.SYSTEM_PROMPT_PATH || 'prompts/system.md'),
  dbPath: resolve(process.env.DB_PATH || 'data/companion.db'),
} as const;
