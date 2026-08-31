/**
 * Shared Google OAuth2 token exchange for the `ops` agent's Gmail/Calendar
 * tools (lib/agents/tools/ops.ts). Deliberately its own credential set —
 * FounderOS's own OAuth client, NOT inherited from the IMAP-based
 * lib/connectors/email.ts or any other tool's Google access. A standard
 * "installed app" refresh-token flow: the operator does the one-time
 * consent dance once (outside this repo, e.g. via Google's OAuth
 * Playground or a throwaway script) and stores the long-lived refresh
 * token here; this module only ever exchanges it for short-lived access
 * tokens, it never runs the interactive consent flow itself.
 *
 * No `googleapis` dependency — both Gmail and Calendar are plain REST APIs
 * over `fetch`, matching every other connector in this repo (see attio.ts).
 */

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export function resolveGoogleOAuthConfig(
  env: Record<string, string | undefined> = process.env,
): GoogleOAuthConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return undefined;
  return { clientId, clientSecret, refreshToken };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Access tokens are short-lived (~1hr) and this process may make many calls
// in a burst (a single agent run can call gmail_search then gmail_read
// several times) — cache in-memory, process-lifetime only, same scope as
// every other in-memory cache in this codebase (orchestrator's memory-file
// cache, sandbox's working memory). Never persisted, never shared across
// distinct refresh tokens.
let cachedToken: { accessToken: string; expiresAt: number; refreshToken: string } | null = null;

/** Exchanges the refresh token for a fresh access token, reusing the cached
    one if it still has >60s of life left. Throws on failure — callers (the
    tool wrappers in ops.ts) turn that into an honest `{ok:false}` rather
    than crashing the agent run. */
export async function getGoogleAccessToken(config: GoogleOAuthConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.refreshToken === config.refreshToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.accessToken;
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google OAuth token refresh failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Google OAuth token refresh returned no access_token');
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
    refreshToken: config.refreshToken,
  };
  return cachedToken.accessToken;
}
