"use client";

/* Unanswered queue on Conversations (PRD FD-24641). Plugs into InboxView as a third tab next to All and
 * Unread; Unread and Needs Attention are untouched (R8).
 *
 *   Tab + live badge   open episodes for the department (R3, R13: badge = query total)
 *   List               Team | Mine | Manager; Open | Aged; oldest wait first (toggle newest) (R3, R4, R7)
 *   Row                wait (in-hours), channel, owner, reason (R3)
 *   Detail             wait banner + "Handled elsewhere" / "No reply needed" (R2), action items, then the
 *                      thread. Opening a row never clears the wait (R2, A10).
 *   Manager view       per-owner counts, oldest waits, click clears, replies; texts; not-configured (R7)
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { InboxAuth, InboxCustomer } from "../api";
import { formatWait, ownerLabel, REASON_LABEL } from "@/lib/unanswered/select";
import type {
  ClearKind,
  Department,
  Episode,
  ManagerPage,
  UnansweredConfig,
  UnansweredPage,
  UnansweredQuery,
} from "@/lib/unanswered/types";

// Same palette as InboxView, so the tab reads as part of the screen.
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
  redAccent: "#fdecee",
  green: "#23ab70",
  amber: "#9a6700",
  amberAccent: "#fff6db",
};

const POLL_MS = 30_000;

const CHANNEL_LABEL: Record<Episode["channel"], string> = { sms: "SMS", email: "Email", chat: "Chat", call: "Call" };

function scopeParams(a: InboxAuth): URLSearchParams {
  const p = new URLSearchParams({ team_id: a.teamId });
  if (a.enterpriseId) p.set("enterprise_id", a.enterpriseId);
  if (a.spyneEnv) p.set("env", a.spyneEnv);
  return p;
}
const authHeaders = (a: InboxAuth): HeadersInit | undefined => (a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : undefined);

function clock(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* ── Data hook ─────────────────────────────────────────────────────────────────────────────── */

export interface UnansweredState {
  page: UnansweredPage | null;
  query: Omit<UnansweredQuery, "department">;
  setQuery: (p: Partial<Omit<UnansweredQuery, "department">>) => void;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  clear: (episodeId: string, kind: ClearKind) => Promise<boolean>;
}

/** Fetches the queue (and with it the badge count and the server-side view flag) for the department, and
 *  re-asks every 30 s so the badge stays live and an off flag hides the view within a minute (R8, A14). */
