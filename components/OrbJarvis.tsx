"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { useSpeech } from "@/lib/hooks/useSpeech";
import { useClapDetector } from "@/lib/hooks/useClapDetector";

type OrbStatus = "idle" | "listening" | "thinking" | "speaking";

/* ── CYBERPUNK STATE THEME (literal Tailwind class strings so they get generated) ── */
const THEME: Record<
  OrbStatus,
  {
    label: string;
    core: string;           // gradient + border color
    glow: string;           // box-shadow
    ringA: string;          // rotating arc A (left/right halves)
    ringB: string;          // rotating arc B (top/bottom halves)
    sweep: string;          // inside radar sweep color
    text: string;           // bottom readout color + glow
    ringOpacity: number;    // how visible rings are
  }
> = {
  idle: {
    label: "STANDBY",
    core: "bg-gradient-to-br from-[#2b0066] via-[#0f002e] to-[#05000a] border-[rgba(168,85,247,0.55)]",
    glow: "0px 0px 30px 8px rgba(168,85,247,0.35)",
    ringA: "border-[#a855f7]/80 border-t-transparent border-b-transparent",
    ringB: "border-[#7c3aed]/70 border-l-transparent border-r-transparent",
    sweep: "rgba(168,85,247,0.55)",
    text: "text-violet-400/60",
    ringOpacity: 0.45,
  },
  listening: {
    label: "SIGNAL IN",
    core: "bg-gradient-to-br from-[#ff1a5e] via-[#7a001f] to-[#1f0007] border-[rgba(255,26,94,0.8)]",
    glow: "0px 0px 48px 16px rgba(255,26,94,0.85)",
    ringA: "border-[#ff4d7d]/95 border-t-transparent border-b-transparent",
    ringB: "border-[#ff1a5e]/75 border-l-transparent border-r-transparent",
    sweep: "rgba(255,77,125,0.7)",
    text: "text-rose-400 drop-shadow-[0_0_8px_rgba(255,26,94,0.9)]",
    ringOpacity: 0.75,
  },
  thinking: {
    label: "PROCESSING",
    core: "bg-gradient-to-br from-[#ffcc00] via-[#8a6a00] to-[#241a00] border-[rgba(255,204,0,0.8)]",
    glow: "0px 0px 46px 14px rgba(255,204,0,0.65)",
    ringA: "border-[#ffdb4d]/80 border-t-transparent border-b-transparent",
    ringB: "border-[#ffcc00]/90 border-l-transparent border-r-transparent",
    sweep: "rgba(255,219,77,0.75)",
    text: "text-yellow-400 drop-shadow-[0_0_8px_rgba(255,204,0,0.85)]",
    ringOpacity: 0.7,
  },
  speaking: {
    label: "TRANSMIT",
    core: "bg-gradient-to-br from-[#00f0ff] via-[#0083a8] to-[#00121c] border-[rgba(0,240,255,0.8)]",
    glow: "0px 0px 56px 20px rgba(0,240,255,0.85)",
    ringA: "border-[#5cf6ff]/80 border-t-transparent border-b-transparent",
    ringB: "border-[#00f0ff]/90 border-l-transparent border-r-transparent",
    sweep: "rgba(92,246,255,0.8)",
    text: "text-cyan-300 drop-shadow-[0_0_8px_rgba(0,240,255,0.95)]",
    ringOpacity: 0.85,
  },
};

