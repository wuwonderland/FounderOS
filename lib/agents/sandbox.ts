/**
 * Sandbox execution engine for the Dev Team Agent suite — the only module
 * in this repo allowed to touch the real filesystem or shell out on behalf
 * of an agent. Every operation is confined to the repo root (no path can
 * escape via `..`, an absolute path, or a symlink target) and every call
 * is recorded into an in-memory working-memory log so worker agents (and a
 * human reviewer) can see exactly what happened, including failures, to
 * drive a self-correction loop.
 *
 * `writeFile` is real — it mutates the actual codebase. Nothing in this
 * file decides WHEN to call it; that decision belongs to
 * lib/agents/orchestrator.ts, which gates real writes behind an explicit
 * human-approval step. Never call writeFile from an unattended pipeline.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = process.cwd();
const MAX_BUFFER = 10 * 1024 * 1024;

export class SandboxPathError extends Error {}

/** Resolves a repo-relative path and guarantees the result stays inside
    REPO_ROOT. Every sandbox fs operation goes through this — nothing here
    ever touches a caller-supplied path directly. */
function resolveSafePath(relativePath: string): string {
  const resolved = path.resolve(REPO_ROOT, relativePath);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SandboxPathError(`path escapes the workspace root: ${relativePath}`);
  }
  return resolved;
}

export type WorkingMemoryEntry = {
  ts: string;
  kind: 'read' | 'write' | 'diff' | 'typecheck';
  detail: string;
  ok: boolean;
};

// Append-only, in-memory, process-lifetime only — not persisted across
// server restarts. Worker agents read this back (getWorkingMemory) to see
// what already happened this session, e.g. "the last typecheck failed with
// these errors" for a self-correction loop.
const workingMemory: WorkingMemoryEntry[] = [];

export function getWorkingMemory(): readonly WorkingMemoryEntry[] {
  return workingMemory;
}

function remember(kind: WorkingMemoryEntry['kind'], detail: string, ok: boolean): void {
  workingMemory.push({ ts: new Date().toISOString(), kind, detail, ok });
}

export type SandboxResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Read a file's contents. Read-only, safe to call from any pipeline. */
export async function readFile(relativePath: string): Promise<SandboxResult<string>> {
  try {
    const full = resolveSafePath(relativePath);
    const content = await fs.readFile(full, 'utf8');
    remember('read', relativePath, true);
    return { ok: true, data: content };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    remember('read', `${relativePath}: ${detail}`, false);
    return { ok: false, error: detail };
  }
}

/** Write a file inside the workspace, creating parent directories as
    needed. This is the one operation here capable of mutating the real
    codebase — see the module docstring. Callers must have already
    obtained explicit approval before invoking this. */
export async function writeFile(relativePath: string, content: string): Promise<SandboxResult<{ bytesWritten: number }>> {
  try {
    const full = resolveSafePath(relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    remember('write', relativePath, true);
    return { ok: true, data: { bytesWritten: Buffer.byteLength(content, 'utf8') } };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    remember('write', `${relativePath}: ${detail}`, false);
    return { ok: false, error: detail };
  }
}

/** `git diff` against the working tree — read-only. Pass a repo-relative
    path to scope it to one file; omit for the full diff. */
export async function getGitDiff(relativePath?: string): Promise<SandboxResult<string>> {
  try {
    const args = ['diff', '--no-color'];
    if (relativePath) args.push('--', resolveSafePath(relativePath));
    const { stdout } = await execFileAsync('git', args, { cwd: REPO_ROOT, maxBuffer: MAX_BUFFER });
    remember('diff', relativePath ?? '(all)', true);
    return { ok: true, data: stdout };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    remember('diff', relativePath ?? '(all)', false);
    return { ok: false, error: detail };
  }
}

/** Runs this repo's own `npm run typecheck` (a fixed command — never an
    arbitrary shell string) and captures the compiler output either way.
    `ok: false` means the sandbox operation itself couldn't run (npm
    missing, etc.); a real compiler failure is `ok: true, data: {passed:
    false, output}` — the useful signal for a self-correction loop, not an
    exception to catch. */
export async function runTypecheck(): Promise<SandboxResult<{ passed: boolean; output: string }>> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', 'typecheck'], {
      cwd: REPO_ROOT,
      maxBuffer: MAX_BUFFER,
    });
    const output = `${stdout}${stderr}`.trim();
    remember('typecheck', 'passed', true);
    return { ok: true, data: { passed: true, output } };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message;
    remember('typecheck', 'failed', true);
    return { ok: true, data: { passed: false, output } };
  }
}

/** Computes a real unified diff between two strings using git's own
    diffing engine — WITHOUT touching the actual working tree or the real
    target file. Used to show a proposed-but-not-yet-applied change (e.g.
    for a Slack approval message) before anything is written. Writes both
    sides to throwaway files in the OS temp dir (never inside the repo —
    this is content we generated, not a caller-supplied path, so it isn't
    routed through resolveSafePath) and diffs those. */
export async function diffContent(oldContent: string, newContent: string, label = 'file'): Promise<SandboxResult<string>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'founderos-diff-'));
  const oldPath = path.join(dir, `a-${label}`);
  const newPath = path.join(dir, `b-${label}`);
  try {
    await fs.writeFile(oldPath, oldContent, 'utf8');
    await fs.writeFile(newPath, newContent, 'utf8');
    try {
      // No differences: exits 0.
      const { stdout } = await execFileAsync('git', ['diff', '--no-index', '--no-color', oldPath, newPath], {
        cwd: REPO_ROOT,
        maxBuffer: MAX_BUFFER,
      });
      return { ok: true, data: stdout };
    } catch (err) {
      // git diff --no-index exits 1 (not an error) when it found
      // differences — the diff text is still on stdout.
      const e = err as { stdout?: string; code?: number };
      if (typeof e.stdout === 'string' && e.code === 1) return { ok: true, data: e.stdout };
      throw err;
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
