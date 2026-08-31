/**
 * Plain-URL fetch + text extraction for the `research` agent's `web_fetch`
 * tool. No API key required — this is just an outbound HTTP GET, so unlike
 * every other connector here it has no `not_configured` state, only
 * success/error. Size-capped and given a short timeout since it fetches
 * arbitrary operator-model-chosen URLs, not a known-good API.
 */

const MAX_BYTES = 500_000;
const FETCH_TIMEOUT_MS = 8000;

export type WebFetchOutcome = { ok: true; data: { title: string; text: string } } | { ok: false; error: string };

/** Strips tags/scripts/styles down to readable text — deliberately simple
    (regex-based, no DOM/JSDOM dependency) since this only needs to give the
    model something to reason over, not a faithful render. */
function htmlToText(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
  return withoutTags.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function fetchUrlText(url: string): Promise<WebFetchOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `invalid URL: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol: ${parsed.protocol}` };
  }
  try {
    const res = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'FounderOS-research-agent/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.text();
    const capped = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw;
    const titleMatch = capped.match(/<title[^>]*>([^<]*)<\/title>/i);
    return { ok: true, data: { title: titleMatch?.[1]?.trim() ?? parsed.hostname, text: htmlToText(capped).slice(0, 20_000) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