/* ── Keyframe-only CSS (scanlines, glitch, caret ripple) ── */
const ORB_CSS = `
  .orbtv-scanlines {
    pointer-events: none;
    background-image: repeating-linear-gradient(
      0deg,
      rgba(190,235,255,0.05) 0 1px,
      transparent 1px 3px
    );
    animation: orbtv-scan 8s ease-in-out infinite;
  }
  @keyframes orbtv-scan { 0%,100% { opacity:.5 } 50% { opacity:1 } }

  .orbtv-band {
    pointer-events: none;
    height: 130px;
    background: linear-gradient(180deg, transparent, rgba(0,240,255,0.05) 45%, rgba(255,26,94,0.04) 55%, transparent);
    animation: orbtv-band 12s linear infinite;
  }
  @keyframes orbtv-band { 0%{transform:translateY(-28vh)} 100%{transform:translateY(115vh)} }

  .orbtv-flash {
    pointer-events:none;
    background: rgba(255,26,94,0.06);
    animation: orbtv-flash .45s steps(1) 1 forwards;
  }
  @keyframes orbtv-flash { 0%{opacity:1} 60%{opacity:.3} 100%{opacity:0} }

  /* chromatic aberration — two ghost layers cloned from the orb background */
  .orbtv-core::before, .orbtv-core::after {
    content:"";
    position:absolute; inset:0; z-index:5;
    border-radius:inherit;
    background:inherit;
    mix-blend-mode:screen;
    opacity:0;
    pointer-events:none;
  }
  .orbtv-core.orbtv-glitching::before{
    opacity:.75; transform:translateX(-3px);
    filter:hue-rotate(100deg) saturate(2.2);
    animation:orbtv-split-a .13s steps(2) infinite alternate;
  }
  .orbtv-core.orbtv-glitching::after{
    opacity:.75; transform:translateX(3px);
    filter:hue-rotate(-80deg) saturate(2.2);
    animation:orbtv-split-b .19s steps(2) infinite alternate;
  }
  @keyframes orbtv-split-a { from{clip-path:inset(0 0 62% 0)} to{clip-path:inset(42% 0 0 0)} }
  @keyframes orbtv-split-b { from{clip-path:inset(54% 0 28% 0)} to{clip-path:inset(6% 0 74% 0)} }

  /* whole-unit jitter while glitching */
  .orbtv-jittering { animation: orbtv-jitter .13s linear infinite; }
  @keyframes orbtv-jitter {
    0%{transform:translate(0,0)} 25%{transform:translate(-1.5px,.7px)}
    50%{transform:translate(1.5px,-.7px)} 75%{transform:translate(-1px,-.5px)} 100%{transform:translate(0,0)}
  }

  .orbtv-caret {
    display:inline-block; width:5px; height:11px;
    background:currentColor;
    animation:orbtv-blink 1.1s steps(1) infinite;
  }
  @keyframes orbtv-blink { 0%,100%{opacity:1} 50%{opacity:0} }

  /* Split-second white flash on a detected clap — see useClapDetector. */
  .orb-clap-flash {
    animation: orb-clap-flash .3s ease-out 1 forwards;
  }
  @keyframes orb-clap-flash { 0%{opacity:.9} 100%{opacity:0} }
`;

const BRAIN_TIMEOUT_MS = 20_000;

// The Web Speech API has no configurable silence/auto-stop timeout —
// `continuous: false` (the old setting here) ends the session on the
// browser's own short, non-configurable pause heuristic (often under 2s in
// Chrome). Listening runs in `continuous: true` mode instead and this
// component owns the inactivity timer itself: every speech event (interim
// or final) resets it, and only once this many ms pass with no speech at
// all does the session end and whatever was said get sent as the turn.
// Tuned near the practical floor (1s) for the fastest listening->thinking
// transition that still functions as real pause detection — trade-off,
// stated plainly: a multi-clause sentence with a pause longer than this
// (common in longer Chinese questions) gets cut off mid-thought and sent
// as a partial turn. Going much below ~700ms starts misfiring on natural
// micro-pauses within continuous speech. Raise this if premature cutoffs
// show up in practice.
const SPEECH_SILENCE_TIMEOUT_MS = 1_000;

// How long a continuous conversation session can sit with NO speech at all
// (across one or more empty listen cycles) before it auto-ends back to
// standby. Distinct from SPEECH_SILENCE_TIMEOUT_MS above, which only ends
// ONE utterance — this ends the whole hands-free session. Reset on every
// speech event and every new listening cycle (see armSilenceTimer).
const CONTINUOUS_SESSION_IDLE_MS = 90_000;

