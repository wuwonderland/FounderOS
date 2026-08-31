/**
 * Tool registry mapping a live agent id to its tool set. The only three
 * ids the executor loop (lib/agents/executor.ts) and the Conductor's live
 * roster (lib/agents/conductor.ts, gated by the `agents.live` column) know
 * about — see CLAUDE.md's "real connectors & agents" section and the
 * task that added this file for why it's exactly these three.
 */
import type { LlmToolSpec } from '@/lib/connectors/llm';
import { devTools } from '@/lib/agents/tools/dev';
import { opsTools } from '@/lib/agents/tools/ops';
import { researchTools } from '@/lib/agents/tools/research';
import type { AgentTool } from '@/lib/agents/tools/types';

export type LiveAgentId = 'dev' | 'ops' | 'research';

export const LIVE_AGENT_IDS: LiveAgentId[] = ['dev', 'ops', 'research'];

export function isLiveAgentId(id: string): id is LiveAgentId {
  return (LIVE_AGENT_IDS as string[]).includes(id);
}

const REGISTRY: Record<LiveAgentId, AgentTool[]> = {
  dev: devTools,
  ops: opsTools,
  research: researchTools,
};

/** The FULL tool set (read + write) for a live agent — only ever handed to
    lib/agents/executor.ts's runAgent, which is the one place that enforces
    the write gate. Never expose this to the plain per-agent chat path
    (chatWithAgent's system prompt promises READ-ONLY; see readOnlyToolsFor
    below for what that path gets instead). */
export function toolsForAgent(id: string): AgentTool[] | undefined {
  return isLiveAgentId(id) ? REGISTRY[id] : undefined;
}

/** Adapts a live agent's READ-sideEffect tools only to the existing
    RuntimeAgent.chatTools() shape (lib/connectors/llm.ts's LlmToolSpec),
    for use in the ordinary read-only chat path (lib/agents/chat.ts). Write
    tools are deliberately excluded here — that chat path's system prompt
    says "you are READ-ONLY", and this keeps that literally true rather
    than just prompted. */
export function readOnlyLlmTools(id: string): LlmToolSpec[] {
  const tools = toolsForAgent(id) ?? [];
  return tools
    .filter((t) => t.sideEffect === 'read')
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      execute: async (args: Record<string, unknown>) => t.execute(args),
    }));
}
