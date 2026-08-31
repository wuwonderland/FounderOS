/**
 * Gmail REST connector for the `ops` agent (lib/agents/tools/ops.ts).
 * Read-only on purpose — searching and reading messages are the only calls
 * this file makes. Composing/sending is deliberately NOT implemented here:
 * ops.ts's `draft_reply` tool is a write-sideEffect tool that only ever
 * builds a proposal for human review (see lib/agents/executor.ts's write
 * gate); it never reaches an API call, so there is nothing here for it to
 * call in the first place.
 */
import { getGoogleAccessToken, resolveGoogleOAuthConfig, type GoogleOAuthConfig } from '@/lib/connectors/google-oauth';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type GmailMessageSummary = { id: string; threadId: string; snippet: string };
export type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  bodyText: string;
};

export type GmailResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function callGmail(config: GoogleOAuthConfig, path: string): Promise<unknown> {
  const token = await getGoogleAccessToken(config);
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gmail API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function headerValue(headers: { name?: string; value?: string }[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** Decodes Gmail's URL-safe-base64 body parts and flattens a message's first
    text/plain part (or falls back to the snippet) — good enough for an agent
    to reason over without a full MIME tree walk. */
function extractBodyText(payload: unknown): string {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined;
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body?.data) {
    try {
      return Buffer.from(p.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  for (const part of p.parts ?? []) {
    const text = extractBodyText(part);
    if (text) return text;
  }
  return '';
}

export async function gmailSearch(query: string, maxResults = 10, env: Record<string, string | undefined> = process.env): Promise<GmailResult<GmailMessageSummary[]>> {
  const config = resolveGoogleOAuthConfig(env);
  if (!config) return { ok: false, error: 'not_configured' };
  try {
    const listed = (await callGmail(
      config,
      `/messages?q=${encodeURIComponent(query)}&maxResults=${Math.max(1, Math.min(maxResults, 25))}`,
    )) as { messages?: { id: string; threadId: string }[] };
    const messages = listed.messages ?? [];
    // Gmail's list endpoint returns bare ids — one metadata fetch each to get
    // a useful snippet, capped at 10 to keep this a fast tool call.
    const detailed = await Promise.all(
      messages.slice(0, 10).map(async (m) => {
        try {
          const full = (await callGmail(config, `/messages/${m.id}?format=metadata`)) as { snippet?: string };
          return { id: m.id, threadId: m.threadId, snippet: full.snippet ?? '' };
        } catch {
          return { id: m.id, threadId: m.threadId, snippet: '' };
        }
      }),
    );
    return { ok: true, data: detailed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function gmailRead(id: string, env: Record<string, string | undefined> = process.env): Promise<GmailResult<GmailMessage>> {
  const config = resolveGoogleOAuthConfig(env);
  if (!config) return { ok: false, error: 'not_configured' };
  try {
    const msg = (await callGmail(config, `/messages/${id}?format=full`)) as {
      id: string;
      threadId: string;
      snippet?: string;
      payload?: { headers?: { name?: string; value?: string }[] };
    };
    const headers = msg.payload?.headers;
    return {
      ok: true,
      data: {
        id: msg.id,
        threadId: msg.threadId,
        from: headerValue(headers, 'From'),
        subject: headerValue(headers, 'Subject'),
        date: headerValue(headers, 'Date'),
        snippet: msg.snippet ?? '',
        bodyText: extractBodyText(msg.payload).slice(0, 8000),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