type BrainTurn = { role: "user" | "assistant"; content: string };
// Client-side cap on how much conversation history is kept at all — the
// server independently caps what it will actually use per request (see
// MAX_HISTORY_TURNS in app/api/voice/brain/route.ts); this just stops the
// in-memory array from growing unbounded across a very long session.
const MAX_CLIENT_HISTORY = 40;

/** Splits a growing text buffer into complete sentences as soon as they
    appear, returning the rest to keep buffering. Good enough for TTS
    chunking (not entity extraction) — doesn't special-case abbreviations
    or ellipses. */
function extractSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  const boundary = /[.!?]+(\s+|$)/;
  let match: RegExpMatchArray | null;
  while ((match = boundary.exec(rest))) {
    const cut = match.index! + match[0].length;
    const sentence = rest.slice(0, cut).trim();
    if (sentence) sentences.push(sentence);
    rest = rest.slice(cut);
  }
  return { sentences, rest };
}

/** Streams the server-side /api/voice/brain route (OpenAI — see
    app/api/voice/brain/route.ts — no LLM key ever reaches the client),
    invoking onSentence as soon as each complete sentence arrives so TTS can
    start before the full reply finishes generating. `history` is the prior
    turns of THIS continuous conversation session, sent along so the model
    has multi-turn context — see historyRef in the component below. Returns
    the full text. Throws on a request-level failure or an empty response
    so the caller can fall back honestly instead of inventing a reply. */
async function streamBrain(transcript: string, history: BrainTurn[], onSentence: (sentence: string) => void): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRAIN_TIMEOUT_MS);
  try {
    const res = await fetch("/api/voice/brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: transcript, history }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      throw new Error(body.error ?? `brain request failed: HTTP ${res.status}`);
    }
    if (!res.body) throw new Error("brain returned no response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      buffer += chunk;
      const { sentences, rest } = extractSentences(buffer);
      buffer = rest;
      for (const sentence of sentences) onSentence(sentence);
    }
    const tail = buffer.trim();
    if (tail) onSentence(tail);

    const text = full.trim();
    if (!text) throw new Error("brain returned an empty response");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

type AudioHandles = {
  audioRef: React.MutableRefObject<HTMLAudioElement | null>;
  objectUrlRef: React.MutableRefObject<string | null>;
  speakAbortRef: React.MutableRefObject<AbortController | null>;
};

/** Stops whatever the shared <audio> element is doing right now and frees
    its object URL. Called before every new playback attempt and on
    unmount/error so a failure or a rapid retrigger can never leave a
    previous stream running underneath a new one (no overlap, no echo). */
function haltPlayback({ audioRef, objectUrlRef, speakAbortRef }: AudioHandles) {
  speakAbortRef.current?.abort();
  speakAbortRef.current = null;
  const audio = audioRef.current;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (objectUrlRef.current) {
    URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }
}

/** Calls the server-side /api/voice/speak route (ElevenLabs key never
    leaves the server — see lib/connectors/elevenlabs.ts) and returns the
    synthesized audio WITHOUT playing it. Kept separate from playback so
    sentence N+1's audio can start generating while sentence N is still
    playing. Returns null on any failure — including a mid-flight abort —
    so the caller can skip that sentence instead of faking a spoken
    response. */
async function fetchSpeechBlob(text: string, signal: AbortSignal): Promise<Blob | null> {
  try {
    const res = await fetch("/api/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      console.warn("[OrbJarvis] speech synthesis unavailable:", body.error ?? res.status);
      return null;
    }
    const blob = await res.blob();
    return signal.aborted ? null : blob; // superseded while the response streamed in
  } catch (err) {
    if (signal.aborted) return null; // intentional — a newer turn superseded this one
    console.warn("[OrbJarvis] speech synthesis failed:", err);
    return null;
  }
}

/** Plays one already-fetched audio blob through the shared <audio> element
    and resolves once playback ends (or immediately on any failure) — never
    rejects, so a broken clip can't stall the sentence queue behind it. */
function playBlob(blob: Blob, handles: AudioHandles): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    handles.objectUrlRef.current = url;
    if (!handles.audioRef.current) handles.audioRef.current = new Audio();
    const audio = handles.audioRef.current;
    const finish = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.src = url;
    audio.onended = finish;
    audio.onerror = () => {
      console.warn("[OrbJarvis] audio playback error.");
      finish();
    };
    audio.play().catch((err) => {
      console.warn("[OrbJarvis] audio playback failed:", err);
      finish();
    });
  });
}

