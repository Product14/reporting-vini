"use client";

/* Upsell surface — shown on the Agents report when a rooftop ISN'T running one of the four agents.
 * Instead of hiding the agent, we pitch its value and capture interest via a form. The value copy is
 * deliberately illustrative (it markets a not-yet-live agent); any hard numbers shown are framed as
 * "typical" or grounded in the rooftop's OWN live volume — never presented as this agent's live data. */

import { useState } from "react";
import { type AgentData, fmtInt } from "./kit";
import type { SpeedToLead } from "./data";

interface UpsellCopy {
  headline: string;
  sub: string;
  does: string[];
  gain: string[];
}

export const UPSELL: Record<string, UpsellCopy> = {
  sales_ib: {
    headline: "Never miss an inbound sales call",
    sub: "Answers every showroom call — nights, weekends and overflow included — qualifies the buyer and books the appointment.",
    does: [
      "Picks up every inbound call, 24/7, with zero hold time",
      "Answers pricing, inventory and trade questions instantly",
      "Qualifies intent and books the showroom appointment",
      "Routes hot buyers to your team in real time",
    ],
    gain: [
      "Capture after-hours & overflow calls that hit voicemail today",
      "Sub-minute first response on every lead",
      "More booked appointments from the same call volume",
    ],
  },
  sales_ob: {
    headline: "Work every lead and campaign automatically",
    sub: "Runs your outbound playbooks — aged-lead, equity, lease-end, service-drive trade-in — and follows up until the lead replies.",
    does: [
      "Dials and texts every lead across multi-day cadences",
      "Runs equity, lease-end and aged-lead campaigns on autopilot",
      "Re-engages cold leads your team gave up on",
      "Books appointments straight onto the calendar",
    ],
    gain: [
      "8–10 follow-ups per lead instead of the usual 2",
      "Revive aged-lead lists that sit untouched",
      "A full outbound motion with no extra headcount",
    ],
  },
  service_ib: {
    headline: "Answer every service call and fill the bay",
    sub: "Handles inbound service calls end-to-end — hours, pricing, scheduling — so advisors stop fielding the phone and the drive stays full.",
    does: [
      "Answers every service call, including peak and after-hours",
      "Quotes hours, pricing and availability instantly",
      "Books, reschedules and confirms service appointments",
      "Escalates only what truly needs an advisor",
    ],
    gain: [
      "Stop service calls rolling to voicemail at peak",
      "Free advisors from the phone to work the lane",
      "More booked ROs from calls you already receive",
    ],
  },
  service_ob: {
    headline: "Fill the service drive on autopilot",
    sub: "Proactively reaches owners for recalls, due-service and declined work, and books them straight into open bays.",
    does: [
      "Runs recall, due-service and declined-work campaigns",
      "Calls and texts owners with open availability",
      "Books appointments into open service slots",
      "Keeps the drive full in slow periods",
    ],
    gain: [
      "Recover declined and deferred work automatically",
      "Smooth out slow days with proactive outreach",
      "More ROs without buying more leads",
    ],
  },
};

