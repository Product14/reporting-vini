"use client";

import { createContext, useContext, useState, ReactNode } from "react";

/* ── Types ── */
export type NewCampaignCategory = "sales" | "service" | "";
export type NewCampaignSubType =
  | "appointment_setting"
  | "lead_generation"
  | "follow_up"
  // Sales Outbound catalog (final PRD §02) — data-layer-backed motions.
  | "aged_lead"
  | "speed_to_lead"
  | "appointment_confirmation"
  | "service_drive_trade_in"
  | "equity_mining"
  | "lease_maturity"
  | "recall"
  | "service_reminder"
  | "";
export type RecurringFrequency = "daily" | "weekly" | "biweekly" | "monthly";

export interface AudienceFilter {
  id: string;
  label: string;
  category: "intent" | "behavior" | "segment";
}

export interface AudienceSegment {
  id: string;
  label: string;
  description: string;
  count: number;
  category: "intent" | "behavior" | "segment";
  icon: string;
}

export const AUDIENCE_SEGMENTS: AudienceSegment[] = [
  { id: "discount_seekers", label: "Discount Seekers", description: "Leads who inquired about promotions or price drops", count: 342, category: "intent", icon: "%" },
  { id: "ev_interest", label: "EV Interested", description: "Leads who asked about electric or hybrid vehicles", count: 218, category: "intent", icon: "⚡" },
  { id: "trade_in_ready", label: "Trade-In Ready", description: "Leads who mentioned trading in their current vehicle", count: 189, category: "intent", icon: "🔄" },
  { id: "financing_inquiry", label: "Financing Inquiry", description: "Leads who asked about loan rates or financing options", count: 276, category: "intent", icon: "$" },
  { id: "feature_seeker", label: "Feature Seekers", description: "Leads who asked about specific features like sunroof, AWD, etc.", count: 154, category: "intent", icon: "★" },
  { id: "hot_leads", label: "Hot Leads", description: "Leads with multiple touchpoints in last 7 days", count: 98, category: "behavior", icon: "🔥" },
  { id: "dormant_leads", label: "Dormant Leads", description: "Leads with no activity in the last 30+ days", count: 467, category: "behavior", icon: "💤" },
  { id: "test_drive_booked", label: "Test Drive Booked", description: "Leads who scheduled but didn't show up", count: 63, category: "behavior", icon: "🚗" },
  { id: "website_visitors", label: "Recent Website Visitors", description: "Leads who visited the website in the last 14 days", count: 391, category: "behavior", icon: "🌐" },
  { id: "luxury_segment", label: "Luxury Segment", description: "Leads browsing vehicles over $60k", count: 112, category: "segment", icon: "💎" },
  { id: "first_time_buyers", label: "First-Time Buyers", description: "Leads who flagged as first vehicle purchase", count: 203, category: "segment", icon: "🎯" },
  { id: "fleet_buyers", label: "Fleet Buyers", description: "Corporate or multi-vehicle purchase leads", count: 45, category: "segment", icon: "🏢" },
  // Data-layer-backed cohorts (final PRD §03–04). Computed from the Vehicle / Deal /
  // Service-RO entities, not from lead intent — these light up the equity/lease/trade catalog.
  { id: "equity_positive", label: "Equity-Positive Owners", description: "Owners whose estimated equity (Black Book ACV − payoff) is positive", count: 271, category: "segment", icon: "📈" },
  { id: "lease_maturing", label: "Lease Maturing (90d)", description: "Customers whose lease end date falls within the next 90 days", count: 134, category: "segment", icon: "📅" },
  { id: "service_due", label: "Service-Due", description: "Vehicles past their OEM service interval by mileage estimate", count: 318, category: "behavior", icon: "🔧" },
  { id: "lapsed_owner", label: "Lapsed Owners", description: "Past buyers with no sales or service contact in 12+ months", count: 156, category: "segment", icon: "🕰️" },
  { id: "recall_eligible", label: "Recall-Eligible", description: "Owned vehicles with an open NHTSA recall (own customers only)", count: 89, category: "segment", icon: "🛟" },
];

export interface AgentOption {
  id: string;
  name: string;
  location: string;
  languages: string[];
  totalCalls: number;
  successRate: number;
  avatar: string;
}

export const AGENT_OPTIONS: AgentOption[] = [
  { id: "alex", name: "Alex Johnson", location: "New York", languages: ["English"], totalCalls: 1240, successRate: 75, avatar: "" },
  { id: "maria", name: "Maria Lopez", location: "Miami", languages: ["English", "Spanish"], totalCalls: 870, successRate: 75, avatar: "" },
  { id: "james", name: "James Carter", location: "Chicago", languages: ["English"], totalCalls: 1105, successRate: 81, avatar: "" },
  { id: "priya", name: "Priya Sharma", location: "Dallas", languages: ["English", "Hindi"], totalCalls: 643, successRate: 78, avatar: "" },
];

