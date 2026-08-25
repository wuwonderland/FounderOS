/**
 * LLM connector — backs agent & Conductor chat. Preference order: the local
 * Hermes Agent proxy (hermes proxy start — free, OAuth-backed, no per-token
 * billing) first, then the Vercel AI Gateway, then native ANTHROPIC_API_KEY /
 * OPENAI_API_KEY — each one only tried if the previous is unconfigured or
 * actually fails at call time (e.g. Hermes isn't running, or an
 * unauthenticated/expired gateway key). Plus a `stub` provider
 * (LLM_PROVIDER=stub) that is deterministic and makes NO network call, so the
 * whole agent-chat stack is testable offline. Status stays honest: no
 * provider reachable ⇒ not_configured, never a fake "connected".
 */
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { CRED_FILES, resolveCred } from '@/lib/creds';
import type { ConnectorStatus } from '@/lib/connectors/types';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';
export type LlmMessage = { role: LlmRole; content: string };

export type LlmToolSpec = {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type LlmToolCall = { name: string; args: unknown; result: unknown };

export type LlmChatRequest = {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  model?: string;
};

export type LlmChatResult = { text: string; toolCalls: LlmToolCall[] };

export interface LlmProvider {
  name: string;
  chat(req: LlmChatRequest): Promise<LlmChatResult>;
}

const GATEWAY_KEY = 'AI_GATEWAY_API_KEY';
const DEFAULT_MODEL = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-5';
const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o';
// `hermes proxy start` binds 127.0.0.1:8645 by default (verified against the
// installed `hermes proxy start --help` — not guessed).
const DEFAULT_HERMES_URL = process.env.HERMES_PROXY_URL ?? 'http://127.0.0.1:8645/v1';
// The proxy attaches your real upstream credentials server-side and doesn't
// validate the bearer it's given — this is a placeholder, not a secret.
const HERMES_PLACEHOLDER_KEY = 'hermes-local-proxy';
const DEFAULT_HERMES_MODEL = process.env.HERMES_MODEL ?? 'poolside/laguna-s-2.1:free';

/** process.env first (Next auto-loads .env.local), then Alex's cred files. */
function resolveGatewayKey(): string | undefined {
  return resolveCred(GATEWAY_KEY, [CRED_FILES.agentsEnv, CRED_FILES.socialMedia]);
}

function resolveAnthropicKey(): string | undefined {
  return resolveCred('ANTHROPIC_API_KEY', [CRED_FILES.agentsEnv]);
}

function resolveOpenAIKey(): string | undefined {
  return resolveCred('OPENAI_API_KEY', [CRED_FILES.agentsEnv]);
}

/** Stub trigger: a user message containing `use-tool:<name>` fires that tool. */
const STUB_TRIGGER = /use-tool:(\S+)/;

export const stubLlmProvider: LlmProvider = {
  name: 'stub',
  async chat(req) {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = lastUser ? `stub-reply: ${lastUser.content}` : 'stub-reply';
    const toolCalls: LlmToolCall[] = [];
    const trigger = lastUser?.content.match(STUB_TRIGGER);
    if (trigger && req.tools) {
      const spec = req.tools.find((t) => t.name === trigger[1]);
      if (spec) {
        const args: Record<string, unknown> = {};
        const result = await spec.execute(args);
        toolCalls.push({ name: spec.name, args, result });
      }
    }
    return { text, toolCalls };
  },
};

/** Shared generateText + tool-call extraction, given an already-resolved
    LanguageModel — every real provider below (gateway, Anthropic, OpenAI)
    is just "resolve a model, then run this". */
async function runChat(model: LanguageModel, req: LlmChatRequest): Promise<LlmChatResult> {
  const { generateText, tool, stepCountIs } = await import('ai');
  const tools = Object.fromEntries(
    (req.tools ?? []).map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: t.parameters, execute: t.execute }),
    ]),
  );
  const messages = req.messages
    .filter((m) => m.role !== 'tool')
    .map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content }));

  const result = await generateText({
    model,
    system: req.system,
    messages,
    tools: req.tools?.length ? tools : undefined,
    stopWhen: stepCountIs(6),
  });

  const toolCalls: LlmToolCall[] = [];
  for (const step of result.steps ?? []) {
    const calls = step.toolCalls ?? [];
    const results = step.toolResults ?? [];
    for (const c of calls) {
      // Match the result to its call by id — a failed/missing tool result
      // can leave `toolResults` shorter than `toolCalls`, so positional
      // alignment would attach the wrong output to every later call.
      const hit = results.find((r) => r.toolCallId === c.toolCallId);
      toolCalls.push({ name: c.toolName, args: c.input, result: hit?.output });
    }
  }
  return { text: result.text, toolCalls };
}

