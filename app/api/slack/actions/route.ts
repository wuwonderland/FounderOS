import { NextResponse } from 'next/server';
import { postToChannel, updateMessage, verifySlackSignature } from '@/lib/connectors/slack';
import { approveAndApply } from '@/lib/agents/orchestrator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Handles Slack interactive-component payloads (block actions — i.e. the
// "Approve & Apply" button from app/api/slack/events). Not yet publicly
// reachable: needs a public URL registered as the Interactivity Request
// URL in the Slack app dashboard, same as the Events route.
//
// Fails CLOSED, same as app/api/slack/events: no SLACK_SIGNING_SECRET
// means no request is trusted, full stop. This route is the one that can
// actually cause a real file write (via approveAndApply, which has its
// own separate SLACK_APPROVAL_USER_IDS allowlist check — signature
// verification proves the request came from Slack, it does NOT by itself
// authorize the clicking user to approve a change).
//
// IMPORTANT: Slack interactivity payloads are `application/x-www-form-
// urlencoded` with the JSON in a `payload` field — NOT raw JSON like the
// Events API. Signature verification still runs over the raw body bytes,
// same v0 HMAC scheme either way.

type SlackBlockActionsPayload = {
  type: 'block_actions';
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: { action_id?: string; value?: string }[];
};

async function handleApproveClick(payload: SlackBlockActionsPayload): Promise<void> {
  const channelId = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const approverId = payload.user?.id;
  const taskId = payload.actions?.[0]?.value;
  if (!channelId || !approverId || !taskId) return;

  const result = await approveAndApply(taskId, approverId);
  const text = result.ok
    ? `${result.task.result?.ok ? '✅' : '❌'} <@${approverId}> approved — ${result.task.result?.summary ?? 'applied.'}`
    : `❌ <@${approverId}>'s approval was rejected: ${result.message}`;

  // Strip the button off the original message so it can't be clicked
  // again, whether it succeeded or was rejected.
  if (messageTs) {
    await updateMessage(channelId, messageTs, text);
  } else {
    await postToChannel(channelId, text);
  }
}

export async function POST(req: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return NextResponse.json({ error: 'SLACK_SIGNING_SECRET is not set — refusing all actions.' }, { status: 401 });
  }

  const rawBody = await req.text();
  const verified = verifySlackSignature(
    rawBody,
    req.headers.get('x-slack-request-timestamp'),
    req.headers.get('x-slack-signature'),
    signingSecret,
  );
  if (!verified) {
    return NextResponse.json({ error: 'invalid Slack signature' }, { status: 401 });
  }

  const form = new URLSearchParams(rawBody);
  const rawPayload = form.get('payload');
  if (!rawPayload) {
    return NextResponse.json({ error: 'missing payload' }, { status: 400 });
  }

  let payload: SlackBlockActionsPayload;
  try {
    payload = JSON.parse(rawPayload) as SlackBlockActionsPayload;
  } catch {
    return NextResponse.json({ error: 'malformed payload' }, { status: 400 });
  }

  if (payload.type === 'block_actions' && payload.actions?.[0]?.action_id === 'approve_task') {
    // Fire-and-forget: ack Slack now (it also requires a response within
    // ~3s), do the real work — including the LLM/typecheck-bound
    // approveAndApply call — after.
    void handleApproveClick(payload).catch((err) => {
      console.error('[slack/actions] handleApproveClick failed:', err);
    });
  }

  return NextResponse.json({ ok: true });
}
