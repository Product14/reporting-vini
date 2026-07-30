"use client";

/* Inbox tab — a two-pane conversation console (left: customer list; right: per-customer thread).
 * Built to the Conversational-AI-2.0 "Inbox" Figma; wired to the Spyne V2 APIs via /api/inbox/*.
 *
 * DATA SOURCES (per the dev API doc):
 *   • Left list  → Leads V2 (identity, per-channel unread counts, last-interaction time).
 *   • Right pane → Conversations V2 for the selected customer: call/sms records + the lead-journey
 *                  timeline + upcoming appointments/action-items. Call bodies come from the transcript
 *                  API (rendered as bubbles); SMS message bodies are not exposed by V2 yet, so an SMS
 *                  record renders as a summary card (see the note in the thread).
 *   • Details    → Persona profile (memory, vehicle interest, budget, trade-in, intent).
 *
 * Scope (team/enterprise/token/env) comes from the host iframe URL via useScenario(). */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScenario } from "@/components/reports/scenario";
import {
  fetchInboxCustomers,
  fetchInboxConversations,
  fetchInboxTimezone,
  fetchInboxPersona,
  fetchInboxFeedback,
  postInboxFeedback,
  stopInboxEngagement,
  fetchInboxTranscript,
  fetchInboxCall,
  resolveInboxActionItem,
  parseSmsText,
  parseCallTranscript,
  type TranscriptTurn,
  type CallAnalysis,
  type InboxAuth,
  type InboxCustomer,
  type LeadsPage,
  type ConversationsV2,
  type ConvRecord,
  type LeadJourneyEvent,
  type AppointmentItem,
  type ActionItem,
  type Persona,
} from "./api";

/* ── tokens ─────────────────────────────────────────────────────────────────── */
const C = {
  primary: "#4600f2",
  primaryAccent: "#efe9ff",
  border: "#e5e7eb",
  sub: "#626f81",
  dark: "#030712",
  bg: "#fafafa",
  blueAccent: "#e9f4ff",
  green: "#23ab70",
  orange: "#e47200",
  orangeAccent: "#fff0dd",
  red: "#ca1f34",
};

const AVATAR_COLORS = ["#006ca7", "#5a22cb", "#a70096", "#38a700", "#d52c2f", "#00aed5", "#f8712e", "#207fb2", "#4600f2", "#0a6029"];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ── time helpers ───────────────────────────────────────────────────────────── */
function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/* Dealer-local timezone — resolved once per team from the working-hours API (fetchInboxTimezone),
 * the SAME source the reports/overview use. Every stamp, day label, due-date and the "Today" date
 * filter below render in THIS zone so they line up with the dealer, their CRM and Mongo — not the
 * viewer's browser tz. Kept as module state (the page shows one team at a time) so the many
 * top-level formatters don't each need the tz threaded through. Undefined ⇒ fall back to local tz. */
let ACTIVE_TZ: string | undefined;
export function setInboxTz(tz: string | null | undefined) { ACTIVE_TZ = tz || undefined; }
// YYYY-MM-DD calendar day of `d` in the active tz (en-CA renders as YYYY-MM-DD). Local tz on failure.
function dayKeyTz(d: Date): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: ACTIVE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
  catch { return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
}
const withTz = <T extends Intl.DateTimeFormatOptions>(o: T): T => (ACTIVE_TZ ? { ...o, timeZone: ACTIVE_TZ } : o);
function timeTz(d: Date): string { return d.toLocaleTimeString([], withTz({ hour: "numeric", minute: "2-digit" })); }
// Short label for an IANA tz (e.g. "America/Los_Angeles" → "PDT"), for the header hint. "" if unknown.
function tzShort(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { return ""; }
}
// Whole dealer-local calendar days between two instants (target − ref), by comparing their day keys.
function daysBetweenTzDays(target: Date, ref: Date): number {
  const ms = (k: string) => Date.parse(`${k}T00:00:00Z`);
  return Math.round((ms(dayKeyTz(target)) - ms(dayKeyTz(ref))) / 86400000);
}
// UTC instant at the start of the dealer-tz calendar day that contains `ref` (local midnight otherwise).
function startOfTzDay(ref: Date): Date {
  if (!ACTIVE_TZ) { const s = new Date(ref); s.setHours(0, 0, 0, 0); return s; }
  const guess = new Date(`${dayKeyTz(ref)}T00:00:00Z`);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: ACTIVE_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(guess).map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guess.getTime() - (asUTC - guess.getTime())); // subtract the tz offset at that instant
}

function fmtTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? timeTz(d) : "";
}
function fmtListStamp(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "";
  const today = dayKeyTz(new Date());
  const dk = dayKeyTz(d);
  if (dk === today) return timeTz(d);
  if (dk === dayKeyTz(new Date(Date.now() - 86400000))) return "Yesterday";
  return d.toLocaleDateString([], withTz({ month: "short", day: "numeric" }));
}
function dayLabel(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "";
  const dk = dayKeyTz(d);
  if (dk === dayKeyTz(new Date())) return "TODAY";
  if (dk === dayKeyTz(new Date(Date.now() - 86400000))) return "YESTERDAY";
  return d.toLocaleDateString([], withTz({ weekday: "short", month: "short", day: "numeric" })).toUpperCase();
}

