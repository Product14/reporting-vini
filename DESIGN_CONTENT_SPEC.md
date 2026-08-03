# Content & Metrics Spec — Overview + Agent Performance

**For: Design team (redesign brief)**
**Not included on purpose: layout, hierarchy, type scale, color, iconography, spacing, chart choice, ordering, mobile treatment, or anything else visual.** Those are design's call. This document is the *content contract* — what data exists, what it means, and what the page has to be able to do. Everything else is open.

---

## 1. What this product is

Vini runs AI voice + SMS agents that act as a dealership's virtual sales and service reps. A car dealership ("rooftop" in our terminology) can run up to **four AI agent slots**:

| Slot | Department | Direction | What it does |
|---|---|---|---|
| Sales Inbound | Sales | Inbound | Answers incoming calls/texts from car-shopping customers — qualifies intent, books showroom appointments, works after-hours. |
| Sales Outbound | Sales | Outbound | Proactively calls/texts leads the dealership already has (aged leads, equity owners, lease-maturity, service-drive trade-in candidates). |
| Service Inbound | Service | Inbound | Answers incoming service calls/texts — books the service drive, handles maintenance/recall/diagnostic questions. |
| Service Outbound | Service | Outbound | Proactively runs recall, due-service, and service-specials campaigns. |

Not every dealership runs all four. A dealership that doesn't run a given slot sees it pitched as an upsell instead of a report.

These two pages are the dealership's **proof-of-value report** — what a General Manager, Owner, Sales Manager or Service Manager opens to see what the AI actually delivered, and to work the leads/appointments/follow-ups the AI surfaced. The audience is dealership staff, not engineers — day-to-day CRM/DMS users, not necessarily software-sophisticated. Keep the automotive dealership context (vehicles, appointments, ROs, trade-ins, recalls, DNC/opt-out compliance) in mind over generic SaaS-dashboard conventions where the two are in tension.

### The two pages this spec covers

The parent console (the main Spyne product) now iframes these as **two separate, standalone pages** rather than tabs of one app:

1. **Overview** — whole-dealership rollup: all agents combined, one scorecard.
2. **Agent performance** ("By-agent") — a deep-dive into **one agent slot at a time**, with a switcher between the up to four slots.

Each page is a full iframe in its own right (own header, own date filter, own loading states) — a user can land on either one without having visited the other first. Cross-navigation between them (e.g. "see this agent's full report") happens at the **parent console level** (it navigates the parent window, not inside the iframe) — so don't assume the two pages need to share a persistent nav shell, but do assume a user might jump from one to the other and should recognize it as "the same product."

---

## 2. The one hard constraint: canonical wording

A small set of metric names must read **identically, verbatim, everywhere** — this app, the rest of the Spyne console, scorecards, and automated email reports all show the same numbers under the same names. Renaming one of these here (even to something clearer-sounding) would make it look like a different metric elsewhere in the product. Everything else — section titles, secondary-metric labels, captions, empty-state copy, tone — is open to rewrite.

**Fixed wording:**
- "Leads reached" (inbound) / "Leads dialed" (outbound)
- "Real conversations"
- "Qualified leads"
- "Appointments — AI-booked" (headline) + "AI-assisted (CRM)" (secondary, always shown smaller/separate, never added into the AI-booked number)
- "Hand-offs to team"
- "Turn rate"
- "Close rate"
- "Engaged" (a bare reply with no buying intent)

**Fixed math (numerator ÷ denominator can't be changed, only how it's displayed):**
- Turn rate = Qualified leads ÷ Real conversations
- Close rate = Appointments (AI-booked) ÷ Qualified leads
- Conversation rate = Real conversations ÷ Leads reached/dialed
- A rate that would round to "0%" must show the fraction instead (e.g. "1 of 32"), never a bare "0%" — a real number reads as broken data at a glance.

---

## 3. Canonical metric glossary

These definitions apply everywhere in the product. Design can decide how prominently to explain them (tooltip, footnote, inline caption, nothing) but the underlying meaning can't drift.

