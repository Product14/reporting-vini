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
  fetchInboxPersona,
  fetchInboxFeedback,
  postInboxFeedback,
  stopInboxEngagement,
  parseSmsText,
  parseCallTranscript,
  type InboxAuth,
  type InboxCustomer,
  type LeadsPage,
  type ConversationsV2,
  type ConvRecord,
  type LeadJourneyEvent,
  type AppointmentItem,
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
function fmtTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}
function fmtListStamp(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function dayLabel(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "TODAY";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "YESTERDAY";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
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
const IconThumbUp = (p: IconProps) => <Svg {...p}><path d="M7 10v11H3V10zM7 10l5-7a2 2 0 0 1 2 2v3h5a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 16.7 21H7" /></Svg>;
const IconThumbDown = (p: IconProps) => <Svg {...p}><path d="M17 14V3h4v11zM17 14l-5 7a2 2 0 0 1-2-2v-3H5a2 2 0 0 1-2-2.3l1.3-7A2 2 0 0 1 7.3 3H17" /></Svg>;
const IconPhone = (p: IconProps) => <Svg {...p}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2Z" /></Svg>;

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

  const [page, setPage] = useState<LeadsPage | null>(null);
  const [loadingList, setLoadingList] = useState(true);
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
  | { t: number; kind: "msg"; side: "in" | "out"; text: string; tool?: string; sender: string; fb?: { conversationId: string; messageIndex: number } }
  | { t: number; kind: "trace"; label: string }
  | { t: number; kind: "created"; emoji: string; title: string; detail: string }
  | { t: number; kind: "event"; emoji: string; title: string; detail: string } // lead-journey milestone, interleaved in the chat
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
      // Load any existing feedback for each SMS conversation so thumbs reflect prior votes.
      const smsConvs = data.conversations.filter((r) => r.type === "sms").map((r) => r.conversationId);
      const lists = await Promise.all(smsConvs.map((id) => fetchInboxFeedback(auth, id)));
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
    (conversationId: string, messageIndex: number, message: string, rating: "up" | "down", note?: string, reason?: string) => {
      const key = `${conversationId}#${messageIndex}`;
      setFbMap((m) => ({ ...m, [key]: rating }));
      void postInboxFeedback(auth, { conversationId, channel: "sms", messageIndex, message, rating, note, reason });
    },
    [auth],
  );

  // §Report-modal (Figma 9842-21472) — thumbs-down opens a report form; submit posts a "down" vote.
  const [reportTarget, setReportTarget] = useState<{ conversationId: string; messageIndex: number; message: string } | null>(null);
  const fbCtx = useMemo<FbCtx>(
    () => ({ map: fbMap, vote: voteFeedback, openReport: (conversationId, messageIndex, message) => setReportTarget({ conversationId, messageIndex, message }) }),
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
        // §02/§03 — one entry per SMS. Customer-facing text → a bubble; a tool-result payload → a
        // compact trace (never raw JSON). toolCalls on an AI message → a plain-language trace label.
        rec.smsMessages.forEach((m, i) => {
          const t = m._ts || base - (rec.smsMessages!.length - i);
          const rawTool = (m.toolCalls ?? undefined)?.[0];
          const tool = rawTool?.function?.name || rawTool?.name;
          const parsed = parseSmsText(m.content);
          if (parsed.kind === "tool") {
            out.push({ t, kind: "trace", label: tool ? toolLabel(tool) : parsed.summary || "Completed an action" });
            return;
          }
          if (!parsed.text && !tool) return;
          const side = m.role === "user" ? "in" : "out";
          out.push({
            t, kind: "msg", side, text: parsed.text, tool: tool || undefined,
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
      out.push({ t: +new Date(ev.timestamp) || 0, kind: "event", emoji: m.emoji, title: m.title, detail: m.detail });
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
            {summary && (
              <div className="rounded-[15px] border px-5 py-3.5" style={{ borderColor: `${C.primary}33`, background: C.primaryAccent }}>
                <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.primary }}>✦ Summary</p>
                <p className="text-[12px] font-medium leading-[18px]" style={{ color: C.dark }}>{summary}</p>
              </div>
            )}
            {renderWithDividers(nodes, fbCtx)}
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
            voteFeedback(reportTarget.conversationId, reportTarget.messageIndex, reportTarget.message, "down", note, reason);
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
  vote: (conversationId: string, messageIndex: number, message: string, rating: "up" | "down", note?: string) => void;
  openReport: (conversationId: string, messageIndex: number, message: string) => void;
}

/* Insert TODAY/date dividers between nodes on day boundaries (§13). */
function renderWithDividers(nodes: ThreadNode[], fb: FbCtx): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastDay = "";
  nodes.forEach((n, i) => {
    const iso = new Date(n.t).toISOString();
    const dl = dayLabel(iso);
    if (dl && dl !== lastDay) {
      out.push(<DayDivider key={`d${i}`} label={dl} />);
      lastDay = dl;
    }
    out.push(<ThreadNodeView key={`n${i}`} node={n} fb={fb} />);
  });
  return out;
}

function ThreadNodeView({ node, fb }: { node: ThreadNode; fb: FbCtx }) {
  if (node.kind === "call") {
    // Place calls on the correct side, like messages: incoming (customer) left, outgoing (AI) right.
    const inbound = (node.rec.callData?.callType || "").toLowerCase().includes("inbound");
    return (
      <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
        <CallCard rec={node.rec} />
      </div>
    );
  }
  if (node.kind === "trace") {
    return (
      <div className="flex justify-end px-0.5">
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: C.sub }}>
          <IconSearch size={10} /> {node.label}
        </div>
      </div>
    );
  }
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
  return <MessageBubble side={node.side} sender={node.sender} text={node.text} tool={node.tool} at={new Date(node.t).toISOString()} fbNode={node.fb} fb={fb} />;
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

/* §02 — one SMS entry. AI (out) = right/blue; customer (in) = left/white. §03 tool-call trace shows a
 * plain-language label under the AI bubble; AI messages carry a thumbs up/down feedback control. */
function MessageBubble({ side, sender, text, tool, at, fbNode, fb }: {
  side: "in" | "out"; sender: string; text: string; tool?: string; at: string;
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
          {tool && (
            <div className="flex items-center gap-1.5 px-0.5 text-[11px]" style={{ color: C.dark }} title={toolDetail(tool)}>
              <IconSearch size={10} /> {toolLabel(tool)}
            </div>
          )}
          <div className="flex items-center gap-2 px-0.5">
            {fbNode && fb && text && (
              <span className={`flex items-center gap-2 transition-opacity ${rating ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                <button onClick={() => fb.vote(fbNode.conversationId, fbNode.messageIndex, text, "up")}
                  title="Good reply" style={{ color: rating === "up" ? C.primary : C.sub }}><IconThumbUp size={13} /></button>
                <button onClick={() => fb.openReport(fbNode.conversationId, fbNode.messageIndex, text)}
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

/* §02 — a voice call entry, rendered like the production console: direction + status header, Call Title,
 * Agent, an INLINE recording player (always visible — the recordingUrl is a range-enabled S3 mp3), and
 * the transcript on demand. (conversations-v2 exposes no call `summary` field, so we show the transcript
 * in its place; a real summary would need an API/field the dev must add.) */
function CallCard({ rec }: { rec: ConvRecord }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const cd = rec.callData || {};
  const dur = fmtDuration(cd.callDuration);
  const turns = parseCallTranscript(cd.transcript || "");
  const recording = cd.recordingUrl || null;
  const inbound = (cd.callType || "").toLowerCase().includes("inbound");
  const dirLabel = inbound ? "Incoming call" : "Outgoing call";
  const statusOk = (rec.status || "").toLowerCase() === "completed";

  return (
    <div className="w-[85%] max-w-[440px]">
      <div className="overflow-hidden rounded-[14px] border bg-white" style={{ borderColor: C.border }}>
        {/* header: direction + time + status */}
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5" style={{ borderColor: C.border }}>
          <span className="flex items-center gap-2 text-[12px] font-semibold" style={{ color: C.dark }}>
            <span className="flex size-6 items-center justify-center rounded-full" style={{ background: `${C.primary}14`, color: C.primary }}><IconPhone size={12} /></span>
            {dirLabel}
            <span className="font-normal" style={{ color: C.sub }}>· {fmtTime(rec.createdAt)}</span>
          </span>
          <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
            style={statusOk ? { background: "#e3ffea", color: "#0a6029" } : { background: "#f1f5f9", color: "#64748b" }}>
            {prettify(rec.status || "")}
          </span>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          {rec.callTitle && (
            <Field label="Call Title"><span className="text-[12px] font-medium" style={{ color: C.dark }}>{rec.callTitle}</span></Field>
          )}
          {cd.agentName && (
            <Field label="Agent"><span className="text-[12px]" style={{ color: C.dark }}>{cd.agentName}</span></Field>
          )}
          {recording ? (
            <Field label="Call Recording">
              <audio controls preload="metadata" src={recording} className="h-9 w-full max-w-[360px]">
                <track kind="captions" />
              </audio>
            </Field>
          ) : (
            <Field label="Call Recording"><span className="text-[11px]" style={{ color: C.sub }}>No recording available{dur ? ` · ${dur}` : ""}</span></Field>
          )}
          {turns.length > 0 && (
            <div>
              <button onClick={() => setShowTranscript((v) => !v)} className="flex items-center gap-1 text-[11px] font-medium" style={{ color: C.primary }}>
                {showTranscript ? "Hide transcript" : "View transcript"} <IconChevron size={12} className={showTranscript ? "rotate-180" : ""} />
              </button>
              {showTranscript && (
                <div className="mt-2 flex flex-col gap-2 rounded-[10px] border p-3" style={{ borderColor: C.border, background: C.bg }}>
                  {turns.map((t, i) => (
                    <div key={i} className={`flex ${t.speaker === "AI" ? "justify-end" : "justify-start"}`}>
                      <div className="max-w-[80%] rounded-[10px] px-3 py-1.5 text-[12px] leading-[17px]"
                        style={t.speaker === "AI" ? { background: C.blueAccent, color: C.dark } : { border: `1px solid ${C.border}`, background: "#fff", color: C.dark }}>
                        {t.text}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// A labeled row inside the call card (label left, value right) — mirrors the console's Call Title / Agent rows.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-[100px] shrink-0 pt-0.5 text-[11px] font-medium" style={{ color: C.sub }}>{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
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
function RightPanel({ auth, customer, onExpand }: { auth: InboxAuth; customer: InboxCustomer; onExpand: () => void }) {
  const [conv, setConv] = useState<ConversationsV2 | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [stoppedLocal, setStoppedLocal] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on customer change
    setConv(null);
    setPersona(null);
    setStoppedLocal(null);
    fetchInboxConversations(auth, customer.customer_id, { limit: 30 }).then((d) => { if (on) setConv(d); });
    fetchInboxPersona(auth, customer.customer_id).then((p) => { if (on) setPersona(p); });
    return () => { on = false; };
  }, [auth, customer.customer_id]);

  const lead = conv?.leads?.[0];
  const appts = conv?.nextAppointments ?? [];
  const actions = (conv?.nextActionItems ?? []).filter((a) => a.is_active && !a.is_completed);
  const stopped = stoppedLocal ?? !!lead?.stopAiEngagement;

  // persona-sourced Intent + AI Insights (same fields the modal shows)
  const vi = persona?.customerPreferences?.vehicleInterest;
  const vehicle = vi ? [vi.year?.value, vi.make?.value, vi.model?.value, vi.trim?.value].filter(Boolean).join(" ") : "";
  const budget = persona?.customerPreferences?.finance?.budgetMax?.value;
  const pStage = persona?.purchaseIntent?.stage?.value;
  const trade = persona?.tradeVehicles?.[0]?.vehicle;
  const summary = persona?.conversationMemory?.summaryShort;
  const motivations = persona?.decisionContext?.motivations ?? [];
  const objections = [...(persona?.decisionContext?.objections ?? []), ...(persona?.decisionContext?.painPoints ?? [])];
  const hasIntent = !!(vehicle || (budget != null && budget !== "NOT_DISCUSSED") || pStage || trade);

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
                <div key={i} className="rounded-xl border p-3" style={{ borderColor: C.border }}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[12px] font-medium" style={{ color: C.dark }}>{a.description || prettify(a.intent || "Follow up")}</p>
                    {a.priority && <span className="shrink-0 text-[9px] font-bold uppercase" style={{ color: a.priority === "HIGH" ? C.red : C.sub }}>{a.priority}</span>}
                  </div>
                  {a.due_date && <p className="mt-0.5 text-[11px]" style={{ color: C.sub }}>Due {fmtTime(a.due_date)}</p>}
                </div>
              ))}
            </RightSection>
          )}

          {hasIntent && (
            <RightSection title="Intent">
              <div className="rounded-xl border p-3" style={{ borderColor: C.border }}>
                {pStage && <Row label="Buying stage" value={stageLabel(String(pStage))} />}
                {vehicle && <Row label="Vehicle" value={vehicle} />}
                {budget != null && budget !== "NOT_DISCUSSED" && <Row label="Budget" value={typeof budget === "number" ? `$${budget.toLocaleString()}` : String(budget)} />}
                {trade && <Row label="Trade-in" value={[trade.year, trade.make, trade.model].filter(Boolean).join(" ")} />}
              </div>
            </RightSection>
          )}

          {(summary || motivations.length > 0 || objections.length > 0) && (
            <RightSection title="AI insights">
              {summary && <p className="text-[12px] leading-[18px]" style={{ color: C.dark }}>{summary}</p>}
              {motivations.length > 0 && (
                <div>
                  <p className="mb-1 mt-1 text-[10px] font-semibold uppercase" style={{ color: C.sub }}>Motivations</p>
                  <ul className="flex flex-col gap-1">{motivations.slice(0, 4).map((m, i) => <li key={i} className="text-[11px] leading-[16px]" style={{ color: C.dark }}>• {m.value}</li>)}</ul>
                </div>
              )}
              {objections.length > 0 && (
                <div>
                  <p className="mb-1 mt-1 text-[10px] font-semibold uppercase" style={{ color: C.sub }}>Objections & pain points</p>
                  <ul className="flex flex-col gap-1">{objections.slice(0, 4).map((m, i) => <li key={i} className="text-[11px] leading-[16px]" style={{ color: C.dark }}>• {m.value}</li>)}</ul>
                </div>
              )}
            </RightSection>
          )}

          <RightSection title="Lead journey">
            <LeadTimeline journey={conv?.leadJourney ?? []} nextScheduled={conv?.nextScheduledTasks?.[0] as { timing?: string; detail?: string; scheduledAt?: string } | undefined} />
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
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on customer change
    setPersona("loading");
    setConv(null);
    setStoppedLocal(null);
    fetchInboxPersona(auth, customer.customer_id).then((p) => { if (on) setPersona(p ?? "error"); });
    fetchInboxConversations(auth, customer.customer_id, { limit: 30 }).then((d) => { if (on) setConv(d); });
    return () => { on = false; };
  }, [auth, customer.customer_id]);

  const P = persona && typeof persona === "object" ? persona : undefined;
  const lead = conv?.leads?.[0];
  const openActions = (conv?.nextActionItems ?? []).filter((a) => a.is_active && !a.is_completed);
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

  const vi = P?.customerPreferences?.vehicleInterest;
  const vehicle = vi ? [vi.year?.value, vi.make?.value, vi.model?.value, vi.trim?.value].filter(Boolean).join(" ") : "";
  const budget = P?.customerPreferences?.finance?.budgetMax?.value;
  const stage = P?.purchaseIntent?.stage?.value;
  const trade = P?.tradeVehicles?.[0]?.vehicle;
  const motivations = P?.decisionContext?.motivations ?? [];
  const objections = [...(P?.decisionContext?.objections ?? []), ...(P?.decisionContext?.painPoints ?? [])];
  const summary = P?.conversationMemory?.summaryShort;

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
                  ) : openActions.map((a, i) => {
                    const due = dueLabel(a.due_date);
                    return (
                      <div key={i} className="rounded-[10px] border px-4 py-3" style={{ borderColor: C.border }}>
                        <p className="text-[12px] font-semibold capitalize leading-[18px]" style={{ color: C.dark }}>{a.description || prettify(a.intent || "Follow up")}</p>
                        <div className="mt-3 flex items-center justify-between">
                          {due.text ? <span className="rounded-[5px] px-3 py-0.5 text-[12px] font-medium" style={due.style}>{due.text}</span> : <span />}
                          <Assignee who={String(a.assigned_to ?? "")} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : tab === "journey" ? (
            <LeadTimeline journey={conv?.leadJourney ?? []} nextScheduled={conv?.nextScheduledTasks?.[0] as { timing?: string; detail?: string; scheduledAt?: string } | undefined} />
          ) : tab === "intent" ? (
            <div className="flex flex-col gap-3">
              {stage && <DetailCard title="Buying stage"><p className="text-[13px] font-medium" style={{ color: C.dark }}>{stageLabel(String(stage))}</p></DetailCard>}
              {vehicle && <DetailCard title="Vehicle interest"><p className="text-[13px] font-medium" style={{ color: C.dark }}>{vehicle}</p></DetailCard>}
              {budget != null && budget !== "NOT_DISCUSSED" && <DetailCard title="Budget"><p className="text-[13px] font-medium" style={{ color: C.dark }}>{typeof budget === "number" ? `$${budget.toLocaleString()}` : String(budget)}</p></DetailCard>}
              {trade && <DetailCard title="Trade-in"><p className="text-[13px] font-medium" style={{ color: C.dark }}>{[trade.year, trade.make, trade.model].filter(Boolean).join(" ")}</p></DetailCard>}
              {!stage && !vehicle && budget == null && !trade && <EmptyDetail label={persona === "error" ? "Intent profile unavailable." : "No intent signals captured yet."} />}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {summary && <DetailCard title="Summary"><p className="text-[12px] leading-[18px]" style={{ color: C.dark }}>{summary}</p></DetailCard>}
              {motivations.length > 0 && <DetailCard title="Motivations"><ul className="flex flex-col gap-1">{motivations.slice(0, 5).map((m, i) => <li key={i} className="text-[12px] leading-[17px]" style={{ color: C.dark }}>• {m.value}</li>)}</ul></DetailCard>}
              {objections.length > 0 && <DetailCard title="Objections & pain points"><ul className="flex flex-col gap-1">{objections.slice(0, 5).map((m, i) => <li key={i} className="text-[12px] leading-[17px]" style={{ color: C.dark }}>• {m.value}</li>)}</ul></DetailCard>}
              {!summary && motivations.length === 0 && objections.length === 0 && <EmptyDetail label={persona === "error" ? "AI insights unavailable." : "No AI insights captured yet."} />}
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

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-3.5" style={{ borderColor: C.border, background: C.bg }}>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.sub }}>{title}</p>
      {children}
    </div>
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
  const startOfDay = (x: Date) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
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
    const s = new Date(now); s.setHours(0, 0, 0, 0);
    return { startDate: s.toISOString(), endDate: end };
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
};
function toolLabel(name: string): string {
  return TOOL_LABELS[name] || "Looked something up";
}
function toolDetail(name: string): string {
  return `The AI used a tool to ${toolLabel(name).toLowerCase()}.`;
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
