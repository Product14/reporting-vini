"use client";

/* Console-v2 pages that sit alongside the Inbox (each iframed by the parent console at its own route).
 * Same visual language as InboxView; wired to EXISTING data — Customers → leads/v2 (inbox api),
 * Action Items → /api/action-items, Appointments → /api/meetings. Campaigns has no team-wide list
 * endpoint yet (shown as an explicit gap). Scope (team/enterprise/token/env) comes from useScenario(). */

import { Suspense, useEffect, useState } from "react";
import { useScenario } from "@/components/reports/scenario";
import { fetchInboxCustomers, type InboxCustomer } from "@/components/inbox/api";
import { fetchActionItems, fetchMeetings, type ActionItem } from "@/components/reports/liveData";
import type { Meeting } from "@/components/reports/data";

const C = {
  primary: "#4600f2",
  primaryAccent: "#efe9ff",
  border: "#e5e7eb",
  sub: "#626f81",
  dark: "#030712",
  bg: "#fafafa",
  orange: "#e47200",
  orangeAccent: "#fff0dd",
  red: "#ca1f34",
  green: "#0a6029",
  greenAccent: "#e3ffea",
};

function fmtWhen(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function initials(name: string): string {
  const p = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  return (p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p[p.length - 1][0]).toUpperCase();
}
const AVATAR = ["#006ca7", "#5a22cb", "#a70096", "#38a700", "#d52c2f", "#00aed5", "#f8712e", "#207fb2", "#4600f2", "#0a6029"];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR[h % AVATAR.length];
}

/* ── shared chrome ──────────────────────────────────────────────────────────── */
function Shell({ title, emoji, actions, children }: { title: string; emoji: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const { account } = useScenario();
  return (
    <div className="flex h-[100dvh] flex-col bg-white" style={{ color: C.dark }}>
      <header className="flex shrink-0 items-center justify-between border-b bg-white px-8 py-3" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg text-[15px] text-white" style={{ background: C.primary }}>{emoji}</span>
          <h1 className="text-[16px] font-semibold" style={{ color: C.dark }}>{title}</h1>
          {account?.name && <span className="ml-1 text-[12px]" style={{ color: C.sub }}>· {account.name}</span>}
        </div>
        <div className="flex items-center gap-3">{actions}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ background: C.bg }}>{children}</div>
    </div>
  );
}

function NoScope() {
  const { teamId } = useScenario();
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-[#fafafa] px-6 text-center">
      <p className="text-[13px]" style={{ color: C.sub }}>
        {teamId ? "Missing enterprise_id in the embed URL." : "No rooftop selected — the host must pass ?team_id= and ?enterprise_id=."}
      </p>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
      <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: C.border }}>
        <table className="w-full border-collapse text-left">
          <thead>
            <tr style={{ background: C.bg }}>
              {head.map((h) => (
                <th key={h} className="border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide" style={{ borderColor: C.border, color: C.sub }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}
const Td = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <td className={`border-b px-4 py-3 align-middle text-[12px] ${className}`} style={{ borderColor: C.border, color: C.dark }}>{children}</td>
);
function Empty({ label }: { label: string }) {
  return <div className="mx-auto max-w-[1200px] px-6 py-20 text-center text-[13px]" style={{ color: C.sub }}>{label}</div>;
}
function Loading() {
  return (
    <div className="mx-auto max-w-[1200px] animate-pulse px-6 py-6">
      <div className="overflow-hidden rounded-xl border" style={{ borderColor: C.border }}>
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-12 border-b" style={{ borderColor: C.border, background: i % 2 ? "#fff" : "#fafafa" }} />)}
      </div>
    </div>
  );
}
function Pill({ text, bg, fg }: { text: string; bg: string; fg: string }) {
  return <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: bg, color: fg }}>{text}</span>;
}