export function createGatewayProvider(model: string = DEFAULT_MODEL): LlmProvider {
  return {
    name: 'gateway',
    async chat(req) {
      // Fail fast with an honest message instead of letting the SDK hang —
      // and hydrate process.env from Alex's cred files so a key that
      // exists outside .env.local still works.
      const key = resolveGatewayKey();
      if (!key) {
        throw new Error('AI_GATEWAY_API_KEY is not set — add it to .env.local to enable agent chat.');
      }
      if (!process.env.AI_GATEWAY_API_KEY) process.env.AI_GATEWAY_API_KEY = key;
      const { gateway } = await import('ai');
      return runChat(gateway(req.model ?? model), req);
    },
  };
}

export function createAnthropicProvider(model: string = DEFAULT_ANTHROPIC_MODEL): LlmProvider {
  return {
    name: 'anthropic',
    async chat(req) {
      const key = resolveAnthropicKey();
      if (!key) throw new Error('ANTHROPIC_API_KEY is not set — add it to .env.local to enable agent chat.');
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const anthropic = createAnthropic({ apiKey: key });
      return runChat(anthropic(req.model ?? model), req);
    },
  };
}

export function createOpenAIProvider(model: string = DEFAULT_OPENAI_MODEL): LlmProvider {
  return {
    name: 'openai',
    async chat(req) {
      const key = resolveOpenAIKey();
      if (!key) throw new Error('OPENAI_API_KEY is not set — add it to .env.local to enable agent chat.');
      const { createOpenAI } = await import('@ai-sdk/openai');
      const openai = createOpenAI({ apiKey: key });
      return runChat(openai.chat(req.model ?? model), req);
    },
  };
}

/** Routes through the local `hermes proxy` (OpenAI-compatible endpoint —
    `hermes proxy start`, default http://127.0.0.1:8645/v1). Free and
    OAuth-backed instead of a paid API key; the proxy attaches real upstream
    credentials, so the bearer this sends is a placeholder. If the proxy
    isn't running the fetch fails fast (localhost, ECONNREFUSED) and the
    fallback chain honestly moves on to the next provider. */
export function createHermesProvider(baseURL: string = DEFAULT_HERMES_URL, model: string = DEFAULT_HERMES_MODEL): LlmProvider {
  return {
    name: 'hermes',
    async chat(req) {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const hermes = createOpenAI({ baseURL, apiKey: HERMES_PLACEHOLDER_KEY });
      return runChat(hermes.chat(req.model ?? model), req);
    },
  };
}

/** Tries every configured provider in preference order — gateway, then
    native Anthropic, then native OpenAI — and only moves to the next one
    when the current provider is unconfigured OR actually fails (e.g. an
    expired/unauthenticated AI_GATEWAY_API_KEY). Never fabricates a reply:
    if nothing is configured, or every configured provider fails, the last
    real error is thrown. */
