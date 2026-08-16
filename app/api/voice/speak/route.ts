import { NextResponse } from 'next/server';
import { synthesizeSpeech } from '@/lib/connectors/elevenlabs';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  const result = await synthesizeSpeech(text);
  if (!result.ok) {
    // Honest failure — mirrors every other connector's "not configured"
    // instead of pretending a voice response went out.
    return NextResponse.json({ error: result.detail }, { status: 501 });
  }

  return new NextResponse(result.audio, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
  });
}
