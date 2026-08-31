/**
 * Tool set for the `ops` live agent — inbox and calendar triage. Gmail/
 * Calendar read tools call FounderOS's own Google OAuth credentials (see
 * lib/connectors/google-oauth.ts) and return `not_configured` honestly if
 * those aren't set — never crash, never fake data. The two write tools
 * (`draft_reply`, `create_event`) never call the Gmail/Calendar APIs at
 * all: they only validate their arguments and hand back a proposal, so
 * there's nothing here for the write gate to have to stop.
 */
import { z } from 'zod';
import { gmailRead, gmailSearch } from '@/lib/connectors/gmail';
import { calendarList } from '@/lib/connectors/google-calendar';
import { approvalRequired, fail, ok, type AgentTool } from '@/lib/agents/tools/types';
import { randomUUID } from 'node:crypto';

const gmailSearchTool: AgentTool = {
  name: 'gmail_search',
  description: 'Search Gmail with a query (Gmail search syntax, e.g. "is:unread from:someone@x.com") and return matching message ids and snippets. Read-only.',
  parameters: z.object({ query: z.string().describe('Gmail search query') }),
  sideEffect: 'read',
  async execute(args) {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query) return fail('query is required');
    const result = await gmailSearch(query);
    return result.ok ? ok(result.data) : fail(result.error, result.error !== 'not_configured');
  },
};

const gmailReadTool: AgentTool = {
  name: 'gmail_read',
  description: 'Read one Gmail message in full by its message id (from gmail_search results). Read-only.',
  parameters: z.object({ id: z.string().describe('Gmail message id') }),
  sideEffect: 'read',
  async execute(args) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) return fail('id is required');
    const result = await gmailRead(id);
    return result.ok ? ok(result.data) : fail(result.error, result.error !== 'not_configured');
  },
};

const calendarListTool: AgentTool = {
  name: 'calendar_list',
  description: 'List calendar events in a date range (ISO 8601 timestamps). Read-only.',
  parameters: z.object({
    timeMin: z.string().describe('range start, ISO 8601'),
    timeMax: z.string().describe('range end, ISO 8601'),
  }),
  sideEffect: 'read',
  async execute(args) {
    const timeMin = typeof args.timeMin === 'string' ? args.timeMin : '';
    const timeMax = typeof args.timeMax === 'string' ? args.timeMax : '';
    if (!timeMin || !timeMax) return fail('timeMin and timeMax are required');
    const result = await calendarList({ timeMin, timeMax });
    return result.ok ? ok(result.data) : fail(result.error, result.error !== 'not_configured');
  },
};

const draftReplyTool: AgentTool = {
  name: 'draft_reply',
  description:
    'Propose a reply to a Gmail message by id. Does NOT send or create anything in Gmail — returns approval_required ' +
    'with the proposed reply body for a human to review.',
  parameters: z.object({
    id: z.string().describe('Gmail message id being replied to'),
    body: z.string().describe('proposed reply text'),
  }),
  sideEffect: 'write',
  async execute(args) {
    const id = typeof args.id === 'string' ? args.id : '';
    const body = typeof args.body === 'string' ? args.body : '';
    if (!id || !body) return fail('id and body are required');
    // Deliberately no Gmail API call here — see the module docstring.
    return approvalRequired(randomUUID(), { kind: 'gmail_draft_reply', messageId: id, body });
  },
};

const createEventTool: AgentTool = {
  name: 'create_event',
  description:
    'Propose a new calendar event (summary, start, end, ISO 8601 timestamps, optional attendee emails). Does NOT ' +
    'create anything on the calendar — returns approval_required with the proposed event for a human to review.',
  parameters: z.object({
    summary: z.string().describe('event title'),
    start: z.string().describe('start time, ISO 8601'),
    end: z.string().describe('end time, ISO 8601'),
    attendees: z.array(z.string()).default([]).describe('attendee email addresses'),
  }),
  sideEffect: 'write',
  async execute(args) {
    const summary = typeof args.summary === 'string' ? args.summary : '';
    const start = typeof args.start === 'string' ? args.start : '';
    const end = typeof args.end === 'string' ? args.end : '';
    const attendees = Array.isArray(args.attendees) ? args.attendees.filter((a): a is string => typeof a === 'string') : [];
    if (!summary || !start || !end) return fail('summary, start, and end are required');
    // Deliberately no Calendar API call here — see the module docstring.
    return approvalRequired(randomUUID(), { kind: 'calendar_create_event', summary, start, end, attendees });
  },
};

export const opsTools: AgentTool[] = [gmailSearchTool, gmailReadTool, calendarListTool, draftReplyTool, createEventTool];