export function createFallbackProvider(): LlmProvider {
  const chain: [string, () => boolean, () => LlmProvider][] = [
    // Always "configured" — a URL with a sane default, not a key. If the
    // proxy isn't actually running, the chat call fails fast (localhost) and
    // the loop below honestly moves to the next provider.
    ['hermes', () => true, () => createHermesProvider()],
    ['gateway', () => Boolean(resolveGatewayKey()), () => createGatewayProvider()],
    ['anthropic', () => Boolean(resolveAnthropicKey()), () => createAnthropicProvider()],
    ['openai', () => Boolean(resolveOpenAIKey()), () => createOpenAIProvider()],
  ];
  return {
    name: 'fallback',
    async chat(req) {
      const configured = chain.filter(([, has]) => has());
      if (configured.length === 0) {
        throw new Error(
          'No LLM provider configured — start the Hermes proxy (`hermes proxy start`), set AI_GATEWAY_API_KEY (preferred), or ANTHROPIC_API_KEY / OPENAI_API_KEY, in .env.local.',
        );
      }
      let lastErr: unknown;
      for (const [name, , make] of configured) {
        try {
          return await make().chat(req);
        } catch (err) {
          lastErr = err;
          console.warn(`[llm] ${name} provider failed, trying next fallback:`, err instanceof Error ? err.message : err);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

export function getLlmProvider(): LlmProvider {
  const name = process.env.LLM_PROVIDER;
  if (name === 'stub') return stubLlmProvider;
  if (name === 'hermes') return createHermesProvider();
  if (name === 'gateway') return createGatewayProvider();
  if (name === 'anthropic') return createAnthropicProvider();
  if (name === 'openai') return createOpenAIProvider();
  // Default: try every configured provider, most-preferred first, instead
  // of hard-failing the moment the gateway key is missing or rejected.
  return createFallbackProvider();
}

export function chat(req: LlmChatRequest): Promise<LlmChatResult> {
  return getLlmProvider().chat(req);
}

/** Quick TCP-level reachability check — localhost only, so a short timeout
    doesn't risk the slow-remote-call problem the rest of this file avoids
    (see file header). Used only to make llmStatus() honest about whether
    the Hermes proxy is actually running, not just configured-by-default. */
async function isHermesReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300);
    try {
      await fetch(DEFAULT_HERMES_URL.replace(/\/v1\/?$/, '/'), { signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

export async function llmStatus(): Promise<ConnectorStatus> {
  const base = { id: 'llm', name: 'LLM (Gateway)', kind: 'orchestration' } as const;
  if (process.env.LLM_PROVIDER === 'stub') {
    return { ...base, state: 'connected', detail: 'stub provider active (tests)' };
  }
  if (await isHermesReachable()) {
    return {
      ...base,
      name: 'LLM (Hermes proxy)',
      state: 'connected',
      detail: `hermes proxy reachable at ${DEFAULT_HERMES_URL} · model ${DEFAULT_HERMES_MODEL}`,
    };
  }
  if (resolveGatewayKey()) {
    return { ...base, state: 'connected', detail: `Vercel AI Gateway · default model ${DEFAULT_MODEL}` };
  }
  if (resolveAnthropicKey()) {
    return {
      ...base,
      name: 'LLM (Anthropic fallback)',
      state: 'connected',
      detail: `No AI_GATEWAY_API_KEY — using native ANTHROPIC_API_KEY · model ${DEFAULT_ANTHROPIC_MODEL}`,
    };
  }
  if (resolveOpenAIKey()) {
    return {
      ...base,
      name: 'LLM (OpenAI fallback)',
      state: 'connected',
      detail: `No AI_GATEWAY_API_KEY — using native OPENAI_API_KEY · model ${DEFAULT_OPENAI_MODEL}`,
    };
  }
  return {
    ...base,
    state: 'not_configured',
    detail: 'Start the Hermes proxy (`hermes proxy start`), set AI_GATEWAY_API_KEY (preferred), or ANTHROPIC_API_KEY / OPENAI_API_KEY, in .env.local.',
  };
}
