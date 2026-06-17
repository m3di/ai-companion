import 'dotenv/config';
import { dirname, resolve } from 'node:path';

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
  // Root holding the user's cloned repos (siblings of this repo by default). A
  // workspace scan registers them so agents know what exists and where.
  workspaceDir: resolve(
    process.env.WORKSPACE_DIR || dirname(resolve(process.env.CLAUDE_WORKING_DIR || process.cwd())),
  ),
  permissionMode: (process.env.PERMISSION_MODE || 'default') as PermissionMode,
  model: process.env.CLAUDE_MODEL || undefined,
  systemPromptPath: resolve(process.env.SYSTEM_PROMPT_PATH || 'prompts/system.md'),
  dbPath: resolve(process.env.DB_PATH || 'data/companion.db'),
  // The git-tracked knowledge base (curated note-units + index.md). Its own git
  // repo, so a future "grow" pass can diff/commit it without touching app code.
  // Under data/ → gitignored from this repo, persisted on the PVC in prod.
  knowledgeDir: resolve(process.env.KNOWLEDGE_DIR || 'data/knowledge'),
} as const;