/* ── inline icons (repo uses inline SVG, not an icon lib) ───────────────────── */
type IconProps = { size?: number; className?: string; style?: React.CSSProperties };
const Svg = ({ size = 16, children, className, style }: IconProps & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    {children}
  </svg>
);
const IconSearch = (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Svg>;
const IconDownload = (p: IconProps) => <Svg {...p}><path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M5 21h14" /></Svg>;
const IconFilter = (p: IconProps) => <Svg {...p}><path d="M3 5h18" /><path d="M6 12h12" /><path d="M10 19h4" /></Svg>;
const IconInfo = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></Svg>;
const IconChevron = (p: IconProps) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
const IconList = (p: IconProps) =><Svg {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></Svg>;
const IconCalendar = (p: IconProps) => <Svg {...p}><rect x="3" y="4.5" width="18" height="17" rx="2" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></Svg>;
const IconBolt = (p: IconProps) => <Svg {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></Svg>;
const IconCallIn = (p: IconProps) => <Svg {...p}><path d="M17 7 7 17" /><path d="M16 17H7V8" /></Svg>;
const IconCallOut = (p: IconProps) => <Svg {...p}><path d="M7 17 17 7" /><path d="M8 7h9v9" /></Svg>;
const IconPlay = (p: IconProps) => <Svg {...p}><path d="M6 4l14 8-14 8z" /></Svg>;
const IconFlag = (p: IconProps) => <Svg {...p}><path d="M4 21V4M4 4h13l-2 5 2 5H4" /></Svg>;
const IconThumbUp = (p: IconProps) => <Svg {...p}><path d="M7 10v11H3V10zM7 10l5-7a2 2 0 0 1 2 2v3h5a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 16.7 21H7" /></Svg>;
const IconThumbDown = (p: IconProps) => <Svg {...p}><path d="M17 14V3h4v11zM17 14l-5 7a2 2 0 0 1-2-2v-3H5a2 2 0 0 1-2-2.3l1.3-7A2 2 0 0 1 7.3 3H17" /></Svg>;
const IconPhone = (p: IconProps) => <Svg {...p}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2Z" /></Svg>;
const IconCheck = (p: IconProps) => <Svg {...p}><path d="m20 6-11 11-5-5" /></Svg>;

/* ══════════════════════════════════════════════════════════════════════════════
 * Root
 * ════════════════════════════════════════════════════════════════════════════ */
export default function InboxView() {
  return (
    <Suspense fallback={null}>
      <Inbox />
    </Suspense>
  );
}

type Tab = "all" | "unread";

function Inbox() {
  const { teamId, enterpriseId, spyneToken, spyneEnv, account } = useScenario();
  const auth: InboxAuth = useMemo(
    () => ({ teamId, enterpriseId, spyneToken, spyneEnv }),
    [teamId, enterpriseId, spyneToken, spyneEnv],
  );

  // Optional deep-link: ?c=<customer_id> opens straight into that conversation (the console can link
  // a customer directly into the Inbox). Read once on mount.
  const initialCustomerId = useMemo(() => {
    if (typeof window === "undefined") return "";
    const sp = new URLSearchParams(window.location.search);
    return (sp.get("c") || sp.get("customer_id") || "").trim();
  }, []);

  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [leadType, setLeadType] = useState<string[]>([]);
  const [leadSource, setLeadSource] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [department, setDepartment] = useState<"" | "sales" | "service">("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = leadType.length + leadSource.length + (dateRange !== "all" ? 1 : 0) + (department ? 1 : 0);

  const [tz, setTz] = useState<string | null>(null);
  const [page, setPage] = useState<LeadsPage | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  // Resolve the rooftop timezone once per team (same working-hours source the reports use) and publish
  // it to the module-level formatters so every stamp / due-date / "Today" filter renders dealer-local.
  useEffect(() => {
    if (!teamId) { setInboxTz(null); return; }
    let on = true;
    fetchInboxTimezone(auth).then((z) => { if (on) { setInboxTz(z); setTz(z); } });
    return () => { on = false; };
  }, [auth, teamId]);
  const [selected, setSelected] = useState<InboxCustomer | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Per-row appointment + action-item indicators. leads/v2 doesn't include these, so we enrich each
  // visible row with a light conversations/v2 call (concurrency-limited + cached by customer_id). They
  // reflect real data, so they persist after a conversation is read (unlike the unread dot).
  const [rowMeta, setRowMeta] = useState<Record<string, { appt: number; actions: number }>>({});
  const rowMetaCache = useRef<Record<string, { appt: number; actions: number }>>({});

  // Debounce the search box → searchTerm query.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Load the customer list whenever scope / tab / search / filters change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when scope/filters change
    if (!teamId || !enterpriseId) { setPage(null); setLoadingList(false); return; }
    let on = true;
    setLoadingList(true);
    const range = dateRangeToIso(dateRange);
    fetchInboxCustomers(auth, {
      limit: 50,
      unreadOnly: tab === "unread",
      searchTerm: debounced || undefined,
      leadType: leadType.length ? leadType : undefined,
      leadSource: leadSource.length ? leadSource : undefined,
      department: department || undefined,
      startDate: range.startDate,
      endDate: range.endDate,
    }).then((p) => {
      if (!on) return;
      setPage(p);
      setLoadingList(false);
      // Auto-select: the deep-linked customer if any (synthesize a stub row if it's not on this page so
      // the thread still loads), else the first conversation. Only when nothing is selected yet.
      setSelected((cur) => {
        if (cur) return cur;
        if (initialCustomerId) {
          return p.customers.find((x) => x.customer_id === initialCustomerId)
            ?? { customer_id: initialCustomerId, customer_name: "", email_id: null, mobile_number: null, createdAt: "", lastInteractionTime: null };
        }
        return p.customers[0] ?? null;
      });
    });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, enterpriseId, spyneToken, spyneEnv, tab, debounced, leadType, leadSource, dateRange, department]);

  const customers = page?.customers ?? [];
  const totalAll = page?.pagination.totalCustomers ?? customers.length;
  const totalUnread = page?.pagination.unreadCount ?? 0;

  // Enrich visible rows with appointment + open-action-item counts (cached by customer_id).
  useEffect(() => {
    const ids = customers.map((c) => c.customer_id).filter((id) => id && !(id in rowMetaCache.current));
    if (!ids.length) { setRowMeta({ ...rowMetaCache.current }); return; }
    let cancelled = false;
    let i = 0;
    const worker = async () => {
      while (i < ids.length && !cancelled) {
        const id = ids[i++];
        const d = await fetchInboxConversations(auth, id, { limit: 1 });
        rowMetaCache.current[id] = {
          appt: d.nextAppointments.length,
          actions: d.nextActionItems.filter((a) => a.is_active && !a.is_completed).length,
        };
        if (!cancelled) setRowMeta({ ...rowMetaCache.current });
      }
    };
    // 6 concurrent fetches — enough to feel instant on a page without hammering the API.
    void Promise.all(Array.from({ length: 6 }, worker));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  if (!teamId || !enterpriseId) return <NoScope hasTeam={!!teamId} />;

  return (
    <div className="flex h-[100dvh] flex-col bg-white" style={{ color: C.dark }}>
      {/* Header bar */}
      <header className="flex shrink-0 items-center justify-between border-b bg-white px-8 py-3" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg text-white" style={{ background: C.primary }}>
            <IconList size={16} />
          </span>
          <h1 className="text-[16px] font-semibold" style={{ color: C.dark }}>Inbox</h1>
          {account?.name && <span className="ml-1 text-[12px]" style={{ color: C.sub }}>· {account.name}</span>}
          {tz && <span className="ml-1 text-[11px]" style={{ color: C.sub }} title={`Times shown in this rooftop's timezone (${tz})`}>· times in {tzShort(tz)}</span>}
        </div>
        <div className="relative flex items-center gap-3.5">
          <button
            onClick={() => exportCsv(customers)}
            className="flex items-center gap-2 rounded-[15px] border px-6 py-2 text-[12px] font-medium transition-colors hover:bg-[#f7f7f8]"
            style={{ borderColor: C.border, color: C.dark }}
          >
            <IconDownload size={13} /> CSV
          </button>
          <button
            onClick={() => setFiltersOpen((v) => !v)}
            className="flex items-center gap-2 rounded-[15px] border px-6 py-2 text-[12px] font-medium transition-colors hover:bg-[#f7f7f8]"
            style={{ borderColor: filtersOpen ? C.primary : C.border, color: filtersOpen ? C.primary : C.dark }}
          >
            <IconFilter size={13} /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
          </button>
          {filtersOpen && (
            <FiltersPopover
              leadType={leadType} onLeadType={setLeadType}
              leadSource={leadSource} onLeadSource={setLeadSource}
              dateRange={dateRange} onDateRange={setDateRange}
              department={department} onDepartment={setDepartment}
              onClose={() => setFiltersOpen(false)}
            />
          )}
        </div>
      </header>

      {/* Two panes */}
      <div className="flex min-h-0 flex-1">
        {/* LEFT — list */}
        <aside className="flex w-[360px] shrink-0 flex-col border-r bg-white" style={{ borderColor: C.border }}>
          <div className="flex h-[68px] shrink-0 items-center px-4">
            <div className="flex flex-1 items-center gap-2.5 rounded-[5px] border px-4 py-2.5" style={{ borderColor: C.border }}>
              <IconSearch size={14} className="text-[#626f81]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Conversation"
                className="w-full bg-transparent text-[12px] outline-none placeholder:text-[#626f81]"
                style={{ color: C.dark }}
              />
            </div>
          </div>
          <div className="flex shrink-0" style={{ borderColor: C.border }}>
            <TabBtn active={tab === "all"} onClick={() => setTab("all")} label={`All(${totalAll})`} />
            <TabBtn active={tab === "unread"} onClick={() => setTab("unread")} label={`Unread(${totalUnread})`} />
            <div className="flex-1 border-b" style={{ borderColor: C.border }} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loadingList ? (
              <ListSkeleton />
            ) : customers.length === 0 ? (
              <div className="px-5 py-10 text-center text-[12px]" style={{ color: C.sub }}>
                No conversations {tab === "unread" ? "unread" : "found"}.
              </div>
            ) : (
              customers.map((c) => (
                <ConversationRow
                  key={c.customer_id}
                  c={c}
                  meta={rowMeta[c.customer_id]}
                  active={selected?.customer_id === c.customer_id}
                  onClick={() => { setSelected(c); setDetailsOpen(false); }}
                />
              ))
            )}
          </div>
        </aside>

        {/* MIDDLE — chat (messages + calls only; milestones live in the right panel) */}
        <section className="flex min-w-0 flex-1 flex-col" style={{ background: C.bg }}>
          {selected ? (
            <ThreadPane
              key={selected.customer_id}
              auth={auth}
              customer={selected}
              onViewDetails={() => setDetailsOpen(true)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px]" style={{ color: C.sub }}>
              Select a conversation to view the thread.
            </div>
          )}
        </section>

        {/* RIGHT — lead status, engagement, journey timeline, appointments, action items (guide §7C-E) */}
        {selected && (
          <RightPanel key={`rp-${selected.customer_id}`} auth={auth} customer={selected} onExpand={() => setDetailsOpen(true)} />
        )}

        {/* Details drawer (full persona deep-dive) */}
        {selected && detailsOpen && (
          <DetailsDrawer auth={auth} customer={selected} onClose={() => setDetailsOpen(false)} />
        )}
      </div>
    </div>
  );
}

/* ── left-pane pieces ───────────────────────────────────────────────────────── */
function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex w-[120px] items-center justify-center border-b px-4 py-2.5 text-[12px] transition-colors"
      style={{
        borderColor: active ? C.primary : C.border,
        borderBottomWidth: active ? 2 : 1,
        color: active ? C.primary : C.sub,
        fontWeight: active ? 600 : 500,
      }}
    >
      {label}
    </button>
  );
}

function ConversationRow({ c, meta, active, onClick }: { c: InboxCustomer; meta?: { appt: number; actions: number }; active: boolean; onClick: () => void }) {
  const unread = c.unreadCounts?.totalUnread ?? 0;
  const callUnread = c.unreadCounts?.callUnread ?? 0;
  const name = c.customer_name || c.mobile_number || "Unknown";
  return (
    <button
      onClick={onClick}
      className="flex w-full flex-col gap-2.5 border-b px-5 py-2.5 text-left transition-colors hover:bg-[#fafafa]"
      style={{
        borderColor: C.border,
        background: active ? "#fafafa" : "#fff",
        borderLeft: active ? `4px solid ${C.primary}` : "4px solid transparent",
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium text-white" style={{ background: avatarColor(c.customer_id || name) }}>
              {initials(name)}
            </span>
            <span className="truncate text-[14px] font-semibold" style={{ color: C.dark }}>{name}</span>
          </div>
          {callUnread > 0 && <IconPhone size={12} className="shrink-0 text-[#626f81]" />}
          {/* appointment indicator (green calendar) + open action-item count (orange badge) */}
          {meta && meta.appt > 0 && (
            <IconCalendar size={13} className="shrink-0" style={{ color: "#0a6029" }} />
          )}
          {meta && meta.actions > 0 && (
            <span className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-semibold" style={{ background: C.orangeAccent, color: C.orange }}>
              <IconList size={9} /> {meta.actions}
            </span>
          )}
        </div>
        <span className="shrink-0 text-[12px] font-medium" style={{ color: C.sub }}>{fmtListStamp(c.lastInteractionTime || c.createdAt)}</span>
      </div>
      <div className="flex items-center gap-2.5">
        <p className="min-w-0 flex-1 truncate text-[12px]" style={{ color: c.lastMessage ? C.dark : C.sub }}>
          {c.lastMessage || c.email_id || c.mobile_number || "No preview available"}
        </p>
        {unread > 0 && <span className="size-2 shrink-0 rounded-full" style={{ background: C.green }} />}
      </div>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2.5 border-b px-5 py-3.5" style={{ borderColor: C.border }}>
          <div className="flex items-center gap-2">
            <div className="size-6 rounded-full bg-[#eef0f3]" />
            <div className="h-3 w-28 rounded bg-[#eef0f3]" />
          </div>
          <div className="h-3 w-56 rounded bg-[#eef0f3]" />
        </div>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Thread pane
 * ════════════════════════════════════════════════════════════════════════════ */
type ThreadNode =
  | { t: number; kind: "msg"; side: "in" | "out"; text: string; sender: string; fb?: { conversationId: string; messageIndex: number } }
  | { t: number; kind: "toolstep"; label: string; rawName: string; args: { k: string; v: string }[]; result?: string; resultExtra?: string }
  | { t: number; kind: "created"; emoji: string; title: string; detail: string }
  | { t: number; kind: "event"; emoji: string; title: string; detail: string; subtle?: boolean } // lead-journey milestone, interleaved in the chat
  | { t: number; kind: "call"; rec: ConvRecord };

const EVENT_GRADIENT =
  "linear-gradient(90deg, rgba(91,109,246,0.10) 1%, rgba(127,106,242,0.10) 23%, rgba(182,81,215,0.10) 66%, rgba(232,62,84,0.10) 86%, rgba(237,137,57,0.10) 113%)";

function ThreadPane({ auth, customer, onViewDetails }: { auth: InboxAuth; customer: InboxCustomer; onViewDetails: () => void }) {
  const [conv, setConv] = useState<ConversationsV2 | null>(null);
  // §7A purple summary box — persona.conversationMemory.summaryShort, shown at the top of the chat.
  const [summary, setSummary] = useState<string>("");
  // §03 feedback — keyed `${conversationId}#${messageIndex}` → thumb direction.
  const [fbMap, setFbMap] = useState<Record<string, "up" | "down">>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let on = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset thread state on customer change
    setConv(null);
    setFbMap({});
    setSummary("");
    // §6 — the two middle-panel calls fire in parallel (conversations + persona summary).
    fetchInboxPersona(auth, customer.customer_id).then((p) => {
      if (on && p?.conversationMemory?.summaryShort) setSummary(p.conversationMemory.summaryShort);
    });
    fetchInboxConversations(auth, customer.customer_id, { limit: 30 }).then(async (data) => {
      if (!on) return;
      setConv(data);
      // Load any existing feedback for every conversation (SMS + call) so thumbs reflect prior votes.
      const lists = await Promise.all(data.conversations.map((r) => fetchInboxFeedback(auth, r.conversationId)));
      if (!on) return;
      const map: Record<string, "up" | "down"> = {};
      lists.flat().forEach((f) => {
        const r = f.metadata?.rating;
        if (r === "up" || r === "down") map[`${f.conversationId}#${f.messageIndex}`] = r;
      });
      if (Object.keys(map).length) setFbMap(map);
    });
    return () => { on = false; };
  }, [auth, customer.customer_id]);

  const voteFeedback = useCallback(
    (conversationId: string, messageIndex: number, message: string, rating: "up" | "down", channel: "sms" | "call", note?: string, reason?: string) => {
      const key = `${conversationId}#${messageIndex}`;
      setFbMap((m) => ({ ...m, [key]: rating }));
      void postInboxFeedback(auth, { conversationId, channel, messageIndex, message, rating, note, reason });
    },
    [auth],
  );

  // §Report-modal (Figma 9842-21472) — thumbs-down opens a report form; submit posts a "down" vote.
  const [reportTarget, setReportTarget] = useState<{ conversationId: string; messageIndex: number; message: string; channel: "sms" | "call" } | null>(null);
  const fbCtx = useMemo<FbCtx>(
    () => ({ map: fbMap, vote: voteFeedback, openReport: (conversationId, messageIndex, message, channel) => setReportTarget({ conversationId, messageIndex, message, channel }) }),
    [fbMap, voteFeedback],
  );

  // Inbound vs outbound filter (attribution: which agent/direction handled or booked). Calls carry the
  // direction on callData.callType; SMS is inferred from who sent the first message.
  const [dir, setDir] = useState<"all" | "in" | "out">("all");
  // Count how many conversations exist per direction (for the filter labels / empty state).
  const dirCounts = useMemo(() => {
    const c = { in: 0, out: 0 };
    for (const rec of conv?.conversations ?? []) {
      const d = convDirection(rec);
      if (d === "in") c.in++; else if (d === "out") c.out++;
    }
    return c;
  }, [conv]);

  // The AI agent's display name (from any call's agentName; else the rooftop's AI, "Vini").
  const aiAgentName = useMemo(
    () => conv?.conversations.map((c) => c.callData?.agentName).find((n) => n && n.trim()) || "Vini",
    [conv],
  );
  const custFirst = (customer.customer_name || "Customer").trim().split(/\s+/)[0];

  // §13 — one chronological, day-grouped stream: every SMS bubble + call + journey milestone interleaved.
  const nodes = useMemo<ThreadNode[]>(() => {
    if (!conv) return [];
    const out: ThreadNode[] = [];
    for (const rec of conv.conversations) {
      // Direction filter — skip conversations that don't match the selected inbound/outbound view.
      if (dir !== "all" && convDirection(rec) !== dir) continue;
      const base = +new Date(rec.createdAt) || 0;
      if (rec.type === "sms" && Array.isArray(rec.smsMessages)) {
        const msgs = rec.smsMessages;
        // Pair each tool CALL (assistant msg w/ toolCalls) with its RESULT (role:"tool", toolCallId).
        const resultByCallId: Record<string, { text: string; extra?: string }> = {};
        for (const m of msgs) {
          if ((m.role || "").toLowerCase() === "tool" && m.toolCallId) resultByCallId[m.toolCallId] = summarizeToolResult(m.content);
        }
        msgs.forEach((m, i) => {
          const t = m._ts || base - (msgs.length - i);
          const role = (m.role || "").toLowerCase();
          if (role === "tool") return; // folded into its tool step (emitted from the call message)
          const rc = (m.toolCalls ?? undefined)?.[0];
          if (rc) {
            // §03 — a tool step: action + query params + result, as an expandable "AI action" card.
            const name = rc.function?.name || rc.name || "";
            const res = rc.id ? resultByCallId[rc.id] : undefined;
            out.push({ t, kind: "toolstep", label: toolLabel(name), rawName: name, args: formatArgs(rc.function?.arguments), result: res?.text, resultExtra: res?.extra });
            return;
          }
          const parsed = parseSmsText(m.content);
          if (parsed.kind === "tool") { // orphan tool result (no linked call in this list)
            out.push({ t, kind: "toolstep", label: "Ran a tool", rawName: "", args: [], result: parsed.summary });
            return;
          }
          if (!parsed.text) return;
          const side = role === "user" ? "in" : "out";
          out.push({
            t, kind: "msg", side, text: parsed.text,
            sender: side === "out" ? aiAgentName : custFirst,
            // Feedback attaches to AI messages only, keyed by conversation + message index (§03).
            fb: side === "out" ? { conversationId: rec.conversationId, messageIndex: i } : undefined,
          });
        });
      } else if (rec.type === "call") {
        out.push({ t: base, kind: "call", rec });
      }
    }
    // Inline "created" events in the chat: appointment booked + action item created (at their createdAt).
    for (const a of conv.nextAppointments ?? []) {
      const t = +new Date((a.createdAt as string) || a.meeting_start_time || "") || 0;
      if (t) out.push({ t, kind: "created", emoji: "🗓", title: "Appointment created", detail: apptLabel(a) });
    }
    for (const ai of conv.nextActionItems ?? []) {
      const t = +new Date((ai.createdAt as string) || "") || 0;
      if (t) out.push({ t, kind: "created", emoji: "⚑", title: "Action item created", detail: ai.description || prettify(ai.intent || "") });
    }
    // Lead-journey milestones interleaved chronologically in the chat (also shown in the right panel).
    for (const ev of conv.leadJourney ?? []) {
      const m = journeyMeta(ev);
      // Per-touch "side tasks" (campaign/follow-up sends) are routine — render them subtly so the
      // milestones (lead created, speed-to-lead, appointment) stay the visual anchors of the journey.
      const subtle = /task/i.test(ev.eventType || "") || /task$/i.test(m.title);
      out.push({ t: +new Date(ev.timestamp) || 0, kind: "event", emoji: m.emoji, title: m.title, detail: m.detail, subtle });
    }
    return out.sort((a, b) => a.t - b.t);
  }, [conv, dir, aiAgentName, custFirst]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [nodes.length]);

  const lead = conv?.leads?.[0];
  const phone = customer.mobile_number || conv?.conversations?.[0]?.customerDetails?.phone || "";
  const engagementStopped = !!lead?.stopAiEngagement;
  // §12 driver — read-only from the data. aiMode ≠ "auto" on the latest conversation ⇒ a human is on it.
  const latestMode = conv?.conversations?.[0]?.aiMode;
  const humanDriving = !engagementStopped && !!latestMode && latestMode !== "auto";

  return (
    <>
      {/* header */}
      <div className="shrink-0 border-b bg-white px-5 py-5 shadow-[0px_1px_1px_rgba(0,0,0,0.06)]" style={{ borderColor: C.border }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-full text-[14px] font-medium text-white" style={{ background: avatarColor(customer.customer_id || customer.customer_name) }}>
              {initials(customer.customer_name || phone)}
            </span>
            <div className="flex flex-col gap-1.5">
              <p className="text-[16px] font-semibold leading-none" style={{ color: C.dark }}>{customer.customer_name || "Unknown"}</p>
              {phone && <a href={`tel:${phone}`} className="text-[14px] font-medium leading-none hover:underline" style={{ color: C.sub }}>{phone}</a>}
            </div>
            {lead?.temperature && <TempBadge temp={lead.temperature} />}
            {engagementStopped && (
              <span className="ml-1 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: "#f1f5f9", color: "#64748b" }}>AI paused</span>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            {/* Inbound / outbound direction filter (attribution) */}
            <div className="flex items-center rounded-[12px] border p-0.5" style={{ borderColor: C.border }}>
              {([["all", "All"], ["in", "Inbound"], ["out", "Outbound"]] as const).map(([v, label]) => {
                const on = dir === v;
                const count = v === "in" ? dirCounts.in : v === "out" ? dirCounts.out : dirCounts.in + dirCounts.out;
                return (
                  <button key={v} onClick={() => setDir(v)}
                    className="rounded-[10px] px-3 py-1.5 text-[12px] font-medium transition-colors"
                    style={on ? { background: C.primaryAccent, color: C.primary } : { color: C.sub }}>
                    {label}{v !== "all" ? ` (${count})` : ""}
                  </button>
                );
              })}
            </div>
            <button onClick={onViewDetails} className="flex items-center gap-2 rounded-[15px] border px-6 py-2.5 text-[12px] font-medium transition-colors hover:bg-[#f7f7f8]" style={{ borderColor: C.border, color: C.dark }}>
              <IconInfo size={14} /> View Details
            </button>
          </div>
        </div>
      </div>

      {/* sticky summary — stays pinned below the header while the conversation scrolls */}
      {summary && (
        <div className="shrink-0 border-b px-5 py-2.5" style={{ borderColor: `${C.primary}33`, background: C.primaryAccent }}>
          <div className="mx-auto w-full max-w-[760px]">
            <p className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.primary }}>✦ Summary</p>
            <p className="line-clamp-2 text-[12px] font-medium leading-[17px]" style={{ color: C.dark }}>{summary}</p>
          </div>
        </div>
      )}

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {conv === null ? (
          <ThreadSkeleton />
        ) : nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px]" style={{ color: C.sub }}>
            {dir === "all"
              ? `No conversation history yet for ${customer.customer_name || "this customer"}.`
              : `No ${dir === "in" ? "inbound" : "outbound"} conversations for ${customer.customer_name || "this customer"}.`}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
            {renderWithDividers(nodes, fbCtx, auth, customer.customer_name || "")}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* footer — §12 driver status, READ-ONLY (no take-over/send/stop API exists yet). */}
      <div className="flex shrink-0 items-center justify-center border-t bg-white px-4 py-2.5 shadow-[0px_-1px_15px_rgba(0,0,0,0.04)]" style={{ borderColor: C.border }}>
        <p className="text-[12px]" style={{ color: C.sub }}>
          {engagementStopped
            ? "🛑 AI engagement is paused for this lead"
            : humanDriving
              ? "🙋 A human is currently handling this conversation"
              : "🤖 Vini is handling replies"}
        </p>
      </div>

      {reportTarget && (
        <ReportModal
          onClose={() => setReportTarget(null)}
          onSubmit={(reason, note) => {
            voteFeedback(reportTarget.conversationId, reportTarget.messageIndex, reportTarget.message, "down", reportTarget.channel, note, reason);
            setReportTarget(null);
          }}
        />
      )}
    </>
  );
}

/* §Report-this-message modal — Figma 9842-21472. Reason chips + optional note → a "down" vote. */
const REPORT_REASONS = ["Gave wrong Information", "Tone was off", "Missed the ask", "Shouldn't have sent this message", "Other"];
function ReportModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string, note: string) => void }) {
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div className="animate-dropdown-in relative w-full max-w-[540px] rounded-[16px] bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <span className="text-[16px]">🚩</span>
          <h2 className="text-[16px] font-semibold" style={{ color: C.dark }}>Report this message</h2>
        </div>
        <p className="mt-1 text-[12px]" style={{ color: C.sub }}>Your feedback trains Vini for this dealership.</p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          {REPORT_REASONS.map((r) => {
            const on = reason === r;
            return (
              <button key={r} onClick={() => setReason(r)}
                className="rounded-full border px-4 py-2 text-[12px] font-medium transition-colors"
                style={on ? { borderColor: C.red, color: C.red, background: "#fdecee" } : { borderColor: C.border, color: C.dark }}>
                {r}
              </button>
            );
          })}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Add a note (optional)…"
          className="mt-4 w-full resize-none rounded-[12px] border px-4 py-3 text-[13px] outline-none focus:border-[#4600f2]"
          style={{ borderColor: C.border, color: C.dark }}
        />
        <div className="mt-5 flex items-center justify-end gap-4">
          <button onClick={onClose} className="text-[13px] font-medium" style={{ color: C.dark }}>Cancel</button>
          <button
            disabled={!reason}
            onClick={() => onSubmit(reason, note.trim())}
            className="rounded-full px-6 py-2.5 text-[13px] font-semibold text-white transition-opacity disabled:opacity-40"
            style={{ background: C.red }}>
            Submit Report
          </button>
        </div>
      </div>
    </div>
  );
}

