import type { ServiceOverviewModel } from "./overviewModel";
import type { ServiceReportsModel } from "./reportsModel";

/* The Overview = Reports comparison behind scripts/check-service-om-parity.ts, kept pure here so it is
 * tested on its own (tests/serviceOmParity.test.ts), including that it catches a planted mismatch. */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const show = (v: unknown) => (v === null || v === undefined ? "n/a" : String(v));

export function compare(ov: ServiceOverviewModel, rp: ServiceReportsModel): Check[] {
  const out: Check[] = [];
  const eq = (name: string, a: unknown, b: unknown) => out.push({ name, ok: a === b, detail: `overview ${show(a)} vs reports ${show(b)}` });

  out.push({ name: "available", ok: ov.appointments.total !== null, detail: ov.appointments.reason ?? "" });
  const reportsTotal = rp.agents.reduce((n, a) => n + (a.period.work.visitsBooked ?? 0), 0) + rp.appointments.unplaced;
  eq("headline", ov.appointments.total, reportsTotal);
  eq("agents", ov.agents.rows.map((r) => r.direction).join("+"), rp.agents.map((a) => a.direction).join("+"));
  for (const r of ov.agents.rows) {
    const a = rp.agents.find((x) => x.key === r.key);
    if (!a) {
      out.push({ name: `${r.direction} agent`, ok: false, detail: "on the Overview, missing on Reports" });
      continue;
    }
    eq(`${r.direction} booked by Spyne`, r.bookedBySpyne, a.period.work.bookedBySpyne);
    eq(`${r.direction} assisted by Spyne`, r.spyneAssisted, a.period.work.spyneAssisted);
    eq(`${r.direction} visits booked`, r.visitsBooked, a.period.work.visitsBooked);
    eq(`${r.direction} funnel booked`, r.visitsBooked, a.bookedAppointments);
    eq(`${r.direction} funnel bar booked`, r.visitsBooked, a.funnel.find((s) => s.key === "booked")?.customers ?? null);
    // A legit funnel: no stage bigger than the one above it.
    const v = a.funnel.map((s) => s.customers);
    const bad = v.findIndex((x, i) => i > 0 && x !== null && v[i - 1] !== null && x > (v[i - 1] as number));
    out.push({ name: `${r.direction} funnel nests`, ok: bad === -1, detail: a.funnel.map((s) => `${s.label} ${show(s.customers)}`).join(" → ") });
  }
  eq("action items open", ov.actionItems.openNow, rp.actionItems.openNow);
  eq("action items past SLA", ov.actionItems.pastSla, rp.actionItems.pastSla);
  eq("action items due today", ov.actionItems.dueToday, rp.actionItems.dueToday);
  eq("upcoming count", ov.upcoming.count, rp.upcomingCount);
  // The Overview asks for the first 10 upcoming, Reports for 20: the 10 must be Reports' first 10.
  const ovUp = ov.upcoming.rows.map((r) => r.id);
  const rpUp = (rp.upcoming ?? []).map((m) => m.id).slice(0, ovUp.length);
  out.push({ name: "upcoming rows", ok: ovUp.join(",") === rpUp.join(","), detail: `overview ${ovUp.length} rows, reports' first ${rpUp.length} ${ovUp.join(",") === rpUp.join(",") ? "the same" : "differ"}` });
  return out;
}