export interface UseCase {
  id: string;
  name: string;
  goal: string;
  passRate: number;
  status: "active" | "draft";
}

export interface CampaignSchedule {
  startDate: string;
  endDate: string;
  callingHoursStart: string;
  callingHoursEnd: string;
  timezone: string;
}

export interface CampaignCadence {
  maxAttempts: number;
  retryDelayHours: number;
  followUpDelayHours: number;
  confirmationLeadHours: number;
}

export interface LaunchedCampaign extends NewCampaign {
  id: string;
  launchedAt: string;
  status: "active" | "paused" | "completed";
}

export interface NewCampaign {
  name: string;
  category: NewCampaignCategory;
  subType: NewCampaignSubType;
  agentId: string;
  isRecurring: boolean;
  recurringFrequency: RecurringFrequency;
  selectedSegments: string[];
  customFilters: AudienceFilter[];
  useCaseId: string;
  goal: string;
  schedule: CampaignSchedule;
  cadence: CampaignCadence;
  contactsFileName: string;
  contactsCount: number;
  /** Plain-English condition under which the agent stops contacting a customer. */
  successCriteria: string;
  /** When true, the campaign auto-drops a customer from cadence the moment successCriteria is met. */
  autoRemoveOnOutcome: boolean;
  /** Source the audience was loaded from — used as the "Audience source" line on the card. */
  audienceSource: string;
  /** Original prompt the user typed in the describe flow, if any. */
  originPrompt: string;
}

const DEFAULT: NewCampaign = {
  name: "",
  category: "",
  subType: "",
  agentId: "",
  isRecurring: false,
  recurringFrequency: "weekly",
  selectedSegments: [],
  customFilters: [],
  useCaseId: "",
  goal: "",
  schedule: {
    startDate: "",
    endDate: "",
    callingHoursStart: "09:00",
    callingHoursEnd: "17:00",
    timezone: "America/Chicago",
  },
  cadence: {
    maxAttempts: 3,
    retryDelayHours: 24,
    followUpDelayHours: 48,
    confirmationLeadHours: 24,
  },
  contactsFileName: "",
  contactsCount: 0,
  successCriteria: "",
  autoRemoveOnOutcome: true,
  audienceSource: "",
  originPrompt: "",
};

interface NewCampaignContextValue {
  campaign: NewCampaign;
  update: (updates: Partial<NewCampaign>) => void;
  reset: () => void;
  totalAudienceCount: number;
  launchedCampaigns: LaunchedCampaign[];
  launch: () => void;
}

const NewCampaignContext = createContext<NewCampaignContextValue | null>(null);

export function NewCampaignProvider({ children }: { children: ReactNode }) {
  const [campaign, setCampaign] = useState<NewCampaign>(DEFAULT);
  const [launchedCampaigns, setLaunchedCampaigns] = useState<LaunchedCampaign[]>([]);

  const update = (updates: Partial<NewCampaign>) =>
    setCampaign((prev) => ({ ...prev, ...updates }));

  const reset = () => setCampaign(DEFAULT);

  const launch = () => {
    const launched: LaunchedCampaign = {
      ...campaign,
      id: `nc-${Date.now()}`,
      launchedAt: new Date().toISOString(),
      status: "active",
    };
    setLaunchedCampaigns((prev) => [launched, ...prev]);
  };

  const totalAudienceCount = campaign.selectedSegments.reduce((sum, id) => {
    const seg = AUDIENCE_SEGMENTS.find((s) => s.id === id);
    return sum + (seg?.count ?? 0);
  }, 0);

  return (
    <NewCampaignContext.Provider value={{ campaign, update, reset, totalAudienceCount, launchedCampaigns, launch }}>
      {children}
    </NewCampaignContext.Provider>
  );
}

export function useNewCampaign() {
  const ctx = useContext(NewCampaignContext);
  if (!ctx) throw new Error("useNewCampaign must be used within NewCampaignProvider");
  return ctx;
}

export const SUB_TYPES: Record<string, { value: NewCampaignSubType; label: string }[]> = {
  sales: [
    { value: "appointment_setting", label: "Appointment Setting" },
    { value: "lead_generation", label: "Lead Generation" },
    { value: "follow_up", label: "Follow Up" },
    { value: "aged_lead", label: "Aged-Lead Re-Engagement" },
    { value: "speed_to_lead", label: "Speed-to-Lead" },
    { value: "appointment_confirmation", label: "Appointment Confirmation" },
    { value: "service_drive_trade_in", label: "Service-Drive Trade-In" },
    { value: "equity_mining", label: "Equity Mining" },
    { value: "lease_maturity", label: "Lease Maturity" },
  ],
  service: [
    { value: "recall", label: "Recall" },
    { value: "service_reminder", label: "Service Reminder" },
  ],
};
