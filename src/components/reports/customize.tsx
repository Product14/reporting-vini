"use client";

/* Per-page layout customization — a customer can HIDE and REORDER the cards/sections on a report page.
 * The chosen layout lives in localStorage, keyed by page + rooftop, so it's per-browser and per-rooftop
 * and survives reloads. Sections are addressed by a stable string id; new sections added later append at
 * the end automatically (saved order is merged with the current id list), so a stored layout never breaks
 * when the page gains a section. Server render is untouched — the layout only applies after mount. */

import React, { useCallback, useEffect, useMemo, useState } from "react";

export interface SectionDef {
  id: string;
  label: string; // shown in the edit toolbar
  node: React.ReactNode; // the actual section content
}

interface Layout {
  order: string[];
  hidden: string[];
}

export interface CustomizeCtrl {
  editing: boolean;
  setEditing: (v: boolean) => void;
  order: string[];
  hidden: Set<string>;
  toggle: (id: string) => void;
  move: (id: string, dir: -1 | 1) => void;
  reset: () => void;
  dirty: boolean; // true when the layout differs from the default (all-visible, natural order)
  saveForMe: () => void; // persist the current layout to this browser only (localStorage)
  saveForAccount: () => Promise<boolean>; // publish to Supabase → shared with every user + rooftop
  savingAccount: boolean;
  hasAccountLayout: boolean; // an account-wide layout exists on the server
}

export interface CustomizeScope {
  teamId: string;
  enterpriseId?: string;
  spyneToken?: string;
}