interface FbCtx {
  map: Record<string, "up" | "down">;
  vote: (conversationId: string, messageIndex: number, message: string, rating: "up" | "down", channel: "sms" | "call", note?: string, reason?: string) => void;
  openReport: (conversationId: string, messageIndex: number, message: string, channel: "sms" | "call") => void;
}

/* Insert TODAY/date dividers between nodes on day boundaries (§13). */
function renderWithDividers(nodes: ThreadNode[], fb: FbCtx, auth: InboxAuth, customerName: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastDay = "";
  nodes.forEach((n, i) => {
    const iso = new Date(n.t).toISOString();
    const dl = dayLabel(iso);
    if (dl && dl !== lastDay) {
      out.push(<DayDivider key={`d${i}`} label={dl} />);
      lastDay = dl;
    }
    out.push(<ThreadNodeView key={`n${i}`} node={n} fb={fb} auth={auth} customerName={customerName} />);
  });
  return out;
}

function ThreadNodeView({ node, fb, auth, customerName }: { node: ThreadNode; fb: FbCtx; auth: InboxAuth; customerName: string }) {
  if (node.kind === "call") {
    // Place calls on the correct side, like messages: incoming (customer) left, outgoing (AI) right.
    const inbound = (node.rec.callData?.callType || "").toLowerCase().includes("inbound");
    return (
      <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
        <CallCard rec={node.rec} fb={fb} auth={auth} customerName={customerName} />
      </div>
    );
  }
  if (node.kind === "toolstep") return <ToolStepCard node={node} />;
  if (node.kind === "created") {
    // Inline system event — appointment / action item created.
    return (
      <div className="flex justify-center">
        <span className="flex items-center gap-1.5 rounded-full border px-3.5 py-1 text-[11px]" style={{ borderColor: C.border, background: "#fff", color: C.dark }}>
          <span>{node.emoji}</span><span className="font-semibold">{node.title}</span>
          {node.detail && <span style={{ color: C.sub }}>· {node.detail}</span>}
        </span>
      </div>
    );
  }
  if (node.kind === "event") {
    // Subtle "side task" (routine campaign/follow-up touch) — a quiet gray line, no gradient pill.
    if (node.subtle) {
      return (
        <div className="flex justify-center">
          <span className="flex items-center gap-1.5 px-2 py-0.5 text-[11px]" style={{ color: C.sub }}>
            <span className="opacity-60">{node.emoji}</span>
            <span className="font-medium">{node.title}</span>
            {node.detail && <span className="opacity-80">· {node.detail}</span>}
            <span className="opacity-70">· {fmtTime(new Date(node.t).toISOString())}</span>
          </span>
        </div>
      );
    }
    // Lead-journey milestone pill, interleaved in the chat.
    return (
      <div className="flex justify-center">
        <span className="flex items-center gap-2 rounded-[15px] px-5 py-1.5 text-[12px]" style={{ background: EVENT_GRADIENT }}>
          <span className="text-[11px]">{node.emoji}</span>
          <span className="font-semibold" style={{ color: C.dark }}>{node.title}</span>
          {node.detail && <span style={{ color: C.dark }}>{node.detail}</span>}
          <span style={{ color: C.sub }}>{fmtTime(new Date(node.t).toISOString())}</span>
        </span>
      </div>
    );
  }
  return <MessageBubble side={node.side} sender={node.sender} text={node.text} at={new Date(node.t).toISOString()} fbNode={node.fb} fb={fb} />;
}

/* §03 — a tool-use "behind the scenes" step: action + query params + result, expandable. Modeled on
 * how chat assistants surface tool calls. Right-aligned (AI side). */