/* ── the upsell pitch shown in place of the report when a missing agent is selected ── */
export function UpsellAgent({
  agent,
  accountName,
  teamId,
  peerCalls,
}: {
  agent: AgentData;
  accountName: string;
  teamId: string;
  peerCalls?: number; // live conversation volume of the rooftop's EXISTING agents, for a grounded line
}) {
  const c = UPSELL[agent.id];
  const [open, setOpen] = useState(false);
  if (!c) return null;
  return (
    <section className="overflow-hidden rounded-3xl border border-[#ece6fb] bg-white shadow-sm">
      {/* header band */}
      <div className="flex flex-col gap-3 bg-gradient-to-r from-[#f6f1ff] via-[#faf8ff] to-white px-8 py-7 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <span className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl bg-white text-[24px] shadow-sm ring-1 ring-[#ece6fb]">{agent.icon}</span>
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f3eaff] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#813fed]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#813fed]" /> Not active for {accountName}
            </span>
            <h2 className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em] text-[#111]">{c.headline}</h2>
            <p className="mt-1 max-w-[620px] text-[13px] leading-snug text-[#6b7280]">{c.sub}</p>
          </div>
        </div>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="flex-none rounded-xl bg-[#813fed] px-5 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-[#6d28d9]"
          >
            I’m interested →
          </button>
        )}
      </div>

      {/* what it does · what you'd gain */}
      <div className="grid grid-cols-1 gap-px bg-[#f0f0f0] md:grid-cols-2">
        <div className="bg-white px-8 py-6">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">What {agent.name} does</p>
          <ul className="flex flex-col gap-2.5">
            {c.does.map((d) => (
              <li key={d} className="flex items-start gap-2.5 text-[12.5px] text-[#374151]">
                <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-[#f3eaff] text-[10px] font-bold text-[#813fed]">→</span>
                {d}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-white px-8 py-6">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">What you’d gain · typical</p>
          <ul className="flex flex-col gap-2.5">
            {c.gain.map((g) => (
              <li key={g} className="flex items-start gap-2.5 text-[12.5px] text-[#374151]">
                <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-[#dcfce7] text-[10px] font-bold text-[#065f46]">✓</span>
                {g}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* grounded line from the rooftop's existing live agents (real numbers, not this agent's) */}
      {peerCalls !== undefined && peerCalls > 0 && (
        <div className="border-t border-[#f0f0f0] bg-[#fcfcfd] px-8 py-4 text-[12px] text-[#6b7280]">
          Your live agents already handle <b className="text-[#111]">{fmtInt(peerCalls)}</b> conversations this period —{" "}
          <b className="text-[#111]">{agent.name}</b> brings the same always-on coverage to your {agent.dept.toLowerCase()} {agent.dir.toLowerCase()} side.
        </div>
      )}

      {/* interest form (revealed on click) */}
      {open && (
        <div className="border-t border-[#ece6fb] px-8 py-7">
          <InterestForm agentId={agent.id} agentName={agent.name} accountName={accountName} teamId={teamId} onCancel={() => setOpen(false)} />
        </div>
      )}
    </section>
  );
}

/* ── Speed-to-Lead upsell — the BODY of the "Speed to lead" card (no chrome of its own) shown on a
 * Sales Inbound report when the rooftop either isn't measuring STL or its typical (median) first
 * response is slower than a minute. `stl` is passed when there IS data (the "slow" case) so we can
 * ground the pitch in the rooftop's own numbers; omitted → the "not measuring" case. ── */
export function StlUpsell({ accountName, teamId, stl }: { accountName: string; teamId: string; stl?: SpeedToLead }) {
  const [open, setOpen] = useState(false);
  const slow = !!stl; // we have data, it's just over a minute at the median
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-2xl bg-[#f3eaff] text-[20px]">⚡</span>
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f3eaff] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#813fed]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#813fed]" /> Speed-to-Lead
          </span>
          <h3 className="mt-1.5 text-[15px] font-extrabold tracking-[-0.01em] text-[#111]">
            {slow ? "Get every new lead a reply under a minute" : "Turn new leads into instant conversations"}
          </h3>
        </div>
      </div>

      {/* grounded line (slow case) or generic value (no-data case) */}
      <p className="text-[12px] leading-snug text-[#6b7280]">
        {slow ? (
          <>
            Right now only <b className="text-[#111]">{stl!.pctWithin5}%</b> of your{" "}
            <b className="text-[#111]">{fmtInt(stl!.crmLeadsNew)}</b> new leads get a first reply within 5 minutes,
            and the typical lead waits longer than a minute. Speed-to-Lead replies to every one in seconds — day or night.
          </>
        ) : (
          <>Speed-to-Lead replies to every new CRM lead in seconds — day, night and weekends — qualifies the buyer and books the appointment before they go cold.</>
        )}
      </p>

      <ul className="flex flex-col gap-2">
        {["Sub-minute first response on 100% of new leads", "Works after-hours and overflow automatically", "Books the appointment before the lead cools off"].map((d) => (
          <li key={d} className="flex items-start gap-2.5 text-[12px] text-[#374151]">
            <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-[#dcfce7] text-[9px] font-bold text-[#065f46]">✓</span>
            {d}
          </li>
        ))}
      </ul>

      {open ? (
        <InterestForm agentId="speed_to_lead" agentName="Speed to Lead" accountName={accountName} teamId={teamId} onCancel={() => setOpen(false)} />
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="mt-1 self-start rounded-xl bg-[#813fed] px-4 py-2 text-[12.5px] font-bold text-white transition-colors hover:bg-[#6d28d9]"
        >
          {slow ? "Speed up my responses →" : "I’m interested →"}
        </button>
      )}
    </div>
  );
}

/* ── interest-capture form → POST /api/agent-interest ── */
function InterestForm({
  agentId,
  agentName,
  accountName,
  teamId,
  onCancel,
}: {
  agentId: string;
  agentName: string;
  accountName: string;
  teamId: string;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const canSubmit = name.trim().length > 1 && emailOk && status !== "sending";

  const submit = async () => {
    if (!canSubmit) return;
    setStatus("sending");
    setError("");
    try {
      const res = await fetch("/api/agent-interest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId,
          accountName,
          agentId,
          agentName,
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          note: note.trim(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error || "Something went wrong.");
      setStatus("done");
    } catch (e) {
      setStatus("error");
      setError((e as Error).message);
    }
  };

  if (status === "done") {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-[#f0fdf6] px-6 py-8 text-center">
        <span className="text-[26px] leading-none">✅</span>
        <p className="text-[14px] font-bold text-[#065f46]">Thanks — we’ll be in touch about {agentName}.</p>
        <p className="max-w-[440px] text-[12px] leading-snug text-[#15803d]">
          Your interest for <b>{accountName}</b> is in. Our team will reach out at <b>{email.trim()}</b> with next steps.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#813fed]">Tell us where to reach you</p>
        <p className="mt-1 text-[12.5px] text-[#6b7280]">
          We’ll show you what <b className="text-[#111]">{agentName}</b> would do for <b className="text-[#111]">{accountName}</b> and get it set up.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Your name" value={name} onChange={setName} placeholder="Jane Advisor" required />
        <Field label="Work email" value={email} onChange={setEmail} placeholder="jane@dealer.com" type="email" required invalid={email.length > 0 && !emailOk} />
        <Field label="Phone (optional)" value={phone} onChange={setPhone} placeholder="(555) 555-5555" type="tel" />
        <Field label="Anything specific? (optional)" value={note} onChange={setNote} placeholder="e.g. busiest in the evenings" />
      </div>
      {status === "error" && <p className="text-[12px] font-semibold text-[#dc2626]">{error}</p>}
      <div className="flex items-center gap-3">
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="rounded-xl bg-[#813fed] px-5 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-[#6d28d9] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "sending" ? "Sending…" : "Request this agent"}
        </button>
        <button onClick={onCancel} className="text-[12.5px] font-semibold text-[#6b7280] hover:text-[#111]">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  invalid?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">
        {label} {required && <span className="text-[#dc2626]">*</span>}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`rounded-lg border px-3 py-2 text-[13px] text-[#111] outline-none transition-colors focus:ring-2 focus:ring-[#d8caff] ${
          invalid ? "border-[#fca5a5]" : "border-[#e5e7eb]"
        }`}
      />
    </label>
  );
}
