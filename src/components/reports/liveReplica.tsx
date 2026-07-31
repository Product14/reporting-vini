/* Pixel-close replica of the Figma "Overview" design (node 9846-110, Conversational-AI-2.0 file) —
 * greeting hero, per-agent performance cards with a photo mockup, whole-fleet funnel, hot leads +
 * appointments, action items and recent conversations. Fed by the SAME real data OverviewView.tsx
 * already computes (fleet/agents/warmLeads/namedAppts/aiStats/workItems/conversations) — this file is
 * a presentation layer, not a new data source.
 *
 * A few literal Figma values have no honest real-data source and are adapted rather than faked:
 *   - The hero's "Good morning, John" names a specific person; this app has no logged-in user identity,
 *     so the greeting drops the name (time-of-day + wave only).
 *   - Each agent card's "+22% from last period" (a per-agent close-rate delta) isn't computed anywhere
 *     today — omitted rather than fabricated.
 *   - "Where the leads stand" is a real lead funnel (reached ⊇ connected ⊇ qualified ⊇ appt), not an
 *     independent part-of-whole split — the stacked bar renders the DROP-OFF between stages (so bands
 *     sum to the reached total), which reproduces the Figma look exactly while staying mathematically honest.
 *   - Hot leads / appointments / action items reuse whichever real fields are the closest honest match
 *     (e.g. appointment "how" instead of a fabricated assignee name); noted inline where it matters.
 */

import React from "react";
import Image from "next/image";
import type { Account } from "./accounts";
import type { AgentData, WarmLeadItem, NamedAppt } from "./data";
import { fmtInt } from "./data";
import type { ActionItem, ActionItemStats, Conversation } from "./liveData";
import type { FleetLive } from "./liveData";
import { fmtRate, fmtDuration, fmtSecs, fmtWhenShort, agentDisplayName, ConversationDrawer } from "./kitV3";
import { UnlockPotentialBanner } from "./valueStory";
import { CountUp, useInView } from "./anim";
import type { CustomizeCtrl } from "./customize";

/* ── palette (exact Figma tokens for this design — intentionally not the site's #813fed accent) ── */
const C = {
  primary: "#4600f2",
  dark: "#030712",
  sub: "#626f81",
  border: "#e5e7eb",
  green: "#0a6029",
  greenBg: "#e8ffee",
  red: "#ca1f34",
  redBg: "#ffecec",
  blue: "#2f7bff",
  blueBg: "#e9f4ff",
  orange: "#e47200",
  orangeBg: "#fff0dd",
  grey: "#535353",
  greyBg: "#efefef",
};
const IB_TONES = ["#e9f4ff", "#bad9ff", "#81baff", "#2f7bff"];
const OB_TONES = ["#c9f2d8", "#7ceda6", "#23ab70", "#0a6029"];
const AVATAR_COLORS = ["#006ca7", "#23ab70", "#a74600", "#a70064", "#0600a7", "#6d726b"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}
function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/* Scoped motion (borrowed from the outbound prototype): staggered fade-up on section entrance +
 * a subtle hover-lift on the agent cards. Reduced-motion respected. */
function LiveAnims() {
  return (
    <style>{`
      @keyframes lvFadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      .lv-rise { animation: lvFadeUp .5s cubic-bezier(.16,1,.3,1) both; }
      .lv-lift { transition: box-shadow .22s ease, transform .22s ease; }
      .lv-lift:hover { transform: translateY(-2px); box-shadow: 0 18px 36px -20px rgba(40,35,80,0.3); }
      @media (prefers-reduced-motion: reduce) { .lv-rise { animation: none; } }
    `}</style>
  );
}
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning 👋" : h < 18 ? "Good afternoon 👋" : "Good evening 👋";
}

