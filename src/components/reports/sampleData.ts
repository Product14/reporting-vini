"use client";

/* Self-contained SAMPLE data for a service rooftop — lets the reports flow render fully populated with
 * NO backend, NO auth, NO env. Engaged via ?sample=1 in OverviewView, which short-circuits every fetch
 * and feeds these objects straight in. Purely illustrative (fake customers); never used for a real team. */

import { AGENTS, type NamedAppt, type WarmLeadItem } from "./data";
import type { FetchResult, ActionItem, ActionItemStats, Conversation } from "./liveData";

// The mock service agents (Service Inbound + Outbound) already carry full metrics/funnels in data.ts.
const serviceAgents = AGENTS.filter((a) => a.id === "service_ib" || a.id === "service_ob");

const now = Date.now();
const dayISO = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString().slice(0, 10);
const at = (daysAgo: number, h: number, m = 0) => { const d = new Date(now - daysAgo * 86_400_000); d.setHours(h, m, 0, 0); return d.toISOString(); };

const WARM: WarmLeadItem[] = [
  { customer: "Marcus Reid", phone: "+1 (205) 555-0100", tier: "hot", interest: "Brake noise on highway — wants an advisor", campaign: "Service Inbound", lastActivity: at(0, 8), serviceType: "service", source: "ib", leadId: "s1" },
  { customer: "Dana Whitfield", phone: "+1 (316) 555-0116", tier: "hot", interest: "Airbag recall — not yet scheduled", campaign: "Recall outreach", lastActivity: at(0, 9), serviceType: "service", source: "ob", leadId: "s2" },
  { customer: "Priya Anand", phone: "+1 (684) 555-0102", tier: "hot", interest: "Declined $890 brake service last visit", campaign: "Declined-service recovery", lastActivity: at(1, 14), serviceType: "service", source: "ob", leadId: "s3" },
  { customer: "Ken Osei", phone: "+1 (671) 555-0110", tier: "warm", interest: "Due for 30K service", campaign: "Due-service reminders", lastActivity: at(1, 11), serviceType: "service", source: "ob", leadId: "s4" },
  { customer: "Sofia Marin", phone: "+1 (219) 555-0114", tier: "warm", interest: "No-show 60K major service — reschedule", campaign: "Service Inbound", lastActivity: at(2, 16), serviceType: "service", source: "ib", leadId: "s5" },
  { customer: "Tom Reyes", phone: "+1 (415) 555-0148", tier: "warm", interest: "Tire rotation + alignment quote", campaign: "Service Inbound", lastActivity: at(2, 10), serviceType: "service", source: "ib", leadId: "s6" },
];

const APPTS: NamedAppt[] = [
  { customer: "Aaron Espinoza", phone: "+1 (205) 555-0180", channel: "Inbound", how: "AI-booked, on call", vehicle: "2019 Honda Odyssey", when: at(0, 9, 30), bookedAt: at(1, 17), status: "scheduled", assisted: false, serviceType: "service" },
  { customer: "Dana Whitfield", phone: "+1 (316) 555-0116", channel: "Outbound", how: "AI-booked, on call", vehicle: "2021 Honda CR-V", when: at(0, 11, 0), bookedAt: at(1, 10), status: "scheduled", assisted: false, serviceType: "service" },
  { customer: "Ken Osei", phone: "+1 (671) 555-0110", channel: "Inbound", how: "AI-assisted → CRM", vehicle: "2020 Honda Accord", when: at(0, 13, 15), bookedAt: at(2, 9), status: "scheduled", assisted: true, serviceType: "service" },
  { customer: "Priya Anand", phone: "+1 (684) 555-0102", channel: "Inbound", how: "AI-booked, on call", vehicle: "2018 Honda Civic", when: at(0, 15, 30), bookedAt: at(1, 12), status: "scheduled", assisted: false, serviceType: "service" },
  { customer: "Marcus Reid", phone: "+1 (205) 555-0100", channel: "Outbound", how: "AI-booked, via SMS", vehicle: "2017 Honda Pilot", when: at(-1, 10, 0), bookedAt: at(0, 8), status: "scheduled", assisted: false, serviceType: "service" },
];

export const SAMPLE_SERVICE_FEED: FetchResult = {
  agents: serviceAgents,
  hasData: true,
  everLive: true,
  fetchedAt: now,
  prior: {
    service_ib: { calls: 240, conversations: 220, qualified: 120, appointments: 104, leads: 250, sms: 52, afterHours: 39, talkMinutes: 740, transfers: 30, callbacks: 12 },
    service_ob: { calls: 900, conversations: 320, qualified: 150, appointments: 60, leads: 940, sms: 500, afterHours: 0, talkMinutes: 900, transfers: 8, callbacks: 20 },
  },
  start: dayISO(30),
  end: dayISO(0),
  timezone: "America/Toronto",
  warmLeads: WARM,
  namedAppointments: APPTS,
};

export const SAMPLE_AISTATS: { stats: ActionItemStats; closers: [] } = {
  stats: { created: 63, completed: 38, open: 25, overdue: 6, dueToday: 4 },
  closers: [],
};

