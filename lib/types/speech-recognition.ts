export {};

// Minimal ambient typing for the (still non-standard) Web Speech API —
// shared so every client component that uses SpeechRecognition augments the
// same global shape instead of redeclaring conflicting ones.
declare global {
  interface SpeechRecognitionAlternativeLike {
    transcript: string;
  }
  interface SpeechRecognitionResultLike {
    isFinal: boolean;
    0: SpeechRecognitionAlternativeLike;
    length: number;
  }
  interface SpeechRecognitionEventLike {
    results: ArrayLike<SpeechRecognitionResultLike>;
  }
  interface SpeechRecognitionLike extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
  }
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}