const ORB_SIZE = 80;
const CORNER_MARGIN = 32; // 2rem

/** Pixel target for the two contextual anchors — numeric, not a CSS calc()/
    vw string: Framer's `type: "spring"` transition can only interpolate
    numbers, so a calc() string silently fails to animate at all (verified
    live: the orb just sat at its untransformed 0,0 origin). Framer's `drag`
    gesture also tracks these same x/y motion values directly — animating
    plain layout props (top/left/right/bottom) *alongside* x/y under an
    active `drag` was tried too and produces broken positioning (verified
    live: Framer resolves them against the wrong box). So the container
    stays CSS-anchored at a fixed top-left origin, and 100% of positioning —
    contextual preset and every drag delta alike — goes through numeric x/y
    alone, recomputed via ResizeObserver (more reliable than the `resize`
    event under viewport/devtools-driven size changes). */
function targetFor(isTaskActive: boolean): { x: number; y: number } {
  if (typeof window === "undefined") return { x: 0, y: 0 };
  return isTaskActive
    ? { x: window.innerWidth - ORB_SIZE - CORNER_MARGIN, y: window.innerHeight - ORB_SIZE - CORNER_MARGIN }
    : { x: window.innerWidth / 2 - ORB_SIZE / 2, y: window.innerHeight / 2 - ORB_SIZE / 2 };
}

