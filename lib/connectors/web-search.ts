/**
 * Web search connector for the `research` agent (lib/agents/tools/research.ts).
 * Brave Search API — a straightforward REST API with its own free tier,
 * independent of every other connector in this repo (no key reuse). Honest
 * `not_configured` when BRAVE_SEARCH_API_KEY is absent, matching every
 * other connector's convention — never a fake result set.
 */

export type WebSearchResult = { title: string; url: string; snippet: string };
export type WebSearchOutcome = { ok: true; data: WebSearchResult[] } | { ok: false; error: string };

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export async function webSearch(
  query: string,
  env: Record<string, string | undefined> = process.env,
): Promise<WebSearchOutcome> {
  const key = env.BRAVE_SEARCH_API_KEY;
  if (!key) return { ok: false, error: 'not_configured' };
  try {
    const res = await fetch(`${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=8`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Brave Search HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string }[] };
    };
    const results = (json.web?.results ?? []).map((r) => ({
      title: r.title ?? '(untitled)',
      url: r.url ?? '',
      snippet: (r.description ?? '').slice(0, 400),
    }));
    return { ok: true, data: results };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