/* ══════════════════════════ 1. Hero — greeting + value-prop strip ══════════════════════════ */
function HeroTile({ icon, value, label, sub, missing }: { icon: string; value: React.ReactNode; label: string; sub: string; missing?: boolean }) {
  // A metric with no data isn't a dead "—" — it's a feature that isn't switched on. Turn it into an
  // upsell that hands the dealer to Training to enable it.
  if (missing) {
    // A metric with no data = a feature not switched on. Since Training is no longer an in-app
    // destination, this is an informational nudge (points at the Spyne team), not a navigating button.
    return (
      <div className="flex flex-1 basis-0 min-w-[170px] flex-col items-start gap-[15px] rounded-lg border border-dashed border-[#d8caff] bg-[#faf8ff] p-[15px] text-left">
        <Image src={icon} alt="" width={28} height={28} className="opacity-40" />
        <div className="flex flex-col items-start gap-1">
          <p className="text-[12px] font-semibold text-[#030712]">{label}</p>
          <p className="text-[11.5px] text-[#9aa1ac]">Not switched on yet</p>
          <span className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] font-bold text-[#4600f2]">Ask your Spyne team to enable</span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 basis-0 min-w-[170px] flex-col items-start gap-[15px] rounded-lg border border-[#e5e7eb] bg-white p-[15px]">
      {icon.startsWith("/") ? <Image src={icon} alt="" width={28} height={28} /> : <span className="text-[24px] leading-none">{icon}</span>}
      <div className="flex flex-col items-start gap-1">
        <p className="text-[16px] font-bold leading-[20px] text-[#030712]">{value}</p>
        <p className="text-[12px] font-semibold text-[#030712]">{label}</p>
        <p className="text-[12px] text-[#626f81]">{sub}</p>
      </div>
    </div>
  );
}

// Service hero: 4 metric tiles in ONE divided container, each an icon-chip + "N Noun" headline + sub
// (matches the Figma service overview — not the sales tile grid).
function ServiceHeroTiles({ fleet, actionStats, hotLeads }: { fleet: FleetLive; actionStats: ActionItemStats | null; hotLeads: number }) {
  const tiles = [
    { icon: "/live-overview/icon-afterhours.svg", chipBg: "#ede9fe", headline: <><CountUp value={fleet.afterHours} /> Leads</>, sub: "Captured after-hours" },
    { icon: "/live-overview/icon-actionitems.svg", chipBg: "#e7f6ec", headline: <>{actionStats ? <CountUp value={actionStats.created} /> : "—"} Action Items</>, sub: actionStats ? `${fmtInt(actionStats.open)} items are still open` : "syncing…" },
    { icon: "🔥", chipBg: "#fde9ec", headline: <><CountUp value={hotLeads} /> Hot Leads</>, sub: "warmed & in-market now" },
    { icon: "/live-overview/icon-appointments.svg", chipBg: "#e8f0ff", headline: <><CountUp value={fleet.appointments} /> Appointments</>, sub: fleet.appointmentsAssisted > 0 ? `+${fmtInt(fleet.appointmentsAssisted)} AI-assisted (CRM)` : "AI-booked meetings" },
  ];
  return (
    <div className="flex w-full flex-wrap items-stretch overflow-hidden rounded-xl border border-[#e5e7eb] bg-white">
      {tiles.map((t, i) => (
        <div key={i} className={`flex flex-1 basis-[210px] items-start gap-3 px-6 py-5 ${i > 0 ? "border-l border-[#e5e7eb]" : ""}`}>
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg" style={{ background: t.chipBg }}>
            {t.icon.startsWith("/") ? <Image src={t.icon} alt="" width={18} height={18} /> : <span className="text-[16px] leading-none">{t.icon}</span>}
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-[18px] font-bold leading-[22px] text-[#030712]">{t.headline}</p>
            <p className="text-[12px] text-[#626f81]">{t.sub}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LiveHero({ fleet, actionStats, controls, serviceMode, hotLeads = 0 }: { fleet: FleetLive; actionStats: ActionItemStats | null; controls?: React.ReactNode; serviceMode?: boolean; hotLeads?: number }) {
  const tiles = [
    { icon: "/live-overview/icon-speed.svg", value: fmtSecs(fleet.responseTimeSec), label: "Speed-to-lead", sub: "avg first response", missing: fleet.responseTimeSec == null },
    { icon: "/live-overview/icon-resolved.svg", value: actionStats ? <CountUp value={actionStats.created} /> : "—", label: "Follow-ups", sub: "logged & worked for your team", missing: !actionStats?.created },
    { icon: "/live-overview/icon-actionitems.svg", value: actionStats ? <CountUp value={actionStats.created} /> : "—", label: "Action Items created", sub: actionStats ? `${fmtInt(actionStats.open)} of which are open` : "syncing…" },
    { icon: "/live-overview/icon-appointments.svg", value: <CountUp value={fleet.appointments} />, label: "Appointments Booked", sub: fleet.appointmentsAssisted > 0 ? `+${fmtInt(fleet.appointmentsAssisted)} AI-assisted (CRM)` : "AI-booked meetings" },
    { icon: "/live-overview/icon-afterhours.svg", value: <><CountUp value={fleet.afterHours} /> leads</>, label: "Captured after-hours", sub: "while the floor was closed" },
  ];
  return (
    <section
      className="flex flex-col items-center justify-center gap-6 rounded-lg border border-[#e5e7eb] px-10 py-6"
      style={{ backgroundImage: "linear-gradient(90deg, rgba(91,109,246,0.1) 1.27%, rgba(127,106,242,0.1) 23.38%, rgba(182,81,215,0.1) 66.65%, rgba(232,62,84,0.1) 85.82%, rgba(237,137,57,0.1) 112.66%), linear-gradient(90deg, #fff, #fff)" }}
    >
      <div className="flex flex-col items-center gap-1.5">
        <Image src="/live-overview/icon-sparkle.svg" alt="" width={18} height={18} />
        <p className="text-[14px] text-[#030712]">{greeting()}</p>
        <p className="text-[22px] font-bold tracking-[-0.01em] text-[#030712]">{serviceMode ? "Here’s what your Service AI agents handled" : "Here’s what your sales AI handled"}</p>
      </div>
      {controls && <div className="no-print flex flex-wrap items-center justify-center gap-2.5">{controls}</div>}
      {serviceMode ? (
        <ServiceHeroTiles fleet={fleet} actionStats={actionStats} hotLeads={hotLeads} />
      ) : (
        <div className="flex w-full flex-wrap items-stretch justify-center gap-[15px]">
          {tiles.map((t) => <HeroTile key={t.label} {...t} />)}
        </div>
      )}
    </section>
  );
}

/* ══════════════════════════ 2. Agent performance card ══════════════════════════ */
export function LiveAgentCard({ agent, onClick }: { agent: AgentData; onClick?: () => void }) {
  const [barRef, grown] = useInView<HTMLDivElement>(0.6); // grows the stacked funnel bar in when scrolled to
  const inbound = agent.dir === "Inbound";
  const lf = agent.leadFunnel;
  const reached = lf?.contacted ?? agent.report.leadsAttempted;
  const connected = lf?.connected ?? agent.metrics.conversations;
  const qualified = lf?.qualified ?? agent.metrics.qualified;
  const appts = agent.metrics.appointments;
  const person = agent.report.summary.person || agent.name;
  const tones = inbound ? IB_TONES : OB_TONES;
  // The drop-off BETWEEN each stage, as a share of the reached total — bands sum to 100% of `reached`
  // (a true funnel, not an independent part-of-whole split; see file header).
  const seg = (a: number, b: number) => (reached > 0 ? Math.max(0, ((a - b) / reached) * 100) : 0);
  const segments = [
    { pct: seg(reached, connected), color: tones[0] },
    { pct: seg(connected, qualified), color: tones[1] },
    { pct: seg(qualified, appts), color: tones[2] },
    { pct: reached > 0 ? (appts / reached) * 100 : 0, color: tones[3] },
  ];
  const legend = [
    { value: reached, label: "Leads Reached", color: tones[0] },
    { value: connected, label: "Real Conversations", color: tones[1] },
    { value: qualified, label: "Qualified Leads", color: tones[2] },
    { value: appts, label: "Appointments Booked", color: tones[3] },
  ];
  const ministats: [string, string][] = [
    ["Calls", fmtInt(agent.metrics.calls)],
    ["SMS sent", fmtInt(agent.metrics.smsSent)],
    ["Talk Time", fmtDuration(agent.metrics.talkMinutes)],
    ["Hand-offs", fmtInt((agent.report.callFlow?.transferred ?? 0) + (agent.report.callFlow?.callbacks ?? 0))],
  ];
  return (
    <button onClick={onClick} className="lv-lift flex flex-1 basis-0 flex-col items-start gap-6 overflow-hidden rounded-[15px] border border-[#e5e7eb] bg-white p-5 text-left">
      <div className="flex w-full items-start justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <span
            className="relative flex h-[60px] w-[60px] flex-none items-center justify-center rounded-full p-[2.5px]"
            style={{ background: inbound ? "linear-gradient(135deg,#86efac,#93c5fd,#c4b5fd)" : "linear-gradient(135deg,#fdba74,#fca5a5,#f0abfc)" }}
          >
            <span className="relative h-full w-full overflow-hidden rounded-full border-2 border-white">
              <Image src={inbound ? "/live-overview/agent-emily.png" : "/live-overview/agent-jenny.png"} alt="" fill className="object-cover object-top" />
            </span>
          </span>
          <div className="flex flex-col items-start gap-2">
            <p className="text-[20px] font-semibold leading-none text-[#030712]">{possessive(person)} Performance</p>
            <span
              className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium"
              style={inbound ? { background: C.blueBg, color: C.blue } : { background: C.greenBg, color: C.green }}
            >
              {inbound ? "↙" : "↗"} {agent.dept} {agent.dir}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <p className="text-[32px] font-semibold leading-none tracking-[-1px] text-[#030712]">{fmtRate(appts, qualified)}</p>
          <p className="text-[12px] font-medium text-[#626f81]">Close Rate</p>
        </div>
      </div>

      <div className="flex w-full flex-col gap-3 rounded-[15px] border border-[#e5e7eb] p-4">
        <div className="flex w-full items-center justify-between">
          <p className="text-[13px] font-semibold text-[#030712]">Where {possessive(person)} leads stand</p>
          <p className="text-[22px] font-bold tracking-[-0.4px] text-[#030712]"><CountUp value={reached} /></p>
        </div>
        <div ref={barRef} className="flex h-2 w-full overflow-hidden rounded-lg bg-[#f3f4f6]">
          {segments.map((s, i) => (
            <div
              key={i}
              className="h-full"
              style={{ width: grown ? `${s.pct}%` : "0%", background: s.color, transition: `width .9s cubic-bezier(.16,1,.3,1) ${i * 90}ms` }}
            />
          ))}
        </div>
        <div className="flex w-full flex-col">
          {legend.map((l, i) => (
            <div key={l.label} className={`flex w-full items-center justify-between py-2.5 ${i > 0 ? "border-t border-[#f0f1f3]" : ""}`}>
              <div className="flex items-center gap-2.5">
                <span className="h-3 w-3 flex-none rounded-sm" style={{ background: l.color }} />
                <span className="text-[13px] tracking-[-0.24px] text-[#626f81]">{l.label}</span>
              </div>
              <span className="text-[15px] font-semibold tracking-[-0.28px] text-[#030712]"><CountUp value={l.value} /></span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex w-full items-center gap-6 rounded-[15px] border border-[#e5e7eb] px-6 py-1.5">
        {ministats.map(([k, v], i) => (
          <React.Fragment key={k}>
            {i > 0 && <div className="h-12 w-px flex-none bg-[#e5e7eb]" />}
            <div className="flex flex-1 basis-0 flex-col items-start gap-2.5">
              <p className="text-[12px] font-medium text-[#626f81]">{k}</p>
              <p className="text-[16px] font-semibold text-[#030712]">{v}</p>
            </div>
          </React.Fragment>
        ))}
      </div>
    </button>
  );
}

/* ══════════════════════════ 2b. Agent NOT available — upsell placeholder ══════════════════════════ */
// Direction-specific value prop shown when a dept's Inbound/Outbound agent isn't live yet. Clicking the
// card emails the dealer's Spyne team to switch that agent on.
const UPSELL_COPY: Record<string, { headline: string; body: string }> = {
  "Sales Inbound": { headline: "Never miss a buyer who calls in", body: "Emily answers every inbound sales lead instantly — day or night — and books the test drive before they call the next dealer." },
  "Sales Outbound": { headline: "Turn old leads into tomorrow's deals", body: "Jenny works your aged and unsold leads, wins back the ones who slipped away, and books them back in." },
  "Service Inbound": { headline: "Answer every service call, instantly", body: "Emily picks up every inbound service call, books the appointment, and frees your advisors for the drive lane." },
  "Service Outbound": { headline: "Fill tomorrow's empty bays tonight", body: "Jenny wins back the customers who slipped away. You wake up to a booked schedule." },
};
function AgentUpsellCard({ dept, dir }: { dept: "Sales" | "Service"; dir: "Inbound" | "Outbound" }) {
  const inbound = dir === "Inbound";
  const copy = UPSELL_COPY[`${dept} ${dir}`] ?? { headline: `Get your ${dir} agent live`, body: "Switch it on to capture more leads, any hour." };
  const subject = `Enable my ${dept} ${dir} AI agent`;
  const body = `Hi Spyne team,\n\nI'd like to switch on the ${dept} ${dir} AI agent for my store. Can you help me enable it?\n\nThanks`;
  const mailto = `mailto:support@spyne.ai?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <a
      href={mailto}
      className="lv-lift group flex flex-1 basis-0 flex-col items-center justify-center gap-3 rounded-[15px] border border-dashed border-[#d8caff] bg-[#faf8ff] p-8 text-center transition-colors hover:bg-[#f3eaff]"
    >
      <span
        className="relative flex h-[72px] w-[72px] flex-none items-center justify-center rounded-full p-[2.5px]"
        style={{ background: inbound ? "linear-gradient(135deg,#86efac,#93c5fd,#c4b5fd)" : "linear-gradient(135deg,#fdba74,#fca5a5,#f0abfc)" }}
      >
        <span className="relative h-full w-full overflow-hidden rounded-full border-2 border-white">
          <Image src={inbound ? "/live-overview/agent-emily.png" : "/live-overview/agent-jenny.png"} alt="" fill className="object-cover object-top opacity-90" />
        </span>
      </span>
      <span className="bg-clip-text text-[11px] font-bold uppercase tracking-wider text-transparent" style={{ backgroundImage: "linear-gradient(90deg,#7c3aed,#ca1f34)" }}>{dept} {dir}</span>
      <p className="text-[18px] font-bold leading-tight text-[#030712]">{copy.headline}</p>
      <p className="max-w-[300px] text-[13px] leading-relaxed text-[#626f81]">{copy.body}</p>
      <span className="mt-1 rounded-lg px-5 py-2.5 text-[13px] font-bold text-white transition-transform group-hover:scale-[1.02]" style={{ background: C.primary }}>Get {dept} {dir}</span>
    </a>
  );
}

/* ══════════════════════════ 3. Lead-to-sale funnel ══════════════════════════ */
function FunnelCell({ label, value, delta, last }: { label: string; value: number; delta: number | null; last?: boolean }) {
  const up = (delta ?? 0) >= 0;
  return (
    <div className={`flex flex-1 basis-0 flex-col items-start gap-2.5 px-4 py-2 ${last ? "" : "border-r border-[#e5e7eb]"}`}>
      <p className="text-[14px] font-medium text-[#626f81]">{label}</p>
      <div className="flex w-full items-center justify-between">
        <p className="text-[24px] font-semibold leading-8 text-[#030712]">{fmtInt(value)}</p>
        {delta !== null && (
          <span
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium"
            style={up ? { background: C.greenBg, color: C.green } : { background: C.redBg, color: C.red }}
          >
            {up ? "▲" : "▼"} {Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  );
}
export function LiveFunnelCard({ fleet, serviceMode }: { fleet: FleetLive; serviceMode?: boolean }) {
  const [leads, conv, qual, appt] = fleet.funnel;
  const conv1 = leads.value > 0 ? Math.round((conv.value / leads.value) * 100) : null;
  const conv2 = conv.value > 0 ? Math.round((qual.value / conv.value) * 100) : null;
  const conv3 = qual.value > 0 ? Math.round((appt.value / qual.value) * 100) : null;
  return (
    <div className="flex w-full flex-col items-start overflow-hidden rounded-[10px] border border-[#e5e7eb] bg-white p-5">
      <div className="flex w-full flex-col items-start gap-[15px]">
        <p className="text-[12px] font-semibold uppercase text-[#030712]">📊 {serviceMode ? "Lead-to-service funnel" : "Lead-to-sale funnel"}</p>
        <div className="flex w-full items-start">
          <FunnelCell label="Leads touched" value={leads.value} delta={fleet.deltas.leads} />
          <FunnelCell label="Real Conversations" value={conv.value} delta={fleet.deltas.conversations} />
          <FunnelCell label="Qualified Leads" value={qual.value} delta={fleet.deltas.qualified} />
          <FunnelCell label="Appointments - AI Booked" value={appt.value} delta={fleet.deltas.appointments} last />
        </div>
      </div>
      {/* stepped funnel — distinct descending bars per stage (NOT a continuous curve); each bar's height
          is its share of the top-of-funnel, with the step conversion % shown above stages 2–4. */}
      <div className="mt-4 flex w-full items-end gap-2.5" style={{ height: 140 }}>
        {([[leads, null], [conv, conv1], [qual, conv2], [appt, conv3]] as const).map(([stage, pct], i) => {
          const max = leads.value || 1;
          const h = stage.value > 0 ? Math.max(6, Math.round((stage.value / max) * 100)) : 0;
          const isLast = i === 3;
          return (
            <div key={i} className="flex flex-1 flex-col items-center justify-end self-stretch">
              {pct !== null && <span className="mb-1.5 rounded-full bg-[#f3eaff] px-2 py-0.5 text-[11px] font-semibold text-[#4600f2]">{pct}%</span>}
              <div
                className="w-full rounded-t-lg"
                style={{ height: `${h}%`, background: isLast ? "linear-gradient(180deg,#23ab70,#0a6029)" : "linear-gradient(180deg,#6a4bf2,#4600f2)", opacity: 1 - i * 0.08 }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════════════ 4. Hot leads + appointments ══════════════════════════ */
const HOT_BADGE_COLORS = ["#fc4c00", "#ff8658", "#ffb397"];
export function LiveHotLeadsCard({ items, onViewAll }: { items: WarmLeadItem[]; onViewAll: () => void }) {
  const hot = items.filter((w) => w.tier === "hot");
  const shown = hot.slice(0, 3);
  return (
    <div className="flex flex-1 basis-0 flex-col items-start gap-[30px] rounded-[10px] border border-[#e5e7eb] bg-white">
      <div className="flex h-[60px] w-full items-center justify-between border-b border-[#e5e7eb] px-5 py-[15px]">
        <div className="flex items-center gap-2">
          <span>🔥</span>
          <p className="text-[14px] font-semibold uppercase text-[#030712]">Hot Leads</p>
        </div>
        <p className="text-[14px] font-medium" style={{ color: C.red }}>Concrete buying signal</p>
      </div>
      <div className="flex w-full flex-col items-start gap-5 px-5">
        {shown.length === 0 ? (
          <p className="py-4 text-[12.5px] text-[#626f81]">No hot leads right now.</p>
        ) : shown.map((w, i) => (
          <React.Fragment key={`${w.customer}-${i}`}>
            {i > 0 && <div className="h-px w-full bg-[#e5e7eb]" />}
            <div className="flex w-full items-center gap-[15px]">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded text-[14px] font-semibold text-white" style={{ background: HOT_BADGE_COLORS[i] }}>{i + 1}</span>
              <div className="flex min-w-0 flex-1 flex-col items-start gap-2.5">
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="text-[16px] font-semibold text-[#030712]">{w.customer}</p>
                    {w.interest && <span className="rounded-full px-3 py-1 text-[12px] font-medium text-[#535353]" style={{ background: C.greyBg }}>{w.interest}</span>}
                  </div>
                  {w.phone && <p className="text-[14px] font-medium text-[#030712]">📞 {w.phone}</p>}
                </div>
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
      <div className="flex w-full items-center justify-between border-t border-[#e5e7eb] px-5 py-[15px]">
        <p className="text-[12px] text-[#626f81]">Top {shown.length} of {hot.length} hot leads</p>
        <button onClick={onViewAll} className="text-[12px] font-medium" style={{ color: C.primary }}>View all Hot Leads →</button>
      </div>
    </div>
  );
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function LiveAppointmentsWeekCard({ items, onViewAll }: { items: NamedAppt[]; onViewAll: () => void }) {
  const [weekOffset, setWeekOffset] = React.useState(0);
  const today = React.useMemo(() => new Date(), []);
  const days = React.useMemo(() => {
    const base = new Date(today);
    base.setDate(base.getDate() + weekOffset * 7 - 3);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(base); d.setDate(base.getDate() + i); return d; });
  }, [today, weekOffset]);
  const byDay = React.useMemo(() => {
    const m = new Map<string, NamedAppt[]>();
    for (const a of items) {
      if (!a.when) continue;
      const key = a.when.slice(0, 10);
      m.set(key, [...(m.get(key) ?? []), a]);
    }
    return m;
  }, [items]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const todayKey = today.toISOString().slice(0, 10);
  const activeKey = selected ?? days.find((d) => d.toISOString().slice(0, 10) === todayKey)?.toISOString().slice(0, 10) ?? days[3].toISOString().slice(0, 10);
  const dayAppts = (byDay.get(activeKey) ?? []).sort((a, b) => (a.when ?? "").localeCompare(b.when ?? ""));

  return (
    <div className="flex flex-1 basis-0 flex-col items-start justify-between gap-[30px] rounded-[10px] border border-[#e5e7eb] bg-white">
      <div className="flex w-full flex-col items-start gap-[30px]">
        <div className="flex w-full flex-col items-start gap-6 border-b border-[#e5e7eb] px-5 py-[15px]">
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-2">
              <span>📅</span>
              <p className="text-[14px] font-semibold uppercase text-[#030712]">Appointments</p>
            </div>
            <p className="text-[14px] font-medium text-[#535353]">{today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
          </div>
          <div className="flex h-[46px] w-full items-center justify-between">
            <button onClick={() => setWeekOffset((w) => w - 1)} aria-label="Previous week" className="flex-none text-[#030712]">←</button>
            {days.map((d) => {
              const key = d.toISOString().slice(0, 10);
              const isSel = key === activeKey;
              const count = byDay.get(key)?.length ?? 0;
              return (
                <button
                  key={key}
                  onClick={() => setSelected(key)}
                  className="flex w-9 flex-none flex-col items-center justify-center gap-1 rounded"
                  style={isSel ? { background: C.primary, color: "#fff", height: 46 } : undefined}
                >
                  <span className="text-[12px]" style={{ color: isSel ? "#fff" : C.sub }}>{DOW[d.getDay()]}</span>
                  <span className="text-[14px] font-semibold tracking-[-1px]" style={{ color: isSel ? "#fff" : C.dark }}>{String(d.getDate()).padStart(2, "0")}</span>
                  {count > 0 && !isSel && <span className="h-1 w-1 rounded-full" style={{ background: C.primary }} />}
                </button>
              );
            })}
            <button onClick={() => setWeekOffset((w) => w + 1)} aria-label="Next week" className="flex-none text-[#030712]">→</button>
          </div>
        </div>
        <div className="flex w-full flex-col items-start gap-5 px-5">
          {dayAppts.length === 0 ? (
            <p className="py-2 text-[12.5px] text-[#626f81]">No appointments on this day.</p>
          ) : dayAppts.slice(0, 4).map((a, i) => (
            <React.Fragment key={`${a.customer}-${i}`}>
              {i > 0 && <div className="h-px w-full bg-[#e5e7eb]" />}
              <div className="flex w-full items-start gap-6">
                <p className="w-[70px] flex-none text-[14px] font-semibold text-[#030712]">{a.when ? fmtWhenShort(a.when).split("· ")[1] ?? fmtWhenShort(a.when) : "—"}</p>
                <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
                  <div className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-2">
                      <p className="text-[16px] font-semibold text-[#030712]">{a.customer}</p>
                      {a.vehicle && <span className="rounded-full px-3 py-1 text-[12px] font-medium text-[#535353]" style={{ background: C.greyBg }}>{a.vehicle}</span>}
                    </div>
                    <span className="text-[12px] font-medium" style={{ color: a.assisted ? C.orange : C.green }}>{a.how}</span>
                  </div>
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="flex w-full items-center justify-between border-t border-[#e5e7eb] px-5 py-[15px]">
        <p className="text-[12px] text-[#626f81]">{items.length} appointments this week</p>
        <button onClick={onViewAll} className="text-[12px] font-medium" style={{ color: C.primary }}>View All →</button>
      </div>
    </div>
  );
}

/* ══════════════════════════ 5. Action items table ══════════════════════════ */
function overdueLabel(dueAt: string): { text: string; danger: boolean } {
  const days = Math.round((Date.now() - new Date(dueAt).getTime()) / 86400000);
  if (days > 0) return { text: `Overdue by ${days} day${days === 1 ? "" : "s"}`, danger: true };
  if (days === 0) return { text: "Due today", danger: false };
  return { text: `Due in ${-days} day${-days === 1 ? "" : "s"}`, danger: false };
}
function TableTabs({ tabs, active, onPick }: { tabs: { key: string; label: string; count?: number }[]; active: string; onPick: (k: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            onClick={() => onPick(t.key)}
            className="rounded-full px-3 py-1 text-[12px] font-medium transition-colors"
            style={on ? { background: C.primary, color: "#fff" } : { background: C.greyBg, color: C.sub }}
          >
            {t.label}{t.count != null ? ` (${t.count})` : ""}
          </button>
        );
      })}
    </div>
  );
}
export function LiveActionItemsTable({ items, stats, onViewAll }: { items: ActionItem[]; stats: ActionItemStats | null; onViewAll: () => void }) {
  const [tab, setTab] = React.useState("created");
  const filtered = items.filter((a) => {
    if (tab === "overdue") return overdueLabel(a.dueAt).danger;
    if (tab === "today") return overdueLabel(a.dueAt).text === "Due today";
    return true; // created / open
  });
  const rows = filtered.slice(0, 5);
  const tabs = [
    { key: "created", label: "Created", count: stats?.created },
    { key: "overdue", label: "Overdue", count: stats?.overdue },
    { key: "today", label: "Due Today", count: stats?.dueToday },
    { key: "open", label: "All Open", count: stats?.open },
  ];
  return (
    <div className="flex w-full flex-col items-start gap-[15px] rounded-[10px] border border-[#e5e7eb] bg-white">
      <div className="flex min-h-[60px] w-full flex-wrap items-center justify-between gap-3 border-b border-[#e5e7eb] px-5 py-[15px]">
        <p className="text-[14px] font-semibold uppercase text-[#030712]">📝 Action items</p>
        <TableTabs tabs={tabs} active={tab} onPick={setTab} />
      </div>
      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-[12.5px] text-[#626f81]">No action items in this view.</p>
      ) : (
        <div className="w-full overflow-x-auto px-[15px]">
          <table className="w-full min-w-[820px] border-collapse text-[14px]">
            <thead>
              <tr className="text-left text-[#626f81]">
                <th className="border-b border-[#e5e7eb] p-[15px] font-medium">Customer</th>
                <th className="border-b border-[#e5e7eb] p-[15px] font-medium">Contact</th>
                <th className="border-b border-[#e5e7eb] p-[15px] font-medium">What to do?</th>
                <th className="border-b border-[#e5e7eb] p-[15px] font-medium">Due Date</th>
                <th className="border-b border-[#e5e7eb] p-[15px] text-center font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const name = a.customer || "Unknown";
                const st = overdueLabel(a.dueAt);
                return (
                  <tr key={a.id}>
                    <td className="border-b border-[#e5e7eb] p-[15px]">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-medium text-white" style={{ background: avatarColor(name) }}>{initials(name)}</span>
                        <span className="whitespace-nowrap text-[#030712]">{name}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap border-b border-[#e5e7eb] p-[15px] text-[#030712]">{a.phone ?? "—"}</td>
                    <td className="max-w-[320px] border-b border-[#e5e7eb] p-[15px] text-[#030712]">{a.description}</td>
                    <td className="whitespace-nowrap border-b border-[#e5e7eb] p-[15px] text-[#030712]">{fmtWhenShort(a.dueAt).split(" · ")[0]}</td>
                    <td className="border-b border-[#e5e7eb] p-[15px] text-center">
                      <span className="whitespace-nowrap rounded px-[15px] py-1 text-[12px] font-medium" style={st.danger ? { background: C.redBg, color: C.red } : { background: C.blueBg, color: C.blue }}>{st.text}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex w-full items-center justify-between border-t border-[#e5e7eb] px-5 py-[15px]">
        <p className="text-[12px] text-[#626f81]">{stats ? `${fmtInt(stats.overdue)} overdue of ${fmtInt(stats.open)} open` : "—"}</p>
        <button onClick={onViewAll} className="text-[12px] font-medium" style={{ color: C.primary }}>View All Action Items →</button>
      </div>
    </div>
  );
}

/* ══════════════════════════ 6. Recent conversations table ══════════════════════════ */
function convStatus(c: Conversation): { text: string; ok: boolean } {
  if (c.appointmentScheduled) return { text: "Appointment", ok: true };
  if (c.queryResolved || c.outcome === "Resolved") return { text: "Resolved", ok: true };
  return { text: "Unresolved", ok: false };
}
export function LiveConversationsTable({
  items, agentNames, onViewAll,
}: {
  items: Conversation[] | null;
  agentNames: Record<string, string>;
  onViewAll: () => void;
}) {
  const [sel, setSel] = React.useState<Conversation | null>(null);
  const [tab, setTab] = React.useState("attention");
  const all = items ?? [];
  const unresolved = all.filter((c) => !convStatus(c).ok).length;
  // "Real conversation" (canonical): the customer actually engaged — a call they stayed on (not a
  // voicemail/no-answer blip) OR an SMS thread with a human reply. No connected flag on the row, so
  // proxy calls by a short talk-time floor and SMS by the presence of an inbound/human message.
  const isReal = (c: Conversation) =>
    c.channel === "call"
      ? (c.durationSec ?? 0) >= 15
      : (c.sms?.some((m) => m.direction === "inbound" || m.authorType === "human") ?? (c.msgs ?? 0) > 1);
  const match = (c: Conversation) => {
    switch (tab) {
      case "attention": return !convStatus(c).ok;
      case "real": return isReal(c);
      case "call": return c.channel === "call";
      case "sms": return c.channel === "sms";
      default: return true; // all
    }
  };
  const rows = all.filter(match).slice(0, 6);
  const tabs = [
    { key: "attention", label: "Needs Attention", count: unresolved },
    { key: "real", label: "Real", count: all.filter(isReal).length },
    { key: "call", label: "Calls", count: all.filter((c) => c.channel === "call").length },
    { key: "sms", label: "SMS", count: all.filter((c) => c.channel === "sms").length },
    { key: "all", label: "All", count: all.length },
  ];
  return (
    <>
      <div className="flex w-full flex-col items-start gap-[15px] rounded-[10px] border border-[#e5e7eb] bg-white">
        <div className="flex min-h-[60px] w-full flex-wrap items-center justify-between gap-3 border-b border-[#e5e7eb] px-5 py-[15px]">
          <p className="text-[14px] font-semibold uppercase text-[#030712]">💬 Recent conversations</p>
          {items !== null && <TableTabs tabs={tabs} active={tab} onPick={setTab} />}
        </div>
        {items === null ? (
          <div className="w-full px-5 pb-5"><div className="h-[220px] w-full animate-pulse rounded-xl bg-[#f3f4f6]" /></div>
        ) : rows.length === 0 ? (
          <p className="px-5 pb-5 text-[12.5px] text-[#626f81]">{tab === "attention" ? "Nothing needs attention — all conversations resolved." : "No conversations synced yet."}</p>
        ) : (
          <div className="w-full overflow-x-auto px-[15px]">
            <table className="w-full min-w-[860px] border-collapse text-[14px]">
              <thead>
                <tr className="text-left text-[#626f81]">
                  <th className="border-b border-[#e5e7eb] p-[15px] font-medium">Customer</th>
                  <th className="border-b border-[#e5e7eb] p-[15px] font-medium">Contact</th>
                  <th className="border-b border-[#e5e7eb] p-[15px] font-medium">Intent</th>
                  <th className="border-b border-[#e5e7eb] p-[15px] text-center font-medium">Date &amp; Time</th>
                  <th className="border-b border-[#e5e7eb] p-[15px] text-center font-medium">Duration</th>
                  <th className="border-b border-[#e5e7eb] p-[15px] text-center font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const name = c.customer || "Unknown";
                  const status = convStatus(c);
                  return (
                    <tr key={c.id} onClick={() => setSel(c)} className="cursor-pointer hover:bg-[#faf8ff]">
                      <td className="border-b border-[#e5e7eb] p-[15px]">
                        <div className="flex items-center gap-2">
                          <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-medium text-white" style={{ background: avatarColor(name) }}>{initials(name)}</span>
                          <span className="whitespace-nowrap text-[#030712]">{name}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap border-b border-[#e5e7eb] p-[15px] text-[#030712]">{c.channel === "sms" ? "💬" : "📞"} {c.phone ?? "—"}</td>
                      <td className="max-w-[280px] truncate border-b border-[#e5e7eb] p-[15px] text-[#030712]">{c.title || agentDisplayName(c, agentNames)}</td>
                      <td className="whitespace-nowrap border-b border-[#e5e7eb] p-[15px] text-center text-[#030712]">{fmtWhenShort(c.at)}</td>
                      <td className="whitespace-nowrap border-b border-[#e5e7eb] p-[15px] text-center text-[#030712]">{c.channel === "call" ? (c.durationSec ? fmtSecs(c.durationSec) : "—") : `${c.msgs ?? 0} messages`}</td>
                      <td className="border-b border-[#e5e7eb] p-[15px] text-center">
                        <span className="whitespace-nowrap rounded px-[15px] py-1 text-[12px] font-medium" style={status.ok ? { background: C.greenBg, color: C.green } : { background: C.redBg, color: C.red }}>{status.text}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex w-full items-center justify-between border-t border-[#e5e7eb] px-5 py-[15px]">
          <p className="text-[12px] text-[#626f81]">{fmtInt(unresolved)} unresolved of {fmtInt((items ?? []).length)} conversations</p>
          <button onClick={onViewAll} className="text-[12px] font-medium" style={{ color: C.primary }}>View All Conversations →</button>
        </div>
      </div>
      <ConversationDrawer conv={sel} onClose={() => setSel(null)} agentNames={agentNames} />
    </>
  );
}

/* ══════════════════════════ top-level composition ══════════════════════════ */
export interface LiveOverviewProps {
  account: Account;
  fleet: FleetLive;
  agents: AgentData[]; // ranked (by appointments desc), already dept-filtered
  warmLeads: WarmLeadItem[];
  namedAppts: NamedAppt[];
  aiStats: { stats: ActionItemStats } | null;
  workItems: ActionItem[];
  conversations: Conversation[] | null;
  agentNames: Record<string, string>;
  onOpenAgent: (id: string) => void;
  onOpenApptModal: () => void;
  onOpenWarmModal: () => void;
  onViewActionItems: () => void;
  onViewConversations: () => void;
  onBackToTraining?: () => void; // legacy hook; Training is no longer surfaced, so unused on Live
  headerControls?: React.ReactNode; // date filter + customize, rendered inside the hero (this IS the header)
  ctrl?: CustomizeCtrl; // Customize: hide + reorder the sections below (omit → default order, all shown)
}

// The customizable sections of the Live overview, in default order. Exposed so OverviewView can build
// the matching useCustomize(ids) + Customize modal groups from the SAME list (ids never drift).
export const LIVE_SECTIONS: { id: string; label: string }[] = [
  { id: "live.hero", label: "Hero metric tiles" },
  { id: "live.agents", label: "Agent performance" },
  { id: "live.funnel", label: "Lead-to-sale funnel" },
  { id: "live.hotleads", label: "Hot Leads" },
  { id: "live.appts", label: "Appointments" },
  { id: "live.actions", label: "Action Items" },
  { id: "live.conversations", label: "Recent Conversations" },
];
// Hot Leads + Appointments render side-by-side when both are visible AND adjacent (the default), and go
// full-width when hidden/separated — so reorder + independent hide work without breaking the layout.
const PAIRABLE = new Set(["live.hotleads", "live.appts"]);

export function LiveOverview({
  account, fleet, agents, warmLeads, namedAppts, aiStats, workItems, conversations, agentNames,
  onOpenAgent, onOpenApptModal, onOpenWarmModal, onViewActionItems, onViewConversations, headerControls, ctrl,
}: LiveOverviewProps) {
  const inbound = agents.find((a) => a.dir === "Inbound");
  const outbound = agents.find((a) => a.dir === "Outbound");
  const serviceMode = agents.length > 0 && agents.every((a) => a.dept === "Service");
  const hotLeads = warmLeads.filter((w) => w.tier === "hot").length;
  // The department in play (from whichever agent IS live), so a missing direction shows the right
  // "Get {dept} {dir}" upsell placeholder instead of an empty slot.
  const deptLabel: "Sales" | "Service" = (inbound ?? outbound)?.dept ?? (serviceMode ? "Service" : "Sales");

  const nodes: Record<string, React.ReactNode> = {
    "live.hero": <LiveHero fleet={fleet} actionStats={aiStats?.stats ?? null} controls={headerControls} serviceMode={serviceMode} hotLeads={hotLeads} />,
    "live.agents": (
      <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch">
        {inbound ? <LiveAgentCard agent={inbound} onClick={() => onOpenAgent(inbound.id)} /> : <AgentUpsellCard dept={deptLabel} dir="Inbound" />}
        {outbound ? <LiveAgentCard agent={outbound} onClick={() => onOpenAgent(outbound.id)} /> : <AgentUpsellCard dept={deptLabel} dir="Outbound" />}
      </div>
    ),
    "live.funnel": (
      <div className="flex flex-col gap-3.5">
        <UnlockPotentialBanner liveCount={1} total={3} teamId={account.teamId} accountName={account.name} />
        <LiveFunnelCard fleet={fleet} serviceMode={serviceMode} />
      </div>
    ),
    "live.hotleads": <LiveHotLeadsCard items={warmLeads} onViewAll={onOpenWarmModal} />,
    "live.appts": <LiveAppointmentsWeekCard items={namedAppts} onViewAll={onOpenApptModal} />,
    "live.actions": <LiveActionItemsTable items={workItems} stats={aiStats?.stats ?? null} onViewAll={onViewActionItems} />,
    "live.conversations": <LiveConversationsTable items={conversations} agentNames={agentNames} onViewAll={onViewConversations} />,
  };

  // Apply the customize layout: chosen order (ctrl.order) minus hidden ids; default order + all shown
  // when there's no ctrl. Unknown ids are skipped so a stale saved layout never renders a ghost.
  const defaultOrder = LIVE_SECTIONS.map((s) => s.id);
  const order = (ctrl ? ctrl.order.filter((id) => nodes[id] !== undefined) : defaultOrder).filter((id) => !ctrl?.hidden.has(id));
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const next = order[i + 1];
    const delay = `${rows.length * 70}ms`;
    if (PAIRABLE.has(id) && next && PAIRABLE.has(next)) {
      rows.push(<div key={id} className="lv-rise flex flex-col gap-5 lg:flex-row lg:items-stretch" style={{ animationDelay: delay }}>{nodes[id]}{nodes[next]}</div>);
      i++; // consumed the pair
    } else {
      rows.push(<div key={id} className="lv-rise" style={{ animationDelay: delay }}>{nodes[id]}</div>);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <LiveAnims />
      {rows}
    </div>
  );
}