export default function OrbJarvis() {
  const [status, setStatus] = useState<OrbStatus>("idle");

  // Single choke point for every status transition. Enforces one
  // invariant: nothing may force the orb back to "idle" while it's
  // actively "thinking" or "speaking" — the two states where a turn is
  // genuinely mid-flight — except the turn's own completion logic (which
  // passes `force: true`) or a real abort/error path (same). Accepts
  // either a value or a React-style updater so it drops in for every old
  // setStatus call 1:1. Logs every transition, applied or blocked, so
  // state changes are traceable in the browser console.
  function setOrbStatus(action: React.SetStateAction<OrbStatus>, opts: { force?: boolean } = {}) {
    setStatus((current) => {
      const next = typeof action === "function" ? (action as (prev: OrbStatus) => OrbStatus)(current) : action;
      if (next === current) return current;
      if (!opts.force && next === "idle" && (current === "thinking" || current === "speaking")) {
        console.warn(`[Orb State] blocked idle reset while ${current} (pass { force: true } if this is a real abort/error)`);
        return current;
      }
      console.log("[Orb State]:", current, "->", next);
      return next;
    });
  }

  const [glitching, setGlitching] = useState(false);
  // Gate on mount: the portal below needs document.body, which only exists
  // client-side — mounting first avoids a server/client markup mismatch.
  const [mounted, setMounted] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const speakAbortRef = useRef<AbortController | null>(null);
  const handles: AudioHandles = { audioRef, objectUrlRef, speakAbortRef };
  const speech = useSpeech();
  const draggedRef = useRef(false);
  const listenBufferRef = useRef("");
  const silenceTimerRef = useRef<number | null>(null);

  // Continuous conversation session — see startSession/endSession below.
  // `continuousRef` is the "still in a hands-free loop" guard requirement
  // 1 asks for; `historyRef` is this session's multi-turn context
  // (requirement 3), reset at the start of every new session.
  const continuousRef = useRef(false);
  const historyRef = useRef<BrainTurn[]>([]);
  const sessionIdleTimerRef = useRef<number | null>(null);

  const [clapFlash, setClapFlash] = useState(false);
  const clapFlashTimerRef = useRef<number | null>(null);
  const clapFlashKeyRef = useRef(0);
  function flashClap() {
    clapFlashKeyRef.current += 1; // forces the flash element to remount so the CSS animation re-triggers even on a fast double-clap
    setClapFlash(true);
    if (clapFlashTimerRef.current != null) window.clearTimeout(clapFlashTimerRef.current);
    clapFlashTimerRef.current = window.setTimeout(() => setClapFlash(false), 300);
  }

  // "A task or application is opened" = any route other than the operator
  // console at `/` — a real signal already present in this app's routing,
  // not a mocked flag.
  const pathname = usePathname();
  const isTaskActive = pathname !== "/";
  const [target, setTarget] = useState(() => targetFor(isTaskActive));

  const t = THEME[status];
  const awake = status !== "idle";

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setTarget(targetFor(isTaskActive));
    const recompute = () => setTarget(targetFor(isTaskActive));
    const observer = new ResizeObserver(recompute);
    observer.observe(document.documentElement);
    window.addEventListener("resize", recompute);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [isTaskActive]);

  useEffect(() => {
    if (status === "idle") return;
    setGlitching(true);
    const timer = window.setTimeout(() => setGlitching(false), 460);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(
    () => () => {
      continuousRef.current = false;
      speech.stop();
      haltPlayback(handles);
      if (clapFlashTimerRef.current != null) window.clearTimeout(clapFlashTimerRef.current);
      if (silenceTimerRef.current != null) window.clearTimeout(silenceTimerRef.current);
      if (sessionIdleTimerRef.current != null) window.clearTimeout(sessionIdleTimerRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function clearSessionIdleTimer() {
    if (sessionIdleTimerRef.current != null) {
      window.clearTimeout(sessionIdleTimerRef.current);
      sessionIdleTimerRef.current = null;
    }
  }

  /** Resets the whole-session inactivity timer — called on every speech
      event and every new listening cycle (see armSilenceTimer). If it ever
      actually fires, nothing has happened for CONTINUOUS_SESSION_IDLE_MS
      straight through, so the hands-free loop ends back to standby. */
  function armSessionIdleTimer() {
    clearSessionIdleTimer();
    sessionIdleTimerRef.current = window.setTimeout(() => {
      console.log("[Orb State] continuous session timed out after inactivity");
      endSession();
    }, CONTINUOUS_SESSION_IDLE_MS);
  }

  /** Starts a fresh hands-free conversation: clears prior context (a new
      session shouldn't inherit an old, unrelated conversation), arms the
      session's own inactivity clock, and begins listening. */
  function startSession() {
    continuousRef.current = true;
    historyRef.current = [];
    armSessionIdleTimer();
    setOrbStatus("listening");
    startListening();
  }

  /** Explicit stop — user clicked the orb mid-conversation, a session
      timed out, or a real recognition error occurred. Always safe to call
      even if no session is active. */
  function endSession() {
    continuousRef.current = false;
    clearSessionIdleTimer();
    clearSilenceTimer();
    speech.stop();
    haltPlayback(handles);
    setOrbStatus("idle", { force: true });
  }

  // Double-Clap Wake Up — only listens while the orb is genuinely idle, so
  // its own mic use (SpeechRecognition) or TTS playback can never trip it.
  useClapDetector({
    enabled: mounted && status === "idle",
    onClap: flashClap,
    onDoubleClap: () => {
      if (status !== "idle") return; // race guard — a turn started between the two claps
      startSession();
    },
  });

  async function respondTo(transcript: string) {
    // Mute immediately — the orb must not transcribe its own "thinking"/
    // "speaking" turn (that's the echo-loop bug: the mic hearing the reply
    // it just spoke and re-triggering itself). Stays off for the rest of
    // this turn — the auto-listen loop only re-arms the mic once this
    // whole turn (including TTS playback) has actually finished, at the
    // bottom of this function — so playback here is inherently echo-free.
    speech.stop();
    haltPlayback(handles); // guarantee no prior turn's audio is still live
    setOrbStatus("thinking");

    const controller = new AbortController();
    handles.speakAbortRef.current = controller;

    // Sentences are queued and played strictly in order, but each one's TTS
    // fetch fires the moment the sentence completes — audio generation for
    // sentence N+1 overlaps both the model still writing sentence N+2 and
    // sentence N still playing, instead of waiting for the full reply.
    let playerChain: Promise<void> = Promise.resolve();
    let queuedAny = false;
    function enqueueSentence(sentence: string) {
      queuedAny = true;
      const blobPromise = fetchSpeechBlob(sentence, controller.signal);
      playerChain = playerChain.then(async () => {
        const blob = await blobPromise;
        if (controller.signal.aborted || !blob) return;
        setOrbStatus("speaking");
        await playBlob(blob, handles);
      });
    }

    let replyText = "";
    try {
      replyText = await streamBrain(transcript, historyRef.current, enqueueSentence);
      // Multi-turn context: only a genuinely successful exchange joins the
      // session's history — a "connection lost" fallback (below) isn't
      // real conversation content and would just pollute later turns.
      historyRef.current = [
        ...historyRef.current,
        { role: "user", content: transcript } as BrainTurn,
        { role: "assistant", content: replyText } as BrainTurn,
      ].slice(-MAX_CLIENT_HISTORY);
    } catch (err) {
      console.warn("[OrbJarvis] brain request failed:", err);
      speech.stop(); // defensive — guarantee the mic is off before/through the fallback line too
      enqueueSentence("System connection lost.");
    }

    if (queuedAny) {
      await playerChain;
      if (handles.speakAbortRef.current === controller) handles.speakAbortRef.current = null;
    }
    // The turn is genuinely over here either way: nothing was ever queued
    // (shouldn't happen — streamBrain throws on a truly empty reply — but
    // never leave the orb stuck mid-turn), or the full sentence queue has
    // actually finished playing (playerChain only resolves once every
    // queued sentence has played). This is the turn's own authoritative
    // completion, not an external interruption — allowed through the
    // thinking/speaking lock either way.
    //
    // Auto-listen loop (requirement 1): if the session is still active —
    // the user hasn't clicked to stop and the session hasn't timed out —
    // go straight back into listening instead of dropping to idle.
    if (continuousRef.current) {
      setOrbStatus("listening"); // thinking/speaking -> listening isn't gated by the idle-lock, no force needed
      startListening();
    } else {
      setOrbStatus("idle", { force: true });
    }
  }

  function clearSilenceTimer() {
    if (silenceTimerRef.current != null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }

  function startListening() {
    listenBufferRef.current = "";

    // Restarts on every speech event (interim or final) — the user is
    // still talking, so the window stays open. Only firing means genuine
    // silence for the full timeout: end the utterance and send whatever
    // was accumulated. Also re-arms the whole-SESSION inactivity clock —
    // any speech activity counts as the session being alive, not just this
    // one utterance (see armSessionIdleTimer/CONTINUOUS_SESSION_IDLE_MS).
    function armSilenceTimer() {
      clearSilenceTimer();
      armSessionIdleTimer();
      silenceTimerRef.current = window.setTimeout(() => {
        speech.stop();
        const transcript = listenBufferRef.current.trim();
        listenBufferRef.current = "";
        if (transcript) {
          respondTo(transcript);
        } else if (continuousRef.current) {
          // Nothing said this cycle, but the session is still active (not
          // timed out) — auto-listen loop keeps going rather than
          // dropping to idle on one quiet window.
          startListening();
        } else {
          setOrbStatus("idle");
        }
      }, SPEECH_SILENCE_TIMEOUT_MS);
    }

    const ok = speech.start(
      { continuous: true, interimResults: true },
      {
        onResult: (finalText, interimText) => {
          if (finalText) listenBufferRef.current = `${listenBufferRef.current} ${finalText}`.trim();
          if (finalText || interimText) armSilenceTimer();
        },
        onError: (error) => {
          console.warn("[OrbJarvis] recognition error:", error);
          endSession(); // a real recognition error ends the whole hands-free loop, not just this turn
        },
        onEnd: () => {
          // Reached only on a real stop neither the silence timer nor an
          // explicit endSession() already handled (e.g. permission revoked
          // mid-session). Self-guarded to "listening" only; the lock in
          // setOrbStatus is a second, independent backstop against this
          // ever touching an in-flight thinking/speaking turn.
          clearSilenceTimer();
          continuousRef.current = false;
          clearSessionIdleTimer();
          setOrbStatus((s) => (s === "listening" ? "idle" : s));
        },
      },
    );
    if (!ok) {
      console.warn("[OrbJarvis] SpeechRecognition is not supported in this browser.");
      endSession();
      return;
    }
    armSilenceTimer(); // grace period in case the user is slow to start talking
  }

  const toggleStatus = () => {
    if (draggedRef.current) {
      draggedRef.current = false; // a real drag just ended — swallow the synthetic click it produces
      return;
    }
    if (status === "idle") {
      startSession();
    } else {
      // Mid-conversation click = explicit stop. Without this the
      // always-on-listen loop would have no way to end except a full
      // inactivity timeout — a real UX requirement once "click again"
      // can't just no-op like it did in push-to-talk mode.
      endSession();
    }
  };

  if (!mounted) return null;

  // Portal straight into <body>: app/template.tsx wraps every page in a
  // `.view` div that runs a mount-in animation touching `transform` — per
  // spec, an ancestor animating `transform` becomes the containing block
  // for `position: fixed` descendants, so without the portal the orb was
  // positioned relative to that wrapper instead of the real viewport
  // (confirmed live — it was pinned to a corner of `.view`, not the screen).
  return createPortal(
    <>
      {/* Ambient full-viewport decoration only — always non-interactive, so
          it can never block the UI behind it. Independent of the orb's own
          (now orb-sized, draggable) container below. */}
      <div className="pointer-events-none fixed inset-0 z-40 select-none" aria-hidden="true">
        <div className="absolute inset-0 orbtv-scanlines" />
        <div className="absolute top-0 left-0 right-0 orbtv-band" />
        {glitching && <div className="absolute inset-0 orbtv-flash" />}
      </div>

      <motion.div
        drag
        dragElastic={0}
        dragMomentum={false}
        animate={{ x: target.x, y: target.y }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        onDragStart={() => {
          draggedRef.current = true;
        }}
        onClick={toggleStatus}
        className="fixed left-0 top-0 z-50 cursor-pointer select-none"
        style={{ touchAction: "none" }}
        aria-label="Voice orb — click to start a hands-free conversation, click again to stop, drag to move"
      >
        <div className={`relative w-20 h-20 ${glitching ? "orbtv-jittering" : ""}`}>
          {["top-0 -left-9 border-t border-l", "top-0 -right-9 border-t border-r",
            "bottom-0 -left-9 border-b border-l", "bottom-0 -right-9 border-b border-r"]
            .map((pos, i) => (
              <span key={i} className={`absolute ${pos} w-5 h-5 border-[rgba(0,240,255,0.5)]`} aria-hidden="true" />
            ))}

          <div className="absolute -inset-9 rounded-full border border-white/10" aria-hidden="true" />
          <div
            className="absolute -inset-1 rounded-full"
            style={{ boxShadow: `inset 0 0 18px 2px ${t.sweep.replace(/,[^,]*\)/, ",0.12)")}` }}
            aria-hidden="true"
          />

          <motion.div
            className="absolute -inset-6 rounded-full border border-dashed border-white/10"
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: awake ? 14 : 40, ease: "linear" }}
            aria-hidden="true"
          />

          <motion.div
            className={`absolute -inset-7 rounded-full border-2 ${t.ringA}`}
            style={{ opacity: t.ringOpacity }}
            animate={{ rotate: -360 }}
            transition={{ repeat: Infinity, duration: awake ? 5 : 18, ease: "linear" }}
            aria-hidden="true"
          />

          <motion.div
            className={`absolute -inset-4 rounded-full border ${t.ringB}`}
            style={{ opacity: t.ringOpacity * 0.85 }}
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: awake ? 3.4 : 24, ease: "linear" }}
            aria-hidden="true"
          />

          <motion.div
            className={`relative w-20 h-20 rounded-full border overflow-hidden backdrop-blur-md ${t.core} orbtv-core ${glitching ? "orbtv-glitching" : ""}`}
            animate={{
              scale: awake ? [1, 1.08, 0.98, 1.1, 1] : [1, 1.015, 1],
              opacity: awake ? [0.95, 1, 0.95] : [0.8, 0.92, 0.8],
              boxShadow: t.glow,
            }}
            transition={{
              repeat: Infinity,
              duration: awake ? (status === "speaking" ? 0.5 : 1.2) : 6,
              ease: "easeInOut",
            }}
          >
            <motion.div
              className="absolute -inset-4 rounded-full mix-blend-screen blur-[10px]"
              style={{ background: `radial-gradient(circle at 32% 30%, ${t.sweep} 0%, ${t.sweep.replace(/,[^,]*\)/, ",0.35)")} 26%, transparent 58%)` }}
              animate={{ x: [0, 12, -8, 0], y: [0, -10, 8, 0], opacity: awake ? [0.5, 0.85, 0.5] : [0.1, 0.22, 0.1] }}
              transition={{ repeat: Infinity, duration: awake ? 3.6 : 11, ease: "easeInOut" }}
              aria-hidden="true"
            />
            <motion.div
              className="absolute -inset-4 rounded-full mix-blend-screen blur-[12px]"
              style={{ background: `radial-gradient(circle at 64% 70%, ${t.sweep} 0%, transparent 55%)` }}
              animate={{ x: [0, -10, 8, 0], y: [0, 11, -8, 0], opacity: awake ? [0.35, 0.6, 0.35] : [0.06, 0.14, 0.06] }}
              transition={{ repeat: Infinity, duration: awake ? 4.5 : 13, ease: "easeInOut" }}
              aria-hidden="true"
            />
            <motion.div
              className="absolute left-0 right-0 h-[3px] mix-blend-screen"
              style={{ background: `linear-gradient(90deg, transparent, ${t.sweep}, transparent)` }}
              animate={{ top: ["12%", "85%", "12%"] }}
              transition={{ repeat: Infinity, duration: awake ? 2 : 7, ease: "linear" }}
              aria-hidden="true"
            />
            <motion.div
              className="absolute inset-0 rounded-full"
              style={{ background: `conic-gradient(from 0deg, transparent 0deg, ${t.sweep} 40deg, transparent 90deg)`, opacity: awake ? 0.3 : 0.12 }}
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: awake ? 5 : 22, ease: "linear" }}
              aria-hidden="true"
            />
            <div
              className="absolute inset-0 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.12)_0%,transparent_62%)] mix-blend-overlay"
              aria-hidden="true"
            />
            {clapFlash && (
              <div key={clapFlashKeyRef.current} className="absolute inset-0 rounded-full bg-white orb-clap-flash" aria-hidden="true" />
            )}
          </motion.div>

          {awake && (
            <motion.div
              key={status}
              className="absolute -inset-3 rounded-full border-2"
              style={{ borderColor: t.sweep }}
              initial={{ scale: 1, opacity: 0.8 }}
              animate={{ scale: 1.7, opacity: 0 }}
              transition={{ duration: 1.1, ease: "easeOut" }}
              aria-hidden="true"
            />
          )}

          <div className="absolute -top-12 left-1/2 -translate-x-1/2 text-[8px] font-mono uppercase tracking-[0.4em] whitespace-nowrap">
            <span className="text-cyan-200/30">[ KERNET // ORB_v2.0 ]</span>
          </div>

          <div className="absolute -left-28 top-1/2 -translate-y-1/2 text-[8px] font-mono text-cyan-100/25 tracking-[0.2em] writing-vertical" aria-hidden="true">
            PWR 96.4%
          </div>
          <div className="absolute -right-28 top-1/2 -translate-y-1/2 text-[8px] font-mono text-cyan-100/25 tracking-[0.2em]" aria-hidden="true">
            SIG ✔
          </div>

          <div className={`absolute -bottom-12 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] font-mono uppercase tracking-[0.3em] ${t.text}`}>
            [ {t.label} ]
            <span className="orbtv-caret ml-2" aria-hidden="true" />
          </div>
        </div>
      </motion.div>

      <style>{ORB_CSS}</style>
    </>,
    document.body,
  );
}
