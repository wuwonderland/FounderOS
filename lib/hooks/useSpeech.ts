'use client';

import { useEffect, useRef } from 'react';
import '@/lib/types/speech-recognition';

export type SpeechOptions = { continuous?: boolean; interimResults?: boolean; lang?: string };
export type SpeechCallbacks = {
  /** Fires on every result event with ONLY the new segment since the last
      event (event.resultIndex forward) — never the whole cumulative
      session, which is what causes the classic "re-reads everything so
      far" duplication bug with continuous=true. */
  onResult: (finalText: string, interimText: string) => void;
  onError?: (error: string) => void;
  onEnd?: () => void;
};

// Module-scoped — the browser only ever allows ONE active SpeechRecognition
// session. OrbJarvis is the sole consumer (see Voice Architecture Phase 1);
// the ownership-tracking singleton stays so a future consumer can never
// silently fight it for the mic.
let recognition: SpeechRecognitionLike | null = null;
let ownerId = 0;
let shouldRestart = false;

function getRecognition(): SpeechRecognitionLike | null {
  if (recognition) return recognition;
  if (typeof window === 'undefined') return null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  recognition = new SR();
  return recognition;
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** Explicitly clears the singleton's event handlers. `rec.onresult = fn`
    (used everywhere here) is a single-slot property assignment, not
    `addEventListener` — every start() call already fully replaces the
    previous handler, so there is no listener "stacking" across
    renders/restarts to begin with. This is defense-in-depth on top of that:
    called whenever the current owner deliberately stops, so a genuinely-
    dead session can't fire into stale closures at all, rather than relying
    solely on the ownerId check inside each handler. */
function detach(): void {
  if (!recognition) return;
  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
}

/** Shared SpeechRecognition access. `start()` always takes over from
    whatever the previous owner was doing — stale callbacks from a
    superseded owner are ignored by id, so an unmount or a new caller can
    never resurrect a dead session or fight over the mic. */
export function useSpeech() {
  const idRef = useRef(0);

  useEffect(
    () => () => {
      // Only yield the mic if THIS consumer is still the current owner —
      // unmounting a component that already lost ownership must not kill a
      // session a newer consumer just started.
      if (idRef.current === ownerId) {
        shouldRestart = false;
        detach();
        recognition?.stop();
      }
    },
    [],
  );

  function start(options: SpeechOptions, callbacks: SpeechCallbacks): boolean {
    const rec = getRecognition();
    if (!rec) return false;

    shouldRestart = false;
    detach(); // drop the previous owner's handlers before rebinding fresh ones below
    rec.stop(); // yield the mic if a previous owner was mid-session

    const myId = ++ownerId;
    idRef.current = myId;
    rec.continuous = options.continuous ?? false;
    rec.interimResults = options.interimResults ?? false;
    // The Web Speech API has no language auto-detection — one `lang` per
    // session, applied to the whole utterance's phonetics. Left at the old
    // 'en-US' default, Traditional Chinese speech gets force-fit into
    // English phoneme space and comes out as hallucinated gibberish, which
    // is why this now defaults to 'zh-TW'. This is a real trade, not a free
    // fix: the same session will now do the same mangling in reverse for
    // pure English speech. Pass `lang: 'en-US'` explicitly per call if a
    // given turn is known to be English; there is no way to get both
    // languages accurately recognized within one session.
    rec.lang = options.lang ?? 'zh-TW';

    rec.onresult = (event) => {
      if (ownerId !== myId) return; // stale — a newer owner has since taken over
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      finalText = finalText.trim();
      interimText = interimText.trim();
      if (finalText || interimText) {
        console.log('[STT Transcript]:', finalText || interimText, finalText ? '(final)' : '(interim)');
      }
      callbacks.onResult(finalText, interimText);
    };
    rec.onerror = (event) => {
      if (ownerId !== myId) return;
      // "aborted" fires on every intentional stop()/takeover — not a real
      // error, and treating it like one is what causes retry/echo loops.
      if (event.error !== 'aborted' && event.error !== 'no-speech') callbacks.onError?.(event.error);
    };
    rec.onend = () => {
      if (ownerId !== myId) return;
      if (shouldRestart) {
        try {
          rec.start();
        } catch {
          // Same InvalidStateError race as the initial start() below — the
          // browser hasn't fully unwound the previous stop() yet. Retry
          // once; if that ALSO fails, the recognizer is genuinely dead and
          // silently swallowing it here would leave the caller stuck in
          // "listening" forever with no recovery — surface it as a real
          // end instead so the caller's onEnd can reset state.
          setTimeout(() => {
            if (ownerId !== myId) return;
            try {
              rec.start();
            } catch {
              callbacks.onEnd?.();
            }
          }, 50);
        }
      } else {
        callbacks.onEnd?.();
      }
    };

    shouldRestart = options.continuous ?? false;
    try {
      rec.start();
    } catch {
      // Chrome throws InvalidStateError if start() lands before the prior
      // stop() has fully unwound — retry once on the next tick.
      setTimeout(() => {
        if (ownerId === myId) {
          try {
            rec.start();
          } catch {
            /* give up quietly */
          }
        }
      }, 50);
    }
    return true;
  }

  /** Stop listening. Safe to call even if this consumer never started a
      session, or another consumer has since taken over (no-op then). */
  function stop() {
    if (idRef.current === ownerId) {
      shouldRestart = false;
      detach();
      recognition?.stop();
    }
  }

  return { start, stop, supported: isSpeechSupported() };
}
