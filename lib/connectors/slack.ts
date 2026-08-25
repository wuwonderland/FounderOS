import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import type { KnownBlock, Block } from '@slack/types';
import type { ConnectorStatus } from '@/lib/connectors/types';

export type SlackMessage = { channel: string; user: string; text: string; ts: string };

/** Token resolution: SLACK_BOT_TOKEN (xoxb-…, a real bot install) wins when
    present; SLACK_ACCESS_TOKEN is the fallback — a token minted by Slack's
    token-rotation flow (xoxe.xoxp-…). That fallback token is a *user*
    token, not a bot token, and it EXPIRES (Slack's auth.test returns
    `expires_in` in seconds) — there's no refresh-token exchange wired up
    here, so once it expires this connector honestly reports 'error' again
    until a fresh token is dropped into .env.local. SLACK_APP_TOKEN (xapp-…,
    Socket Mode) isn't consumed by anything in this repo yet.
    SLACK_SIGNING_SECRET IS consumed — see verifySlackSignature below,
    used by app/api/slack/events and app/api/slack/actions to verify
    inbound requests actually come from Slack. */
function resolveToken(env: Record<string, string | undefined>): string | undefined {
  return env.SLACK_BOT_TOKEN || env.SLACK_ACCESS_TOKEN;
}

function client(env: Record<string, string | undefined>): WebClient | null {
  const token = resolveToken(env);
  return token ? new WebClient(token) : null;
}

