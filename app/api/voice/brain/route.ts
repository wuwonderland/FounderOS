import { NextResponse } from 'next/server';
import { chat } from '@/lib/connectors/llm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// TTS-bound persona for OrbJarvis — short, plain-text, spoken-friendly.
const SYSTEM_PROMPT =
  'You are FounderOS, an advanced, highly capable AI executive assistant for a top-tier CEO. ' +
  'You manage business operations, the NERVE app development, and strategic decisions. Your ' +
  'responses are being fed directly into a Text-to-Speech (TTS) engine. Therefore, you MUST ' +
  'keep your answers extremely concise (1-3 sentences max). NEVER use markdown, bullet points, ' +
  'asterisks, emojis, or any special characters. Speak in a natural, highly professional, and ' +
  'slightly conversational tone.';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const prompt = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!prompt) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  try {
    // getLlmProvider() throws its own honest "AI_GATEWAY_API_KEY is not
    // set" message when unconfigured — that flows straight through as the
    // error below rather than a fake reply.
    const result = await chat({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    return NextResponse.json({ text: result.text });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
