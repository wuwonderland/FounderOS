'use client';

import { useEffect, useRef, useState } from 'react';
import { Dot } from '@/components/terminal';

// @mediapipe/hands and @mediapipe/camera_utils ship as browser-global IIFE
// scripts (they assign onto `window`, not `module.exports`/ESM exports), so
// they can't be `import`ed through a bundler — load them as <script> tags at
// runtime instead, only once the operator opts in.
declare global {
  interface Window {
    Hands?: new (config: { locateFile: (file: string) => string }) => any;
    Camera?: new (video: HTMLVideoElement, config: { onFrame: () => Promise<void>; width: number; height: number }) => any;
  }
}

const HANDS_SCRIPT = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js';
const CAMERA_SCRIPT = 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js';

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/** Local-only hand-gesture input. Off by default — the webcam only turns on
    once the operator opts in, and the stream + model are torn down on
    disable/unmount so nothing keeps recording in the background. */
export default function GestureControl({ onGesture }: { onGesture?: (gesture: 'SELECT' | 'NAVIGATE') => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [gestureText, setGestureText] = useState('No gesture detected');

  useEffect(() => {
    if (!enabled || !videoRef.current) return;

    let cancelled = false;
    let camera: any;
    let hands: any;

    (async () => {
      try {
        await loadScript(HANDS_SCRIPT);
        await loadScript(CAMERA_SCRIPT);
        if (cancelled || !videoRef.current || !window.Hands || !window.Camera) return;

        hands = new window.Hands({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.7,
          minTrackingConfidence: 0.7,
        });
        hands.onResults((results: any) => {
          if (cancelled) return;
          const landmarks = results.multiHandLandmarks?.[0];
          if (!landmarks) {
            setGestureText('No gesture detected');
            return;
          }
          const indexFingerTip = landmarks[8];
          const thumbTip = landmarks[4];
          const distance = Math.hypot(indexFingerTip.x - thumbTip.x, indexFingerTip.y - thumbTip.y);
          if (distance < 0.05) {
            setGestureText('Pinch — Select');
            onGesture?.('SELECT');
          } else {
            setGestureText('Open palm — Navigate');
            onGesture?.('NAVIGATE');
          }
        });

        camera = new window.Camera(videoRef.current, {
          onFrame: async () => {
            if (videoRef.current) await hands.send({ image: videoRef.current });
          },
          width: 320,
          height: 240,
        });
        camera.start();
      } catch {
        if (!cancelled) setGestureText('Failed to load gesture model');
      }
    })();

    return () => {
      cancelled = true;
      camera?.stop();
      hands?.close();
      setGestureText('No gesture detected');
    };
  }, [enabled, onGesture]);

  return (
    <div className="fixed bottom-6 right-6 z-50 w-64 border border-os-border bg-os-surface/90 p-3 backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-os-dim">
        <span>Gesture control</span>
        <Dot state={enabled ? 'active' : 'off'} pulse={enabled} />
      </div>
      <video ref={videoRef} className="hidden h-36 w-full object-cover" />
      {enabled && (
        <div className="mb-2 border border-os-border-strong bg-os-bg2 px-2.5 py-2 text-center font-mono text-[11px] text-os-muted">
          {gestureText}
        </div>
      )}
      <button
        type="button"
        onClick={() => setEnabled((v) => !v)}
        className="hoverable w-full border border-os-border-strong px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-os-muted transition-colors hover:text-os-accent"
      >
        {enabled ? 'Disable camera' : 'Enable camera'}
      </button>
    </div>
  );
}
