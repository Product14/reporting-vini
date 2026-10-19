"use client";

/* COPY of components/reports/agentsNext/AppointmentsByStatusModal.tsx for the Service OM Reports page, so the
 * old page stays exactly as it is. What changed:
 *   - each row carries a pill saying who booked it: Booked by Spyne (Vini booked it) or Assisted by Spyne
 *     (the store booked it after Vini handed the customer over), from the API row's `tag`;
 *   - the footer adds that split;
 *   - "Other status" reads "Status not available": past appointments the store never updated (Om's S1 term),
 *     which is what fills that group on live rooftops;
 *   - "Completed" reads "Showed": rows follow Om's statusNow, where a matching repair order is a visit.
 * The rows themselves are the ones the clicked number counted (rule 8). */

import React, { useEffect } from "react";
import { EmptyState, Portal } from "@/components/reports/kit";
import type { Meeting } from "@/components/reports/data";
import { statusSection } from "@/components/reports/agentsNext/AppointmentsByStatusModal";
import { parseReportTs } from "@/lib/reports/storeTime";

type SectionKey = ReturnType<typeof statusSection>;

const SECTIONS: { key: SectionKey; label: string; dot: string }[] = [
  { key: "scheduled", label: "Scheduled", dot: "#6366f1" },
  { key: "completed", label: "Showed", dot: "#10b981" },
  { key: "noshow", label: "No-show", dot: "#f59e0b" },
  { key: "cancelled", label: "Cancelled", dot: "#dc2626" },
  { key: "other", label: "Status not available", dot: "#9ca3af" },
];

/** Who booked the appointment, from the row (toMeetings sets `assisted` and `source` from the API's tag). */
export function bookedBy(m: Meeting): "spyne" | "assisted" | null {
  if (m.assisted) return "assisted";
  return m.source === "spyne" ? "spyne" : null;
}

const PILL: Record<"spyne" | "assisted", { label: string; style: React.CSSProperties }> = {
  spyne: { label: "Booked by Spyne", style: { background: "#e8ffee", color: "#0a6029" } },
  assisted: { label: "Assisted by Spyne", style: { background: "#f3eaff", color: "#6d28d9" } },
};

/* Row helpers copied from kit.tsx (private there): no zone means UTC, never the viewer's. */
function formatMeetingWhen(iso: string, tz?: string | null): string {
  if (!iso) return "—";
  const d = parseReportTs(iso);
  if (!d) return iso;
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz || "UTC" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(d);
  }
}
function meetingStatusColor(s: string): string {
  const v = (s || "").toLowerCase();
  if (v.includes("cancel") || v.includes("no-show") || v.includes("no_show") || v.includes("no show")) return "#dc2626";
  if (v.includes("complete") || v.includes("confirm") || v.includes("show")) return "#10b981";
  if (v.includes("not available")) return "#9ca3af";
  return "#6366f1"; // scheduled / default
}

/** kit.tsx's MeetingsList, plus the Booked by / Assisted by pill beside the customer. */
function OmMeetingsList({ meetings }: { meetings: Meeting[] }) {
  return (
    <div className="divide-y divide-[#f3f4f6]">
      {meetings.map((m, i) => {
        const by = bookedBy(m);
        return (
          <div key={m.id || i} className="flex items-center justify-between gap-3 px-6 py-3">
            <div className="min-w-0">
              <p className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-semibold text-[#111]">{m.customer || "—"}</span>
                {by && <span className="flex-none rounded-full px-2 py-0.5 text-[10px] font-semibold" style={PILL[by].style}>{PILL[by].label}</span>}
              </p>
              <p className="truncate text-[11px] text-[#6b7280]">
                {m.vehicle || "Vehicle TBD"}
                {m.phone && <span className="text-[#9ca3af]"> · {m.phone}</span>}
              </p>
            </div>
            <div className="flex-none text-right">
              <p className="text-[12px] font-medium text-[#111]">{formatMeetingWhen(m.when, m.tz)}</p>
              <span className="inline-flex items-center gap-1.5">
                {m.serviceType && <span className="text-[9px] font-semibold uppercase tracking-wide text-[#9ca3af]">{m.serviceType}</span>}
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: meetingStatusColor(m.status) }}>{m.status || "—"}</span>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OmAppointmentsModal({
  open,
  onClose,
  title,
  sub,
  items,
  statusNow = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  /** The rows behind the clicked number; their count is that number. */
  items: Meeting[];
  /** The rollback switch (statusNowSwitch.ts): off, the group reads "Completed" again, as before. */
  statusNow?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;

  const groups = SECTIONS
    .map((sec) => ({ ...sec, label: sec.key === "completed" && !statusNow ? "Completed" : sec.label, rows: items.filter((m) => statusSection(m.status) === sec.key) }))
    .filter((g) => g.rows.length > 0);
  const bySpyne = items.filter((m) => bookedBy(m) === "spyne").length;
  const assisted = items.filter((m) => bookedBy(m) === "assisted").length;

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
                  <OmMeetingsList meetings={g.rows} />
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
              {bySpyne > 0 && assisted > 0 && ` · ${bySpyne} booked by Spyne · ${assisted} Spyne-assisted`}
              {groups.length > 1 && ` · ${groups.map((g) => `${g.rows.length} ${g.label.toLowerCase()}`).join(" · ")}`}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}