function ToolStepCard({ node }: { node: Extract<ThreadNode, { kind: "toolstep" }> }) {
  const [open, setOpen] = useState(false);
  const hasDetail = node.args.length > 0 || !!node.result;
  const subtitle = node.resultExtra || (node.result ? humanizeTrace(node.result) : "") ||
    (node.args.length ? node.args.map((a) => a.v).join(" · ") : "");
  return (
    <div className="flex justify-end px-0.5">
      <div className="max-w-[75%] overflow-hidden rounded-[12px] border" style={{ borderColor: `${C.primary}2e`, background: `${C.primary}08` }}>
        <button onClick={() => hasDetail && setOpen((v) => !v)} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${hasDetail ? "" : "cursor-default"}`}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full" style={{ background: `${C.primary}1a`, color: C.primary }}><IconBolt size={11} /></span>
          <span className="text-[11px] font-semibold" style={{ color: C.dark }}>{node.label}</span>
          {subtitle && <span className="truncate text-[11px]" style={{ color: C.sub }}>· {subtitle}</span>}
          {hasDetail && <IconChevron size={12} className={`ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`} style={{ color: C.sub }} />}
        </button>
        {open && hasDetail && (
          <div className="flex flex-col gap-2 border-t px-3 py-2" style={{ borderColor: `${C.primary}22` }}>
            {node.args.length > 0 && (
              <div>
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide" style={{ color: C.sub }}>Query</p>
                <div className="flex flex-col gap-0.5">
                  {node.args.map((a, i) => (
                    <div key={i} className="flex gap-2 text-[11px]">
                      <span className="shrink-0 capitalize" style={{ color: C.sub }}>{a.k}</span>
                      <span className="min-w-0 flex-1 break-words font-medium" style={{ color: C.dark }}>{a.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {node.result && (
              <div>
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide" style={{ color: C.sub }}>Result</p>
                <p className="text-[11px] leading-[16px]" style={{ color: C.dark }}>{humanizeTrace(node.result)}{node.resultExtra ? ` · ${node.resultExtra}` : ""}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-5">
      <div className="h-px flex-1" style={{ background: C.border }} />
      <span className="text-[10px] font-medium" style={{ color: C.sub }}>{label}</span>
      <div className="h-px flex-1" style={{ background: C.border }} />
    </div>
  );
}

/* §02 — one SMS entry. AI (out) = right/blue; customer (in) = left/white. AI messages carry a
 * thumbs-up / report feedback control; tool activity renders as its own ToolStepCard. */
function MessageBubble({ side, sender, text, at, fbNode, fb }: {
  side: "in" | "out"; sender: string; text: string; at: string;
  fbNode?: { conversationId: string; messageIndex: number }; fb?: FbCtx;
}) {
  const meta = <span className="px-0.5 text-[11px]" style={{ color: C.sub }}><span className="font-medium" style={{ color: C.dark }}>{sender}</span> · {fmtTime(at)}</span>;
  if (side === "out") {
    const rating = fbNode && fb ? fb.map[`${fbNode.conversationId}#${fbNode.messageIndex}`] : undefined;
    return (
      <div className="group flex justify-end gap-2">
        <div className="flex max-w-[70%] flex-col items-end gap-1.5">
          {text && (
            <div className="rounded-[15px] rounded-br-none px-5 py-3.5 text-[12px] leading-[18px]" style={{ background: C.blueAccent, color: C.dark }}>
              {text}
            </div>
          )}
          <div className="flex items-center gap-2 px-0.5">
            {fbNode && fb && text && (
              <span className={`flex items-center gap-2 transition-opacity ${rating ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                <button onClick={() => fb.vote(fbNode.conversationId, fbNode.messageIndex, text, "up", "sms")}
                  title="Good reply" style={{ color: rating === "up" ? C.primary : C.sub }}><IconThumbUp size={13} /></button>
                <button onClick={() => fb.openReport(fbNode.conversationId, fbNode.messageIndex, text, "sms")}
                  title="Report this message" style={{ color: rating === "down" ? C.red : C.sub }}><IconThumbDown size={13} /></button>
              </span>
            )}
            {meta}
          </div>
        </div>
        <Avatar kind="agent" name={sender} />
      </div>
    );
  }
  return (
    <div className="flex justify-start gap-2">
      <Avatar kind="customer" name={sender} />
      <div className="flex max-w-[70%] flex-col items-start gap-1.5">
        <div className="rounded-[15px] rounded-bl-none border px-5 py-3.5 text-[12px] leading-[18px]" style={{ borderColor: C.border, background: "#fff", color: C.dark }}>
          {text}
        </div>
        {meta}
      </div>
    </div>
  );
}

// Message avatar — agent (flat headset glyph) vs customer (colored initials).
function Avatar({ kind, name }: { kind: "agent" | "customer"; name: string }) {
  if (kind === "agent") {
    return (
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full" style={{ background: C.primaryAccent, color: C.primary }} title={name}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="2.5" y="13.5" width="4" height="6" rx="1.5" /><rect x="17.5" y="13.5" width="4" height="6" rx="1.5" /><path d="M20 19v1a3 3 0 0 1-3 3h-3" /></svg>
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-medium text-white" style={{ background: avatarColor(name || "?") }} title={name}>
      {initials(name)}
    </span>
  );
}

/* §02 — a voice call entry (Figma "Call types" 10015-275). Four variants by direction + outcome, each
 * with a colored direction icon; connected calls show a play-pill that expands to the recording player
 * + a timestamped transcript (fetched from the transcript endpoint) and a Report action. Missed /
 * didn't-connect calls have no recording, so no player/expand. */
function CallCard({ rec, fb, auth, customerName }: { rec: ConvRecord; fb: FbCtx; auth: InboxAuth; customerName: string }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<TranscriptTurn[] | null>(null);
  const [tab, setTab] = useState<"transcript" | "review">("transcript");
  const [detail, setDetail] = useState<CallAnalysis | null | undefined>(undefined); // undefined=unfetched, null=none
  const cd = rec.callData || {};
  const inbound = (cd.callType || "").toLowerCase().includes("inbound");
  const durSec = parseFloat(cd.callDuration || "0");
  const recording = cd.recordingUrl || null;
  const noAnswer = /voicemail|no[-_ ]?answer|missed|not[-_ ]?connect|failed|before[-_ ]?warm/i.test(cd.endedReason || "");
  const connected = !!recording && durSec > 3 && !noAnswer;
  const rating = fb.map[`${rec.conversationId}#0`];
  const name = (rec.customerDetails?.name || customerName || "the customer").trim();
  const custFirst = name.split(/\s+/)[0] || name;
  const dur = fmtDuration(cd.callDuration);

  // Only spoken turns in the transcript — drop tool-call/result turns (role "tool" or JSON content).
  const spoken = (turns ?? []).filter((t) => {
    const c = (t.content || "").trim();
    if (!c || c.startsWith("{")) return false;
    return ["bot", "assistant", "agent", "user"].includes((t.role || "").toLowerCase());
  });
  const variant = inbound ? (connected ? "inbound" : "missed") : connected ? "outbound" : "didnt";
  const V = {
    inbound: { title: `Inbound call from ${name}`, Icon: IconCallIn, bg: C.blueAccent, fg: "#2f7bff" },
    outbound: { title: `Outbound call to ${name}`, Icon: IconCallOut, bg: "#e3ffea", fg: "#0a6029" },
    missed: { title: `Missed call from ${name}`, Icon: IconCallIn, bg: "#fdecee", fg: C.red },
    didnt: { title: `Call to ${name} didn't connect`, Icon: IconCallOut, bg: "#fdecee", fg: C.red },
  }[variant];

  // Fetch the timestamped transcript on first expand (falls back to the inline callData transcript).
  useEffect(() => {
    if (!open || turns !== null || !(rec.callId || rec.conversationId)) return;
    let on = true;
    fetchInboxTranscript(auth, rec.callId || rec.conversationId).then((t) => {
      if (!on) return;
      setTurns(t.length ? t : parseCallTranscript(cd.transcript || "").map((x) => ({ role: x.speaker === "AI" ? "bot" : "user", content: x.text } as TranscriptTurn)));
    });
    // Call intelligence (AI Review): outcome, summary, query resolution, AI score, sentiment, intent.
    if (rec.callId) fetchInboxCall(auth, rec.callId).then((d) => { if (on) setDetail(d?.analysis ?? null); });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- no callId ⇒ no analysis to fetch
    else setDetail(null);
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="w-[90%] max-w-[560px]">
      <div className="overflow-hidden rounded-[14px] border bg-white" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-3 px-3.5 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full" style={{ background: V.bg, color: V.fg }}><V.Icon size={15} /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold" style={{ color: C.dark }}>{V.title}</p>
            {rec.callTitle && <p className="truncate text-[12px]" style={{ color: C.sub }}>{rec.callTitle}</p>}
          </div>
          {recording && (
            <button onClick={() => setOpen((v) => !v)} className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-[#f7f4ff]"
              style={{ borderColor: `${C.primary}44`, color: C.primary }}>
              <IconPlay size={9} /> {dur || "Play"}
            </button>
          )}
          <span className="shrink-0 text-[12px]" style={{ color: C.sub }}>{fmtTime(rec.createdAt)}</span>
          {recording && (
            <button onClick={() => setOpen((v) => !v)} className="shrink-0" title={open ? "Collapse" : "Expand"}>
              <IconChevron size={14} className={open ? "rotate-180" : ""} style={{ color: C.sub }} />
            </button>
          )}
        </div>

        {open && recording && (
          <div className="border-t px-4 py-3" style={{ borderColor: C.border }}>
            <audio controls preload="metadata" src={recording} className="h-9 w-full"><track kind="captions" /></audio>
            <div className="mt-3 flex items-center justify-between border-b" style={{ borderColor: C.border }}>
              <div className="flex items-center gap-4">
                {(["transcript", "review"] as const).map((t) => (
                  <button key={t} onClick={() => setTab(t)}
                    className="px-1 pb-1.5 text-[12px] font-semibold transition-colors"
                    style={tab === t ? { borderBottom: `2px solid ${C.primary}`, color: C.primary } : { color: C.sub }}>
                    {t === "transcript" ? "Transcript" : "AI Review"}
                  </button>
                ))}
              </div>
              <button onClick={() => fb.openReport(rec.conversationId, 0, rec.callTitle || "Call", "call")}
                className="flex items-center gap-1 pb-1.5 text-[11px] font-medium" style={{ color: rating === "down" ? C.red : C.sub }} title="Report this call">
                <IconFlag size={11} /> {rating === "down" ? "Reported" : "Report"}
              </button>
            </div>
            {tab === "transcript" ? (
              <div className="mt-2 flex flex-col gap-1">
                {turns === null ? (
                  <p className="text-[11px]" style={{ color: C.sub }}>Loading transcript…</p>
                ) : spoken.length === 0 ? (
                  <p className="text-[11px]" style={{ color: C.sub }}>No transcript available.</p>
                ) : (
                  spoken.map((t, i) => {
                    const isAI = ["assistant", "bot", "agent"].includes((t.role || "").toLowerCase());
                    return (
                      <div key={i} className="flex gap-2.5 rounded-[8px] px-2 py-1" style={isAI ? undefined : { background: "#fff9e6" }}>
                        <span className="shrink-0 pt-0.5 text-[10px] tabular-nums" style={{ color: C.sub }}>{fmtSecs(t.secondsFromStart)}</span>
                        <p className="text-[12px] leading-[17px]" style={{ color: C.dark }}>
                          <span className="font-semibold" style={{ color: isAI ? C.primary : "#0a6029" }}>{isAI ? cd.agentName || "Vini" : custFirst}:</span> {t.content}
                        </p>
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
              <CallReview detail={detail} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// AI Review — call intelligence from GET /conversation/calls/:callUid (analysis). Every field is
// optional on UAT, so each renders only when present and the panel degrades to "not available yet".
function CallReview({ detail }: { detail: CallAnalysis | null | undefined }) {
  if (detail === undefined) return <p className="mt-3 text-[11px]" style={{ color: C.sub }}>Loading AI review…</p>;
  const a = detail || {};
  const outcome = a.primaryOutcome || a.outcome || null;
  const intent = a.primaryIntent || a.customerIntent || null;
  const summary = a.summary || null;
  const scorePct = typeof a.qualityScorePct === "number" ? a.qualityScorePct
    : typeof a.qualityScore === "number" ? Math.round(a.qualityScore * (a.qualityScore <= 1 ? 100 : 1)) : null;
  const yesNo = (v: boolean | null | undefined) => (v === true ? "Yes" : v === false ? "No" : null);
  const sentiment = typeof a.sentimentScore === "number"
    ? a.sentimentScore >= 0.6 ? "Positive" : a.sentimentScore <= 0.4 ? "Negative" : "Neutral"
    : a.customerFrustrated === true ? "Frustrated" : null;

  const stats: { label: string; value: string; tone?: "good" | "bad" }[] = [];
  if (scorePct != null) stats.push({ label: "AI score", value: `${scorePct}%${a.qualityGrade ? ` · ${a.qualityGrade}` : ""}`, tone: scorePct >= 70 ? "good" : scorePct < 50 ? "bad" : undefined });
  const qr = yesNo(a.queryResolved); if (qr) stats.push({ label: "Query resolved", value: qr, tone: a.queryResolved ? "good" : "bad" });
  const ql = yesNo(a.qualified); if (ql) stats.push({ label: "Qualified", value: ql, tone: a.qualified ? "good" : undefined });
  const ap = yesNo(a.appointmentScheduled); if (ap) stats.push({ label: "Appointment", value: ap, tone: a.appointmentScheduled ? "good" : undefined });
  if (sentiment) stats.push({ label: "Sentiment", value: sentiment, tone: sentiment === "Positive" ? "good" : sentiment === "Negative" || sentiment === "Frustrated" ? "bad" : undefined });

  const empty = !outcome && !intent && !summary && stats.length === 0;
  if (empty) return <p className="mt-3 text-[11px]" style={{ color: C.sub }}>AI review isn&apos;t available for this call yet.</p>;

  const toneColor = (t?: "good" | "bad") => (t === "good" ? C.green : t === "bad" ? C.red : C.dark);
  return (
    <div className="mt-3 flex flex-col gap-3">
      {(outcome || intent) && (
        <div className="flex flex-wrap gap-2">
          {intent && <span className="rounded-full px-2.5 py-1 text-[11px] font-medium" style={{ background: C.primaryAccent, color: C.primary }}>Intent · {prettify(intent)}</span>}
          {outcome && <span className="rounded-full px-2.5 py-1 text-[11px] font-medium" style={{ background: C.blueAccent, color: "#2f7bff" }}>Outcome · {prettify(outcome)}</span>}
        </div>
      )}
      {stats.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-[10px] border px-2.5 py-2" style={{ borderColor: C.border, background: "#fafafa" }}>
              <p className="text-[10px] uppercase tracking-wide" style={{ color: C.sub }}>{s.label}</p>
              <p className="mt-0.5 text-[13px] font-semibold" style={{ color: toneColor(s.tone) }}>{s.value}</p>
            </div>
          ))}
        </div>
      )}
      {summary && (
        <div>
          <p className="text-[10px] uppercase tracking-wide" style={{ color: C.sub }}>Summary</p>
          <p className="mt-1 text-[12px] leading-[18px]" style={{ color: C.dark }}>{summary}</p>
        </div>
      )}
    </div>
  );
}

// Label a lead-journey milestone per the integration guide §7C (used by the right-panel timeline).
function journeyMeta(ev: LeadJourneyEvent): { emoji: string; title: string; detail: string } {
  const map: Record<string, { emoji: string; title: (e: LeadJourneyEvent) => string; detail: (e: LeadJourneyEvent) => string }> = {
    lead_created: { emoji: "🌱", title: () => "Lead created", detail: () => "A new lead entered the pipeline" },
    stl_triggered: { emoji: "⚡", title: () => "Speed to lead triggered", detail: (e) => [e.channel, e.status].filter(Boolean).map(prettify).join(" · ") },
    // §7C: render "${task.source} task" — e.g. "CAMPAIGN task", "FOLLOWUP task".
    outbound_task: { emoji: "📤", title: (e) => `${(e.source || "Outbound").toUpperCase()} task`, detail: (e) => [e.channel, e.outcome || e.status].filter(Boolean).map(prettify).join(" · ") },
    campaign_started: { emoji: "📣", title: () => "Campaign started", detail: (e) => e.campaignName ? `- ${e.campaignName}` : "" },
    campaign_ended: { emoji: "🏁", title: () => "Campaign ended", detail: (e) => e.campaignName ? `- ${e.campaignName}` : "" },
    engagement_stopped: { emoji: "🛑", title: () => "Engagement stopped", detail: () => "Automated outreach was paused" },
  };
  const cfg = map[ev.eventType] || { emoji: "•", title: () => prettify(ev.eventType), detail: () => (ev.status ? prettify(ev.status) : "") };
  return { emoji: cfg.emoji, title: cfg.title(ev), detail: cfg.detail(ev) };
}

/* Build the journey timeline, MERGING each campaign_started with its matching campaign_ended (same
 * campaignName) into ONE entry so the linked pair reads as a single campaign with a start→end span,
 * instead of two far-apart rows. Other events pass through individually. */
interface TimelineItem { emoji: string; title: string; detail: string; at: string; endAt?: string; campaign?: boolean; children?: TimelineItem[] }
function buildTimeline(journey: LeadJourneyEvent[]): TimelineItem[] {
  const sorted = [...journey].sort((a, b) => (+new Date(a.timestamp) || 0) - (+new Date(b.timestamp) || 0));
  const items: TimelineItem[] = [];
  const openByName: Record<string, TimelineItem> = {};
  // A speed-to-lead trigger fires an outbound touch — nest that resulting task UNDER the trigger as a
  // sub-layer, instead of showing the two connected events flat side-by-side.
  let trigger: TimelineItem | null = null;
  for (const ev of sorted) {
    if (ev.eventType === "campaign_started") {
      trigger = null;
      const item: TimelineItem = { emoji: "📣", title: ev.campaignName || "Campaign", detail: "Campaign", at: ev.timestamp, campaign: true };
      items.push(item);
      if (ev.campaignName) openByName[ev.campaignName] = item;
    } else if (ev.eventType === "campaign_ended") {
      trigger = null;
      const open = ev.campaignName ? openByName[ev.campaignName] : undefined;
      if (open) { open.endAt = ev.timestamp; if (ev.campaignName) delete openByName[ev.campaignName]; }
      else items.push({ emoji: "🏁", title: ev.campaignName || "Campaign ended", detail: "Campaign ended", at: ev.timestamp, campaign: true });
    } else if (ev.eventType === "stl_triggered") {
      const m = journeyMeta(ev);
      const item: TimelineItem = { emoji: m.emoji, title: m.title, detail: m.detail, at: ev.timestamp, children: [] };
      items.push(item);
      trigger = item; // subsequent outbound tasks attach here
    } else if (ev.eventType === "outbound_task") {
      const m = journeyMeta(ev);
      const child: TimelineItem = { emoji: m.emoji, title: m.title, detail: m.detail, at: ev.timestamp };
      if (trigger) (trigger.children ||= []).push(child);
      else items.push(child);
    } else {
      trigger = null;
      const m = journeyMeta(ev);
      items.push({ emoji: m.emoji, title: m.title, detail: m.detail, at: ev.timestamp });
    }
  }
  return items;
}

/* Vertical journey timeline (guide §7C / Figma 9842-24234). A linked campaign shows one entry with a
 * "Started … · Ended …" span. Optionally appends the NEXT SCHEDULED dashed box. */
function LeadTimeline({ journey, nextScheduled }: { journey: LeadJourneyEvent[]; nextScheduled?: { timing?: string; detail?: string; scheduledAt?: string } }) {
  const items = buildTimeline(journey);
  if (!items.length && !nextScheduled) return <p className="text-[11px]" style={{ color: C.sub }}>No milestones yet.</p>;
  return (
    <div className="relative flex flex-col gap-3.5 pl-4">
      {items.length > 0 && <span className="absolute bottom-2 left-[5px] top-2 w-px" style={{ background: C.border }} />}
      {items.map((it, i) => (
        <div key={i} className="relative">
          <span className="absolute -left-[13px] top-[5px] size-2 rounded-full" style={{ background: it.campaign ? C.primary : "#c4b5fd" }} />
          <p className="text-[12px] font-semibold" style={{ color: C.dark }}>{it.emoji} {it.campaign ? `Campaign · ${it.title}` : it.title}</p>
          {!it.campaign && it.detail && <p className="text-[11px]" style={{ color: C.sub }}>{it.detail}</p>}
          <p className="text-[10px]" style={{ color: C.sub }}>
            {it.endAt ? `Started ${fmtListStamp(it.at)} · Ended ${fmtListStamp(it.endAt)}` : it.campaign ? `Started ${fmtListStamp(it.at)} · Active` : fmtListStamp(it.at)}
          </p>
          {/* connected events (the resulting outbound touch) shown as an indented sub-layer */}
          {it.children && it.children.length > 0 && (
            <div className="mt-2 flex flex-col gap-2 border-l pl-3" style={{ borderColor: C.border }}>
              {it.children.map((c, j) => (
                <div key={j}>
                  <p className="text-[11px] font-medium" style={{ color: C.dark }}>{c.emoji} {c.title}</p>
                  {c.detail && <p className="text-[11px]" style={{ color: C.sub }}>{c.detail}</p>}
                  <p className="text-[10px]" style={{ color: C.sub }}>{fmtListStamp(c.at)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {nextScheduled && (
        <div className="mt-1 rounded-[10px] border border-dashed px-3.5 py-2.5" style={{ borderColor: `${C.primary}66` }}>
          <p className="text-[11px]" style={{ color: C.sub }}>
            <span className="font-semibold uppercase" style={{ color: C.primary }}>Next scheduled: </span>
            <span className="font-semibold" style={{ color: C.dark }}>{nextScheduled.timing || (nextScheduled.scheduledAt ? fmtListStamp(nextScheduled.scheduledAt) : "")}</span>
          </p>
          {nextScheduled.detail && <p className="mt-0.5 text-[11px]" style={{ color: C.sub }}>{nextScheduled.detail}</p>}
        </div>
      )}
    </div>
  );
}

// Normalize a raw nextScheduledTasks[0] into the shape LeadTimeline/NextScheduledChip render.
// Field names vary across providers, so probe the common ones (scheduledAt/scheduled_at/nextRunAt/…).
function normalizeNextScheduled(raw: unknown): { timing?: string; detail?: string; scheduledAt?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const str = (...keys: string[]) => {
    for (const k of keys) { const v = r[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
    return undefined;
  };
  const scheduledAt = str("scheduledAt", "scheduled_at", "nextRunAt", "runAt", "scheduledFor", "scheduled_for", "dueAt", "due_date", "timestamp");
  const timing = str("timing", "label", "when");
  const channel = str("channel", "medium");
  const kind = str("taskType", "task_type", "type", "source", "action");
  const detail = [kind && prettify(kind), channel && prettify(channel)].filter(Boolean).join(" · ") || str("detail", "description", "summary");
  if (!scheduledAt && !timing && !detail) return undefined;
  return { timing, detail: detail || undefined, scheduledAt };
}

// Compact "next scheduled touch" chip surfaced at the top of the right panel (also in the journey box).
function NextScheduledChip({ ns }: { ns: { timing?: string; detail?: string; scheduledAt?: string } }) {
  const when = ns.timing || (ns.scheduledAt ? fmtListStamp(ns.scheduledAt) : "");
  if (!when && !ns.detail) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed px-3.5 py-2.5" style={{ borderColor: `${C.primary}66`, background: C.primaryAccent }}>
      <span className="mt-px shrink-0" style={{ color: C.primary }}><IconCalendar size={13} /></span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.primary }}>Next scheduled touch</p>
        {when && <p className="mt-0.5 text-[12px] font-semibold" style={{ color: C.dark }}>{when}</p>}
        {ns.detail && <p className="text-[11px]" style={{ color: C.sub }}>{ns.detail}</p>}
      </div>
    </div>
  );
}

function TempBadge({ temp }: { temp: string }) {
  const t = temp.toLowerCase();
  const map: Record<string, { bg: string; fg: string }> = {
    hot: { bg: "#ffe4e4", fg: "#d52c2f" },
    warm: { bg: C.orangeAccent, fg: C.orange },
    cold: { bg: "#e0f2fe", fg: "#0369a1" },
    dead: { bg: "#f1f5f9", fg: "#64748b" },
  };
  const s = map[t] || { bg: C.primaryAccent, fg: C.primary };
  return <span className="ml-1 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize" style={{ background: s.bg, color: s.fg }}>{t}</span>;
}

function ThreadSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[760px] animate-pulse flex-col gap-6 pt-4">
      <div className="mx-auto h-3 w-16 rounded bg-[#eef0f3]" />
      {[70, 55, 60].map((w, i) => (
        <div key={i} className="flex justify-end gap-1.5">
          <div className="h-16 rounded-[15px] bg-[#eef0f3]" style={{ width: `${w}%` }} />
          <div className="size-8 rounded-full bg-[#eef0f3]" />
        </div>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Right panel — lead status pills, engagement, journey timeline, appointments,
 * action items (integration guide §7C-E). Milestones live here, NOT in the chat.
 * ════════════════════════════════════════════════════════════════════════════ */
// The upstream id under any of the shapes Spyne returns; "" means we can't resolve it (hide the button).
function actionItemId(a: ActionItem): string {
  return String(a.actionItemId || a._id || a.id || a.action_item_id || "");
}

// One action item with a Resolve (✓) control — PUT /conversation/action-items/mark-completed. On success
// it removes itself optimistically. `compact` is the tighter drawer styling.
function ActionItemRow({ a, auth, compact, onResolved }: { a: ActionItem; auth: InboxAuth; compact?: boolean; onResolved?: (id: string) => void }) {
  const id = actionItemId(a);
  const [busy, setBusy] = useState(false);
  async function resolve() {
    if (!id || busy) return;
    setBusy(true);
    const ok = await resolveInboxActionItem(auth, id, true);
    setBusy(false);
    if (ok) onResolved?.(id); // parent drops it from the list AND updates the "(n)" count
    else if (typeof window !== "undefined") window.alert("Couldn't resolve this action item — please try again.");
  }
  return (
    <div className={`rounded-xl border ${compact ? "p-2.5" : "p-3"}`} style={{ borderColor: C.border }}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-medium" style={{ color: C.dark }}>{a.description || prettify(a.intent || "Follow up")}</p>
        {a.priority && <span className="shrink-0 text-[9px] font-bold uppercase" style={{ color: a.priority === "HIGH" ? C.red : C.sub }}>{a.priority}</span>}
      </div>
      {a.due_date && <p className="mt-0.5 text-[11px]" style={{ color: C.sub }}>Due {fmtTime(a.due_date)}</p>}
      {id && (
        <button onClick={resolve} disabled={busy}
          className="mt-2 flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors enabled:hover:bg-[#f0fdf4] disabled:opacity-50"
          style={{ borderColor: `${C.green}55`, color: C.green }}>
          <IconCheck size={11} /> {busy ? "Resolving…" : "Resolve"}
        </button>
      )}
    </div>
  );
}

// Drawer variant of an action item (due badge + assignee) with the same Resolve control.
function DrawerActionItemRow({ a, auth, onResolved }: { a: ActionItem; auth: InboxAuth; onResolved?: (id: string) => void }) {
  const id = actionItemId(a);
  const due = dueLabel(a.due_date);
  const [busy, setBusy] = useState(false);
  async function resolve() {
    if (!id || busy) return;
    setBusy(true);
    const ok = await resolveInboxActionItem(auth, id, true);
    setBusy(false);
    if (ok) onResolved?.(id);
    else if (typeof window !== "undefined") window.alert("Couldn't resolve this action item — please try again.");
  }
  return (
    <div className="rounded-[10px] border px-4 py-3" style={{ borderColor: C.border }}>
      <p className="text-[12px] font-semibold capitalize leading-[18px]" style={{ color: C.dark }}>{a.description || prettify(a.intent || "Follow up")}</p>
      <div className="mt-3 flex items-center justify-between">
        {due.text ? <span className="rounded-[5px] px-3 py-0.5 text-[12px] font-medium" style={due.style}>{due.text}</span> : <span />}
        <Assignee who={String(a.assigned_to ?? "")} />
      </div>
      {id && (
        <button onClick={resolve} disabled={busy}
          className="mt-3 flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors enabled:hover:bg-[#f0fdf4] disabled:opacity-50"
          style={{ borderColor: `${C.green}55`, color: C.green }}>
          <IconCheck size={11} /> {busy ? "Resolving…" : "Mark resolved"}
        </button>
      )}
    </div>
  );
}

/* ── persona (Lead Details) rendering ─────────────────────────────────────────
 * The persona API backs far more than we used to show: per-field AI confidence +
 * CONFIRMED/INFERRED status, purchase timeline, payment method, the vehicles the
 * customer actually looked at, cross-vehicle signals, and "do not repeat" memory.
 * Everything degrades independently — "NOT_DISCUSSED"/null fields simply don't render. */
const NOT_DISCUSSED = (v: unknown) => v == null || v === "NOT_DISCUSSED" || v === "";
function pval<T>(f?: { value?: T | null } | null): T | undefined {
  return f && !NOT_DISCUSSED(f.value) ? (f.value as T) : undefined;
}
function money(v: unknown): string { return typeof v === "number" ? `$${v.toLocaleString()}` : String(v ?? ""); }
// Small chip showing how sure the AI is about a field + whether the customer confirmed it.
function ConfBadge({ f }: { f?: { confidence?: number | null; status?: string | null } | null }) {
  if (!f || typeof f.confidence !== "number") return null;
  const confirmed = (f.status || "").toUpperCase() === "CONFIRMED";
  return (
    <span className="ml-1.5 shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
      style={{ background: confirmed ? "#e6f7ef" : C.primaryAccent, color: confirmed ? C.green : C.primary }}
      title={confirmed ? "Confirmed by the customer" : "Inferred by the AI"}>
      {Math.round(f.confidence * 100)}%
    </span>
  );
}
function Chips({ items }: { items: (string | number)[] }) {
  const seen = new Set<string>();
  const uniq = items.map((x) => String(x)).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
  if (!uniq.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {uniq.map((x) => <span key={x} className="rounded-full px-2 py-0.5 text-[11px] capitalize" style={{ background: "#f1f5f9", color: "#475569" }}>{x}</span>)}
    </div>
  );
}
function VehicleCard({ title, sub, price, viewedAt, inStock }: { title: string; sub?: string; price?: unknown; viewedAt?: string | null; inStock?: boolean }) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: C.border }}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-semibold" style={{ color: C.dark }}>{title}</p>
        {inStock && <span className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold" style={{ background: "#e6f7ef", color: C.green }}>In stock</span>}
      </div>
      {sub && <p className="mt-0.5 text-[11px] capitalize" style={{ color: C.sub }}>{sub}</p>}
      <div className="mt-1 flex items-center gap-2 text-[11px]" style={{ color: C.sub }}>
        {price != null && !NOT_DISCUSSED(price) && <span className="font-semibold" style={{ color: C.primary }}>{money(price)}</span>}
        {viewedAt && <span>· viewed {fmtListStamp(viewedAt)}</span>}
      </div>
    </div>
  );
}

// The full persona detail set. `scope` lets the tabbed drawer show just Intent-side or just Insights-side.
function PersonaSections({ persona, conv, scope = "all" }: { persona?: Persona | null; conv: ConversationsV2 | null; scope?: "all" | "intent" | "insights" }) {
  const p = persona || undefined;
  const vi = p?.customerPreferences?.vehicleInterest;
  const fin = p?.customerPreferences?.finance;
  const stage = p?.purchaseIntent?.stage;
  const timeline = pval<string>(p?.purchaseIntent?.timelineToBuy);
  const payMethod = pval<string>(fin?.paymentMethod);
  const monthly = pval<number | string>(fin?.monthlyBudgetMax);
  const budget = pval<number | string>(fin?.budgetMax);
  const trade = p?.tradeVehicles?.[0]?.vehicle;
  const mem = p?.conversationMemory;
  const sig = vi?.vehicleSignals;
  const features = vi?.vehiclePreferences?.featurePreference ?? [];
  const watched = (vi?.watchedOtherVehicles ?? []).filter((w) => w.make || w.model);
  const primaryVeh = vi ? [pval(vi.year), pval(vi.make), pval(vi.model), pval(vi.trim)].filter(Boolean).join(" ") : "";
  const stageVal = pval<string>(stage);
  const motivations = [...(mem?.topMotivations ?? []), ...(p?.decisionContext?.motivations ?? []).map((m) => m.value)].filter(Boolean);
  const objections = [...(mem?.topObjections ?? []), ...(p?.decisionContext?.objections ?? []).map((m) => m.value), ...(p?.decisionContext?.painPoints ?? []).map((m) => m.value)].filter(Boolean);
  const doNotRepeat = (mem?.doNotRepeat ?? []).filter(Boolean);
  const lastContacted = p?.engagement?.lastContactedAt;
  const touches = conv?.conversations?.length ?? 0;

  const showIntent = scope !== "insights";
  const showInsights = scope !== "intent";
  const hasIntent = !!(stageVal || timeline || payMethod || monthly != null || budget != null || primaryVeh || trade || watched.length || (sig && (sig.makes?.length || sig.models?.length || sig.bodyTypes?.length)) || features.length);
  const hasInsights = !!(mem?.summaryShort || motivations.length || objections.length || doNotRepeat.length || lastContacted);

  return (
    <>
      {showIntent && (stageVal || timeline) && (
        <RightSection title="Purchase intent">
          <div className="rounded-xl border p-3" style={{ borderColor: C.border }}>
            {stageVal && (
              <div className="flex items-center justify-between py-0.5">
                <span className="text-[11px]" style={{ color: C.sub }}>Buying stage</span>
                <span className="flex items-center text-[12px] font-medium" style={{ color: C.dark }}>{stageLabel(stageVal)}<ConfBadge f={stage} /></span>
              </div>
            )}
            {timeline && <Row label="Timeline to buy" value={prettify(timeline)} />}
          </div>
        </RightSection>
      )}

      {showIntent && (payMethod || monthly != null || budget != null) && (
        <RightSection title="Payment">
          <div className="rounded-xl border p-3" style={{ borderColor: C.border }}>
            {(monthly != null || budget != null) && (
              <div className="flex items-center justify-between py-0.5">
                <span className="text-[11px]" style={{ color: C.sub }}>Budget</span>
                <span className="flex items-center text-[12px] font-medium" style={{ color: C.dark }}>
                  {monthly != null ? `${money(monthly)}/mo` : money(budget)}
                  {payMethod && <span className="lowercase" style={{ color: C.sub }}>&nbsp;· {prettify(payMethod)}</span>}
                  <ConfBadge f={fin?.paymentMethod} />
                </span>
              </div>
            )}
            {monthly == null && budget == null && payMethod && <Row label="Payment method" value={prettify(payMethod)} />}
          </div>
        </RightSection>
      )}

      {showIntent && (primaryVeh || watched.length > 0) && (
        <RightSection title="Considered vehicles">
          {primaryVeh && (
            <VehicleCard title={primaryVeh}
              sub={[pval(vi?.conditionPreference), pval(vi?.bodyType), pval(vi?.color)].filter(Boolean).map((x) => prettify(String(x))).join(" · ") || undefined}
              price={pval<number>(vi?.price)} viewedAt={vi?.lastEngagedAt}
              inStock={!!(pval(vi?.dealerVinId) || pval(vi?.vin))} />
          )}
          {watched.map((w, i) => (
            <VehicleCard key={i} title={[w.year, w.make, w.model].filter(Boolean).join(" ")}
              sub={w.color ? prettify(w.color) : undefined} price={w.watchedPrice ?? undefined}
              viewedAt={w.lastEngagedAt} inStock={!!(w.dealerVinId || w.vin)} />
          ))}
        </RightSection>
      )}

      {showIntent && trade && (
        <RightSection title="Trade-in">
          <div className="rounded-xl border p-3" style={{ borderColor: C.border }}>
            <p className="text-[12px] font-medium" style={{ color: C.dark }}>{[trade.year, trade.make, trade.model].filter(Boolean).join(" ") || "On file"}</p>
          </div>
        </RightSection>
      )}

      {showIntent && sig && (!!sig.makes?.length || !!sig.models?.length || !!sig.bodyTypes?.length || features.length > 0) && (
        <RightSection title="Signals">
          <div className="flex flex-col gap-2">
            {!!sig.makes?.length && (<div><p className="mb-1 text-[10px] font-semibold uppercase" style={{ color: C.sub }}>Makes</p><Chips items={sig.makes} /></div>)}
            {!!sig.models?.length && (<div><p className="mb-1 text-[10px] font-semibold uppercase" style={{ color: C.sub }}>Models</p><Chips items={sig.models} /></div>)}
            {!!sig.bodyTypes?.length && (<div><p className="mb-1 text-[10px] font-semibold uppercase" style={{ color: C.sub }}>Body</p><Chips items={sig.bodyTypes} /></div>)}
            {features.length > 0 && (<div><p className="mb-1 text-[10px] font-semibold uppercase" style={{ color: C.sub }}>Features</p><Chips items={features} /></div>)}
          </div>
        </RightSection>
      )}

      {showInsights && (mem?.summaryShort || motivations.length || objections.length || doNotRepeat.length) && (
        <RightSection title="Conversation memory">
          {mem?.summaryShort && <p className="text-[12px] leading-[18px]" style={{ color: C.dark }}>{mem.summaryShort}</p>}
          {motivations.length > 0 && (<div><p className="mb-1 mt-1 text-[10px] font-semibold uppercase" style={{ color: C.sub }}>Motivations</p><ul className="flex flex-col gap-1">{motivations.slice(0, 5).map((m, i) => <li key={i} className="text-[11px] leading-[16px]" style={{ color: C.dark }}>• {m}</li>)}</ul></div>)}
          {objections.length > 0 && (<div><p className="mb-1 mt-1 text-[10px] font-semibold uppercase" style={{ color: C.sub }}>Objections &amp; pain points</p><ul className="flex flex-col gap-1">{objections.slice(0, 5).map((m, i) => <li key={i} className="text-[11px] leading-[16px]" style={{ color: C.dark }}>• {m}</li>)}</ul></div>)}
          {doNotRepeat.length > 0 && (<div><p className="mb-1 mt-1 text-[10px] font-semibold uppercase" style={{ color: C.orange }}>Do not repeat</p><ul className="flex flex-col gap-1">{doNotRepeat.slice(0, 6).map((m, i) => <li key={i} className="text-[11px] leading-[16px]" style={{ color: C.sub }}>• {m}</li>)}</ul></div>)}
        </RightSection>
      )}

      {showInsights && (lastContacted || touches > 0) && (
        <RightSection title="Engagement">
          <div className="rounded-xl border p-3" style={{ borderColor: C.border }}>
            {lastContacted && <Row label="Last contacted" value={fmtListStamp(lastContacted)} />}
            {touches > 0 && <Row label="Touches" value={String(touches)} />}
          </div>
        </RightSection>
      )}

      {scope === "all" && !hasIntent && !hasInsights && (
        <p className="text-[12px]" style={{ color: C.sub }}>No lead insights captured yet.</p>
      )}
    </>
  );
}

function RightPanel({ auth, customer, onExpand }: { auth: InboxAuth; customer: InboxCustomer; onExpand: () => void }) {
  const [conv, setConv] = useState<ConversationsV2 | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [stoppedLocal, setStoppedLocal] = useState<boolean | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on customer change
    setConv(null);
    setPersona(null);
    setStoppedLocal(null);
    setResolvedIds(new Set());
    fetchInboxConversations(auth, customer.customer_id, { limit: 30 }).then((d) => { if (on) setConv(d); });
    fetchInboxPersona(auth, customer.customer_id).then((p) => { if (on) setPersona(p); });
    return () => { on = false; };
  }, [auth, customer.customer_id]);

  const lead = conv?.leads?.[0];
  const appts = conv?.nextAppointments ?? [];
  // Resolved-in-session ids drop out here so the "Action items (n)" count and the list both update.
  const actions = (conv?.nextActionItems ?? []).filter((a) => a.is_active && !a.is_completed && !resolvedIds.has(actionItemId(a)));
  const nextSched = normalizeNextScheduled(conv?.nextScheduledTasks?.[0]);
  const stopped = stoppedLocal ?? !!lead?.stopAiEngagement;

  async function handleStop() {
    if (stopped || busy || !lead?.lead_id) return;
    if (typeof window !== "undefined" && !window.confirm("Stop AI engagement for this lead? Vini will stop all automated outreach.")) return;
    setBusy(true);
    const ok = await stopInboxEngagement(auth, lead.lead_id);
    setBusy(false);
    if (ok) setStoppedLocal(true);
    else if (typeof window !== "undefined") window.alert("Couldn't stop engagement — please try again.");
  }

  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-y-auto border-l bg-white" style={{ borderColor: C.border }}>
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3" style={{ borderColor: C.border }}>
        <span className="text-[13px] font-semibold" style={{ color: C.dark }}>Lead Details</span>
        <button onClick={onExpand} title="Expand" className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-[#f2f2f4]" style={{ color: C.sub }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
        </button>
      </div>
      {conv === null ? (
        <div className="space-y-3 p-4">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-[#eef0f3]" />)}</div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {/* lead status pills + engagement */}
          <div className="flex flex-wrap items-center gap-2">
            {lead?.temperature && <TempBadge temp={lead.temperature} />}
            {lead?.stage && <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: C.primaryAccent, color: C.primary }}>{stageLabel(lead.stage)}</span>}
            {lead?.service_type && <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize" style={{ background: "#f1f5f9", color: "#64748b" }}>{lead.service_type}</span>}
          </div>
          <button
            onClick={handleStop}
            disabled={stopped || busy || !lead?.lead_id}
            title={stopped ? "AI engagement is stopped" : "Stop all automated outreach for this lead"}
            className="flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-colors enabled:hover:bg-[#fafafa] disabled:cursor-default"
            style={{ borderColor: C.border, background: C.bg }}>
            <span className="text-[12px] font-medium" style={{ color: stopped ? "#64748b" : C.dark }}>
              {busy ? "Stopping…" : stopped ? "AI engagement stopped" : "Stop AI Engagement"}
            </span>
            <span className="flex h-[22px] w-[38px] items-center rounded-full px-0.5 transition-colors" style={{ background: stopped ? C.primary : "#d1d5db" }}>
              <span className="size-[18px] rounded-full bg-white transition-transform" style={{ transform: stopped ? "translateX(16px)" : "translateX(0)" }} />
            </span>
          </button>

          {nextSched && <NextScheduledChip ns={nextSched} />}

          {appts.length > 0 && (
            <RightSection title="Next appointments">
              {appts.map((a, i) => {
                const b = bookingInfo(a, conv?.conversations ?? []);
                return (
                  <div key={i} className="rounded-xl border p-3" style={{ borderColor: C.border }}>
                    <p className="text-[12px] font-semibold" style={{ color: C.dark }}>{apptLabel(a)}</p>
                    {a.status && <p className="mt-0.5 text-[11px] capitalize" style={{ color: C.sub }}>{prettify(a.status)}</p>}
                    {Array.isArray(a.tags) && a.tags.length > 0 && <p className="mt-0.5 text-[11px]" style={{ color: C.sub }}>{a.tags.join(" · ")}</p>}
                    {b && (b.agent || b.dir !== "unknown") && (
                      <p className="mt-1 text-[11px]" style={{ color: C.primary }}>
                        Booked by {b.agent || "Vini"}{b.dir !== "unknown" ? ` · ${dirLabel(b.dir)}` : ""}
                      </p>
                    )}
                  </div>
                );
              })}
            </RightSection>
          )}

          {actions.length > 0 && (
            <RightSection title={`Action items (${actions.length})`}>
              {actions.slice(0, 8).map((a, i) => (
                <ActionItemRow key={actionItemId(a) || i} a={a} auth={auth}
                  onResolved={(id) => setResolvedIds((prev) => new Set(prev).add(id))} />
              ))}
            </RightSection>
          )}

          <PersonaSections persona={persona} conv={conv} />

          <RightSection title="Lead journey">
            <LeadTimeline journey={conv?.leadJourney ?? []} nextScheduled={normalizeNextScheduled(conv?.nextScheduledTasks?.[0])} />
          </RightSection>
        </div>
      )}
    </aside>
  );
}

// Simple label/value row for the sidebar Intent card.
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-[11px]" style={{ color: C.sub }}>{label}</span>
      <span className="text-[12px] font-medium" style={{ color: C.dark }}>{value}</span>
    </div>
  );
}

function RightSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.sub }}>{title}</p>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Lead Details drawer — tabbed Intent / Activity / Journey / AI Insights
 * (Figma 9842-23905 / 9842-24234). Opened from "View Details".
 * ════════════════════════════════════════════════════════════════════════════ */
type DetailTab = "intent" | "activity" | "journey" | "insights";
function DetailsDrawer({ auth, customer, onClose }: { auth: InboxAuth; customer: InboxCustomer; onClose: () => void }) {
  const [persona, setPersona] = useState<Persona | null | "loading" | "error">("loading");
  const [conv, setConv] = useState<ConversationsV2 | null>(null);
  const [tab, setTab] = useState<DetailTab>("activity");
  const [stoppedLocal, setStoppedLocal] = useState<boolean | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on customer change
    setPersona("loading");
    setConv(null);
    setStoppedLocal(null);
    setResolvedIds(new Set());
    fetchInboxPersona(auth, customer.customer_id).then((p) => { if (on) setPersona(p ?? "error"); });
    fetchInboxConversations(auth, customer.customer_id, { limit: 30 }).then((d) => { if (on) setConv(d); });
    return () => { on = false; };
  }, [auth, customer.customer_id]);

  const P = persona && typeof persona === "object" ? persona : undefined;
  const lead = conv?.leads?.[0];
  const openActions = (conv?.nextActionItems ?? []).filter((a) => a.is_active && !a.is_completed && !resolvedIds.has(actionItemId(a)));
  const appt = conv?.nextAppointments?.[0];
  const stopped = stoppedLocal ?? !!lead?.stopAiEngagement;

  async function handleStop() {
    if (stopped || busy || !lead?.lead_id) return;
    if (typeof window !== "undefined" && !window.confirm("Stop AI engagement for this lead? Vini will stop all automated outreach.")) return;
    setBusy(true);
    const ok = await stopInboxEngagement(auth, lead.lead_id);
    setBusy(false);
    if (ok) setStoppedLocal(true);
    else if (typeof window !== "undefined") window.alert("Couldn't stop engagement — please try again.");
  }

  const TABS: { id: DetailTab; label: string; count?: number }[] = [
    { id: "intent", label: "Intent" },
    { id: "activity", label: "Activity", count: openActions.length },
    { id: "journey", label: "Journey" },
    { id: "insights", label: "AI Insights" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div className="relative flex h-full w-[440px] flex-col border-l bg-white shadow-xl" style={{ borderColor: C.border }} onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-5">
          <h2 className="text-[16px] font-semibold" style={{ color: C.dark }}>{customer.customer_name || "Lead"} Lead Details</h2>
          <button onClick={onClose} className="text-[20px] leading-none" style={{ color: C.dark }}>×</button>
        </div>
        {/* tabs */}
        <div className="flex shrink-0 px-1">
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="flex flex-1 items-center justify-center gap-1.5 border-b px-3 py-2.5 text-[12px] transition-colors"
                style={{ borderColor: on ? C.primary : C.border, borderBottomWidth: on ? 2 : 1, color: on ? C.primary : C.sub, fontWeight: on ? 600 : 500 }}>
                {t.label}
                {t.count ? <span className="flex size-[14px] items-center justify-center rounded-full text-[9px] font-medium text-white" style={{ background: C.red }}>{t.count}</span> : null}
              </button>
            );
          })}
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {conv === null && persona === "loading" ? (
            <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-[#eef0f3]" />)}</div>
          ) : tab === "activity" ? (
            <div className="flex flex-col gap-5">
              {appt ? (
                <div>
                  <SectionLabel>Next appointment</SectionLabel>
                  <div className="mt-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className="text-[14px] font-semibold" style={{ color: C.dark }}>{fmtApptTime(appt)}</span>
                        <span className="rounded-[5px] px-3 py-0.5 text-[12px] font-medium" style={{ background: "#e3ffea", color: "#0a6029" }}>{apptType(appt)}</span>
                      </div>
                      <Assignee who={String(appt.assigned_to ?? "")} />
                    </div>
                    {Array.isArray(appt.tags) && appt.tags.length > 0 && <p className="mt-2 text-[12px]" style={{ color: C.sub }}>{appt.tags.join(", ")}</p>}
                    {(() => {
                      const b = bookingInfo(appt, conv?.conversations ?? []);
                      return b && (b.agent || b.dir !== "unknown") ? (
                        <p className="mt-1 text-[12px]" style={{ color: C.primary }}>Booked by {b.agent || "Vini"}{b.dir !== "unknown" ? ` · ${dirLabel(b.dir)}` : ""}</p>
                      ) : null;
                    })()}
                  </div>
                  <div className="mt-4 h-px w-full" style={{ background: C.border }} />
                </div>
              ) : null}
              <div>
                <SectionLabel>Action items{openActions.length ? ` (${openActions.length})` : ""}</SectionLabel>
                <div className="mt-3 flex flex-col gap-2.5">
                  {openActions.length === 0 ? (
                    <p className="text-[12px]" style={{ color: C.sub }}>No open action items.</p>
                  ) : openActions.map((a, i) => (
                    <DrawerActionItemRow key={actionItemId(a) || i} a={a} auth={auth}
                      onResolved={(id) => setResolvedIds((prev) => new Set(prev).add(id))} />
                  ))}
                </div>
              </div>
            </div>
          ) : tab === "journey" ? (
            <LeadTimeline journey={conv?.leadJourney ?? []} nextScheduled={normalizeNextScheduled(conv?.nextScheduledTasks?.[0])} />
          ) : tab === "intent" ? (
            <div className="flex flex-col gap-4">
              {P ? <PersonaSections persona={P} conv={conv} scope="intent" />
                : <EmptyDetail label={persona === "error" ? "Intent profile unavailable." : "No intent signals captured yet."} />}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {P ? <PersonaSections persona={P} conv={conv} scope="insights" />
                : <EmptyDetail label={persona === "error" ? "AI insights unavailable." : "No AI insights captured yet."} />}
            </div>
          )}
        </div>

        {/* Stop Engagement — deletes the lead's sequence workflows (DELETE …/delete-by-lead). */}
        <div className="shrink-0 border-t px-5 pb-5 pt-3" style={{ borderColor: C.border }}>
          <button
            onClick={handleStop}
            disabled={stopped || busy || !lead?.lead_id}
            title={stopped ? "AI engagement is stopped" : "Stop all automated outreach for this lead"}
            className="flex w-full items-center justify-center gap-2 rounded-[15px] border py-2.5 text-[14px] font-medium transition-colors enabled:hover:bg-[#fafafa] disabled:cursor-default"
            style={{ borderColor: C.border, color: stopped ? "#64748b" : C.red }}>
            🚫 {busy ? "Stopping…" : stopped ? "Engagement stopped" : "Stop Engagement"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] font-medium uppercase tracking-wide" style={{ color: C.sub }}>{children}</p>;
}
function EmptyDetail({ label }: { label: string }) {
  return <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[12px]" style={{ borderColor: C.border, color: C.sub }}>{label}</p>;
}
function Assignee({ who }: { who: string }) {
  const name = !who || who === "SYSTEM" ? "Vini AI" : prettify(who);
  return (
    <span className="flex items-center gap-1.5 text-[12px]" style={{ color: C.dark }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
      {name}
    </span>
  );
}

// §08 appointment helpers.
function apptType(a: AppointmentItem): string {
  return a.intent ? prettify(a.intent.replace(/^schedule_/, "")) : "Appointment";
}
function fmtApptTime(a: AppointmentItem): string {
  const iso = a.meeting_start_time;
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: a.timezone || undefined });
}
// §07 due-date badge: Due Today (orange) / Due Tomorrow / Due in N days (blue) / Overdue (red).
function dueLabel(due?: string): { text: string; style: React.CSSProperties } {
  if (!due) return { text: "", style: {} };
  const d = new Date(due);
  if (!Number.isFinite(d.getTime())) return { text: "", style: {} };
  const days = daysBetweenTzDays(d, new Date()); // dealer-local day diff — matches the CRM/Mongo date
  if (days < 0) return { text: "Overdue", style: { background: "#fdecee", color: C.red } };
  if (days === 0) return { text: "Due Today", style: { background: C.orangeAccent, color: C.orange } };
  if (days === 1) return { text: "Due Tomorrow", style: { background: C.blueAccent, color: "#2f7bff" } };
  return { text: `Due in ${days} days`, style: { background: C.blueAccent, color: "#2f7bff" } };
}

/* ── filters popover (§11) — every option maps to a real leads/v2 query param ─── */
const LEAD_TYPES = ["HOT", "WARM", "COLD", "DEAD"];
// §01 lead sources. Display label → the value leads/v2 expects (docs show short lowercase keys like
// "internet"/"phone"). NOTE: the demo team has no source data, so this couldn't be validated end-to-end;
// confirm the exact accepted enum with the dev.
const LEAD_SOURCES: { label: string; value: string }[] = [
  { label: "Internet Lead", value: "internet" },
  { label: "Phone Lead", value: "phone" },
  { label: "Email Lead", value: "email" },
  { label: "Walk-in", value: "walk-in" },
  { label: "Referral", value: "referral" },
  { label: "Online Scheduler", value: "online_scheduler" },
  { label: "Service Campaign", value: "service_campaign" },
];
type DateRange = "all" | "today" | "7d" | "30d";
const DATE_RANGES: { v: DateRange; label: string }[] = [
  { v: "all", label: "All time" }, { v: "today", label: "Today" }, { v: "7d", label: "Last 7 days" }, { v: "30d", label: "Last 30 days" },
];

// Resolve a preset to leads/v2 startDate/endDate (ISO). The API adjusts date-only endDate to end-of-day.
function dateRangeToIso(r: DateRange): { startDate?: string; endDate?: string } {
  if (r === "all") return {};
  const now = new Date();
  const end = now.toISOString();
  if (r === "today") {
    // Start of the DEALER's calendar day (not the viewer's) so "Today" matches the dealer's clock.
    return { startDate: startOfTzDay(now).toISOString(), endDate: end };
  }
  const days = r === "7d" ? 7 : 30;
  const s = new Date(now.getTime() - days * 86400000);
  return { startDate: s.toISOString(), endDate: end };
}

function FiltersPopover({
  leadType, onLeadType, leadSource, onLeadSource, dateRange, onDateRange, department, onDepartment, onClose,
}: {
  leadType: string[]; onLeadType: (v: string[]) => void;
  leadSource: string[]; onLeadSource: (v: string[]) => void;
  dateRange: DateRange; onDateRange: (v: DateRange) => void;
  department: "" | "sales" | "service"; onDepartment: (v: "" | "sales" | "service") => void;
  onClose: () => void;
}) {
  const toggle = (arr: string[], set: (v: string[]) => void, t: string) =>
    set(arr.includes(t) ? arr.filter((x) => x !== t) : [...arr, t]);
  const anyActive = leadType.length || leadSource.length || dateRange !== "all" || department;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="animate-dropdown-in absolute right-0 top-11 z-50 max-h-[70vh] w-64 overflow-y-auto rounded-xl border bg-white p-3 shadow-lg" style={{ borderColor: C.border }}>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.sub }}>Department</p>
        <div className="mb-3 flex gap-1.5">
          {(["", "sales", "service"] as const).map((d) => (
            <button key={d || "all"} onClick={() => onDepartment(d)}
              className="flex-1 rounded-lg border py-1.5 text-[11px] font-medium capitalize transition-colors"
              style={department === d ? { borderColor: C.primary, color: C.primary, background: C.primaryAccent } : { borderColor: C.border, color: C.sub }}>
              {d || "All"}
            </button>
          ))}
        </div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.sub }}>Date range</p>
        <div className="mb-3 flex flex-col gap-1">
          {DATE_RANGES.map((d) => (
            <label key={d.v} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] hover:bg-[#fafafa]" style={{ color: C.dark }}>
              <input type="radio" name="daterange" checked={dateRange === d.v} onChange={() => onDateRange(d.v)} className="accent-[#4600f2]" />
              {d.label}
            </label>
          ))}
        </div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.sub }}>Lead temperature</p>
        <div className="mb-3 flex flex-col gap-1">
          {LEAD_TYPES.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] hover:bg-[#fafafa]" style={{ color: C.dark }}>
              <input type="checkbox" checked={leadType.includes(t)} onChange={() => toggle(leadType, onLeadType, t)} className="accent-[#4600f2]" />
              <span className="capitalize">{t.toLowerCase()}</span>
            </label>
          ))}
        </div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.sub }}>Lead source</p>
        <div className="flex flex-col gap-1">
          {LEAD_SOURCES.map((s) => (
            <label key={s.value} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] hover:bg-[#fafafa]" style={{ color: C.dark }}>
              <input type="checkbox" checked={leadSource.includes(s.value)} onChange={() => toggle(leadSource, onLeadSource, s.value)} className="accent-[#4600f2]" />
              {s.label}
            </label>
          ))}
        </div>
        {anyActive ? (
          <button onClick={() => { onLeadType([]); onLeadSource([]); onDateRange("all"); onDepartment(""); }}
            className="mt-3 w-full rounded-lg border py-1.5 text-[11px] font-medium" style={{ borderColor: C.border, color: C.sub }}>
            Clear all
          </button>
        ) : null}
      </div>
    </>
  );
}

/* ── misc ───────────────────────────────────────────────────────────────────── */
function NoScope({ hasTeam }: { hasTeam: boolean }) {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-[#fafafa] px-6 text-center">
      <div>
        <p className="text-[15px] font-semibold" style={{ color: C.dark }}>Inbox unavailable</p>
        <p className="mt-1 text-[13px]" style={{ color: C.sub }}>
          {hasTeam ? "This rooftop is missing an enterprise_id in the embed URL." : "No rooftop selected — the host must pass ?team_id= and ?enterprise_id=."}
        </p>
      </div>
    </div>
  );
}

function prettify(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
/* §03 — tool-call trace: ALWAYS plain language; the raw function name is deliberately never surfaced.
 * Unknown tools fall back to a generic verb rather than the prettified function id. */
const TOOL_LABELS: Record<string, string> = {
  inventory_search_vehicles_v3: "Checked inventory",
  inventory_search: "Checked inventory",
  check_inventory: "Checked inventory",
  search_vehicles: "Checked inventory",
  get_trade_in_estimate: "Pulled a trade-in estimate",
  schedule_appointment: "Booked an appointment",
  book_appointment: "Booked an appointment",
  check_availability: "Checked availability",
  transfer_call: "Transferred the call",
  request_callback: "Logged a callback request",
  get_business_hours: "Checked store hours",
  dealership_check_hours: "Checked store hours",
};
function toolLabel(name: string): string {
  return TOOL_LABELS[name] || (name ? prettify(name.replace(/_v\d+$/, "")) : "Ran a tool");
}
// Summarize a tool RESULT payload into a headline + a small "extra" chip (never dump raw JSON).
function summarizeToolResult(content: string): { text: string; extra?: string } {
  const raw = (content || "").trim();
  if (!raw.startsWith("{")) return { text: raw || "Completed" };
  try {
    const j = JSON.parse(raw) as { message?: unknown; status?: unknown; vehicles?: unknown; hours?: { open?: string; close?: string } };
    let text = "Completed";
    if (typeof j.message === "string" && j.message) text = j.message;
    else if (typeof j.status === "string" && j.status) text = prettify(j.status);
    let extra: string | undefined;
    if (Array.isArray(j.vehicles)) extra = `${j.vehicles.length} vehicle${j.vehicles.length === 1 ? "" : "s"}`;
    if (j.hours?.open && j.hours?.close) extra = `${j.hours.open}–${j.hours.close}`;
    return { text, extra };
  } catch {
    return { text: "Completed" };
  }
}
// Turn a tool's `arguments` (JSON string or object) into readable query rows for the expanded step.
function formatArgs(argsIn: unknown): { k: string; v: string }[] {
  let obj: Record<string, unknown> | null = null;
  if (typeof argsIn === "string") { try { obj = JSON.parse(argsIn) as Record<string, unknown>; } catch { obj = null; } }
  else if (argsIn && typeof argsIn === "object") obj = argsIn as Record<string, unknown>;
  if (!obj) return [];
  const rows: { k: string; v: string }[] = [];
  for (const [k, val] of Object.entries(obj)) {
    if (val == null || val === "") continue;
    rows.push({ k: prettify(k), v: typeof val === "object" ? JSON.stringify(val) : String(val) });
  }
  return rows.slice(0, 8);
}
// Make a tool-trace line presentable: replace raw ISO datetimes with a readable date/time.
function humanizeTrace(s: string): string {
  return (s || "").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, (m) => {
    const d = new Date(m.endsWith("Z") ? m : `${m}Z`);
    return Number.isFinite(d.getTime()) ? d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : m;
  });
}

// §01 — buying stage. Map the raw stage code to the doc's funnel wording where recognizable.
const STAGE_LABELS: Record<string, string> = {
  just_looking: "Just Looking",
  browsing: "Just Looking",
  comparing: "Comparing Options",
  comparing_options: "Comparing Options",
  evaluation: "Comparing Options",
  ready_to_visit: "Ready to Visit",
  talking_numbers: "Talking Numbers",
  negotiation: "Talking Numbers",
  ready_to_buy: "Ready to Buy",
};
function stageLabel(stage: string): string {
  return STAGE_LABELS[stage.toLowerCase()] || prettify(stage);
}

// §08 — appointment: type from `intent`, time from `meeting_start_time` (shown in its own timezone).
function apptLabel(a: AppointmentItem): string {
  const type = a.intent ? prettify(a.intent.replace(/^schedule_/, "")) : "Appointment";
  const iso = a.meeting_start_time;
  let when = "";
  if (iso) {
    const d = new Date(iso);
    if (Number.isFinite(d.getTime())) {
      when = d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: a.timezone || undefined });
    }
  }
  return [type, when].filter(Boolean).join(" · ");
}

