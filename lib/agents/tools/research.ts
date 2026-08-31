/**
 * Tool set for the `research` live agent — web research plus note-saving.
 * `save_note` is a write tool: it never actually persists anything (there's
 * no notes store wired up yet), it only builds and returns a proposal — see
 * the module-level contract in lib/agents/tools/types.ts.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { webSearch } from '@/lib/connectors/web-search';
import { fetchUrlText } from '@/lib/connectors/web-fetch';
import { approvalRequired, fail, ok, type AgentTool } from '@/lib/agents/tools/types';

const webSearchTool: AgentTool = {
  name: 'web_search',
  description: 'Search the web for a query and return the top results (title, url, snippet). Read-only.',
  parameters: z.object({ query: z.string().describe('search query') }),
  sideEffect: 'read',
  async execute(args) {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query) return fail('query is required');
    const result = await webSearch(query);
    return result.ok ? ok(result.data) : fail(result.error, result.error !== 'not_configured');
  },
};

const webFetchTool: AgentTool = {
  name: 'web_fetch',
  description: 'Fetch a URL and return its page title and readable text content. Read-only.',
  parameters: z.object({ url: z.string().describe('a full http(s) URL') }),
  sideEffect: 'read',
  async execute(args) {
    const url = typeof args.url === 'string' ? args.url : '';
    if (!url) return fail('url is required');
    const result = await fetchUrlText(url);
    return result.ok ? ok(result.data) : fail(result.error, true);
  },
};

const saveNoteTool: AgentTool = {
  name: 'save_note',
  description:
    'Propose saving a research note (title + body) for later reference. Does NOT persist anything yet — returns ' +
    'approval_required with the proposed note for a human to review.',
  parameters: z.object({
    title: z.string().describe('note title'),
    body: z.string().describe('note body'),
  }),
  sideEffect: 'write',
  async execute(args) {
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    if (!title || !body) return fail('title and body are required');
    // No notes store wired up yet — see the module docstring. The proposal
    // itself is still real (persisted via the executor's tool_calls log),
    // just not applied anywhere.
    return approvalRequired(randomUUID(), { kind: 'research_note', title, body });
  },
};

export const researchTools: AgentTool[] = [webSearchTool, webFetchTool, saveNoteTool];
