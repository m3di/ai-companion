import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from './config.js';
import { type RepoInfo, listRepos, upsertRepo } from './db.js';

/** Run a git command in a repo, returning trimmed stdout or undefined on error. */
function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Register one repo by absolute path (origin remote, branch, convention files). */
export function registerRepo(path: string): RepoInfo | undefined {
  if (!existsSync(join(path, '.git'))) return undefined;
  const name = basename(path);
  const remote = git(path, ['remote', 'get-url', 'origin']) ?? null;
  const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? null;
  const conventions =
    ['CLAUDE.md', 'AGENTS.md'].filter((f) => existsSync(join(path, f))).join(', ') || null;
  upsertRepo(name, path, remote ?? undefined, branch ?? undefined, conventions ?? undefined);
  return { name, path, remote, branch, conventions };
}

/** Register a curated set of repos by path (skips paths that aren't git repos). */
export function addRepos(paths: string[]): RepoInfo[] {
  return paths.map((p) => registerRepo(p)).filter((r): r is RepoInfo => r !== undefined);
}

/**
 * Walk the workspace root and register every git repo found — the broad,
 * fresh-machine discovery path. Returns them. Prefer addRepos for a curated set;
 * a full ~/Projects scan will also pull in unrelated personal repos.
 */
export function scanWorkspace(): RepoInfo[] {
  const root = config.workspaceDir;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: RepoInfo[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue;
    const path = join(root, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const r = registerRepo(path);
    if (r) found.push(r);
  }
  return found;
}

/** A compact name → path manifest (addresses only) for injecting into agents. */
export function workspaceManifest(): string {
  return listRepos()
    .map((r) => `- ${r.name} → ${r.path}${r.branch ? ` (${r.branch})` : ''}`)
    .join('\n');
}

/** The manifest wrapped with usage guidance, for a worker's always-on context. */
export function workspaceContext(): string {
  const manifest = workspaceManifest();
  if (!manifest) return '';
  return `Workspace repos (local clones on this machine — operate with local git per repo, follow each repo's CLAUDE.md/AGENTS.md, avoid worktrees unless strictly necessary, and prefer the gh API for read-only lookups):\n${manifest}`;
}
