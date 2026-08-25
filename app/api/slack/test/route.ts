import { NextResponse } from 'next/server';
import { verifySlackConnection } from '@/lib/connectors/slack';

export const dynamic = 'force-dynamic';

/** Smoke test for the Slack connector — calls auth.test with whichever
    token is configured (SLACK_BOT_TOKEN, else SLACK_ACCESS_TOKEN) and
    reports honestly whether it actually authenticates. Never returns a
    fake "connected". HTTP status is always 200 — same convention as every
    other connector-status route in this repo (GET /api/connections etc.):
    the state lives in `ok`/`error`, not the status code, so a token
    expiring or a missing config is a normal 200 response to check, not a
    server error. */
export async function GET() {
  const result = await verifySlackConnection();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.detail });
  }
  return NextResponse.json({
    ok: true,
    botId: result.botId,
    botName: result.name,
    teamName: result.teamName,
    userId: result.userId,
    expiresInSeconds: result.expiresInSeconds,
  });
}
