import { fetchInboxAgents } from "@/components/inbox/api";
import type { AgentProfile, AppointmentList, AppointmentListQuery, OverviewResponses, ReportsResponses } from "./contract";
import { apiActionItems, apiAppointmentList, apiAppointments, apiAppointmentTrend, apiCallsReport, apiContact, apiFollowUp, apiUpcoming, type ApiCtx } from "./api";
import { mockActionItems, mockAgents, mockAppointmentList, mockAppointments, mockCallsReport, mockCampaign, mockContact, mockFollowUp } from "./mock";
import { resolveWindow, type ResolvedWindow } from "./window";

/* Where the Service OM pages get their numbers: Om's API ("api") or the sample data ("mock").
 *
 * Order: `?om_source=` (local dev only, so a dealer can never flip it), then NEXT_PUBLIC_SERVICE_OM_SOURCE,
 * then the default — "mock" in local dev, "api" in a production build. A production deploy therefore
 * never shows sample data unless someone sets the env var to "mock" on purpose, and the page labels
 * sample data on screen whenever it is used. */
export type OmSource = "api" | "mock";

export function resolveOmSource(urlValue: string | null | undefined, env: string | undefined = process.env.NEXT_PUBLIC_SERVICE_OM_SOURCE, isProd = process.env.NODE_ENV === "production"): OmSource {
  const norm = (v: string | null | undefined): OmSource | null => {
    const s = (v ?? "").trim().toLowerCase();
    return s === "api" || s === "mock" ? s : null;
  };
  return (!isProd ? norm(urlValue) : null) ?? norm(env) ?? (isProd ? "api" : "mock");
}

export interface SourceCtx extends ApiCtx {
  nameHint?: string;
  agents?: string[];
  /** Sample data only: answer the way UAT does today, Spyne-assisted not available (`?om_assisted=off`). */
  mockAssistedOff?: boolean;
}

const mockCtx = (ctx: SourceCtx) => ({ teamId: ctx.teamId, nameHint: ctx.nameHint, agents: ctx.agents, assistedOff: ctx.mockAssistedOff });

/** A short wait on sample data, so loading states get exercised the way the real API will exercise them.
 * SERVICE_OM_MOCK_LATENCY_MS (server/scripts only, never in the browser bundle) shortens it for the
 * all-rooftops check. */
const MOCK_LATENCY_MS = Number(process.env.SERVICE_OM_MOCK_LATENCY_MS ?? 450);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Carl's and Emily's names and photos. Om's API doesn't carry them (gap 1), so they come from the rooftop's
 * onboarded Service agents, the same call the inbox makes. Null when that call fails or runs outside a
 * browser (the all-rooftops check); the pages then say "Inbound agent" / "Outbound agent". */
async function apiAgents(ctx: SourceCtx): Promise<AgentProfile[] | null> {
  if (typeof window === "undefined") return null;
  const rows = await fetchInboxAgents({ teamId: ctx.teamId, enterpriseId: ctx.enterpriseId, spyneToken: ctx.spyneToken, spyneEnv: ctx.spyneEnv });
  const service = rows.filter((a) => (a.agentType ?? "").toLowerCase() === "service");
  const one = (d: "inbound" | "outbound"): AgentProfile[] => {
    const a = service.find((x) => (x.agentCallType ?? "").toLowerCase() === d);
    return a ? [{ direction: d, name: a.name ?? null, imageUrl: a.imageUrl ?? null }] : [];
  };
  return service.length ? [...one("inbound"), ...one("outbound")] : null;
}

export async function loadOverview(source: OmSource, ctx: SourceCtx, w: ResolvedWindow): Promise<OverviewResponses> {
  if (source === "mock") {
    await wait(MOCK_LATENCY_MS);
    const m = mockCtx(ctx);
    return {
      appointments: mockAppointments(m, w),
      upcoming: mockAppointments(m, w, { list: "upcoming", limit: 10 }),
      actionItems: mockActionItems(m, w, { limit: 10 }),
      agents: mockAgents(m),
    };
  }
  const readAt = new Date().toISOString();
  const [appointments, upcoming, actionItems, agents] = await Promise.all([
    apiAppointments(ctx, w.params),
    apiUpcoming(ctx, w.params, 10),
    apiActionItems(ctx, w.params, 10),
    apiAgents(ctx),
  ]);
  return { readAt, appointments, upcoming, actionItems, agents };
}

/** The Reports page: the same /appointment, upcoming and action-item calls as the Overview (so shared numbers
 * are the same read), plus the funnel, both directions of /contact, the calls report and the follow-up lists,
 * all on the page's window and timezone (rule 2). The 7-day trend card is the one fixed window: the last 7
 * days with grain=day, one call per agent (doc 1.7), in the same timezone. */
export async function loadReports(source: OmSource, ctx: SourceCtx, w: ResolvedWindow): Promise<ReportsResponses> {
  const w7 = resolveWindow("last7", null, w.params.timezone ?? null);
  if (source === "mock") {
    await wait(MOCK_LATENCY_MS);
    const m = mockCtx(ctx);
    return {
      appointments: mockAppointments(m, w),
      campaign: mockCampaign(m, w),
      contactInbound: mockContact(m, w, "inbound"),
      contactOutbound: mockContact(m, w, "outbound"),
      upcoming: mockAppointments(m, w, { list: "upcoming", limit: 20 }),
      actionItems: mockActionItems(m, w, { limit: 50 }),
      callsReport: mockCallsReport(m, w),
      followUp: mockFollowUp(m, w, "warmLeads", 50),
      trendInbound: mockAppointments(m, w7, { grain: "day", direction: "inbound" }),
      trendOutbound: mockAppointments(m, w7, { grain: "day", direction: "outbound" }),
      agents: mockAgents(m),
    };
  }
  const readAt = new Date().toISOString();
  // No /campaign: its funnel counts customers enrolled in the window, and the outbound funnel is the period's
  // activity instead (user, 13-Oct). It was also the slowest call, timing out on long windows on prod.
  const campaign = null;
  const [appointments, contactInbound, contactOutbound, upcoming, actionItems, callsReport, followUp, trendInbound, trendOutbound, agents] = await Promise.all([
    apiAppointments(ctx, w.params),
    apiContact(ctx, w.params, "inbound"),
    apiContact(ctx, w.params, "outbound"),
    apiUpcoming(ctx, w.params, 20),
    apiActionItems(ctx, w.params, 50),
    apiCallsReport(ctx, w.params),
    apiFollowUp(ctx, w.params, "warmLeads", 50),
    apiAppointmentTrend(ctx, w7.params, "inbound"),
    apiAppointmentTrend(ctx, w7.params, "outbound"),
    apiAgents(ctx),
  ]);
  return { readAt, appointments, campaign, contactInbound, contactOutbound, upcoming, actionItems, callsReport, followUp, trendInbound, trendOutbound, agents };
}

/** The rows behind a clicked number (A9). */
export async function loadAppointmentList(source: OmSource, ctx: SourceCtx, w: ResolvedWindow, q: AppointmentListQuery): Promise<AppointmentList | null> {
  if (source === "mock") {
    await wait(MOCK_LATENCY_MS / 2);
    return mockAppointmentList(mockCtx(ctx), w, q);
  }
  return apiAppointmentList(ctx, w.params, q);
}
