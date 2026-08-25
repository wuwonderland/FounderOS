import path from 'node:path';
import { NextResponse } from 'next/server';
import type { KnownBlock } from '@slack/types';
import { postToChannel, verifySlackSignature } from '@/lib/connectors/slack';
import { planFromRequest, runPlan, approveAndApply } from '@/lib/agents/orchestrator';
import { diffContent } from '@/lib/agents/sandbox';
import type { Task } from '@/types/agent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Not yet publicly reachable: this route only receives traffic once a
// public URL for it is registered under Event Subscriptions in the Slack
// app dashboard (a local dev server needs a tunnel — ngrok or similar —
// for that). Until then this endpoint exists but nothing calls it.
//
// Fails CLOSED: without SLACK_SIGNING_SECRET configured, every request is
// rejected — there is no "trust it anyway" fallback. This is one of two
// inbound, internet-facing endpoints in the Dev Team Agent suite (the
// other is app/api/slack/actions); a request that can't be proven to be
// from Slack must never reach the orchestrator.

const seenEventIds = new Set<string>();
const MAX_SEEN = 500;

function rememberEventId(id: string): boolean {
  // Returns true if this is a NEW event (should be processed), false if
  // it's a duplicate delivery we've already handled.
  if (seenEventIds.has(id)) return false;
  seenEventIds.add(id);
  if (seenEventIds.size > MAX_SEEN) {
    const oldest = seenEventIds.values().next().value;
    if (oldest !== undefined) seenEventIds.delete(oldest);
  }
  return true;
}

type SlackAppMentionEvent = {
  type: 'app_mention';
  text: string;
  channel: string;
  user?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
};

/** Strips the leading `<@BOTID>` mention token Slack includes at the start
    of an app_mention's text, leaving just the instruction. */
function stripMention(text: string): string {
  return text.replace(/^\s*<@[A-Z0-9]+>\s*/i, '').trim();
}

const APPROVE_RE = /^approve\s+(\S+)/i;
const DIFF_PREVIEW_LIMIT = 2500; // Slack block text fields cap around 3000 chars

function summarizeTask(task: Task): string {
  const marker = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : task.status === 'validating' ? '⏸️' : '⏳';
  let line = `${marker} *${task.title}* (${task.role}, ${task.status})`;
  if (task.result?.summary) line += `\n   ${task.result.summary}`;
  if (task.status === 'validating') line += `\n   Task id: \`${task.id}\``;
  return line;
}

/** Builds the Block Kit approval message for one developer task sitting in
    "validating" — the diff of what would be written, plus the button that
    (once clicked by an authorized approver — see
    orchestrator.ts#approveAndApply) actually applies it. */
async function buildApprovalBlocks(task: Task): Promise<KnownBlock[]> {
  const targetFile = task.targetFiles[0] ?? 'unknown file';
  const diff = await diffContent(task.previousContent ?? '', task.proposedContent ?? '', path.basename(targetFile));
  let diffText = diff.ok ? diff.data.trim() : `(diff unavailable: ${diff.error})`;
  if (!diffText) diffText = '(no textual difference)';
  const truncated = diffText.length > DIFF_PREVIEW_LIMIT;
  if (truncated) diffText = `${diffText.slice(0, DIFF_PREVIEW_LIMIT)}\n… (truncated)`;

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `⏸️ *${task.title}*\n${task.description}\n\nProposed change to \`${targetFile}\`:` },
    },
    { type: 'section', text: { type: 'mrkdwn', text: '```' + diffText + '```' } },
    {
      type: 'actions',
      block_id: 'approve_task_actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve & Apply' },
          style: 'primary',
          action_id: 'approve_task',
          value: task.id,
        },
      ],
    },
  ];
}

/** The actual work — deliberately NOT awaited by the request handler, so
    the HTTP response (which Slack requires within ~3s) returns immediately
    after signature verification. Plans + runs read-only/drafting steps for
    a fresh request, or resolves an "approve <task_id>" command against an
    already-proposed task — never applies a write except via the shared,
    authorization-gated approveAndApply. */
async function handleMention(event: SlackAppMentionEvent): Promise<void> {
  const instruction = stripMention(event.text);
  if (!instruction) return;
  const threadTs = event.thread_ts ?? event.ts;

  const approveMatch = instruction.match(APPROVE_RE);
  if (approveMatch) {
    const result = await approveAndApply(approveMatch[1], event.user ?? 'unknown');
    const text = result.ok
      ? `${result.task.result?.ok ? '✅' : '❌'} ${result.task.result?.summary ?? 'Applied.'}`
      : `❌ ${result.message}`;
    await postToChannel(event.channel, text, { threadTs });
    return;
  }

  await postToChannel(event.channel, `🔧 On it — breaking this down: "${instruction}"`, { threadTs });

  const plan = await planFromRequest(instruction, 'slack', { channel: event.channel, threadTs, userId: event.user ?? 'unknown' });
  if (plan.planError || plan.tasks.length === 0) {
    await postToChannel(event.channel, `❌ Couldn't build a plan: ${plan.planError ?? 'no tasks produced'}`, { threadTs });
    return;
  }

  const executed = await runPlan(plan);
  const summary = executed.tasks.map(summarizeTask).join('\n\n');
  await postToChannel(event.channel, summary, { threadTs });

  for (const task of executed.tasks) {
    if (task.status !== 'validating') continue;
    const blocks = await buildApprovalBlocks(task);
    await postToChannel(event.channel, `Proposed change ready for review: ${task.title}`, { threadTs, blocks });
  }
}

export async function POST(req: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    // Fail closed — no verification key means no request can be trusted.
    return NextResponse.json({ error: 'SLACK_SIGNING_SECRET is not set — refusing all events.' }, { status: 401 });
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

  const body = JSON.parse(rawBody) as Record<string, unknown>;

  // Slack's one-time handshake when Event Subscriptions is first enabled.
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return NextResponse.json({ challenge: body.challenge });
  }

  if (body.type !== 'event_callback') {
    return NextResponse.json({ ok: true }); // acknowledged, nothing to do
  }

  // A retried delivery (Slack didn't get our ack fast enough last time, or
  // we errored) — we've already started (or finished) handling the
  // original, so just ack without reprocessing.
  if (req.headers.get('x-slack-retry-num')) {
    return NextResponse.json({ ok: true });
  }
  const eventId = typeof body.event_id === 'string' ? body.event_id : null;
  if (eventId && !rememberEventId(eventId)) {
    return NextResponse.json({ ok: true });
  }

  const event = body.event as Partial<SlackAppMentionEvent> | undefined;
  if (event?.type === 'app_mention' && !event.bot_id && typeof event.text === 'string' && event.channel && event.ts) {
    // Fire-and-forget: ack Slack now, do the real work after.
    void handleMention(event as SlackAppMentionEvent).catch((err) => {
      console.error('[slack/events] handleMention failed:', err);
    });
  }

  return NextResponse.json({ ok: true });
}
