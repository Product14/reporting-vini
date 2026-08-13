"use client";

/**
 * ConversationDrawer — the expanded, right-side "Listen / Transcript" sidebar (ported in spirit from
 * action-items-console's CallConversationDrawer). Two variants:
 *   • call      → waveform player (Listen) + timestamped transcript with click-to-seek
 *   • sms/chat  → the message conversation
 * Data comes from what the caller already has (inline transcript/smsMessages) or is fetched by callId.
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

interface Turn { role: "ai" | "customer"; text: string; atSec: number | null }

function fmtSec(s: number | null): string {
  if (s == null || !isFinite(s) || s < 0) return "";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// Normalize a raw call-transcript turn (either shape) → spoken lines only. Only bot/assistant/agent/user
// turns are real speech; drop the `system` prompt turn and `tool` (JSON) turns entirely.
const SPOKEN_ROLES = new Set(["bot", "assistant", "agent", "user", "customer"]);
function spokenTurns(raw: (TranscriptTurn | TeamTranscriptTurn)[]): Turn[] {
  const out: Turn[] = [];
  for (const t of raw) {
    const role = (t.role || "").toLowerCase();
    if (!SPOKEN_ROLES.has(role)) continue; // skip system / tool
    const text = ((t as TranscriptTurn).content ?? t.message ?? "").toString().trim();
    if (!text || text.startsWith("{")) continue;
    const atSec = typeof (t as TranscriptTurn).secondsFromStart === "number" ? (t as TranscriptTurn).secondsFromStart! : null;
    out.push({ role: role === "user" || role === "customer" ? "customer" : "ai", text, atSec });
  }
  return out;
}

function smsTurns(messages: SmsMessage[]): Turn[] {
  // team endpoint returns smsMessages newest-first → oldest-first for reading
  return [...messages]
    .reverse()
    .map((m) => {
      const p = parseSmsText(m.content ?? "");
      const text = (p.text || p.summary || "").trim();
      return { role: (m.role || "").toLowerCase() === "user" ? "customer" : "ai", text, atSec: null } as Turn;
    })
    .filter((t) => t.text);
}

const IconClose = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>);

export function ConversationDrawer({ auth, target, onClose }: { auth: InboxAuth; target: DrawerTarget; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[] | null>(target.kind === "call" ? null : smsTurns(target.messages));
  const [recordingUrl, setRecordingUrl] = useState<string | null | undefined>(target.kind === "call" ? target.recordingUrl : null);
  const waveRef = useRef<WaveformHandle>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Resolve the call's transcript + recording (from inline data, else by callId).
  useEffect(() => {
    if (target.kind !== "call") return;
    let on = true;
    if (target.inlineTranscript && target.inlineTranscript.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed from inline data
      setTurns(spokenTurns(target.inlineTranscript));
    } else {
      const id = target.callId || target.conversationId;
      fetchInboxTranscript(auth, id).then((t) => { if (on) setTurns(spokenTurns(t)); });
    }
    if (!target.recordingUrl && target.callId) {
      fetchInboxCall(auth, target.callId).then((d) => { if (on && d?.recordingUrl) setRecordingUrl(d.recordingUrl); });
    }
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.conversationId]);

  const seek = useCallback((sec: number | null) => { if (sec != null) { waveRef.current?.seek(sec); waveRef.current?.play(); } }, []);
  const isCall = target.kind === "call";
  const list = useMemo(() => turns ?? [], [turns]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div onClick={onClose} className="fixed inset-0 z-[199]" style={{ background: "rgba(15,23,42,0.45)" }} />
      <div className="fixed right-0 top-0 z-[200] flex h-screen w-[500px] max-w-[96vw] flex-col bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label={isCall ? "Call detail" : "Conversation detail"}>
        {/* header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "#eee" }}>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold" style={{ color: "#0f172a" }}>{target.title}</p>
            {target.sub && <p className="mt-0.5 truncate text-[12px]" style={{ color: "#626f81" }}>{target.sub}</p>}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg p-2 text-[#94a3b8] transition-colors hover:bg-[#f2f2f4] hover:text-[#626f81]" title="Close (Esc)"><IconClose /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {isCall && (
            <div className="mb-4">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "#626f81" }}>Listen</p>
              <WaveformPlayer ref={waveRef} url={recordingUrl || ""} />
            </div>
          )}
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "#626f81" }}>{isCall ? "Transcript" : "Conversation"}</p>
          {turns === null ? (
            <p className="py-8 text-center text-[13px]" style={{ color: "#94a3b8" }}>Loading…</p>
          ) : list.length === 0 ? (
            <p className="py-8 text-center text-[13px]" style={{ color: "#94a3b8" }}>No {isCall ? "transcript" : "conversation"} available.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {list.map((t, i) => (
                <div key={i} className={`flex flex-col ${t.role === "customer" ? "items-start" : "items-end"}`}>
                  <div className="flex max-w-[85%] flex-col gap-1">
                    <div className="flex items-center gap-2 text-[11px]" style={{ color: "#94a3b8" }}>
                      <span className="font-semibold" style={{ color: t.role === "customer" ? "#0f172a" : "#4600f2" }}>{t.role === "customer" ? "Customer" : "AI"}</span>
                      {isCall && t.atSec != null && (
                        <button onClick={() => seek(t.atSec)} className="tabular-nums hover:underline" style={{ color: "#4600f2" }} title="Jump to this point">{fmtSec(t.atSec)}</button>
                      )}
                    </div>
                    <div
                      className="rounded-[12px] px-3.5 py-2.5 text-[13px] leading-relaxed"
                      style={t.role === "customer" ? { background: "#f1f5f9", color: "#0f172a" } : { background: "#efe9ff", color: "#0f172a" }}
                    >
                      {t.text}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
