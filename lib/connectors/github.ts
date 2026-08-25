/**
 * GitHub connector — read/write for the Dev Team Agent's "memory" files
 * (user.md, identity.md, memory.md, soul.md) via the GitHub Contents API.
 *
 * IMPORTANT, checked live before writing this: this repo's own `origin`
 * remote is `Bennettxai/FounderOS-DEMO`, and the configured GITHUB_TOKEN
 * (wuwonderland's) has PULL-only access to it — no push. So GITHUB_REPO is
 * never derived from `git remote`; it must be set explicitly to a repo the
 * token can actually write to. Left unset (or pointed at a repo without
 * push access), every write here fails honestly — same "never fake
 * success" convention as every other connector in this repo — rather than
 * silently landing nowhere or erroring confusingly against the wrong repo.
 */
import type { ConnectorStatus } from '@/lib/connectors/types';

export type MemoryFileName = 'user' | 'identity' | 'memory' | 'soul';

const DEFAULT_MEMORY_DIR = '.github/agent';
const FILE_NAMES: Record<MemoryFileName, string> = {
  user: 'user.md',
  identity: 'identity.md',
  memory: 'memory.md',
  soul: 'soul.md',
};
const API_BASE = 'https://api.github.com';

type GithubConfig = { token: string; owner: string; repo: string; dir: string; branch?: string };

function resolveConfig(env: Record<string, string | undefined>): GithubConfig | null {
  const token = env.GITHUB_TOKEN;
  const repoSlug = env.GITHUB_REPO; // "owner/repo"
  if (!token || !repoSlug) return null;
  const [owner, repo] = repoSlug.split('/');
  if (!owner || !repo) return null;
  return { token, owner, repo, dir: env.GITHUB_MEMORY_PATH || DEFAULT_MEMORY_DIR, branch: env.GITHUB_MEMORY_BRANCH };
}

function pathFor(dir: string, name: MemoryFileName): string {
  return `${dir.replace(/\/+$/, '')}/${FILE_NAMES[name]}`;
}

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

export async function githubStatus(env: Record<string, string | undefined> = process.env): Promise<ConnectorStatus> {
  const base = { id: 'github', name: 'GitHub (Memory)', kind: 'knowledge' } as const;
  const config = resolveConfig(env);
  if (!config) {
    return {
      ...base,
      state: 'not_configured',
      detail: 'Set GITHUB_TOKEN and GITHUB_REPO ("owner/repo" — must be a repo the token can PUSH to, not just read) in .env.local.',
    };
  }
  try {
    const res = await fetch(`${API_BASE}/repos/${config.owner}/${config.repo}`, {
      headers: headers(config.token),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const repoInfo = (await res.json()) as { permissions?: { push?: boolean }; full_name?: string };
    if (!repoInfo.permissions?.push) {
      return { ...base, state: 'error', detail: `Token can read ${repoInfo.full_name ?? config.repo} but not push — memory writes will fail.` };
    }
    return { ...base, state: 'connected', detail: `Connected to ${repoInfo.full_name} (${config.dir})` };
  } catch (err) {
    return { ...base, state: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

export type GithubFileResult = { ok: true; content: string; sha: string } | { ok: false; error: string; notFound?: boolean };

/** Reads one of the four memory files. `notFound: true` distinguishes "the
    file doesn't exist yet" (fine — writeMemoryFile creates it) from a real
    failure (bad token, no access, network). */
export async function readMemoryFile(
  name: MemoryFileName,
  env: Record<string, string | undefined> = process.env,
): Promise<GithubFileResult> {
  const config = resolveConfig(env);
  if (!config) return { ok: false, error: 'GitHub is not configured (GITHUB_TOKEN / GITHUB_REPO)' };
  const path = pathFor(config.dir, name);
  try {
    const url = new URL(`${API_BASE}/repos/${config.owner}/${config.repo}/contents/${path}`);
    if (config.branch) url.searchParams.set('ref', config.branch);
    const res = await fetch(url, { headers: headers(config.token), signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return { ok: false, error: `${path} does not exist yet`, notFound: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { content: string; sha: string };
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { ok: true, content, sha: data.sha };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type GithubWriteResult = { ok: true; commitUrl: string | null } | { ok: false; error: string };

/** Writes one of the four memory files, creating it if it doesn't exist yet.
    Always reads the current SHA first — required by the Contents API to
    update an existing file, and it avoids clobbering a concurrent edit with
    a stale write. */
export async function writeMemoryFile(
  name: MemoryFileName,
  content: string,
  message: string,
  env: Record<string, string | undefined> = process.env,
): Promise<GithubWriteResult> {
  const config = resolveConfig(env);
  if (!config) return { ok: false, error: 'GitHub is not configured (GITHUB_TOKEN / GITHUB_REPO)' };
  const path = pathFor(config.dir, name);
  const existing = await readMemoryFile(name, env);
  const sha = existing.ok ? existing.sha : undefined;
  if (!existing.ok && !existing.notFound) return { ok: false, error: existing.error }; // real failure, not "doesn't exist yet"

  try {
    const res = await fetch(`${API_BASE}/repos/${config.owner}/${config.repo}/contents/${path}`, {
      method: 'PUT',
      headers: { ...headers(config.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha,
        branch: config.branch,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    }
    const data = (await res.json()) as { commit?: { html_url?: string } };
    return { ok: true, commitUrl: data.commit?.html_url ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Appends a new, timestamped entry to memory.md — the automated "learned
    this while working" log (called from lib/agents/orchestrator.ts on task
    completion). Best-effort by design: a memory-write failure must never
    fail the actual task that triggered it — callers should log the
    returned error, never throw it. */
export async function updateMemory(
  newContext: string,
  env: Record<string, string | undefined> = process.env,
): Promise<GithubWriteResult> {
  const existing = await readMemoryFile('memory', env);
  const priorContent = existing.ok ? existing.content : existing.notFound ? '# Memory\n' : null;
  if (priorContent === null) return { ok: false, error: (existing as { error: string }).error };
  const entry = `\n## ${new Date().toISOString()}\n${newContext.trim()}\n`;
  return writeMemoryFile('memory', `${priorContent.trimEnd()}\n${entry}`, `memory: ${newContext.slice(0, 72)}`, env);
}

/** Best-effort read of all four memory files for prompt injection (see
    lib/agents/orchestrator.ts) — files that don't exist or fail to read
    are simply omitted, never block the caller. */
export async function readAllMemoryFiles(
  env: Record<string, string | undefined> = process.env,
): Promise<Partial<Record<MemoryFileName, string>>> {
  const names: MemoryFileName[] = ['user', 'identity', 'memory', 'soul'];
  const out: Partial<Record<MemoryFileName, string>> = {};
  await Promise.all(
    names.map(async (name) => {
      const result = await readMemoryFile(name, env);
      if (result.ok) out[name] = result.content;
    }),
  );
  return out;
}
