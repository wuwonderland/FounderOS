'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Dot } from '@/components/terminal';
import '@/lib/types/speech-recognition';

const BAR_COUNT = 4;
const IDLE_DURATIONS = [0.8, 0.6, 1.0, 0.7];

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'not connected',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
};

const STATE_DOT: Record<VoiceState, string> = {
  idle: 'off',
  listening: 'active',
  thinking: 'idle',
  speaking: 'active',
};

/** Floating ambient HUD with an opt-in mic: real Web Audio waveform driven by
    mic volume, real (feature-detected) browser speech recognition, and a
    genuine ElevenLabs TTS round trip for the spoken reply — with an honest
    "not configured" fallback when no ELEVENLABS_API_KEY is set, same as
    every other connector in this repo. Nothing here is faked; every failure
    mode surfaces as text instead of a silently-broken interaction. */
export function VoiceHUD() {
  const [micOn, setMicOn] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState('');
  const [speechSupported, setSpeechSupported] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const responseSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const visualizerRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const wantsRecognitionRef = useRef(false);

  useEffect(() => {
    setSpeechSupported(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
  }, []);

  function stopVisualizer() {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    visualizerRef.current?.disconnect();
    visualizerRef.current = null;
    barRefs.current.forEach((bar) => {
      if (bar) bar.style.height = '';
    });
  }

  function startVisualizer(node: AudioNode) {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    stopVisualizer();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    node.connect(analyser);
    visualizerRef.current = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const step = Math.max(1, Math.floor(data.length / BAR_COUNT));
    const loop = () => {
      analyser.getByteFrequencyData(data);
      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        for (let j = i * step; j < (i + 1) * step && j < data.length; j++) sum += data[j];
        const avg = sum / step;
        const bar = barRefs.current[i];
        if (bar) bar.style.height = `${3 + (avg / 255) * 17}px`;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();
  }

  async function speak(text: string) {
    setVoiceState('thinking');
    setNote(null);
    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setNote(body.error ?? 'ElevenLabs not configured — showing transcript only.');
        setVoiceState(micOn ? 'listening' : 'idle');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (!audioElRef.current) audioElRef.current = new Audio();
      const audioEl = audioElRef.current;
      audioEl.src = url;

      const ctx = audioCtxRef.current;
      if (ctx) {
        if (!responseSourceRef.current) {
          responseSourceRef.current = ctx.createMediaElementSource(audioEl);
          responseSourceRef.current.connect(ctx.destination);
        }
        startVisualizer(responseSourceRef.current);
      }

      setVoiceState('speaking');
      audioEl.onended = () => {
        URL.revokeObjectURL(url);
        if (micOn && micSourceRef.current) startVisualizer(micSourceRef.current);
        else stopVisualizer();
        setVoiceState(micOn ? 'listening' : 'idle');
      };
      await audioEl.play();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Speech synthesis failed.');
      setVoiceState(micOn ? 'listening' : 'idle');
    }
  }

  async function enableMic() {
    setNote(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) throw new Error('Web Audio API not supported in this browser.');
      const ctx = audioCtxRef.current ?? new AudioCtx();
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended') await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      micSourceRef.current = source;
      startVisualizer(source);
      setMicOn(true);
      setVoiceState('listening');

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        wantsRecognitionRef.current = true;
        const recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.onresult = (event) => {
          let finalText = '';
          let interim = '';
          for (let i = 0; i < event.results.length; i++) {
            const r = event.results[i];
            if (r.isFinal) finalText += r[0].transcript;
            else interim += r[0].transcript;
          }
          setTranscript(finalText || interim);
          if (finalText.trim()) speak(`Acknowledged: ${finalText.trim()}`);
        };
        recognition.onerror = (event) => {
          if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            setNote('Microphone permission denied.');
          }
        };
        recognition.onend = () => {
          // Chrome auto-stops recognition after a pause; restart while the mic is still on.
          if (wantsRecognitionRef.current) {
            try {
              recognition.start();
            } catch {
              /* already running */
            }
          }
        };
        recognitionRef.current = recognition;
        recognition.start();
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Microphone permission denied or unavailable.');
      setMicOn(false);
      setVoiceState('idle');
    }
  }

  function disableMic() {
    wantsRecognitionRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopVisualizer();
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setMicOn(false);
    setVoiceState('idle');
    setTranscript('');
  }

  useEffect(
    () => () => {
      wantsRecognitionRef.current = false;
      recognitionRef.current?.stop();
      stopVisualizer();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioElRef.current?.pause();
      audioCtxRef.current?.close();
    },
    [],
  );

  return (
    <div className="fixed left-1/2 top-3 z-40 flex -translate-x-1/2 flex-col items-center gap-1.5">
      <div className="flex items-center gap-3 border border-os-border bg-os-surface/85 px-4 py-2 backdrop-blur-md">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.24em] text-os-dim">Voice HUD</span>
        <div className="flex h-4 items-end gap-[3px]">
          {Array.from({ length: BAR_COUNT }).map((_, i) =>
            micOn ? (
              <span
                key={i}
                ref={(el) => {
                  barRefs.current[i] = el;
                }}
                className="w-[3px] bg-os-accent"
                style={{ height: 3 }}
              />
            ) : (
              <motion.span
                key={i}
                className="w-[3px] bg-os-border-strong"
                animate={{ height: [3, 6, 3] }}
                transition={{ repeat: Infinity, duration: IDLE_DURATIONS[i], ease: 'easeInOut' }}
              />
            ),
          )}
        </div>
        <span className="flex items-center gap-1.5 font-mono text-[9.5px] text-os-dim">
          <Dot state={STATE_DOT[voiceState]} pulse={voiceState === 'listening' || voiceState === 'speaking'} />
          {STATE_LABEL[voiceState]}
        </span>
        <button
          type="button"
          onClick={() => (micOn ? disableMic() : enableMic())}
          className="hoverable border border-os-border-strong px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-os-muted transition-colors hover:text-os-accent"
        >
          {micOn ? 'Mic off' : 'Mic on'}
        </button>
      </div>
      {(transcript || note || speechSupported === false) && (
        <div className="max-w-[420px] border border-os-border bg-os-surface/85 px-3.5 py-1.5 text-center font-mono text-[10.5px] text-os-muted backdrop-blur-md">
          {transcript && <div className="truncate">&ldquo;{transcript}&rdquo;</div>}
          {speechSupported === false && <div className="text-os-dim">Speech recognition not supported in this browser — visual only.</div>}
          {note && <div className="text-os-warn">{note}</div>}
        </div>
      )}
    </div>
  );
}