/* ══ Customers (leads/v2) ═══════════════════════════════════════════════════ */
export function CustomersView() {
  return <Suspense fallback={null}><Customers /></Suspense>;
}
function Customers() {
  const { teamId, enterpriseId, spyneToken, spyneEnv } = useScenario();
  const [rows, setRows] = useState<InboxCustomer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on scope change
    if (!teamId || !enterpriseId) { setRows([]); return; }
    let on = true;
    setRows(null);
    fetchInboxCustomers({ teamId, enterpriseId, spyneToken, spyneEnv }, { limit: 100, searchTerm: q || undefined }).then((p) => {
      if (!on) return; setRows(p.customers); setTotal(p.pagination.totalCustomers);
    });
    return () => { on = false; };
  }, [teamId, enterpriseId, spyneToken, spyneEnv, q]);

  if (!teamId || !enterpriseId) return <NoScope />;
  return (
    <Shell title="Customers" emoji="👥" actions={
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customers"
        className="w-64 rounded-[10px] border px-3.5 py-2 text-[12px] outline-none focus:border-[#4600f2]" style={{ borderColor: C.border }} />
    }>
      {rows === null ? <Loading /> : rows.length === 0 ? <Empty label="No customers found." /> : (
        <>
          <p className="mx-auto max-w-[1200px] px-6 pt-5 text-[12px]" style={{ color: C.sub }}>{total.toLocaleString()} customers</p>
          <Table head={["Customer", "Phone", "Email", "Unread", "Last interaction"]}>
            {rows.map((c) => (
              <tr key={c.customer_id}>
                <Td>
                  <span className="flex items-center gap-2">
                    <span className="flex size-6 items-center justify-center rounded-full text-[10px] font-medium text-white" style={{ background: avatarColor(c.customer_id) }}>{initials(c.customer_name || "?")}</span>
                    <span className="font-medium">{c.customer_name || "Unknown"}</span>
                  </span>
                </Td>
                <Td>{c.mobile_number || "—"}</Td>
                <Td>{c.email_id || "—"}</Td>
                <Td>{(c.unreadCounts?.totalUnread ?? 0) > 0 ? <Pill text={String(c.unreadCounts!.totalUnread)} bg={C.orangeAccent} fg={C.orange} /> : "—"}</Td>
                <Td className="text-[#626f81]">{fmtWhen(c.lastInteractionTime || c.createdAt)}</Td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Shell>
  );
}

/* ══ Action Items (/api/action-items) ══════════════════════════════════════ */
export function ActionItemsView() {
  return <Suspense fallback={null}><ActionItems /></Suspense>;
}
function ActionItems() {
  const { teamId, spyneToken } = useScenario();
  const [scope, setScope] = useState<"open" | "overdue">("open");
  const [rows, setRows] = useState<ActionItem[] | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on scope change
    if (!teamId) { setRows([]); return; }
    let on = true;
    setRows(null);
    fetchActionItems(teamId, { scope, limit: 200, spyneToken }).then((a) => { if (on) setRows(a); });
    return () => { on = false; };
  }, [teamId, spyneToken, scope]);

  if (!teamId) return <NoScope />;
  const prioStyle = (p: string) => p?.toUpperCase() === "HIGH" ? { bg: "#fdecee", fg: C.red } : p?.toUpperCase() === "LOW" ? { bg: "#f1f5f9", fg: "#64748b" } : { bg: C.orangeAccent, fg: C.orange };
  return (
    <Shell title="Action Items" emoji="⚑" actions={
      <div className="flex items-center rounded-[12px] border p-0.5" style={{ borderColor: C.border }}>
        {(["open", "overdue"] as const).map((s) => (
          <button key={s} onClick={() => setScope(s)} className="rounded-[10px] px-3 py-1.5 text-[12px] font-medium capitalize transition-colors"
            style={scope === s ? { background: C.primaryAccent, color: C.primary } : { color: C.sub }}>{s}</button>
        ))}
      </div>
    }>
      {rows === null ? <Loading /> : rows.length === 0 ? <Empty label={`No ${scope} action items.`} /> : (
        <Table head={["Task", "Customer", "Priority", "Due", "Dept"]}>
          {rows.map((a) => { const s = prioStyle(a.priority); return (
            <tr key={a.id}>
              <Td className="font-medium capitalize">{a.description || a.intent}</Td>
              <Td>{a.customer || a.phone || "—"}</Td>
              <Td>{a.priority ? <Pill text={a.priority} bg={s.bg} fg={s.fg} /> : "—"}</Td>
              <Td className="text-[#626f81]">{fmtWhen(a.dueAt)}</Td>
              <Td className="capitalize text-[#626f81]">{a.dept}</Td>
            </tr>
          ); })}
        </Table>
      )}
    </Shell>
  );
}

/* ══ Appointments (/api/meetings) ══════════════════════════════════════════ */
export function AppointmentsView() {
  return <Suspense fallback={null}><Appointments /></Suspense>;
}
function Appointments() {
  const { teamId, enterpriseId, spyneToken, spyneEnv } = useScenario();
  const [scope, setScope] = useState<"upcoming" | "window">("upcoming");
  const [rows, setRows] = useState<Meeting[] | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on scope change
    if (!teamId) { setRows([]); return; }
    let on = true;
    setRows(null);
    fetchMeetings({ teamId, enterpriseId, scope, bucket: "last30", spyneToken, spyneEnv }).then((r) => { if (on) setRows(r.meetings); });
    return () => { on = false; };
  }, [teamId, enterpriseId, spyneToken, spyneEnv, scope]);

  if (!teamId) return <NoScope />;
  const statusStyle = (s: string) => /cancel|no_show|lost/i.test(s) ? { bg: "#fdecee", fg: C.red } : /complete|confirm/i.test(s) ? { bg: C.greenAccent, fg: C.green } : { bg: C.primaryAccent, fg: C.primary };
  return (
    <Shell title="Appointments" emoji="🗓" actions={
      <div className="flex items-center rounded-[12px] border p-0.5" style={{ borderColor: C.border }}>
        {(["upcoming", "window"] as const).map((s) => (
          <button key={s} onClick={() => setScope(s)} className="rounded-[10px] px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={scope === s ? { background: C.primaryAccent, color: C.primary } : { color: C.sub }}>{s === "upcoming" ? "Upcoming" : "Last 30 days"}</button>
        ))}
      </div>
    }>
      {rows === null ? <Loading /> : rows.length === 0 ? <Empty label={`No ${scope === "upcoming" ? "upcoming" : "recent"} appointments.`} /> : (
        <Table head={["Customer", "When", "Vehicle", "Type", "Status", "Assigned"]}>
          {rows.map((m) => { const s = statusStyle(m.status || ""); return (
            <tr key={m.id}>
              <Td className="font-medium">{m.customer || m.phone || "—"}</Td>
              <Td className="text-[#626f81]">{fmtWhen(m.when)}</Td>
              <Td>{m.vehicle || "—"}</Td>
              <Td className="capitalize">{(m.intent || "").replace(/^schedule_/, "").replace(/_/g, " ") || "—"}</Td>
              <Td>{m.status ? <Pill text={m.status.replace(/_/g, " ")} bg={s.bg} fg={s.fg} /> : "—"}</Td>
              <Td className="capitalize text-[#626f81]">{m.assignedTo && m.assignedTo !== "SYSTEM" ? m.assignedTo : "Vini AI"}</Td>
            </tr>
          ); })}
        </Table>
      )}
    </Shell>
  );
}

/* ══ Campaigns — no team-wide list endpoint exists yet ═════════════════════ */
export function CampaignsView() {
  return <Suspense fallback={null}><Campaigns /></Suspense>;
}
function Campaigns() {
  const { teamId } = useScenario();
  if (!teamId) return <NoScope />;
  return (
    <Shell title="Campaigns" emoji="📣">
      <div className="mx-auto max-w-[640px] px-6 py-20 text-center">
        <p className="text-[15px] font-semibold" style={{ color: C.dark }}>No campaigns endpoint yet</p>
        <p className="mx-auto mt-2 max-w-[460px] text-[13px] leading-[20px]" style={{ color: C.sub }}>
          There&apos;s no team-wide campaign-list API in the current V2 set — campaign start/end only appear
          per-lead in the conversation lead-journey. Share a campaigns endpoint and I&apos;ll wire this page to it.
        </p>
      </div>
    </Shell>
  );
}