| Metric | Definition |
|---|---|
| **Real conversation** | The customer actually engaged — a live call where they spoke (not voicemail/IVR/silence), an inbound call that was answered, or an SMS reply. Voicemail is explicitly excluded. |
| **Connected / reached** | The call connected to a person, or (for SMS) a human reply exists. |
| **Qualified lead** | Concrete buying intent — asked about a vehicle, availability, price, financing, trade-in, test-drive, or booking. Same bar for calls and SMS. A bare SMS reply with no intent is "Engaged," not qualified — engagement alone is not qualification. |
| **Appointment — AI-booked** | The AI itself created the meeting record. This is the **primary/headline** appointment number. |
| **Appointment — AI-assisted (CRM)** | A meeting booked in the dealership's CRM on a lead the AI had worked (≥1 AI touch — call or text). **Secondary**, shown smaller, *never* added into the AI-booked headline. |
| **Hand-offs to team** | Completed transfers + requested callbacks. |
| **Transfer (completed)** | A call that ended with the AI handing off to a staff member. |
| **Transfer (failed)** | An attempted transfer that didn't complete — reported **separately**, never folded into "hand-offs" or transfer counts. |
| **Callback** | The customer asked the AI to have someone call them back. |
| **Turn rate** | Qualified leads ÷ Real conversations — of the people who actually talked to the AI, how many turned into a qualified lead. |
| **Close rate** | Appointments (AI-booked) ÷ Qualified leads — of qualified leads, how many became a booked appointment. |
| **Response time / Speed-to-lead** | Time from a new lead arriving to the AI's first touch. Currently only meaningful for Sales Inbound (the only slot with a "new lead arrives" trigger). |
| **Talk time** | Total minutes of AI phone conversation — framed to the dealer as staff time saved ("zero staff minutes spent"). |
| **After-hours captured** | Engagement that happened outside the dealership's working hours — demand that would otherwise have gone to voicemail overnight. Inbound-only concept (outbound campaigns only dial within compliant windows). |
| **Opt-out** | A recipient who asked to stop SMS contact. |

---

## 4. Shared requirements across both pages

These apply identically to Overview and Agent performance:

