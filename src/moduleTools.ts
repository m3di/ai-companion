import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { recordFriction } from './db.js';
import { callModule, evalInModule, listModules, renderCatalog, renderResult } from './modules.js';
import { touchNudges } from './touch.js';

/**
 * The three tools that make knowledge callable (round 9 §3), shared by workers
 * and the concierge so both halves of the system see one API.
 *
 * `callModule` is the normal path. `evalInModule` is the escape hatch that keeps
 * the API from having to anticipate every question. `reportFriction` is the one
 * signal that cannot be instrumented — everything else in the ledger is recorded
 * by the runtime, without asking.
 */
/** A read that touched a node with an open question carries the question. */
function withNudges(text: string, sessionKey: string, refs: string[] | undefined): string {
  const lines = touchNudges(sessionKey, refs ?? []);
  return lines.length ? `${text}\n\n${lines.join('\n')}` : text;
}

export function buildModuleTools(
  sessionKey: string,
  /**
   * Whether this caller may write, asked FRESH at every call rather than
   * captured once when the tools were built. A turn can outlive the state it
   * started in — the operator sedates the bot mid-answer, or wakes it — and a
   * flag frozen at build time would let a turn write on a permission that
   * expired, or refuse one that has since been granted.
   */
  readOnly: () => boolean = () => false,
) {
  const catalog = tool(
    'listKnowledgeApi',
    'List the callable knowledge API: every module, its functions, their signatures and what each returns. Call this first if you are unsure what exists — it is signatures and docs only, so it is cheap.',
    {},
    async () => {
      const text = renderCatalog();
      return { content: [{ type: 'text' as const, text: text || 'No modules yet — the knowledge tree is still read through readNote/recallNotes.' }] };
    },
  );

  const call = tool(
    'callModule',
    'Call a function from the knowledge API (see listKnowledgeApi) and get its result as JSON. This is the fast, exact way to ask the system what it knows — prefer it over reading files under data/knowledge, which returns raw rows you then have to interpret.',
    {
      module: z.string().describe('Module name, e.g. "entities"'),
      fn: z.string().describe('Function name from the catalog, e.g. "openLoops"'),
      args: z.array(z.unknown()).optional().describe('Positional arguments, in the order the signature lists them'),
    },
    async ({ module, fn, args }) => {
      const r = await callModule(module, fn, (args ?? []) as unknown[], sessionKey, undefined, readOnly());
      return { content: [{ type: 'text' as const, text: withNudges(renderResult(r), sessionKey, r.refs) }], isError: !r.ok };
    },
  );

  const evaluate = tool(
    'evalInModule',
    'Run a one-line TypeScript/JavaScript EXPRESSION over a module\'s functions, with the module bound to `m` — e.g. `m.openLoops("core-api").filter(e => !e.actor).map(e => e.id)`. Use it to compose, filter, count or join results without needing a dedicated function for every question. Read-only; the expression may not write anything.',
    {
      module: z.string().describe('Module whose namespace is bound to `m`'),
      expression: z.string().describe('A single expression (it may await). Its value is returned as JSON.'),
    },
    async ({ module, expression }) => {
      const r = await evalInModule(module, expression, sessionKey, readOnly());
      return { content: [{ type: 'text' as const, text: withNudges(renderResult(r), sessionKey, r.refs) }], isError: !r.ok };
    },
  );

  const report = tool(
    'reportFriction',
    'Report that the system has NO REPRESENTATION for something you needed — not a missing function over data that exists, but a concept, entity or relationship the memory does not model at all. This is the only friction you have to report: everything else (a call that failed, returned nothing, was slow, or did not exist; a raw file you had to read) is already recorded automatically. Do not use it for a task-level problem — this is about the memory, not the work.',
    {
      missing: z.string().describe('What the system had no way to represent, in one self-contained line'),
      needed: z.string().describe('What you were trying to answer when you hit it'),
    },
    async ({ missing, needed }) => {
      recordFriction({
        kind: 'missing_concept',
        signature: missing.toLowerCase().replace(/\s+/g, ' ').slice(0, 120),
        detail: `${missing} — needed for: ${needed}`,
        sessionKey,
      });
      return { content: [{ type: 'text' as const, text: 'Recorded. The nightly code audit reads these; back to your task.' }] };
    },
  );

  return [catalog, call, evaluate, report];
}

/** Tool names, for the concierge's allowlist. */
export const MODULE_TOOL_NAMES = ['listKnowledgeApi', 'callModule', 'evalInModule', 'reportFriction'].map((n) => `mcp__bot__${n}`);

/**
 * The catalog block injected into an agent's context.
 *
 * Empty until a loadable module exists, deliberately: dead instructions about a
 * capability that is not there is exactly the kind of prompt text that decays
 * into noise and then into distrust of the rest of the prompt.
 */
export function catalogSection(): string {
  if (!listModules().some((m) => m.loadable)) return '';
  return (
    '## The knowledge API — CALL it, do not read it\n' +
    'These functions answer questions about what the system knows. They are exact, current, and cost a subprocess instead of a context window. ' +
    'Use callModule for one answer, evalInModule to compose several. Reading the raw files under data/knowledge still works and is not forbidden — but if you find yourself doing it, the API is missing something, and the system records that.\n' +
    renderCatalog()
  );
}
