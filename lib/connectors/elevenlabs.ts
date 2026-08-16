/**
 * ElevenLabs connector — text-to-speech for the Voice HUD's spoken agent
 * responses. Status is a presence check only (no network call), mirroring
 * llm.ts: no ELEVENLABS_API_KEY ⇒ honest "not_configured", never a fake
 * "connected".
 */
import type { ConnectorStatus } from '@/lib/connectors/types';

// ElevenLabs' premade "Adam" voice — a deep, resonant male preset from their
// default public voice library. Override with ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE_ID = 'pNInz6obpgDQGcFmaJgB';

export async function elevenLabsStatus(env: Record<string, string | undefined> = process.env): Promise<ConnectorStatus> {
  const base = { id: 'elevenlabs', name: 'ElevenLabs', kind: 'voice' } as const;
  if (!env.ELEVENLABS_API_KEY) {
    return {
      ...base,
      state: 'not_configured',
      detail: 'Set ELEVENLABS_API_KEY in .env.local to enable spoken agent responses on the Voice HUD.',
    };
  }
  return { ...base, state: 'connected', detail: `Key set · voice ${env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID}` };
}

export type SpeakResult = { ok: true; audio: ArrayBuffer } | { ok: false; detail: string };

/** Synthesize `text` to speech via the ElevenLabs REST API. Returns an
    honest failure detail rather than throwing, so the caller can surface it
    in the UI the same way every other connector reports "not configured". */
export async function synthesizeSpeech(
  text: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SpeakResult> {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) return { ok: false, detail: 'ELEVENLABS_API_KEY is not set.' };
  const voiceId = env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        // Higher stability + moderate similarity reads as a steadier, deeper
        // delivery than the ElevenLabs defaults — closest fit to a
        // "Jarvis"-style calm tone without needing a custom cloned voice.
        voice_settings: { stability: 0.7, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, detail: `ElevenLabs error: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}` };
    }
    return { ok: true, audio: await res.arrayBuffer() };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
