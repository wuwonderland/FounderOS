/**
 * Conductor routing. A message can name its target explicitly with a leading
 * `@<agentId|name>`; otherwise the model picks the best-fit agent from the
 * roster. Either way the Conductor delegates to that agent's chat (with its
 * tools) and returns `{ routedTo, ...chat }`. Routing never throws on a bad
 * `@name` — it falls back to model routing.
 */
import { chat as llmChat } from '@/lib/connectors/llm';
import { chatWithAgent, type ChatResult } from '@/lib/agents/chat';
import { isLiveAgentId } from '@/lib/agents/tools';
import type { FounderDb } from '@/lib/db';
import type { RuntimeAgent } from '@/lib/agents/runtime';

export type ConductorResult = ChatResult & { routedTo: string };

const AT_PREFIX = /^@(\S+)\s*/;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function matchAgent(agents: RuntimeAgent[], token: string): RuntimeAgent | undefined {
  const t = slug(token);
  return agents.find((a) => a.id === token || a.id === t || slug(a.name) === t);
}

/** Ask the model for the single best-fit agent id; fall back to the first agent. */
async function pickAgent(routable: RuntimeAgent[], message: string): Promise<string> {
  const roster = routable.map((a) => `- ${a.id}: ${a.name} — ${a.description}`).join('\n');
  const system = [
    'You are the Conductor, the router for Founder OS operator agents.',
    'Pick the single best-fit agent for the user message.',
    'Reply with ONLY that agent id and nothing else. Options:',
    roster,
  ].join('\n');
  const res = await llmChat({ system, messages: [{ role: 'user', content: message }] });
  const picked = (res.text.trim().split(/\s+/)[0] ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  const found = routable.find((a) => a.id === picked);
  return (found ?? routable[0]).id;
}

export async function routeConductorMessage(
  db: FounderDb,
  agents: RuntimeAgent[],
  message: string,
  opts: { screenContext?: string } = {},
): Promise<ConductorResult> {
  // Candidate set restricted to the "live" agents — dev/ops/research today.
  // Gated on lib/agents/tools/index.ts's LIVE_AGENT_IDS (the static list
  // that actually determines whether an agent has a real tool-executing
  // runAgent() loop behind it) rather than a live `db.agents` query: the
  // `agents.live` column (see lib/db.ts's migrateAgentsTable) mirrors the
  // same three ids for display/consistency, but making this routing gate
  // depend on that row existing in whatever `db` a caller happens to pass
  // in would be a fragile way to enforce it — an unseeded db would
  // silently route nowhere. Every other seeded agent keeps working via its
  // own direct /api/agents/[id]/chat and /api/agents/[id]/run routes;
  // they're just no longer something the Conductor will route a message to.
  const routable = agents.filter((a) => a.id !== 'conductor' && isLiveAgentId(a.id));
  if (routable.length === 0) {
    return {
      routedTo: 'none',
      reply: 'No live agents are configured yet — set `live = true` on at least one row in the agents table.',
      messages: [],
    };
  }
  let targetId: string | undefined;
  let delivered = message;

  const at = message.match(AT_PREFIX);
  if (at) {
    const explicit = matchAgent(routable, at[1]);
    if (explicit) {
      targetId = explicit.id;
      delivered = message.replace(AT_PREFIX, '').trim() || message;
    }
    // unknown @name → fall through to model routing (never throw)
  }

  if (!targetId) targetId = await pickAgent(routable, message);

  const result = await chatWithAgent(db, agents, targetId, delivered, opts);
  return { routedTo: targetId, ...result };
}
