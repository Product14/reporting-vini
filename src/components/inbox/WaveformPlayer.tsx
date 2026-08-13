"use client";

/**
 * WaveformPlayer — the "Listen" waveform for the call drawer (ported from action-items-console).
 * Exposes seek/play/pause via ref so transcript turns can jump the audio (click-to-seek). The S3 host
 * has no CORS header, so the url is piped through the same-origin /api/inbox/call-recording shim.
 */
import WavesurferPlayer from "@wavesurfer/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface WaveformHandle {
  seek: (time: number) => void;
  play: () => void;
  pause: () => void;
}

function fmt(seconds: number): string {
  if (!seconds || isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

// Route the S3 recording through the same-origin shim so WaveSurfer can fetch the bytes (CORS).
function proxied(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (/(^|\.)amazonaws\.com$/i.test(u.hostname)) return `/api/inbox/call-recording?url=${encodeURIComponent(url)}`;
  } catch { /* not an absolute url — use as-is */ }
  return url;
}

const Ico = ({ d, size = 13 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d={d} /></svg>
);

const WaveformPlayer = forwardRef<WaveformHandle, {
  url: string;
  onTimeUpdate?: (t: number) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onReady?: () => void;
  onError?: () => void;
}>(function WaveformPlayer({ url, onTimeUpdate, onPlay, onPause, onReady: onReadyProp, onError: onErrorProp }, ref) {
  const [wavesurfer, setWavesurfer] = useState<import("wavesurfer.js").default | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const prevUrl = useRef(url);
  const src = proxied(url);

  useEffect(() => {
    if (prevUrl.current !== url) {
      setIsReady(false); setHasError(false); setIsPlaying(false); setCurrentTime(0); setDuration(0); setWavesurfer(null);
      prevUrl.current = url;
    }
  }, [url]);

  useImperativeHandle(ref, () => ({
    seek: (time) => {
      if (wavesurfer && isReady) {
        try { const dur = wavesurfer.getDuration(); if (isFinite(time) && isFinite(dur) && dur > 0) wavesurfer.setTime(Math.max(0, Math.min(time, dur))); } catch { /* noop */ }
      }
    },
    play: () => { if (wavesurfer && isReady) { try { void wavesurfer.play(); } catch { /* noop */ } } },
    pause: () => { if (wavesurfer && isReady) { try { wavesurfer.pause(); } catch { /* noop */ } } },
  }), [wavesurfer, isReady]);

  const onReady = useCallback((ws: import("wavesurfer.js").default) => {
    setWavesurfer(ws); setIsReady(true); setHasError(false); setIsPlaying(false);
    try { const dur = ws.getDuration(); if (isFinite(dur) && dur > 0) setDuration(dur); } catch { /* noop */ }
    onReadyProp?.();
  }, [onReadyProp]);
  const onErr = useCallback(() => { setHasError(true); setIsReady(false); onErrorProp?.(); }, [onErrorProp]);
  const onTime = useCallback((_ws: unknown, time: number) => { setCurrentTime(time); onTimeUpdate?.(time); }, [onTimeUpdate]);
  const playPause = useCallback(() => { if (wavesurfer && isReady) { try { void wavesurfer.playPause(); } catch { /* noop */ } } }, [wavesurfer, isReady]);
  const restart = useCallback(() => { if (wavesurfer && isReady) { try { if (wavesurfer.getDuration() > 0) wavesurfer.setTime(0); } catch { /* noop */ } } }, [wavesurfer, isReady]);

  const valid = !!src && (src.startsWith("/") || src.startsWith("http"));
  if (!valid) {
    return <div className="flex h-20 items-center justify-center rounded-lg border border-[#eee] bg-[#fafafa] p-3"><span className="text-[13px] text-[#94a3b8]">No recording available</span></div>;
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[#eee] bg-[#fafafa] p-3" onClick={(e) => e.stopPropagation()}>
      {isReady && (
        <button onClick={playPause} className="flex size-10 shrink-0 items-center justify-center rounded-full text-white transition-all" style={{ background: "#4600f2" }} title={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? <Ico d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <Ico d="M6 4l14 8-14 8z" />}
        </button>
      )}
      {isReady && (
        <div className="shrink-0 text-[13px] tabular-nums text-[#626f81]">
          <span>{fmt(currentTime)}</span><span className="mx-1 text-[#94a3b8]">/</span><span>{fmt(duration)}</span>
        </div>
      )}
      <div className="relative min-w-0 flex-1">
        {!hasError && (
          <WavesurferPlayer
            key={src} url={src}
            waveColor="#e5e5e5" progressColor="#4600F2" cursorColor="transparent"
            height={45} barHeight={2} barWidth={2} barGap={1.5} barRadius={5}
            onReady={onReady}
            onPlay={() => { setIsPlaying(true); onPlay?.(); }}
            onPause={() => { setIsPlaying(false); onPause?.(); }}
            onTimeupdate={onTime}
            onError={onErr}
          />
        )}
        {!isReady && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-[#fafafa]">
            <span className="size-4 animate-spin rounded-full border-2 border-[#e5e7eb] border-t-[#4600f2]" /><span className="text-[11px] text-[#626f81]">Loading audio…</span>
          </div>
        )}
        {hasError && (
          <div className="flex h-[45px] items-center justify-center gap-2 bg-[#fafafa]"><span className="text-[13px] text-[#94a3b8]">Audio not present</span></div>
        )}
      </div>
      {isReady && (
        <button onClick={restart} className="flex size-8 shrink-0 items-center justify-center rounded-md text-[#626f81] hover:bg-[#eee]" title="Restart">
          <Ico d="M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" size={15} />
        </button>
      )}
    </div>
  );
});

export default WaveformPlayer;
