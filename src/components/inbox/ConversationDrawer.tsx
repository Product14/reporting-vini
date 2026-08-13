"use client";

/**
 * ConversationDrawer — expanded right-side "Listen / Transcript" modal, matching the action-items-console
 * CallConversationDrawer look (icon-box header, waveform, transcript turn-cards with role avatars +
 * click-to-seek + active-turn highlight while playing). Two variants:
 *   • call     → waveform (Listen) + timestamped transcript, click a turn to jump the audio
 *   • sms/chat → the message conversation (same turn-card styling, absolute times in the dealer tz)
 */
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WaveformPlayer, { type WaveformHandle } from "./WaveformPlayer";
import {
  fetchInboxTranscript,
  fetchInboxCall,
  parseSmsText,
  type InboxAuth,
  type TranscriptTurn,
  type TeamTranscriptTurn,
  type SmsMessage,
} from "./api";

export type DrawerTarget =
  | { kind: "call"; title: string; sub?: string; conversationId: string; callId?: string | null; recordingUrl?: string | null; inlineTranscript?: (TranscriptTurn | TeamTranscriptTurn)[] }
  | { kind: "sms" | "chat"; title: string; sub?: string; conversationId: string; messages: SmsMessage[] };

interface Turn { role: "ai" | "customer"; text: string; atSec: number | null; atMs: number | null }

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtClock(sec: number | null): string {
  if (sec == null || isNaN(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtStamp(ms: number | null, tz?: string): string {
  if (!ms) return "";
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
        .formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
    );
    return `${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
  } catch { return ""; }
}
void MON;

const SPOKEN_ROLES = new Set(["bot", "assistant", "agent", "user", "customer"]);
function spokenTurns(raw: (TranscriptTurn | TeamTranscriptTurn)[]): Turn[] {
  const out: Turn[] = [];
  for (const t of raw) {
    const role = (t.role || "").toLowerCase();
    if (!SPOKEN_ROLES.has(role)) continue; // skip system / tool
    const text = ((t as TranscriptTurn).content ?? t.message ?? "").toString().trim();
    if (!text || text.startsWith("{")) continue;
    const atSec = typeof (t as TranscriptTurn).secondsFromStart === "number" ? (t as TranscriptTurn).secondsFromStart! : null;
    out.push({ role: role === "user" || role === "customer" ? "customer" : "ai", text, atSec, atMs: null });
  }
  return out;
}
function smsTurns(messages: SmsMessage[]): Turn[] {
  return [...messages]
    .reverse() // team endpoint returns newest-first
    .map((m) => {
      const p = parseSmsText(m.content ?? "");
      return { role: (m.role || "").toLowerCase() === "user" ? "customer" : "ai", text: (p.text || p.summary || "").trim(), atSec: null, atMs: typeof m._ts === "number" ? m._ts : null } as Turn;
    })
    .filter((t) => t.text);
}

/* ── icons (inline; match the reference's gray/purple/green palette) ─────────── */
const Svg = (p: { d: string; size?: number; stroke?: boolean; className?: string }) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill={p.stroke ? "none" : "currentColor"} stroke={p.stroke ? "currentColor" : "none"} strokeWidth={p.stroke ? 2 : 0} strokeLinecap="round" strokeLinejoin="round" className={p.className} aria-hidden>
    <path d={p.d} />
  </svg>
);
const D_PHONE = "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2Z";
const D_CHAT = "M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z";
const D_CLOSE = "M18 6 6 18M6 6l12 12";
const D_CLOCK = "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z";
const D_FILE = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6";

export function ConversationDrawer({ auth, target, tz, onClose }: { auth: InboxAuth; target: DrawerTarget; tz?: string; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[] | null>(target.kind === "call" ? null : smsTurns(target.messages));
  const [recordingUrl, setRecordingUrl] = useState<string | null | undefined>(target.kind === "call" ? target.recordingUrl : null);
  const [audioTime, setAudioTime] = useState(0);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const waveRef = useRef<WaveformHandle>(null);
  const turnRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const isCall = target.kind === "call";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (target.kind !== "call") return;
    let on = true;
    if (target.inlineTranscript && target.inlineTranscript.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed from inline data
      setTurns(spokenTurns(target.inlineTranscript));
    } else {
      fetchInboxTranscript(auth, target.callId || target.conversationId).then((t) => { if (on) setTurns(spokenTurns(t)); });
    }
    if (!target.recordingUrl && target.callId) {
      fetchInboxCall(auth, target.callId).then((d) => { if (on && d?.recordingUrl) setRecordingUrl(d.recordingUrl); });
    }
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.conversationId]);

  // Which transcript turn is "live" as the audio plays → highlight + auto-scroll (call only).
  const activeIndex = useMemo(() => {
    if (!isCall || !audioPlaying || !turns) return -1;
    let idx = -1;
    for (let i = 0; i < turns.length; i++) { if ((turns[i].atSec ?? Infinity) <= audioTime) idx = i; else break; }
    return idx;
  }, [isCall, audioPlaying, turns, audioTime]);
  useEffect(() => {
    if (activeIndex >= 0) turnRefs.current.get(activeIndex)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex]);
  // Always open at the TOP of the transcript/conversation (start), not scrolled to the end.
  useEffect(() => {
    if (turns) scrollRef.current?.scrollTo({ top: 0 });
  }, [turns]);

  const seek = useCallback((sec: number | null) => { if (sec != null) { waveRef.current?.seek(sec); waveRef.current?.play(); } }, []);
  const list = turns ?? [];

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div onClick={onClose} className="fixed inset-0 z-[199]" style={{ background: "rgba(15,23,42,0.45)" }} />
      <div className="fixed right-0 top-0 z-[200] flex h-screen w-[500px] max-w-[96vw] flex-col bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label={isCall ? "Call detail" : "Conversation detail"}>
        {/* Header */}
        <div className="flex-none border-b border-gray-100 bg-white px-6 pb-5 pt-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500">
              <Svg d={isCall ? D_PHONE : D_CHAT} size={20} stroke />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="mb-1.5 break-words text-xl font-semibold text-gray-900">{target.title}</h1>
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Svg d={D_CLOCK} size={15} stroke /> <span>{target.sub || (isCall ? "Call" : target.kind === "chat" ? "Chat" : "SMS")}</span>
              </div>
            </div>
            <button onClick={onClose} className="flex-shrink-0 rounded-lg p-2 text-gray-400 transition-all hover:bg-gray-100 hover:text-gray-600" title="Close (Esc)"><Svg d={D_CLOSE} size={18} stroke /></button>
          </div>
        </div>

        {/* Waveform (call only) */}
        {isCall && (
          <div className="flex-none border-b border-gray-100 bg-white px-6 py-4">
            <WaveformPlayer ref={waveRef} url={recordingUrl || ""} onTimeUpdate={setAudioTime} onPlay={() => setAudioPlaying(true)} onPause={() => setAudioPlaying(false)} />
          </div>
        )}

        {/* Transcript / conversation */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto bg-gray-50/50 px-6 py-6">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-gray-900">
            <Svg d={isCall ? D_FILE : D_CHAT} size={16} stroke className="text-gray-400" /> {isCall ? "Transcript" : "Conversation"}
          </h3>
          {turns === null ? (
            <p className="py-8 text-center text-sm text-gray-500">Loading…</p>
          ) : list.length === 0 ? (
            <div className="py-8 text-center">
              <Svg d={D_FILE} size={40} stroke className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm text-gray-500">No {isCall ? "transcript" : "conversation"} available</p>
            </div>
          ) : (
            <div className="space-y-4">
              {list.map((m, i) => {
                const active = i === activeIndex;
                const clickable = isCall && m.atSec != null;
                const badge = m.role === "ai" ? { label: "AI", cls: "bg-purple-200 text-purple-700" } : { label: "CU", cls: "bg-green-200 text-green-700" };
                return (
                  <div key={i} ref={(el) => { turnRefs.current.set(i, el); }}>
                    <div
                      onClick={() => clickable && seek(m.atSec)}
                      title={clickable ? "Click to jump to this point in audio" : undefined}
                      className={`overflow-hidden rounded-xl border p-4 transition-all ${clickable ? "cursor-pointer" : ""} ${active ? "border-[#4600f2] bg-[#4600f2]/10 shadow-md ring-2 ring-[#4600f2]/30" : "border-gray-200 bg-gray-50 " + (clickable ? "hover:border-[#4600f2] hover:bg-[#4600f2]/5" : "")}`}
                    >
                      <div className="flex gap-3">
                        <div className={`flex size-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ${active ? "bg-[#4600f2] text-white" : badge.cls}`}>{badge.label}</div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-2 flex items-baseline gap-3">
                            <span className={`font-semibold ${active ? "text-[#4600f2]" : "text-gray-900"}`}>{m.role === "ai" ? "Agent" : "Customer"}</span>
                            {m.atSec != null ? (
                              <span className={`text-xs hover:underline ${active ? "font-medium text-[#4600f2]" : "text-[#4600f2]"}`}>{fmtClock(m.atSec)}</span>
                            ) : m.atMs ? (
                              <span className="text-xs text-gray-500">{fmtStamp(m.atMs, tz)}</span>
                            ) : null}
                          </div>
                          <div className={`text-[13px] leading-relaxed ${active ? "text-gray-800" : "text-gray-700"}`}>{m.text}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
