/**
 * Tool set for the `dev` live agent — reads the codebase and, for the one
 * write tool, hands a proposed patch off to lib/agents/orchestrator.ts
 * instead of ever touching disk itself. See lib/agents/tools/types.ts for
 * the sideEffect contract every tool here follows.
 */
import { z } from 'zod';
import * as sandbox from '@/lib/agents/sandbox';
import { proposePatchFromDiff } from '@/lib/agents/orchestrator';
import { approvalRequired, fail, ok, type AgentTool } from '@/lib/agents/tools/types';

const readFileTool: AgentTool = {
  name: 'read_file',
  description: 'Read the full text content of one file in the FounderOS repo, given its repo-relative path. Read-only.',
  parameters: z.object({ path: z.string().describe('repo-relative file path, e.g. "lib/db.ts"') }),
  sideEffect: 'read',
  async execute(args) {
    const relPath = typeof args.path === 'string' ? args.path : '';
    if (!relPath) return fail('path is required');
    const result = await sandbox.readFile(relPath);
    return result.ok ? ok({ path: relPath, content: result.data }) : fail(result.error, true);
  },
};

const listFilesTool: AgentTool = {
  name: 'list_files',
  description:
    'List repo files matching a glob pattern (e.g. "lib/agents/*.ts") relative to the repo root. Read-only.',
  parameters: z.object({ glob: z.string().describe('a glob pattern, repo-relative') }),
  sideEffect: 'read',
  async execute(args) {
    const glob = typeof args.glob === 'string' ? args.glob : '';
    if (!glob) return fail('glob is required');
    try {
      // No new dependency for a full glob engine — shell out to git's own
      // pathspec matching, which already understands globs and, being git,
      // never walks outside the repo or into node_modules/.git.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('git', ['ls-files', '--', glob], {
        cwd: process.cwd(),
        maxBuffer: 5 * 1024 * 1024,
      });
      const files = stdout.split('\n').filter(Boolean).slice(0, 200);
      return ok({ glob, count: files.length, files });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), true);
    }
  },
};

const searchCodeTool: AgentTool = {
  name: 'search_code',
  description: 'Search the FounderOS repo for a literal string or regular expression and return matching lines with file:line. Read-only.',
  parameters: z.object({ query: z.string().describe('text or regex to search for') }),
  sideEffect: 'read',
  async execute(args) {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query) return fail('query is required');
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(
        'git',
        ['grep', '-n', '-I', '--extended-regexp', '-e', query, '--', ':!node_modules', ':!.next'],
        { cwd: process.cwd(), maxBuffer: 5 * 1024 * 1024 },
      );
      const matches = stdout.split('\n').filter(Boolean).slice(0, 100);
      return ok({ query, count: matches.length, matches });
    } catch (err) {
      // git grep exits 1 (not an error) when nothing matched.
      const e = err as { code?: number };
      if (e.code === 1) return ok({ query, count: 0, matches: [] });
      return fail(err instanceof Error ? err.message : String(err), true);
    }
  },
};

const proposePatchTool: AgentTool = {
  name: 'propose_patch',
  description:
    'Propose a code change as a unified diff against one file. Does NOT write to disk — hands the proposal to the ' +
    'Dev Team Agent approval flow and returns approval_required. Read the target file with read_file first so the ' +
    'diff applies cleanly.',
  parameters: z.object({
    path: z.string().describe('repo-relative path of the file to patch'),
    diff: z.string().describe('a unified diff (git-style, --- / +++ / @@ hunks) against the file\'s current content'),
  }),
  sideEffect: 'write',
  async execute(args) {
    const relPath = typeof args.path === 'string' ? args.path : '';
    const diff = typeof args.diff === 'string' ? args.diff : '';
    if (!relPath || !diff) return fail('path and diff are required');
    // Safe to actually run: proposePatchFromDiff only computes what the file
    // WOULD look like (via sandbox.applyUnifiedDiff, which never touches the
    // real working tree) and stores a `validating` Task — see its docstring
    // in orchestrator.ts. Nothing here calls sandbox.writeFile.
    const result = await proposePatchFromDiff(relPath, diff);
    if (!result.ok) return fail(result.error, true);
    // The executor's write gate (lib/agents/executor.ts) enforces this outer
    // shape regardless, but returning it directly here keeps this tool
    // correct even if called outside that gate (e.g. a future direct test).
    return approvalRequired(result.taskId, { targetFile: relPath, diffPreview: result.diffPreview });
  },
};

export const devTools: AgentTool[] = [readFileTool, listFilesTool, searchCodeTool, proposePatchTool];
