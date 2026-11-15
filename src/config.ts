import 'dotenv/config';
import { dirname, resolve } from 'node:path';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';
/** Thinking effort a turn is asked for — the SDK's EffortLevel, narrowed to the three a dispatch chooses between. */
export type Effort = 'low' | 'medium' | 'high';

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
  // WHO RUNS ON WHAT (2026-08-27). One CLAUDE_MODEL ran everyone at default
  // effort and the week read ~$375: concierge $206 over 278 turns, workers
  // $129 over 96, the night $39 over 12. The concierge keeps CLAUDE_MODEL —
  // it is the judgment seat — but most of its turns are routing and relay,
  // so its default EFFORT is medium and the ledger judges. Workers get a
  // default the concierge may override per dispatch (dispatchTask's model /
  // effort, kept on the thread): sonnet at medium for the routine, opus/high
  // for design and root cause, haiku/low for the mechanical. The night is
  // untouched: $3 a turn for the smartest, most-access role is the right spend.
  conciergeEffort: (process.env.CONCIERGE_EFFORT || 'medium') as Effort,
  // The BUILT-IN tools the concierge may have (SDK `tools`; MCP tools are not
  // governed by it and always come from the servers). Every built-in schema
  // it does not need sits in the cache prefix — the 13,573 tokens the ledger
  // read on every turn were mostly this. The default is what the ledger says
  // it USES: over the seven days to 08-27 the concierge called Bash 60 times
  // (gh pr view, gh run view, the fibery script — its "ground before
  // asserting" habit, not bypasses) and WebFetch for links; it called Read 0
  // times. So Bash and WebFetch stay; Read/Grep/Glob/Edit/Write are off —
  // Read is the raw-file "bypass" path the friction ledger counts, closed here
  // by mechanism (I9). CONCIERGE_BUILTIN_TOOLS overrides the whole list.
  conciergeBuiltinTools: (process.env.CONCIERGE_BUILTIN_TOOLS ?? 'Bash,WebFetch')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  workerModel: process.env.WORKER_MODEL || 'sonnet',
  workerEffort: (process.env.WORKER_EFFORT || 'medium') as Effort,
  systemPromptPath: resolve(process.env.SYSTEM_PROMPT_PATH || 'prompts/system.md'),
  dbPath: resolve(process.env.DB_PATH || 'data/companion.db'),
  // The git-tracked knowledge base (curated note-units + index.md). Its own git
  // repo, so a future "grow" pass can diff/commit it without touching app code.
  // Under data/ → gitignored from this repo, persisted on the PVC in prod.
  knowledgeDir: resolve(process.env.KNOWLEDGE_DIR || 'data/knowledge'),
  /** VOICE IN (src/transcribe.ts): a local whisper.cpp binary and model. */
  whisperBin: process.env.WHISPER_BIN || 'whisper-cli',
  whisperModel: resolve((process.env.WHISPER_MODEL || `${process.env.HOME}/whisper-models/ggml-large-v3-turbo.bin`).replace(/^~/, process.env.HOME ?? '')),
  /** 'auto' lets a note switch between Persian and English mid-sentence. */
  whisperLanguage: process.env.WHISPER_LANGUAGE || 'auto',
  /** Where incoming audio is parked. Under data/, never in git. */
  voiceDir: resolve(process.env.VOICE_DIR || 'data/voice'),
  /** VOICE OUT (src/speak.ts): Piper in its own venv, and a folder of .onnx voices. */
  piperBin: process.env.PIPER_BIN || `${process.env.HOME}/piper/venv/bin/piper`,
  piperVoicesDir: process.env.PIPER_VOICES_DIR || `${process.env.HOME}/piper/voices`,
  // Model for the distillation pass. Defaults to whatever the rest of the bot
  // runs on — picking a cheaper tier is a cost decision that belongs to Mehdi,
  // not a silent default (set DISTILL_MODEL to override).
  distillModel: process.env.DISTILL_MODEL || process.env.CLAUDE_MODEL || '',
  // The reform writes a whole domain's knowledge in one shot against a strict
  // grammar — the one pass where a weaker model costs more in retries than it
  // saves, so it defaults to the main model rather than the distil one.
  reformModel: process.env.REFORM_MODEL || process.env.CLAUDE_MODEL || '',
  // Concierge session ROTATION (src/rotation.ts). The session is cleared when
  // its LIVE context has grown past `rotateAboveTokens` AND the human has been
  // quiet for `rotateIdleMin` minutes — or, whatever the human is doing, past
  // `rotateCeilingTokens`. A flat turn counter (30) fired on 2026-08-25 between
  // two messages a minute apart; these numbers replaced it.
  //   above 200k — the counter was a COST guard, and at ~200k a turn costs
  //     about $1 while rotating at idle costs nothing (the cache is cold after
  //     ~5 min anyway). Over the 7 days to 08-26 the concierge's per-call
  //     context ran p50 92k · p90 150k · p99 209k · max 237k, so this fires on
  //     the long tail, at the seam, and never on an ordinary day.
  //   ceiling 600k — 60% of the 1M window: forced, with a handoff, well before
  //     the SDK would compact on its own and lose the thread its own way.
  // Override per deployment, never per session.
  rotateAboveTokens: Number(process.env.ROTATE_ABOVE_TOKENS) || 200_000,
  rotateIdleMin: Number(process.env.ROTATE_IDLE_MIN) || 15,
  rotateCeilingTokens: Number(process.env.ROTATE_CEILING_TOKENS) || 600_000,
  // Projects not harvested AT ALL — no episode, no skeleton, no recap, nothing
  // parsed and nothing stored. Two by default (Mehdi, 2026-07-19):
  //   ai-companion  — time spent building this system is not work it should
  //                   remember as his; studying its own development is a
  //                   recursion with no upside.
  //   pandoc_resume — his personal life.
  //                   "they stay out of the bot." Note this is stronger than
  //                   not-distilled or not-folded: those still keep the
  //                   skeleton, which holds his own words verbatim.
  noHarvestProjects: new Set(
    (process.env.NO_HARVEST_PROJECTS ?? 'ai-companion,pandoc_resume')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  ),
  // Transcripts NOT harvested because a PROGRAM drove them, not Mehdi at a
  // terminal. Every transcript line names its `entrypoint`: `cli` and
  // `claude-desktop` are him typing; `sdk-ts`/`sdk-py`/`sdk-cli` are an app
  // calling the Agent SDK — the bot's own fleet, montaj's media pipeline,
  // storysim's simulator. Reading those back would let the system treat a
  // program's output as evidence of his work (the same reason bot sessions are
  // excluded by id). Glob-ish: a trailing `*` matches a prefix. Added
  // 2026-10-30 when storysim became the second SDK-driven project; a new one
  // needs no entry here unless it invents a new entrypoint name.
  noHarvestEntrypoints: (process.env.NO_HARVEST_ENTRYPOINTS ?? 'sdk-*')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean),
  // Projects harvested and summarised, but never folded into the knowledge
  // tree — recaps stay in /episodes, the nightly operator never sees them.
  // Empty by default; the boundary that matters is noHarvestProjects above.
  // Kept because the tree has NO per-note access control: any worker, on any
  // repo, can readNote any key, so "in the tree" means "readable by the whole
  // fleet" — a weaker place to draw a line than never harvesting at all.
  noFoldProjects: new Set(
    (process.env.NO_FOLD_PROJECTS ?? '')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  ),
  // Projects harvested but NEVER distilled: episodes stay searchable as traces,
  // and no agent summarises them into the tree. Empty by default —
  // pandoc_resume sat here until 2026-07-19, when Mehdi chose to let his
  // personal life into the memory rather than wall it off. Comma-separated
  // working-dir basenames; set NO_DISTILL_PROJECTS to restore a boundary.
  noDistillProjects: new Set(
    (process.env.NO_DISTILL_PROJECTS ?? '')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  ),
} as const;