- **Rooftop scope.** Each page shows exactly one dealership at a time (never a multi-dealership rollup) — the parent console tells the page which one.
- **Department filter: All / Sales / Service.** Re-scopes every number and list on the page. Persists across navigation between the two pages.
- **Date range.** Presets: Today, Yesterday, Last 7 days, Last 14 days, Last 30 days, Month-to-date, Lifetime — plus a custom start/end range (including a single-day pick). These are **rolling** windows ending at "now" in the dealership's own timezone — "Today" is the live, still-accumulating day, not a fixed complete day. A custom range persists across navigation between the two pages.
- **Dealership timezone.** Every page must indicate which timezone its dates/times are shown in (the dealership's own local time, not the viewer's browser time or UTC) — the same window can mean a different set of calendar days depending on timezone, so this needs to be visible somewhere, not just implied.
- **"Last synced" freshness indicator.** Data is fetched, not real-time-streamed — the page should communicate roughly how fresh the numbers are and offer a manual refresh.
- **Refresh control.** Manually re-fetch the current view.
- **Export.** Agent performance currently offers CSV and XLSX download of the selected agent's full report. (Overview does not yet — flag to product if design wants export parity there; not decided either way.)
- **Customize (hide/reorder).** Both pages let the dealer hide sections (and, on Overview, hide individual metric tiles) and reorder sections. A hidden/reordered layout can be saved either "just for me" (this browser only) or "for everyone at this dealership" (shared, affects every user viewing this rooftop's report). This is a **required capability** on both pages — how it's exposed (a settings panel, drag handles, a menu, whatever) is entirely design's call.
- **Currency:** none. This version deliberately shows counts/rates, not dollar figures — no revenue, cost, or ROI-in-dollars anywhere on either page today.

### States every page/section must account for

| State | Meaning | Notes |
|---|---|---|
| No dealership resolved | The page doesn't know which dealership to show | Should read as a configuration issue, not "no data" |
| First-time / not yet set up | Dealership hasn't connected/launched any agents | Onboarding-style pitch, not an empty report |
| Onboarding | CRM history importing, agents about to go live | Shows import progress; report not real yet |
| "Coming soon" | Dealership is live-eligible but has **never** produced any data | Distinct from an empty date range — this is "never happened," not "didn't happen in this window" |
| Loading | Data fetch in progress | |
| Degraded / syncing | A transient fetch hiccup | Must look like "still loading," never like an empty or broken state — the difference matters, a dealer shouldn't think their AI stopped working because of a network blip |
| Empty window | Dealership **is** live, but the selected date range has zero activity | Gentle inline note, not a full-page empty state — the rest of the (zeroed) report still renders |
| Agent not run by this dealership (Agent-performance page only) | The dealership doesn't run that slot | Shown as an upsell pitch in place of a report |
| Agent recently went live (Agent-performance page only) | Slot launched in the last few days | "Early numbers, still calibrating" framing — sets expectations that trends will firm up |

---

## 5. Page 1 — Overview

Whole-dealership rollup: every active agent slot, summed and cross-cut by Inbound/Outbound.

### 5.1 Header

- Department filter (All / Sales / Service)
- Date range filter
- Customize control
- Refresh + last-synced + timezone

### 5.2 "The value delivered" — headline KPI strip

**Main metrics** (4). Each shows: total, an Inbound sub-count, an Outbound sub-count, and the % change vs. the prior equal-length window (e.g. this-30-days vs. previous-30-days). A metric with no prior-window basis should read as "new," not a misleading "0% change."

| Metric | Meaning |
|---|---|
| Leads touched | Distinct leads the AI reached (inbound) or dialed (outbound) this window |
| Real conversations | Distinct leads who actually engaged (see glossary) |
| Qualified leads | Distinct leads with concrete buying intent |
| Appointments — AI-booked | AI-created meetings, **+ a secondary "AI-assisted (CRM)" count**. Clickable → opens the list of the actual appointments behind the number. |

**Secondary metrics** (up to 6 — single value + a short caption, no Inbound/Outbound split, no delta):

| Metric | Meaning |
|---|---|
| Hand-offs to team | Transfers + callbacks (with the transfer/callback split as a caption). Failed transfers are tracked but reported separately, not folded in. |
| Response time | Avg speed-to-lead (Sales Inbound only — absent if not measurable) |
| Action items created | Follow-up tasks the AI logged this window, + how many closed / still open. Clickable → full action-items list. |
| Calls & texts | Total AI conversations (voice + SMS combined), with the split as a caption |
| Talk time | Total AI phone-conversation minutes |
| After-hours captured | Count of engagement outside working hours |

Every tile in this section (main and secondary) is individually hideable via Customize.

### 5.3 "Who drove it" — per-agent leaderboard

- Timezone + last-synced note
- One card per active agent slot, ranked by appointments booked. Each card:
  - Icon, the AI's persona name (e.g. "Emily"), role (department · direction)
  - Close rate (headline number on the card)
  - The same 4-stage funnel as the fleet-wide one: Leads reached/dialed → Real conversations → Qualified leads → Appointments — AI-booked, each stage showing its count **and** its conversion % from the previous stage
  - "+N AI-assisted (CRM)" note when applicable
  - Mini-stats: Calls, SMS sent, Talk time, Hand-offs
  - Clicking a card opens that agent's full Agent-performance report

### 5.4 "Work these now" (only renders if there's something to show)

Three possible cards, present independently of each other:

- **Hot & warm leads.** Named leads with buying intent and no appointment yet, split into two tiers — "hottest" (concrete buying signal) and "warm" (engaged, needs nurturing). Each entry: customer name, their stated interest, and a tap-to-call phone number. A "view all" expands to the full list with a per-lead conversation drill-down.
- **Appointments.** A short preview (customer, vehicle if known, how it was booked — AI-booked vs. AI-assisted, when) of on-the-books appointments, with a "view all" link.
- **Action items.** The created/closed/open/overdue/due-today scoreboard, plus a queue of open items sorted soonest-due-first (customer, what needs doing, priority, due date), with a "view all" link.

### 5.5 "Recent conversations"

A feed of the most recent calls and texts: customer, AI agent name, what the customer wanted (intent), vehicle if known, outcome (resolved / not resolved), date & time, duration. Clicking a row previews the full conversation (call summary or SMS thread) without leaving the page. A "view all" link to the complete conversation history.

### 5.6 Definitions footer

A short, always-present reference strip pinned near the bottom, spelling out: Real conversation, Qualified, Appointments — AI-booked/AI-assisted, Hand-offs, Turn rate, Close rate — plus a line noting all figures are de-duplicated and consistent across the console/scorecards/email reports, and the timezone in use. (Wording per §3 is fixed; whether this is a persistent footer, a collapsible strip, tooltips-per-metric, or something else is design's call.)

---

## 6. Page 2 — Agent performance ("By-agent")

A deep-dive into **one** agent slot at a time.

### 6.1 Header

- Date range filter, refresh, CSV/XLSX export
- (Department filter is shared with Overview and scopes which agent pills are selectable)

### 6.2 Agent switcher

Up to 4 selectable entries, one per slot the dealership runs — icon, slot name, and leads-attempted count for the current window. Selecting one drives everything below it. A slot the dealership does **not** run appears as a distinct "not yet added" entry that, when opened, shows an upsell pitch instead of a report.

### 6.3 "Performance" — the selected agent's core report

- Timezone + last-synced note
- Identity: persona name + slot name + period label
- Close rate — headline number
- The same 4-stage funnel described above, for this agent only, each row with count + conversion-from-prior-stage + a proportional bar. The **appointments** stage is clickable → the actual list of appointments behind the number.
- Activity row (4 stats): Total calls (inbound) / Calls dispatched (outbound) + talk minutes as a caption; Total SMS; Turn rate; and — Close rate (inbound) or Warm-leads count (outbound).
- **Call breakdown:**
  - During-hours vs. after-hours share
  - Outcome counts: Real conversations, Qualified leads, and (**inbound only**) Transferred, Transfers failed (only shown when it's actually happened — never a permanent zero row), Callbacks

### 6.4 Day-on-day trend

Per-day figures across the selected window: leads touched, qualified, appointments.

### 6.5 "Conversations & outcomes" (inbound agents only, when data exists)

A table of what customers wanted, by intent/topic: how many conversations per topic, that topic's share of all conversations, how many the AI resolved itself, how many were booked, transferred, or asked for a callback. An "other conversations" catch-all row reconciles the table's total against the "Real conversations" figure above it (the intent tags cover only a subset of topics — the residual has to be visible, not silently dropped). A totals row sums every column.

### 6.6 "Inbound operations" / "Outbound campaigns"

- **Leads by source** (both directions): per lead-source (e.g. dealership website, third-party listing sites, phone, walk-in), how many were interacted with, total leads, appointments booked.
- **Speed to lead** (Sales Inbound only): avg first-response time, % of new leads contacted within 5 minutes, counts for instantly-touched / after-hours-instant / instant-to-appointment, and the instant→appointment rate. Also an "open funnel" comparing two paths — speed-to-lead-driven bookings vs. follow-up-driven bookings — each as leads-handled → appointments → rate. Has a locked/upsell variant when the dealership's response times don't yet qualify for this card to be meaningful.
- **Active campaigns** (outbound only): per campaign — name, use case, enrolled leads, appointments, appointment rate, warm leads, opt-outs — plus a "N warm leads across M campaigns" headline above the table.
- **Outbound outcomes** (outbound only): every worked lead's current disposition, ranked best-to-least: **Booked → Warm (buying intent, not yet booked) → Callback requested → Transferred → Engaged (replied, no intent) → Unclear/info → Not yet worked → No reach (bad number) → Lost/declined → Opt-out → Other.** Each bucket shows its count and share of the total worked.

### 6.7 "Appointments" card

- Total AI-booked count (clickable → the appointment list) + "AI-assisted (CRM)" secondary count when applicable
- **Upcoming** — a list of scheduled/confirmed appointments from now forward: customer, vehicle, phone, status, when

### 6.8 "Action items" card

- Live counts: Open, Overdue, Due today
- The open queue: customer, what needs doing, priority (Low/Medium/High), due date/time — overdue items need a visual flag
- "View all" link

### 6.9 "Hot & warm leads" (only if this agent has any)

Same two-tier chip format as Overview's version, scoped to this one agent.

### 6.10 "Multi-day reply effectiveness" (only if data exists)

% of replies landing same-day vs. 1/2/3+ days after the first touch — shows how much of the AI's value comes from persistent multi-day follow-up rather than the first attempt.

### 6.11 "Quality & trend"

- **Conversation quality:** the agent's primary quality metric (Answer rate for inbound / Qualification rate for outbound), Avg handle time, Opt-outs, and — when meaningful — Transfer success rate with a status read (good / watch / poor).
- **Time-of-day distribution:** activity across business hours (12 hourly buckets, 7am–6pm).
- **7-day trend:** the agent's headline volume metric, Monday through Sunday.
- **Highlights & missed opportunities** (only if data exists): "Wins" = the AI's best booked-call moments (a one-line description + date) in this agent's direction. "Missed" (**outbound only**) = categorized missed-opportunity counts by channel — went to voicemail, no answer, abandoned in silence, SMS failed to deliver.

---

## 7. Data reference

Field-level shapes behind the sections above, for anyone speccing exact table columns or tooltip content.

### 7.1 Fleet / whole-dealership numbers (Overview)

| Field | Meaning |
|---|---|
| Leads / Conversations / Qualified / Appointments | As defined in §3, summed across active agents |
| Appointments — AI-assisted (CRM) | Secondary appointment count |
| Transfers / Transfers failed / Callbacks / Hand-offs | As defined in §3 |
| Query resolution rate | Inbound-only: of inbound real conversations, what share the AI resolved without a human — numerator and denominator both inbound-only (outbound reactivation has ~no "query resolved" concept and would dilute the number if blended in) |
| Response time | Avg speed-to-lead, seconds — null when not measurable |
| Talk minutes / SMS sent / Opt-outs / After-hours | As defined in §3 |
| Each metric's Inbound and Outbound sub-total | Every "value delivered" main tile splits by direction |
| Period-over-period % change | Per metric, vs. the prior equal-length window; null = no prior basis ("new"), not "0% change" |

### 7.2 Per-agent identity & metrics (both pages)

| Field | Meaning |
|---|---|
| Slot id / name / department / direction | Sales/Service × Inbound/Outbound |
| Persona name | The AI's given name shown to the dealer (e.g. "Emily") |
| Icon | A small glyph identifying the slot |
| Calls | Handled (inbound) or dispatched (outbound) |
| Conversations / Qualified / Appointments / Appointments-assisted | As above, per agent |
| SMS sent / Opt-outs / After-hours / Talk minutes | As above, per agent |
| Turn rate / Close rate | As defined in §3 |
| Primary quality metric | "Answer rate" (inbound) or "Qualification rate" (outbound), % |
| Avg handle time | Formatted duration (e.g. "3m 48s") |
| Transfer success rate | % of attempted transfers that completed — status-colored (e.g. good ≥80%, watch ≥60%, poor below) |

### 7.3 Day-on-day trend

Per calendar day: label, leads touched, qualified, appointments.

### 7.4 Leads by source

Per source name: how many were interacted with, total leads, appointments booked.

### 7.5 Speed to lead (Sales Inbound)

Avg response time (formatted), % within 5 minutes, count of new CRM leads, count touched instantly, count touched instantly after-hours, count of instant-touch appointments, instant-touch→appointment rate, plus the two-path open-funnel breakdown (speed-to-lead path vs. follow-up path, each with leads-handled / appointments / rate).

### 7.6 Active campaigns (outbound)

Per campaign: name, use case, enrolled count, appointments, appointment rate, warm-leads count, opt-outs count.

### 7.7 Outbound outcomes

Per outcome bucket (fixed canonical order, §6.6): label, count. (Share % is derived from the total.)

### 7.8 Named appointments

Per appointment: customer name, phone, channel (inbound/outbound, or none for AI-assisted), how it was booked (on a call vs. via SMS vs. AI-assisted/CRM), vehicle (if known), scheduled time, booked-at time, status (scheduled/cancelled/showed/no-show/completed), whether it's AI-assisted, sales vs. service.

### 7.9 Named warm/hot leads

Per lead: customer name, phone, tier (hot/warm), their interest (a short prettified label), which campaign surfaced them, last-activity time, sales vs. service, inbound vs. outbound source.

### 7.10 Conversations & outcomes (per-intent table)

Per intent/topic: label, conversation count, resolved count, booked count, transferred count, callback-requested count. Plus a computed "other conversations" residual and column totals.

### 7.11 Recent conversations feed

Per conversation: customer, phone, AI agent name, channel (call/SMS), direction (inbound/outbound), department, title/intent, one-line summary, vehicle (if known), duration (calls), an AI quality score (when available), sentiment read (when available), whether an appointment was scheduled, whether the customer's query was resolved, whether it spawned an action item, and — for SMS threads — the individual message bubbles for the preview drawer.

### 7.12 Action items

Per item: customer, description/intent, priority (Low/Medium/High), completed flag, due date/time, department, assigned-to. Scoreboard: created / completed / open / overdue / due-today counts for the window.

### 7.13 Highlights & missed opportunities

Highlights: direction, a one-line title, the date it occurred. Missed (outbound only): channel + category (voicemail / no-answer / abandoned / SMS-failed) + count.

---

## 8. What's explicitly NOT in this spec (design owns all of it)

- Page layout, section order, grid structure, card vs. table vs. chart choice
- Typography (sizes, weights, families), color palette, iconography, spacing/density
- Whether Overview and Agent-performance should look visually related, distinct, or something in between
- Chart types for any of the trend/distribution data (line, bar, sparkline, whatever fits)
- Empty-state illustration/tone, loading-state treatment, error handling visuals
- Mobile/responsive behavior
- Exact copy for anything **not** listed as fixed wording in §2 (section titles, captions, button labels, empty-state text, tooltips — all rewritable)
- Whether/how the Customize (hide/reorder) and Export controls are exposed in the UI

If something in the data model isn't mentioned above and doesn't clearly belong on either page, treat it as **not currently part of this report** — don't design around it. If a real automotive-dealership need surfaces during design (e.g. something GMs commonly ask for that these two pages don't answer), flag it back to product rather than inventing a metric — everything above is definitionally exact, and a new metric needs the same rigor before it's real.