export async function slackStatus(env: Record<string, string | undefined> = process.env): Promise<ConnectorStatus> {
  const slack = client(env);
  if (!slack) {
    return {
      id: 'slack',
      name: 'Slack',
      kind: 'slack',
      state: 'not_configured',
      detail:
        'Set SLACK_BOT_TOKEN (xoxb-…, preferred — needs channels:read, channels:history, users:read scopes) ' +
        'or SLACK_ACCESS_TOKEN in .env.local.',
    };
  }
  try {
    const auth = await slack.auth.test();
    const expiry = typeof auth.expires_in === 'number' ? ` (expires in ${Math.round(auth.expires_in / 60)}m)` : '';
    return {
      id: 'slack',
      name: 'Slack',
      kind: 'slack',
      state: 'connected',
      detail: `Connected to ${auth.team} as ${auth.user}${expiry}`,
      meta: { team: String(auth.team ?? ''), user: String(auth.user ?? '') },
    };
  } catch (err) {
    return {
      id: 'slack',
      name: 'Slack',
      kind: 'slack',
      state: 'error',
      detail: `Token set but auth failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export type SlackSendResult = { ok: boolean; detail: string };

/** Post a reply into a channel by name. Fails honestly without a token. */
export async function sendSlackMessage(
  channelName: string,
  text: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SlackSendResult> {
  const slack = client(env);
  if (!slack) return { ok: false, detail: 'SLACK_BOT_TOKEN not set — add it under Connections → API keys' };
  try {
    const list = await slack.conversations.list({ types: 'public_channel,private_channel', limit: 200 });
    const channel = list.channels?.find((c) => c.name === channelName.replace(/^#/, ''));
    if (!channel?.id) return { ok: false, detail: `channel #${channelName} not found or bot not invited` };
    await slack.chat.postMessage({ channel: channel.id, text });
    return { ok: true, detail: `sent to #${channelName}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Post a reply directly by channel ID (and optionally into a thread) —
    the primitive the Slack Events/Actions dispatchers need, since an
    incoming event/payload carries a channel ID, not a name.
    sendSlackMessage above stays the name-based convenience wrapper for
    other callers. `blocks` is optional Block Kit content (e.g. an
    "Approve & Apply" button) — `text` is always sent too, as Slack's
    required fallback for notifications/accessibility. */
export async function postToChannel(
  channelId: string,
  text: string,
  opts: { threadTs?: string; blocks?: (KnownBlock | Block)[]; env?: Record<string, string | undefined> } = {},
): Promise<SlackSendResult> {
  const slack = client(opts.env ?? process.env);
  if (!slack) return { ok: false, detail: 'No Slack token configured' };
  try {
    await slack.chat.postMessage({ channel: channelId, text, thread_ts: opts.threadTs, blocks: opts.blocks });
    return { ok: true, detail: `sent to ${channelId}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Edits an existing message in place — used to strip the "Approve &
    Apply" button off a message once it's been clicked, so a second click
    (or a race between two people) can't re-trigger the action. Not a
    substitute for approveAndApply's own idempotency check (task status),
    just belt-and-suspenders UX. */
export async function updateMessage(
  channelId: string,
  ts: string,
  text: string,
  opts: { blocks?: (KnownBlock | Block)[]; env?: Record<string, string | undefined> } = {},
): Promise<SlackSendResult> {
  const slack = client(opts.env ?? process.env);
  if (!slack) return { ok: false, detail: 'No Slack token configured' };
  try {
    await slack.chat.update({ channel: channelId, ts, text, blocks: opts.blocks });
    return { ok: true, detail: `updated ${channelId}/${ts}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const SIGNATURE_REPLAY_WINDOW_SECONDS = 60 * 5;

/** Verifies Slack's `v0=` HMAC-SHA256 request signature (used identically
    by both the Events API and interactive-component/actions payloads) —
    the single implementation every inbound Slack route in this repo must
    use, so a security-critical check never drifts between two copies.
    `rawBody` must be the EXACT bytes Slack sent (read before any
    JSON/form parsing) — signing is over the raw request body. Rejects a
    timestamp more than 5 minutes old as a possible replay. */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
): boolean {
  if (!timestamp || !signature) return false;
  const timestampNum = Number(timestamp);
  if (!Number.isFinite(timestampNum)) return false;
  if (Math.abs(Date.now() / 1000 - timestampNum) > SIGNATURE_REPLAY_WINDOW_SECONDS) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

export async function recentMessages(
  limit = 10,
  env: Record<string, string | undefined> = process.env,
): Promise<SlackMessage[]> {
  const slack = client(env);
  if (!slack) throw new Error('SLACK_BOT_TOKEN is not set');
  const channels = await slack.conversations.list({ limit: 10, exclude_archived: true, types: 'public_channel' });
  const messages: SlackMessage[] = [];
  for (const channel of channels.channels ?? []) {
    if (!channel.id || !channel.is_member) continue;
    const history = await slack.conversations.history({ channel: channel.id, limit: 5 });
    for (const msg of history.messages ?? []) {
      messages.push({
        channel: channel.name ?? channel.id,
        user: msg.user ?? 'unknown',
        text: msg.text ?? '',
        ts: msg.ts ?? '',
      });
    }
  }
  return messages.sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, limit);
}

export type SlackVerifyResult =
  | {
      ok: true;
      botId: string | null;
      /** The authed identity's display name — for a bot token this is the
          bot's own name; for a user token (e.g. the SLACK_ACCESS_TOKEN
          fallback) it's the human user's name. Slack's auth.test doesn't
          distinguish the two in its response shape. */
      name: string | null;
      teamName: string | null;
      userId: string | null;
      /** Seconds until this token expires, for rotating tokens (like the
          SLACK_ACCESS_TOKEN fallback) — null for a token that doesn't
          expire (a normal xoxb- bot token). */
      expiresInSeconds: number | null;
    }
  | { ok: false; detail: string };

/** Calls Slack's auth.test to verify whichever token is configured
    actually authenticates, and surfaces who it authenticated as. Never
    throws — a missing token or a failed call both come back as
    `{ok: false, detail}` so the caller can report a clean error instead of
    a fake "connected". */
export async function verifySlackConnection(
  env: Record<string, string | undefined> = process.env,
): Promise<SlackVerifyResult> {
  const slack = client(env);
  if (!slack) {
    return {
      ok: false,
      detail: 'No Slack token configured — set SLACK_BOT_TOKEN (preferred) or SLACK_ACCESS_TOKEN in .env.local.',
    };
  }
  try {
    const auth = await slack.auth.test();
    return {
      ok: true,
      botId: auth.bot_id ?? null,
      name: auth.user ?? null,
      teamName: auth.team ?? null,
      userId: auth.user_id ?? null,
      expiresInSeconds: typeof auth.expires_in === 'number' ? auth.expires_in : null,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
