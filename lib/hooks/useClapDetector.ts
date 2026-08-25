'use client';

import { useEffect, useRef, useState } from 'react';

export type ClapDetectorOptions = {
  /** Gate the detector — pause it whenever the orb is already listening,
      thinking, or speaking, so the mic activity or TTS playback from those
      states can never be mistaken for a wake-up clap. */
  enabled: boolean;
  /** Two claps must land within this window (ms) to count as a double-clap. */
  doubleClapWindowMs?: number;
  onDoubleClap: () => void;
  /** Fires once per detected clap, including the first of a pair that never
      completes — hook visual flair up to this rather than onDoubleClap. */
  onClap?: () => void;
};

// Normalized (0-1) deviation from silence a sample must cross to count as a
// clap's transient. Claps are short, loud, broadband spikes — comfortably
// above normal speech/ambient noise on a laptop mic.
const CLAP_THRESHOLD = 0.45;
// Minimum gap after a detected clap before the next spike can register as a
// NEW clap, so one clap's decay tail isn't counted several times over.
const CLAP_REFRACTORY_MS = 150;

/** Always-on (while `enabled`) background clap detector via the Web Audio
    API — a lightweight amplitude-spike scan over a requestAnimationFrame
    loop, not a per-sample audio-thread callback, so it stays cheap on the
    main thread. Two distinct claps within `doubleClapWindowMs` fire
    `onDoubleClap`. Mic permission failures degrade to `error` being set
    instead of throwing — the rest of the app must keep working with
    click-to-talk even when the wake-up feature can't get the mic.

    The mic stream and AudioContext are acquired ONCE, the first time
    `enabled` turns true, and kept alive for the component's lifetime —
    `enabled` toggling after that only pauses/resumes the analysis loop, it
    never tears down and re-requests the mic. Re-acquiring on every
    idle<->listening turn (the original implementation) meant real,
    avoidable work — and, worse, mic-hardware contention — landing right at
    the moment SpeechRecognition also wants the microphone. */
export function useClapDetector({
  enabled,
  doubleClapWindowMs = 800,
  onDoubleClap,
  onClap,
}: ClapDetectorOptions): { supported: boolean; error: string | null } {
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastClapAtRef = useRef<number | null>(null);
  const firstClapAtRef = useRef<number | null>(null);

  // Latest values live in refs so the long-lived analysis loop always sees
  // the current `enabled`/window/callbacks without needing to restart.
  const enabledRef = useRef(enabled);
  const windowMsRef = useRef(doubleClapWindowMs);
  const onDoubleClapRef = useRef(onDoubleClap);
  const onClapRef = useRef(onClap);
  useEffect(() => {
    enabledRef.current = enabled;
    windowMsRef.current = doubleClapWindowMs;
    onDoubleClapRef.current = onDoubleClap;
    onClapRef.current = onClap;
  });

  function loop() {
    if (!enabledRef.current) {
      rafRef.current = null; // paused — the resume effect below restarts it
      return;
    }
    const analyser = analyserRef.current;
    const data = dataRef.current;
    if (!analyser || !data) {
      rafRef.current = null;
      return;
    }

    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const deviation = Math.abs(data[i] - 128) / 128;
      if (deviation > peak) peak = deviation;
    }

    const now = performance.now();
    const lastClapAt = lastClapAtRef.current;
    const isNewClap = peak >= CLAP_THRESHOLD && (lastClapAt == null || now - lastClapAt >= CLAP_REFRACTORY_MS);

    if (isNewClap) {
      lastClapAtRef.current = now;
      onClapRef.current?.();
      const firstClapAt = firstClapAtRef.current;
      if (firstClapAt != null && now - firstClapAt <= windowMsRef.current) {
        firstClapAtRef.current = null;
        onDoubleClapRef.current();
      } else {
        // Either the first clap of a fresh pair, or a pair that arrived too
        // slowly — either way this clap becomes the new anchor.
        firstClapAtRef.current = now;
      }
    } else if (firstClapAtRef.current != null && now - firstClapAtRef.current > windowMsRef.current) {
      // Window expired with no second clap — reset and wait for a fresh pair.
      firstClapAtRef.current = null;
    }

    rafRef.current = requestAnimationFrame(loop);
  }

  // Acquire the mic + build the audio graph once, the first time the
  // detector is enabled. Guarded by `audioCtxRef.current` so this body only
  // ever runs a single time for the component's life, regardless of how
  // many times `enabled` flips afterward.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setSupported(false);
      return;
    }
    if (!enabled || audioCtxRef.current) return;

    let cancelled = false;

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (cancelled) return;
        // Permission denied / no device / blocked by policy — degrade
        // honestly, don't retry-loop or crash the orb.
        console.warn('[useClapDetector] microphone unavailable:', err);
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) {
        setSupported(false);
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      streamRef.current = stream;
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      // `new Uint8Array(n)` infers `Uint8Array<ArrayBufferLike>` under TS's
      // newer typed-array generics — too loose for the DOM lib's
      // `getByteTimeDomainData`, which wants `Uint8Array<ArrayBuffer>`
      // specifically. Backing it with an explicit ArrayBuffer satisfies that.
      dataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      setError(null);

      if (enabledRef.current && rafRef.current == null) rafRef.current = requestAnimationFrame(loop);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Pause/resume the per-frame scan as `enabled` toggles — no mic/context
  // churn, just start or stop scheduling the next animation frame. No-ops
  // on the very first `enabled=true` (the setup effect above hasn't
  // finished acquiring the mic yet); it schedules the loop itself once ready.
  useEffect(() => {
    if (enabled && analyserRef.current && rafRef.current == null) {
      lastClapAtRef.current = null;
      firstClapAtRef.current = null;
      rafRef.current = requestAnimationFrame(loop);
    } else if (!enabled && rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // True teardown only on unmount — the mic stays open across ordinary
  // idle<->listening turns (see the setup effect above).
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      analyserRef.current = null;
      dataRef.current = null;
      lastClapAtRef.current = null;
      firstClapAtRef.current = null;
    };
  }, []);

  return { supported, error };
}
