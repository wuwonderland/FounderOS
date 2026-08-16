"use client";

import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import "@/lib/types/speech-recognition";

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
`;

const BRAIN_TIMEOUT_MS = 20_000;

/** Calls the server-side /api/voice/brain route (Vercel AI Gateway — see
    lib/connectors/llm.ts — no LLM key ever reaches the client) and returns
    the generated reply text. Throws on failure/timeout so the caller can
    fall back honestly instead of inventing a response. */
async function askBrain(transcript: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRAIN_TIMEOUT_MS);
  try {
    const res = await fetch("/api/voice/brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: transcript }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      throw new Error(body.error ?? `brain request failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { text?: string };
    const text = typeof data.text === "string" ? data.text.trim() : "";
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
    leaves the server — see lib/connectors/elevenlabs.ts) and plays back the
    returned audio. Returns false on any failure — including a mid-flight
    abort — so the caller can fall back to idle instead of faking a spoken
    response. `onEnded` fires exactly once, whether playback finishes
    naturally or errors out after starting. */
async function speakWithElevenLabs(text: string, handles: AudioHandles, onEnded: () => void): Promise<boolean> {
  haltPlayback(handles); // guarantee no prior stream is still live before this one starts
  const controller = new AbortController();
  handles.speakAbortRef.current = controller;
  try {
    const res = await fetch("/api/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      console.warn("[OrbJarvis] speech synthesis unavailable:", body.error ?? res.status);
      return false;
    }
    const blob = await res.blob();
    if (controller.signal.aborted) return false; // superseded while the response streamed in
    const url = URL.createObjectURL(blob);
    handles.objectUrlRef.current = url;
    if (!handles.audioRef.current) handles.audioRef.current = new Audio();
    const audio = handles.audioRef.current;
    audio.src = url;
    audio.onended = onEnded;
    audio.onerror = () => {
      console.warn("[OrbJarvis] audio playback error — resetting to idle.");
      onEnded();
    };
    await audio.play();
    return true;
  } catch (err) {
    if (controller.signal.aborted) return false; // intentional — a newer call superseded this one
    console.warn("[OrbJarvis] speech synthesis failed:", err);
    return false;
  } finally {
    if (handles.speakAbortRef.current === controller) handles.speakAbortRef.current = null;
  }
}

export default function OrbJarvis() {
  const [status, setStatus] = useState<OrbStatus>("idle");
  const [glitching, setGlitching] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const speakAbortRef = useRef<AbortController | null>(null);
  const listeningRef = useRef(false);
  const handles: AudioHandles = { audioRef, objectUrlRef, speakAbortRef };

  const t = THEME[status];
  const awake = status !== "idle";

  useEffect(() => {
    if (status === "idle") return;
    setGlitching(true);
    const timer = window.setTimeout(() => setGlitching(false), 460);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(
    () => () => {
      listeningRef.current = false;
      recognitionRef.current?.stop();
      haltPlayback(handles);
    },
    [],
  );

  async function speakAndTrack(text: string) {
    const spoke = await speakWithElevenLabs(text, handles, () => setStatus("idle"));
    setStatus(spoke ? "speaking" : "idle");
  }

  async function respondTo(transcript: string) {
    setStatus("thinking");
    let reply: string;
    try {
      reply = await askBrain(transcript);
    } catch (err) {
      console.warn("[OrbJarvis] brain request failed:", err);
      await speakAndTrack("System connection lost.");
      return;
    }
    await speakAndTrack(reply);
  }

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn("[OrbJarvis] SpeechRecognition is not supported in this browser.");
      setStatus("idle");
      return;
    }
    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const finalText = Array.from({ length: event.results.length })
        .map((_, i) => event.results[i][0].transcript)
        .join(" ")
        .trim();
      if (finalText) respondTo(finalText);
    };
    recognition.onerror = (event) => {
      if (event.error !== "no-speech") console.warn("[OrbJarvis] recognition error:", event.error);
    };
    recognition.onend = () => {
      listeningRef.current = false;
      setStatus((s) => (s === "listening" ? "idle" : s));
    };
    recognitionRef.current = recognition;
    listeningRef.current = true;
    recognition.start();
  }

  const toggleStatus = () => {
    if (status !== "idle") return; // one interaction at a time — real state, not a demo cycle
    setStatus("listening");
    startListening();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none select-none">
      <div className="absolute inset-0 orbtv-scanlines" aria-hidden="true" />
      <div className="absolute top-0 left-0 right-0 orbtv-band" aria-hidden="true" />
      {glitching && <div className="absolute inset-0 orbtv-flash" aria-hidden="true" />}

      <div className="relative pointer-events-auto cursor-pointer" onClick={toggleStatus} aria-label="Voice orb — click to talk">
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
      </div>

      <style>{ORB_CSS}</style>
    </div>
  );
}
