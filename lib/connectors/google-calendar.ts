/**
 * Google Calendar REST connector for the `ops` agent (lib/agents/tools/ops.ts).
 * Read-only: listing events is the only real API call. `create_event` is a
 * write-sideEffect tool that only ever builds a proposal (see
 * lib/agents/executor.ts's write gate) — it never reaches this file.
 */
import { getGoogleAccessToken, resolveGoogleOAuthConfig } from '@/lib/connectors/google-oauth';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
};

export type CalendarResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function calendarList(
  range: { timeMin: string; timeMax: string },
  env: Record<string, string | undefined> = process.env,
): Promise<CalendarResult<CalendarEvent[]>> {
  const config = resolveGoogleOAuthConfig(env);
  if (!config) return { ok: false, error: 'not_configured' };
  try {
    const token = await getGoogleAccessToken(config);
    const params = new URLSearchParams({
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '25',
    });
    const res = await fetch(`${CALENDAR_API}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Calendar API HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      items?: {
        id: string;
        summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        attendees?: { email?: string }[];
      }[];
    };
    const events = (json.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary ?? '(no title)',
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      attendees: (e.attendees ?? []).map((a) => a.email).filter((a): a is string => Boolean(a)),
    }));
    return { ok: true, data: events };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