export const SAMPLE_WORKITEMS: ActionItem[] = [
  { id: "a1", intent: "REQUEST_CALLBACK", leadId: "s2", assignedTo: "Priya Shah", description: "Call back re: airbag recall — not yet scheduled", priority: "HIGH", completed: false, dept: "service", customer: "Dana Whitfield", phone: "+1 (316) 555-0116", dueAt: at(3, 9), at: at(3, 9) },
  { id: "a2", intent: "FOLLOW_UP", leadId: "s1", assignedTo: "Reid Mercur", description: "Advisor callback — brake noise, wants a quote", priority: "HIGH", completed: false, dept: "service", customer: "Marcus Reid", phone: "+1 (205) 555-0100", dueAt: at(2, 10), at: at(2, 10) },
  { id: "a3", intent: "FOLLOW_UP", leadId: "s4", assignedTo: "Priya Shah", description: "Follow up on declined 30K service ($640)", priority: "MEDIUM", completed: false, dept: "service", customer: "Ken Osei", phone: "+1 (671) 555-0110", dueAt: at(1, 11), at: at(1, 11) },
  { id: "a4", intent: "RESCHEDULE", leadId: "s5", assignedTo: "Unassigned", description: "Reschedule no-show — 60K major service", priority: "MEDIUM", completed: false, dept: "service", customer: "Sofia Marin", phone: "+1 (219) 555-0114", dueAt: at(0, 12), at: at(0, 12) },
  { id: "a5", intent: "CONFIRM", leadId: "s6", assignedTo: "Priya Shah", description: "Confirm tomorrow 8:00 AM drop-off", priority: "LOW", completed: false, dept: "service", customer: "Tom Reyes", phone: "+1 (415) 555-0148", dueAt: at(0, 16), at: at(0, 16) },
];

const conv = (o: Partial<Conversation> & Pick<Conversation, "id" | "customer" | "channel" | "direction" | "title" | "at">): Conversation => ({
  leadId: null, phone: null, email: null, dept: "service", summary: "", appointmentScheduled: false, queryResolved: false, hasActionItem: false, ...o,
});

export const SAMPLE_CONVERSATIONS: Conversation[] = [
  conv({ id: "c1", customer: "Marcus Reid", phone: "+1 (205) 555-0100", channel: "call", direction: "inbound", agent: "Ava", title: "Brake noise — wants advisor", vehicle: "2017 Honda Pilot", durationSec: 134, score: 8, outcome: "Not Resolved", hasActionItem: true, at: at(0, 8, 12), summary: "Customer reported grinding brakes on the highway and asked for an advisor callback with a quote." }),
  conv({ id: "c2", customer: "Dana Whitfield", phone: "+1 (316) 555-0116", channel: "call", direction: "inbound", agent: "Ava", title: "Asked about airbag recall", vehicle: "2021 Honda CR-V", durationSec: 161, score: 7, outcome: "Not Resolved", hasActionItem: true, at: at(0, 9, 26), summary: "Asked whether her CR-V is covered by the airbag recall; AI confirmed and offered to schedule." }),
  conv({ id: "c3", customer: "Ken Osei", phone: "+1 (671) 555-0110", channel: "call", direction: "outbound", agent: "Theo", title: "Due for 30K service", vehicle: "2020 Honda Accord", durationSec: 48, score: 9, outcome: "Resolved", appointmentScheduled: true, at: at(1, 15, 20), summary: "Reached on the due-service list; booked a 30K service appointment." }),
  conv({ id: "c4", customer: "Priya Anand", phone: "+1 (684) 555-0102", channel: "sms", direction: "outbound", agent: "Theo", title: "Declined brake service last visit", vehicle: "2018 Honda Civic", msgs: 3, outcome: "Not Resolved", hasActionItem: true, at: at(1, 13, 58), summary: "Followed up on the declined $890 brake job; customer is weighing options.", sms: [{ authorType: "ai", body: "Hi Priya — following up on the brake service we recommended. Want me to book you in?", status: "sent", at: at(1, 13, 55), direction: "outbound" }, { authorType: "human", body: "Maybe next week, how much again?", status: "received", at: at(1, 13, 57), direction: "inbound" }, { authorType: "ai", body: "It's $890 all-in. I can hold a Saturday slot — interested?", status: "sent", at: at(1, 13, 58), direction: "outbound" }] }),
  conv({ id: "c5", customer: "Sofia Marin", phone: "+1 (219) 555-0114", channel: "call", direction: "inbound", agent: "Ava", title: "Oil change appointment", vehicle: "2016 Honda Fit", durationSec: 65, score: 9, outcome: "Resolved", queryResolved: true, appointmentScheduled: true, at: at(1, 11, 12), summary: "Booked a routine oil change and confirmed pricing." }),
  conv({ id: "c6", customer: "Tom Reyes", phone: "+1 (415) 555-0148", channel: "call", direction: "outbound", agent: "Theo", title: "Tire rotation + alignment", vehicle: "2019 Honda HR-V", durationSec: 121, score: 8, outcome: "Not Resolved", hasActionItem: true, at: at(2, 10, 5), summary: "Quoted a tire rotation and alignment; customer to confirm a drop-off time." }),
];
