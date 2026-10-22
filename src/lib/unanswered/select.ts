/* Pure query + summary logic for the Unanswered queue. The sample source uses it today; it is also the
 * reference the backend team-list query (PRD R13) and manager view (R7) are tested against. */
import type {
  ClearKind,
  Department,
  Episode,
  ManagerOwnerRow,
  OwnerState,
  UnansweredQuery,
} from "./types";

const ms = (iso: string) => Date.parse(iso) || 0;

/** R13: filter by department + bucket (+ owner for Mine), sort by `since`. */
export function selectEpisodes(all: Episode[], q: UnansweredQuery, viewerConsoleUserId: string | null): Episode[] {
  const rows = all.filter(
    (e) =>
      e.department === q.department &&
      e.status === q.bucket &&
      (q.scope === "team" || (!!viewerConsoleUserId && e.owner.consoleUserId === viewerConsoleUserId)),
  );
  rows.sort((a, b) => (q.sort === "oldest" ? ms(a.since) - ms(b.since) : ms(b.since) - ms(a.since)));
  return rows;
}

/** The badge counts open episodes only: aged ones are off the badge (R3). */
export function countBuckets(all: Episode[], department: Department): { open: number; aged: number } {
  let open = 0;
  let aged = 0;
  for (const e of all) {
    if (e.department !== department) continue;
    if (e.status === "open") open += 1;
    else aged += 1;
  }
  return { open, aged };
}

export interface ClearRecord {
  episodeId: string;
  department: Department;
  ownerKey: string;
  /** Owner as it was at clear time, so an owner whose queue is now empty still shows their clears. */
  ownerLabel: string;
  ownerState: OwnerState;
  kind: ClearKind | "console_reply";
  actor: string;
  at: string;
}

export function ownerKeyOf(e: Episode): string {
  return e.owner.state === "owned" && e.owner.consoleUserId ? e.owner.consoleUserId : e.owner.state;
}

export function ownerRowLabel(e: Episode): string {
  return e.owner.state === "owned" ? e.owner.name ?? "Unknown" : OWNER_LABEL[e.owner.state];
}

const OWNER_LABEL: Record<Exclude<OwnerState, "owned">, string> = {
  no_owner: "No owner",
  unmapped: "Unmapped (CRM owner has no console seat)",
  stale: "Stale (owner not refreshed)",
};

/** R7: per owner, open and aged counts, oldest in-hours wait of each, click clears, replies per member. */
export function summarizeByOwner(all: Episode[], clears: ClearRecord[], department: Department): ManagerOwnerRow[] {
  const rows = new Map<string, ManagerOwnerRow>();
  const row = (key: string, label: string, kind: OwnerState): ManagerOwnerRow => {
    let r = rows.get(key);
    if (!r) {
      r = { ownerKey: key, ownerLabel: label, kind, open: 0, aged: 0, oldestOpenMinutes: null, oldestAgedMinutes: null, clicks: [], repliesByMember: 0 };
      rows.set(key, r);
    }
    return r;
  };
  for (const e of all) {
    if (e.department !== department) continue;
    const key = ownerKeyOf(e);
    const r = row(key, ownerRowLabel(e), e.owner.state);
    if (e.status === "open") {
      r.open += 1;
      r.oldestOpenMinutes = Math.max(r.oldestOpenMinutes ?? 0, e.waitInHoursMinutes);
    } else {
      r.aged += 1;
      r.oldestAgedMinutes = Math.max(r.oldestAgedMinutes ?? 0, e.waitInHoursMinutes);
    }
  }
  for (const c of clears) {
    if (c.department !== department) continue;
    const r = rows.get(c.ownerKey) ?? row(c.ownerKey, c.ownerLabel, c.ownerState);
    if (c.kind === "console_reply") r.repliesByMember += 1;
    else r.clicks.push({ at: c.at, actor: c.actor, kind: c.kind });
  }
  // Named owners first (most open), then the unowned rows the unowned-queue owner works.
  const order: OwnerState[] = ["owned", "no_owner", "unmapped", "stale"];
  return [...rows.values()].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.open - a.open || a.ownerLabel.localeCompare(b.ownerLabel),
  );
}

/** "42m", "2h 05m", "1d 3h" — in-hours wait, so a weekend never inflates it. */
export function formatWait(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))}m`;
  if (minutes < 60 * 24) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  const d = Math.floor(minutes / (60 * 24));
  const h = Math.floor((minutes % (60 * 24)) / 60);
  return `${d}d ${h}h`;
}

export const REASON_LABEL: Record<Episode["reason"], string> = {
  handoff: "Vini handed off",
  action_item: "Open action item",
  human_last_reply: "Rep replied last",
  missed_call: "Missed call",
};

export function ownerLabel(e: Episode): string {
  if (e.owner.state === "owned") return e.owner.name ?? "Owner";
  if (e.owner.state === "unmapped") return e.owner.name ? `${e.owner.name} (no console seat)` : "Unmapped";
  if (e.owner.state === "stale") return e.owner.name ? `${e.owner.name} (stale)` : "Stale";
  return "No owner";
}