export function useUnanswered(auth: InboxAuth, department: Department): UnansweredState {
  const [page, setPage] = useState<UnansweredPage | null>(null);
  const [query, setQ] = useState<Omit<UnansweredQuery, "department">>({ bucket: "open", sort: "oldest", scope: "team" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const setQuery = useCallback((p: Partial<Omit<UnansweredQuery, "department">>) => setQ((q) => ({ ...q, ...p })), []);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!auth.teamId) return;
    let cancelled = false;
    const q = scopeParams(auth);
    q.set("department", department);
    q.set("bucket", query.bucket);
    q.set("sort", query.sort);
    q.set("scope", query.scope);
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/inbox/unanswered?${q}`, { cache: "no-store", headers: authHeaders(auth) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const p = (await r.json()) as UnansweredPage;
        if (!cancelled) {
          setPage(p);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, department, query.bucket, query.sort, query.scope, tick]);

  useEffect(() => {
    if (!auth.teamId) return;
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [auth.teamId, refresh]);

  // Switching department starts from that department's own state (A13).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the department changes
    setPage(null);
  }, [department]);

  const clear = useCallback(
    async (episodeId: string, kind: ClearKind) => {
      try {
        const r = await fetch(`/api/inbox/unanswered/clear?${scopeParams(auth)}`, {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json", ...(authHeaders(auth) as Record<string, string> | undefined) },
          body: JSON.stringify({ episodeId, kind }),
        });
        refresh();
        return r.ok;
      } catch {
        return false;
      }
    },
    [auth, refresh],
  );

  return { page, query, setQuery, loading, error, refresh, clear };
}

/* ── "Customers unanswered" line with live badge ───────────────────────────────────────────── */

/** A full-width line above the tabs (the dealer's "customers unanswered line above Conversations", PRD
 *  E11), so it stays visible from any tab and doesn't crowd the existing All / Unread / Needs Attention. */
export function UnansweredBar({ active, count, onClick }: { active: boolean; count: number | null; onClick: () => void }) {
  const hot = (count ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title="Customers waiting on a person to reply"
      className="flex w-full shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-left text-[12.5px] transition-colors"
      style={{
        borderColor: C.border,
        background: active ? C.primaryAccent : hot ? C.redAccent : "#fff",
        color: active ? C.primary : hot ? C.red : C.sub,
      }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className="inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11.5px] font-bold tabular-nums"
          style={hot ? { background: C.red, color: "#fff" } : { background: "#eef1f4", color: C.sub }}
        >
          {count ?? "–"}
        </span>
        <span className="truncate font-semibold">
          Unanswered
        </span>
      </span>
      <span className="shrink-0 font-semibold">{active ? "Viewing" : "View →"}</span>
    </button>
  );
}

/* ── List ──────────────────────────────────────────────────────────────────────────────────── */

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; disabled?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center rounded-[15px] border p-0.5" style={{ borderColor: C.border }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={!!o.disabled}
            title={o.disabled}
            onClick={() => onChange(o.value)}
            aria-pressed={on}
            className="rounded-[13px] px-2.5 py-1 text-[11.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={on ? { background: C.primary, color: "#fff" } : { color: C.sub }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export type UnansweredScope = "team" | "mine" | "manager";

export function UnansweredControls({
  state,
  scope,
  onScope,
  config,
  landing,
  onLanding,
  landingOptions,
}: {
  state: UnansweredState;
  scope: UnansweredScope;
  onScope: (s: UnansweredScope) => void;
  config: UnansweredConfig | null;
  landing: LandingView;
  onLanding: (v: LandingView) => void;
  landingOptions: LandingView[];
}) {
  const p = state.page;
  return (
    <div className="flex flex-col gap-2 border-b px-4 py-2.5" style={{ borderColor: C.border }}>
      <div className="flex flex-wrap items-center gap-2">
        <Seg
          label="Whose queue"
          value={scope}
          onChange={onScope}
          options={[
            { value: "team", label: "Team" },
            { value: "mine", label: "Mine", disabled: config && !config.mineAvailable ? "Mine turns on once the CRM owner is connected for this rooftop" : undefined },
            ...(config?.viewerIsManager ? [{ value: "manager" as const, label: "Manager" }] : []),
          ]}
        />
        <label className="ml-auto flex items-center gap-1.5 text-[11.5px]" style={{ color: C.sub }}>
          Open Conversations on
          <select
            value={landing}
            onChange={(e) => onLanding(e.target.value as LandingView)}
            className="rounded-md border bg-white px-1.5 py-0.5 text-[11.5px]"
            style={{ borderColor: C.border, color: C.dark }}
          >
            {landingOptions.map((v) => (
              <option key={v} value={v}>{LANDING_LABEL[v]}</option>
            ))}
          </select>
        </label>
      </div>
      {scope !== "manager" && (
        <div className="flex flex-wrap items-center gap-2">
          <Seg
            label="Bucket"
            value={state.query.bucket}
            onChange={(bucket) => state.setQuery({ bucket })}
            options={[
              { value: "open", label: `Open${p ? ` (${p.openCount})` : ""}` },
              { value: "aged", label: `Aged${p ? ` (${p.agedCount})` : ""}` },
            ]}
          />
          <Seg
            label="Sort"
            value={state.query.sort}
            onChange={(sort) => state.setQuery({ sort })}
            options={[
              { value: "oldest", label: "Oldest first" },
              { value: "newest", label: "Newest first" },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function OwnerChip({ e }: { e: Episode }) {
  const warn = e.owner.state !== "owned";
  return (
    <span className="truncate" style={{ color: warn ? C.amber : C.sub }}>
      {ownerLabel(e)}
    </span>
  );
}

export function UnansweredList({
  state,
  selectedId,
  onSelect,
}: {
  state: UnansweredState;
  selectedId: string | null;
  onSelect: (e: Episode) => void;
}) {
  const { page, error, loading } = state;
  if (error && !page) {
    return (
      <div role="alert" className="m-4 rounded-lg border px-3 py-3 text-[12.5px]" style={{ borderColor: "#f5c2c7", background: C.redAccent, color: C.red }}>
        Couldn&apos;t load unanswered conversations ({error}). Other tabs still work.{" "}
        <button className="font-semibold underline" onClick={state.refresh}>Try again</button>
      </div>
    );
  }
  if (!page) return <div className="px-5 py-10 text-center text-[12px]" style={{ color: C.sub }}>{loading ? "Loading…" : ""}</div>;
  const staleBanner = error ? (
    <div role="alert" className="mx-4 mt-3 rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: "#f5c2c7", background: C.redAccent, color: C.red }}>
      Couldn&apos;t refresh ({error}). Showing the last list. <button className="font-semibold underline" onClick={state.refresh}>Try again</button>
    </div>
  ) : null;
  if (page.episodes.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-[12px]" style={{ color: C.sub }}>
        {staleBanner}
        {state.query.bucket === "aged"
          ? "No aged conversations."
          : state.query.scope === "mine"
            ? "Nobody is waiting on you."
            : "Nobody is waiting on a person right now."}
      </div>
    );
  }
  return (
    <>
    {staleBanner}
    <ul>
      {page.episodes.map((e) => {
        const active = e.episodeId === selectedId;
        const aged = e.status === "aged";
        return (
          <li key={e.episodeId}>
            <button
              type="button"
              onClick={() => onSelect(e)}
              aria-current={active ? "true" : undefined}
              className="flex w-full flex-col gap-1 border-b px-4 py-3 text-left transition-colors hover:bg-[#f7f4ff] focus:outline-none focus-visible:bg-[#f7f4ff]"
              style={{ borderColor: C.border, background: active ? C.primaryAccent : undefined, borderLeft: active ? `3px solid ${C.primary}` : "3px solid transparent" }}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-semibold" style={{ color: C.dark }}>{e.customerName}</span>
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                  style={aged ? { background: "#eef1f4", color: C.sub } : { background: C.orangeAccent, color: C.orange }}
                  title={aged ? "Wait counted in working hours" : `Waiting since ${clock(e.since)}, counted in working hours`}
                >
                  {aged ? "Aged" : `Waiting ${formatWait(e.waitInHoursMinutes)}`}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]" style={{ color: C.sub }}>
                <span>{CHANNEL_LABEL[e.channel]}</span>
                <span aria-hidden>·</span>
                <span>{REASON_LABEL[e.reason]}</span>
                <span aria-hidden>·</span>
                <OwnerChip e={e} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
    </>
  );
}

/* ── Detail ────────────────────────────────────────────────────────────────────────────────── */

export function episodeAsCustomer(e: Episode): InboxCustomer {
  return {
    customer_id: e.customerId,
    customer_name: e.customerName,
    email_id: null,
    mobile_number: e.phone,
    createdAt: e.since,
    lastInteractionTime: e.recentMessages.at(-1)?.at ?? e.since,
  };
}

export function UnansweredDetail({
  episode,
  config,
  onClear,
  renderThread,
}: {
  episode: Episode;
  config: UnansweredConfig;
  onClear: (kind: ClearKind) => Promise<void>;
  /** Live mode: InboxView's real thread pane for this customer. Sample mode: omitted → sample messages. */
  renderThread?: (customer: InboxCustomer) => React.ReactNode;
}) {
  const [busy, setBusy] = useState<ClearKind | null>(null);
  const aged = episode.status === "aged";
  const go = async (k: ClearKind) => {
    setBusy(k);
    await onClear(k);
    setBusy(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="flex flex-col gap-3 border-b bg-white px-5 py-4" style={{ borderColor: C.border }} aria-label="Waiting on a reply">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[16px] font-semibold" style={{ color: C.dark }}>{episode.customerName}</h2>
          <span className="text-[12px]" style={{ color: C.sub }}>{[episode.phone, episode.vehicle].filter(Boolean).join(" · ")}</span>
        </div>

        <div
          className="flex flex-col gap-1 rounded-lg border px-3.5 py-2.5"
          style={aged ? { borderColor: C.border, background: "#f6f7f9" } : { borderColor: "#ffd8a8", background: C.orangeAccent }}
        >
          <p className="text-[13px] font-semibold" style={{ color: aged ? C.dark : C.orange }}>
            {aged ? config.agedLabel : `Waiting on a person for ${formatWait(episode.waitInHoursMinutes)}`}
            <span className="font-normal" style={{ color: C.sub }}> · since {clock(episode.since)}</span>
          </p>
          <p className="text-[12.5px]" style={{ color: C.dark }}>
            {REASON_LABEL[episode.reason]} · {CHANNEL_LABEL[episode.channel]} · Owner: <OwnerChip e={episode} />
          </p>
          <p className="text-[11.5px]" style={{ color: C.sub }}>A reply from the console clears this automatically. Opening the conversation doesn&apos;t.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void go("handled_elsewhere")}
            title="You answered in the CRM, by phone or in person"
            className="rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
            style={{ background: C.primary }}
          >
            {busy === "handled_elsewhere" ? "Clearing…" : "Handled elsewhere"}
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void go("no_reply_needed")}
            title="The customer doesn't need an answer (e.g. 'thanks')"
            className="rounded-lg border bg-white px-3.5 py-1.5 text-[12.5px] font-semibold disabled:opacity-50"
            style={{ borderColor: C.border, color: C.dark }}
          >
            {busy === "no_reply_needed" ? "Clearing…" : "No reply needed"}
          </button>
        </div>

        {episode.actionItems.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: C.sub }}>Open action items</h3>
            <ul className="flex flex-col gap-1.5">
              {episode.actionItems.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-[12.5px]" style={{ borderColor: C.border }}>
                  <span style={{ color: C.dark }}>{i.title}</span>
                  {i.due_at && (
                    <span className="shrink-0 text-[11.5px]" style={{ color: i.overdue ? C.red : C.sub, fontWeight: i.overdue ? 600 : 400 }}>
                      {i.overdue ? "Overdue · " : "Due "}{clock(i.due_at)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="flex min-h-0 flex-1 flex-col" style={{ background: C.bg }}>
        {renderThread ? (
          renderThread(episodeAsCustomer(episode))
        ) : (
          <ol className="flex flex-col gap-2 overflow-y-auto px-5 py-4" aria-label="Conversation">
            <li className="text-center text-[11px]" style={{ color: C.sub }}>Sample conversation</li>
            {episode.recentMessages.map((m, idx) => {
              const mine = m.from !== "CUSTOMER";
              return (
                <li key={`${m.at}-${idx}`} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className="max-w-[78%] rounded-2xl px-3 py-2 text-[13px]"
                    style={m.from === "CUSTOMER" ? { background: "#fff", border: `1px solid ${C.border}`, color: C.dark } : m.from === "HUMAN" ? { background: C.green, color: "#fff" } : { background: C.primary, color: "#fff" }}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                    <p className="mt-0.5 text-[10.5px] opacity-75">
                      {m.from === "CUSTOMER" ? "Customer" : m.from === "HUMAN" ? "Rep" : "Vini"} · {CHANNEL_LABEL[m.channel]} · {clock(m.at)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

/* ── Manager view ──────────────────────────────────────────────────────────────────────────── */

const CLICK_LABEL = { handled_elsewhere: "Handled elsewhere", no_reply_needed: "No reply needed" } as const;

export function ManagerView({ auth, department }: { auth: InboxAuth; department: Department }) {
  const [page, setPage] = useState<ManagerPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const q = scopeParams(auth);
    q.set("department", department);
    (async () => {
      try {
        const r = await fetch(`/api/inbox/unanswered/manager?${q}`, { cache: "no-store", headers: authHeaders(auth) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const p = (await r.json()) as ManagerPage;
        if (!cancelled) {
          setPage(p);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, department, tick]);

  const totals = useMemo(
    () => (page ? page.owners.reduce((t, o) => ({ open: t.open + o.open, aged: t.aged + o.aged }), { open: 0, aged: 0 }) : null),
    [page],
  );

  if (error && !page) {
    return (
      <div role="alert" className="m-5 rounded-lg border px-3 py-3 text-[12.5px]" style={{ borderColor: "#f5c2c7", background: C.redAccent, color: C.red }}>
        Couldn&apos;t load the manager view ({error}). <button className="font-semibold underline" onClick={() => setTick((t) => t + 1)}>Try again</button>
      </div>
    );
  }
  if (!page) return <div className="p-6 text-[12.5px]" style={{ color: C.sub }}>Loading…</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-semibold" style={{ color: C.dark }}>
          {department === "service" ? "Service" : "Sales"}: who is waiting on whom
        </h2>
        {totals && (
          <span className="text-[12.5px]" style={{ color: C.sub }}>
            {totals.open} open · {totals.aged} aged
          </span>
        )}
      </div>

      {!page.escalationConfigured && (
        <div className="rounded-lg border px-3.5 py-2.5 text-[12.5px]" style={{ borderColor: "#f1d38a", background: C.amberAccent, color: C.amber }}>
          <b>Escalation not configured.</b> Working hours, the wait limit or recipients aren&apos;t set for {department}, so nothing escalates and no texts go. Your CSM can set these.
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-white" style={{ borderColor: C.border }}>
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead>
            <tr style={{ background: C.bg, color: C.sub }}>
              <th className="px-3 py-2 text-left font-semibold">Owner</th>
              <th className="px-3 py-2 text-right font-semibold">Open</th>
              <th className="px-3 py-2 text-right font-semibold">Oldest open</th>
              <th className="px-3 py-2 text-right font-semibold">Aged</th>
              <th className="px-3 py-2 text-right font-semibold">Oldest aged</th>
              <th className="px-3 py-2 text-right font-semibold">Console replies</th>
              <th className="px-3 py-2 text-left font-semibold">Click clears</th>
            </tr>
          </thead>
          <tbody>
            {[
              ...page.owners.filter((o) => o.kind === "owned").map((o) => ({ o, group: false })),
              ...(page.owners.some((o) => o.kind !== "owned") ? [{ o: null, group: true }] : []),
              ...page.owners.filter((o) => o.kind !== "owned").map((o) => ({ o, group: false })),
            ].map(({ o, group }) =>
              group || !o ? (
                <tr key="unowned-group" className="border-t" style={{ borderColor: C.border, background: C.bg }}>
                  <td colSpan={7} className="px-3 py-1.5 text-[11.5px] font-semibold" style={{ color: C.sub }}>
                    Unowned queue · worked by {page.unownedQueueOwner}
                  </td>
                </tr>
              ) : (
              <tr key={o.ownerKey} className="border-t align-top" style={{ borderColor: C.border }}>
                <td className={`py-2 pr-3 ${o.kind === "owned" ? "pl-3" : "pl-6"}`} style={{ color: o.kind === "owned" ? C.dark : C.amber, fontWeight: o.kind === "owned" ? 500 : 600 }}>{o.ownerLabel}</td>
                <td className="px-3 py-2 text-right tabular-nums" style={{ color: o.open ? C.dark : C.sub, fontWeight: o.open ? 600 : 400 }}>{o.open}</td>
                <td className="px-3 py-2 text-right tabular-nums">{o.oldestOpenMinutes == null ? "–" : formatWait(o.oldestOpenMinutes)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{o.aged}</td>
                <td className="px-3 py-2 text-right tabular-nums">{o.oldestAgedMinutes == null ? "–" : formatWait(o.oldestAgedMinutes)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{o.repliesByMember}</td>
                <td className="px-3 py-2">
                  {o.clicks.length === 0 ? (
                    <span style={{ color: C.sub }}>None</span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {o.clicks.map((c, i) => (
                        <li key={`${c.at}-${i}`} style={{ color: C.dark }}>
                          {CLICK_LABEL[c.kind]} <span style={{ color: C.sub }}>by {c.actor}, {clock(c.at)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: C.sub }}>Escalation texts</h3>
        {page.texts.length === 0 ? (
          <p className="text-[12.5px]" style={{ color: C.sub }}>None.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {page.texts.map((t, i) => (
              <li key={`${t.at}-${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-[12.5px]" style={{ borderColor: C.border }}>
                <span style={{ color: C.dark }}>
                  {t.recipient} · {t.episodes} waiting · {clock(t.at)}
                  {t.error ? <span style={{ color: C.red }}> · {t.error}</span> : null}
                </span>
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize"
                  style={t.status === "failed" ? { background: C.redAccent, color: C.red } : t.status === "deferred" ? { background: C.amberAccent, color: C.amber } : { background: "#e7f7ef", color: C.green }}
                >
                  {t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ── Landing view per member (PRD R11, P2) ─────────────────────────────────────────────────────
 * Each member chooses which view Conversations opens on. Stored in this browser per rooftop + member;
 * a server-side member preference replaces this once the backend has one (so it follows them across
 * devices). An unknown or unavailable stored value falls back to All. */

export type LandingView = "all" | "unanswered" | "needs_attention";

export const LANDING_LABEL: Record<LandingView, string> = {
  all: "All",
  unanswered: "Unanswered",
  needs_attention: "Needs Attention",
};

const landingKey = (teamId: string, member: string) => `inbox_landing_${teamId}_${member || "anon"}`;

export function readLanding(teamId: string, member: string): LandingView {
  try {
    const v = window.localStorage.getItem(landingKey(teamId, member));
    return v === "unanswered" || v === "needs_attention" ? v : "all";
  } catch {
    return "all";
  }
}

export function writeLanding(teamId: string, member: string, v: LandingView): void {
  try {
    window.localStorage.setItem(landingKey(teamId, member), v);
  } catch {
    /* storage blocked: the choice lasts for this visit only */
  }
}
