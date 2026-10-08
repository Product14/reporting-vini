"use client";

/* The appointment drill-down for the Service cards on Reports > Agent performance (next): the same rows as
 * kit.tsx's MeetingsModal, split into one section per status (Scheduled, Completed, No-show, Cancelled,
 * then anything else), each with its count. Asked for 2026-10-08 so cancelled bookings are not mixed in
 * with live ones. The total stays the card's Booked number: the source pages count cancelled bookings
 * too, so they are shown, just apart.
 *
 * A new component rather than a change to MeetingsModal, which the original page still uses. It reuses
 * the shared Portal, MeetingsList and EmptyState unchanged. */

import { useEffect } from "react";
import { EmptyState, MeetingsList, Portal } from "@/components/reports/kit";
import type { Meeting } from "@/components/reports/data";
import { isCancelledMeeting } from "@/lib/reports/appointmentStatus";

type SectionKey = "scheduled" | "completed" | "noshow" | "cancelled" | "other";

const SECTIONS: { key: SectionKey; label: string; dot: string }[] = [
  { key: "scheduled", label: "Scheduled", dot: "#6366f1" },
  { key: "completed", label: "Completed", dot: "#10b981" },
  { key: "noshow", label: "No-show", dot: "#f59e0b" },
  { key: "cancelled", label: "Cancelled", dot: "#dc2626" },
  { key: "other", label: "Other status", dot: "#9ca3af" },
];

/** Which section a meeting status belongs to. Cancelled uses the app's one rule (appointmentStatus.ts). */
export function statusSection(status: string | null | undefined): SectionKey {
  if (isCancelledMeeting(status)) return "cancelled";
  const s = (status || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (s === "scheduled" || s === "confirmed" || s === "rescheduled" || s === "booked") return "scheduled";
  if (s === "completed" || s === "show" || s === "showed") return "completed";
  if (s === "noshow") return "noshow";
  return "other";
}

export function AppointmentsByStatusModal({
  open,
  onClose,
  title,
  sub,
  items,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  /** The rows behind the card's Booked number; their count is that number. */
  items: Meeting[];
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;

  const groups = SECTIONS
    .map((sec) => ({ ...sec, rows: items.filter((m) => statusSection(m.status) === sec.key) }))
    .filter((g) => g.rows.length > 0);

  return (
    <Portal>
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
        <div className="relative flex max-h-[80vh] w-full max-w-[520px] flex-col overflow-hidden rounded-3xl border border-[#ece6fb] bg-white shadow-[0_24px_70px_rgba(16,24,40,0.3)]">
          <div className="flex items-start justify-between gap-3 border-b border-[#f0f0f0] px-6 py-4">
            <div className="min-w-0">
              <p className="text-[15px] font-extrabold tracking-[-0.01em] text-[#111]">{title}</p>
              {sub && <p className="mt-0.5 text-[11.5px] text-[#6b7280]">{sub}</p>}
              {groups.length > 1 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {groups.map((g) => (
                    // A button, not a #link: jumping to the section must not change the page URL.
                    <button
                      key={g.key}
                      type="button"
                      onClick={() => document.getElementById(`appt-${g.key}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[#f6f6f8] px-2.5 py-0.5 text-[11px] font-semibold text-[#374151] hover:bg-[#efeff3]"
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: g.dot }} />
                      {g.label} <span className="tabular-nums text-[#6b7280]">{g.rows.length}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-[18px] leading-none text-[#9ca3af] transition-colors hover:bg-[#f3f4f6] hover:text-[#111]"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {groups.length ? (
              groups.map((g) => (
                <section key={g.key} id={`appt-${g.key}`} aria-label={`${g.label} appointments`}>
                  <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-[#f0f0f0] bg-[#fafafb] px-6 py-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: g.dot }} />
                    <p className="text-[11px] font-bold uppercase tracking-wider text-[#374151]">{g.label}</p>
                    <p className="text-[11px] font-semibold tabular-nums text-[#9ca3af]">{g.rows.length}</p>
                  </div>
                  <MeetingsList meetings={g.rows} />
                </section>
              ))
            ) : (
              <div className="p-6">
                <EmptyState icon="📅" title="No appointments to show" body="No booked appointments fall in this period for this agent." />
              </div>
            )}
          </div>
          {items.length > 0 && (
            <div className="border-t border-[#f0f0f0] px-6 py-2.5 text-[11px] text-[#9ca3af]">
              {`${items.length} appointment${items.length === 1 ? "" : "s"}`}
              {groups.length > 1 && ` · ${groups.map((g) => `${g.rows.length} ${g.label.toLowerCase()}`).join(" · ")}`}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}