export function useCustomize(pageKey: string, scope: CustomizeScope, ids: string[]): CustomizeCtrl {
  const { teamId, enterpriseId = "", spyneToken = "" } = scope;
  const storageKey = `vini:layout:${pageKey}:${teamId || "default"}`;
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<Layout>({ order: [], hidden: [] });
  const [accountLayout, setAccountLayout] = useState<Layout | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);

  // Load precedence: this browser's "just me" layout (localStorage) wins; else the account-wide layout
  // (Supabase); else the built-in default. Local is read synchronously after mount; the account layout is
  // fetched and only applied when there's no local override.
  useEffect(() => {
    let local: Layout | null = null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const p = JSON.parse(raw) as Partial<Layout>;
        local = { order: Array.isArray(p.order) ? p.order : [], hidden: Array.isArray(p.hidden) ? p.hidden : [] };
      }
    } catch {
      /* ignore malformed layout */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (local) setLayout(local);

    if (!teamId) return;
    let on = true;
    const q = new URLSearchParams({ team_id: teamId, page: pageKey });
    if (enterpriseId) q.set("enterprise_id", enterpriseId);
    const headers = spyneToken ? { Authorization: `Bearer ${spyneToken}` } : undefined;
    fetch(`/api/report-layout?${q.toString()}`, { headers, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!on) return;
        const a = j?.layout as Partial<Layout> | null | undefined;
        if (a && (Array.isArray(a.order) || Array.isArray(a.hidden))) {
          const al: Layout = { order: Array.isArray(a.order) ? a.order : [], hidden: Array.isArray(a.hidden) ? a.hidden : [] };
          setAccountLayout(al);
          if (!local) setLayout(al); // no personal override → follow the account layout
        }
      })
      .catch(() => {});
    return () => { on = false; };
  }, [storageKey, teamId, enterpriseId, spyneToken, pageKey]);

  // Effective order: saved order (dropping ids that no longer exist) then any new ids appended.
  const order = useMemo(
    () => [...layout.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !layout.order.includes(id))],
    [layout.order, ids],
  );
  // hidden holds ANY id — top-level sections AND individual sub-elements (Hideable) — so it isn't filtered
  // to the section ids. Stale ids simply never match a rendered element (harmless).
  const hidden = useMemo(() => new Set(layout.hidden), [layout.hidden]);
  const dirty = layout.hidden.length > 0 || order.some((id, i) => id !== ids[i]);

  // Edits update the working layout AND auto-save to this browser (so they're never lost = "just me").
  const persistLocal = useCallback(
    (next: Layout) => {
      setLayout(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage full / unavailable — the in-memory layout still applies for this session */
      }
    },
    [storageKey],
  );

  const toggle = useCallback(
    (id: string) => {
      const h = new Set(hidden);
      if (h.has(id)) h.delete(id);
      else h.add(id);
      persistLocal({ order, hidden: [...h] });
    },
    [hidden, order, persistLocal],
  );

  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      const next = [...order];
      [next[i], next[j]] = [next[j], next[i]];
      persistLocal({ order: next, hidden: [...hidden] });
    },
    [order, hidden, persistLocal],
  );

  // Reset goes to the TRUE built-in default (every section visible, natural order) — never the rooftop's
  // shared account layout. `dirty` is computed against this same true default, so the button's enabled
  // state and what it resets TO always agree — if the account layout hides something, dirty is true (you
  // differ from the true default) and reset actually clears that, rather than reapplying the same hidden
  // account layout as a no-op. Persisted like any other edit, so it sticks across reloads.
  const reset = useCallback(() => persistLocal({ order: [], hidden: [] }), [persistLocal]);

  const saveForMe = useCallback(() => persistLocal({ order, hidden: [...hidden] }), [order, hidden, persistLocal]);

  const saveForAccount = useCallback(async (): Promise<boolean> => {
    if (!teamId) return false;
    setSavingAccount(true);
    try {
      const next: Layout = { order, hidden: [...hidden] };
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (spyneToken) headers.Authorization = `Bearer ${spyneToken}`;
      const r = await fetch(`/api/report-layout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ team_id: teamId, enterprise_id: enterpriseId, page: pageKey, layout: next }),
      });
      if (!r.ok) return false;
      setAccountLayout(next);
      // Clear the personal override so this browser now follows the shared account layout (== what we saved).
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
      return true;
    } catch {
      return false;
    } finally {
      setSavingAccount(false);
    }
  }, [teamId, enterpriseId, spyneToken, pageKey, order, hidden, storageKey]);

  return { editing, setEditing, order, hidden, toggle, move, reset, dirty, saveForMe, saveForAccount, savingAccount, hasAccountLayout: accountLayout != null };
}

/* The Customize button — opens the customize MODAL (all hide/reorder controls live there, so the page
 * itself never enters an inline edit mode). */
export function CustomizeToggle({ ctrl }: { ctrl: CustomizeCtrl }) {
  return (
    <button
      onClick={() => ctrl.setEditing(true)}
      className="no-print inline-flex items-center gap-1.5 rounded-lg border border-[#e5e7eb] bg-white px-2.5 py-1 text-[11.5px] font-semibold text-[#6b7280] transition-colors hover:text-[#111]"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h10M4 12h16M4 18h7" />
        <circle cx="18" cy="6" r="2" /><circle cx="14" cy="18" r="2" />
      </svg>
      Customize
    </button>
  );
}

/* Renders the sections in the customer's chosen order, dropping hidden ones. The page always shows the
 * APPLIED layout — the controls to change it live in the modal, not inline. */
export function CustomizeSections({ ctrl, sections }: { ctrl: CustomizeCtrl; sections: SectionDef[] }) {
  const byId = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections]);
  return (
    <>
      {ctrl.order.map((id) => {
        const s = byId.get(id);
        if (!s || s.node == null || s.node === false) return null;
        if (ctrl.hidden.has(id)) return null;
        return <React.Fragment key={id}>{s.node}</React.Fragment>;
      })}
    </>
  );
}

/* In-place variant for pages whose sections can't be cleanly hoisted into an array (deeply nested /
 * conditional JSX). Wrap each section inline: <Section id ctrl>…existing JSX…</Section>. It reorders via
 * CSS flex `order` (nothing moves in source) and hides by not-rendering. The parent must be a flex column;
 * fixed chrome above the sections keeps the default order 0 and stays on top (sections use order ≥ 1). */
export function Section({ id, ctrl, children }: { id: string; ctrl: CustomizeCtrl; children: React.ReactNode }) {
  if (children == null || children === false) return null;
  if (ctrl.hidden.has(id)) return null;
  const idx = ctrl.order.indexOf(id);
  return <div style={{ order: idx < 0 ? 999 : idx + 1 }}>{children}</div>;
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-[#813fed] transition-colors hover:bg-[#f3eaff] disabled:cursor-not-allowed disabled:opacity-30"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

/* Eye (visible) / eye-off (hidden) glyph. */
function EyeIcon({ off, size = 14 }: { off: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {off ? (
        <>
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68M6.06 6.06A13.16 13.16 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 4.06-.94" />
          <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" />
          <path d="M2 2l20 20" />
        </>
      ) : (
        <>
          <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

/* Hide / show toggle rendered as an eye icon — hidden = eye-off (filled purple), visible = plain eye. */
function HideEyeBtn({ isHidden, onClick }: { isHidden: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={isHidden ? "Show" : "Hide"}
      aria-label={isHidden ? "Show" : "Hide"}
      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
        isHidden ? "bg-[#813fed] text-white" : "text-[#813fed] hover:bg-[#f3eaff]"
      }`}
    >
      <EyeIcon off={isHidden} />
    </button>
  );
}

/* Fine-grained hide for an INDIVIDUAL element inside a section (a card / tile / div). Wrap inline:
 * <Hideable id="tile.appts" ctrl={ctrl}>…</Hideable>. Renders the children with NO wrapper when visible
 * (layout stays pixel-identical) and nothing when hidden. Visibility is toggled from the Customize modal
 * (register the id + a label in that page's manifest). Give each a stable, unique id. */
export function Hideable({ id, ctrl, children }: { id: string; ctrl: CustomizeCtrl; children: React.ReactNode }) {
  if (ctrl.hidden.has(id)) return null;
  return <>{children}</>;
}

/* Manifest for the Customize modal: the top-level sections (reorderable + hideable), each optionally
 * listing the individual cards/tiles inside it (hideable). ids must match the section ids passed to
 * useCustomize and the <Hideable id=…> ids on the page. */
export interface CustomizeGroup {
  id: string;
  label: string;
  items?: { id: string; label: string }[];
}

/* The Customize modal — show/hide + reorder sections, and hide individual cards/tiles. Changes apply
 * live (auto-saved to this browser = "just me"); "Apply to everyone" publishes to the account (Supabase).
 * Renders only when ctrl.editing (opened by CustomizeToggle). */
export function CustomizeModal({ ctrl, groups, accountLabel }: { ctrl: CustomizeCtrl; groups: CustomizeGroup[]; accountLabel?: string }) {
  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  if (!ctrl.editing) return null;
  const close = () => ctrl.setEditing(false);
  return (
    <div className="no-print fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={close} />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_20px_60px_rgba(16,24,40,0.25)]">
        <div className="flex items-start justify-between gap-3 border-b border-[#f0f0f0] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-bold text-[#111]">Customize layout</h2>
            <p className="mt-0.5 text-[12px] text-[#6b7280]">Show, hide and reorder what appears on this report. The eye toggles visibility.</p>
          </div>
          <button onClick={close} aria-label="Close" className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-[#9ca3af] transition-colors hover:bg-[#f3f4f6] hover:text-[#111]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-2">
            {ctrl.order.map((id, idx) => {
              const g = byId.get(id);
              if (!g) return null;
              const isHidden = ctrl.hidden.has(id);
              return (
                <div key={id} className="overflow-hidden rounded-xl border border-[#eceaf5]">
                  <div className="flex items-center justify-between gap-2 bg-[#faf8ff] px-3 py-2.5">
                    <span className={`text-[13px] font-semibold ${isHidden ? "text-[#9ca3af] line-through" : "text-[#111]"}`}>{g.label}</span>
                    <div className="flex items-center gap-1">
                      <IconBtn label="Move up" disabled={idx === 0} onClick={() => ctrl.move(id, -1)}><path d="M18 15l-6-6-6 6" /></IconBtn>
                      <IconBtn label="Move down" disabled={idx === ctrl.order.length - 1} onClick={() => ctrl.move(id, 1)}><path d="M6 9l6 6 6-6" /></IconBtn>
                      <HideEyeBtn isHidden={isHidden} onClick={() => ctrl.toggle(id)} />
                    </div>
                  </div>
                  {g.items && g.items.length > 0 && (
                    <div className={`px-3 py-1.5 ${isHidden ? "opacity-50" : ""}`}>
                      {g.items.map((it) => {
                        const ih = ctrl.hidden.has(it.id);
                        return (
                          <div key={it.id} className="flex items-center justify-between gap-2 py-1">
                            <span className={`text-[12px] ${ih ? "text-[#9ca3af] line-through" : "text-[#374151]"}`}>{it.label}</span>
                            <HideEyeBtn isHidden={ih} onClick={() => ctrl.toggle(it.id)} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[#f0f0f0] px-5 py-3.5">
          <button onClick={ctrl.reset} disabled={!ctrl.dirty} className="rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-[#6b7280] transition-colors hover:text-[#111] disabled:opacity-40">
            Reset to default
          </button>
          <div className="flex items-center gap-2">
            <button onClick={close} className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#374151] transition-colors hover:bg-[#faf8ff]">
              Done — just me
            </button>
            <button
              disabled={ctrl.savingAccount}
              onClick={async () => { const ok = await ctrl.saveForAccount(); if (ok) close(); }}
              className="rounded-lg border border-[#813fed] bg-[#813fed] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#6d28d9] disabled:opacity-60"
            >
              {ctrl.savingAccount ? "Saving…" : `Apply to everyone${accountLabel ? ` at ${accountLabel}` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