// Direction of a conversation for the inbound/outbound filter + appointment attribution.
// Calls: from callData.callType. SMS: inferred from who sent the earliest message (user = inbound).
function convDirection(rec: ConvRecord): "in" | "out" | "unknown" {
  if (rec.type === "call") {
    const t = (rec.callData?.callType || "").toLowerCase();
    if (t.includes("inbound")) return "in";
    if (t.includes("outbound")) return "out";
    return "unknown";
  }
  const msgs = rec.smsMessages ?? [];
  if (!msgs.length) return "unknown";
  const earliest = [...msgs].sort((a, b) => (a._ts || 0) - (b._ts || 0))[0];
  return earliest.role === "user" ? "in" : "out";
}

// Who booked an appointment + via which direction — matched from the appointment's conversation_id.
function bookingInfo(appt: AppointmentItem, convs: ConvRecord[]): { agent?: string; dir: "in" | "out" | "unknown" } | null {
  const cid = appt.conversation_id;
  if (!cid) return null;
  const rec = convs.find((c) => c.conversationId === cid);
  if (!rec) return null;
  return { agent: rec.callData?.agentName || undefined, dir: convDirection(rec) };
}
function dirLabel(d: "in" | "out" | "unknown"): string {
  return d === "in" ? "Inbound" : d === "out" ? "Outbound" : "";
}

// §02 — call duration mm:ss from a seconds string.
function fmtDuration(sec?: string): string {
  const n = Math.round(parseFloat(sec || "0"));
  if (!n) return "";
  return `${Math.floor(n / 60)}:${(n % 60).toString().padStart(2, "0")}`;
}
// mm:ss from a numeric seconds offset (transcript line timestamps).
function fmtSecs(s?: number): string {
  if (s == null || !Number.isFinite(s)) return "";
  const n = Math.floor(s);
  return `${Math.floor(n / 60)}:${(n % 60).toString().padStart(2, "0")}`;
}

function exportCsv(customers: InboxCustomer[]) {
  const rows = [
    ["Name", "Phone", "Email", "Unread", "Last interaction"],
    ...customers.map((c) => [
      c.customer_name || "",
      c.mobile_number || "",
      c.email_id || "",
      String(c.unreadCounts?.totalUnread ?? 0),
      c.lastInteractionTime || c.createdAt || "",
    ]),
  ];
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "inbox-conversations.csv";
  a.click();
  URL.revokeObjectURL(url);
}
