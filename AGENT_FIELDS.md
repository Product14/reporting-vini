# Agent Performance Report — Field & Widget Reference

Single source of truth for the agent performance report: every field, its meaning,
which agents use it, whether it's live, and the widget-level approval status from the
reviewer tracker.

Sources: [data.ts](src/components/reports/data.ts) (model + mock),
[liveData.ts](src/components/reports/liveData.ts) (live overlay),
[metabaseCards.ts](src/components/reports/metabaseCards.ts) (the 20 Metabase cards),
[page.tsx](src/app/reports/agents/page.tsx) (widgets), [kit.tsx](src/components/reports/kit.tsx) (chips).

---

## The four agents

| ID | Name | Persona | Direction | Headline metric |
|----|------|---------|-----------|-----------------|
| `sales_ib` | Sales Inbound | Emily | Inbound | Calls handled |
| `sales_ob` | Sales Outbound | Jenny | Outbound | Calls dispatched |
| `service_ib` | Service Inbound | Mia | Inbound | Calls handled |
| `service_ob` | Service Outbound | Theo | Outbound | Calls dispatched |

**Inbound** = `sales_ib`, `service_ib` · **Outbound** = `sales_ob`, `service_ob`.

### Status / confidence chips

| Chip | Value | Meaning |
|------|-------|---------|
| Health (`green`) | **On target** | Performing within expected range |
| Health (`amber`) | **Watch** | Drifting — worth monitoring |
| Health (`red`) | **At risk** | Below threshold, needs attention |
| Confidence (`low`) | **Low sample** | Window too thin to fully trust |
| Confidence (`none`) | **No data yet** | Nothing in window |

---

## 1. Core metrics — required for all 4 agents (`AgentMetrics`)

| Field | Meaning | Inbound sense | Outbound sense | Live? |
|-------|---------|---------------|----------------|-------|
| `calls` | Call volume | Calls **handled** | Calls **dispatched** (dials) | yes |
| `connectRate` | % that connected | % answered | % a person picked up | yes |
| `conversations` | Reached a live person/agent | Connected callers | Connected dials | yes |
| `qualified` | Passed qualification | Qualified intent (sales) / booking-eligible (service) | Same | yes |
| `appointments` | Appointments booked | — | — | yes |
| `showed` | Appointments that showed up | — | — | **mock** |
| `deals` | Sales deals closed / service ROs completed | — | — | **mock** |
| `revenue` | $ attributed | — | — | **mock** |
| `cost` | $ to run (telephony + SMS + data lookups) | — | — | **mock** |
| `smsSent` | SMS messages sent | — | — | yes |
| `optOuts` | Recipients who opted out of SMS | — | — | yes |
| `afterHours` | Calls captured **outside the dealership's business hours** — after-hours / overflow demand that would otherwise hit voicemail. **Inbound only**; `0` for outbound (campaigns dial only within compliant windows). | Captured | Always 0 | yes |
| `talkMinutes` | Total minutes of talk time | — | — | yes |

**During hours vs After hours** (Call-breakdown strip):
- **After hours** = `afterHours`
- **During hours** = `calls − afterHours`

---

## 2. Quality — required for all 4 agents (`AgentQuality`)

| Field | Meaning | Live? |
|-------|---------|-------|
| `primaryLabel` / `primary` / `primaryStatus` | Headline quality KPI + RAG. Inbound = **"Answer rate"**, Outbound = **"Qualification rate"** | yes |
| `handleTime` / `handleStatus` | Average handle time per call (AHT) + RAG | yes |
| `csat` / `csatStatus` | Customer satisfaction, out of 5, + RAG | yes |
| `fourthLabel` / `fourthValue` / `fourthStatus` | 4th cell — **"Transfer success"** (most) / **"Compliance (exempt)"** (Service OB) | **coming soon** |
| `sentiment` | % of conversations with positive sentiment | yes |

---

## 3. Report block — shared, required for all 4 agents (`AgentReport`)

| Field | Meaning | Live? |
|-------|---------|-------|
| `leadsAttempted` | Unique leads the agent attempted to reach | yes |
| `turnRate` | % qualified out of connected (`qualified / conversations`) | yes |
| `abr` | **Appointment Booking Rate** — appointments ÷ leads | yes |
| `deltas` | Period-over-period change (the "↓9% vs prev" pills) | yes |
| `breakdown` | Labelled sub-counts under the KPI strip (after-hours, overflows, transfers…) | yes |
| `dayOnDay` | Per-day line: touched → qualified → appointments | yes |
| `intent` | Intent mix (high / mid / low intent, not qualified) | yes |
| `qualifiedPct` | % of connected conversations that qualified | yes |
| `queries` | Per-topic resolution: how often the agent resolved a topic **without a human** | yes |
| `callFlow` | Funnel: total → answered / missed → transferred / lost, plus `handledByAI` | yes |
| `multiDayReply` | Reply rate by days-since-first-touch (same-day, day 1, 2, 3+) | yes |
| `summary` | Persona card: name, conversations, avg first-contact, appts booked, booking rate | partial |

---

## 4. Inbound-only fields (`sales_ib`, `service_ib`)

| Field | Meaning | Live? |
|-------|---------|-------|
| `leadsBySource` | Per-source table: interacted → total leads → appts booked | yes |
| `speedToLead` | How fast new CRM leads get a first touch — avg time, % within 5 min, new leads, instantly touched | yes |
| `upcomingAppointments` | Booked appointment feed (customer, time, vehicle, note) | **coming soon** |
| `followUps` | Priority callbacks the agent flagged | **coming soon** |

## 5. Outbound-only fields (`sales_ob`, `service_ob`)

| Field | Meaning | Live? |
|-------|---------|-------|
| `activeCampaigns` | Campaigns running: status, days live, appts, conversion % | **coming soon** |
| `outcomes` | Outbound disposition mix — "How outbound conversations ended" (Not Connected / General Engagement / Not Interested / Opt Out / …), from the `outbound_outcome` column. Renders as a SplitBar. | yes |
| `noInteraction` | (superseded by `outcomes`) Older total/interested/no-reply/disconnected shape; no longer rendered | mock only |

## 6. Story blocks (slated for removal — see tracker)

| Field | Meaning |
|-------|---------|
| `benchmarks` | 3-pitch story vs industry / human baseline |
| `compare` | Before/after table: `[Your team, M1, M2, M3]` |

---

## Widget approval tracker (Sales Inbound review)

| # | Section | Widget | Status | Reviewer note → action |
|---|---------|--------|--------|------------------------|
| 1 | Header | Agent selector tiles | Live | Relabel **"Calls" → "Leads Handled"**; "On Target/Watch" = health chips (see above) |
| 2 | Header | Selected-agent bar | Live | **Agent name incorrect** — `summary.person` is hardcoded, not from a card |
| 3 | Value | Value Created card + cost/appt | Live | **Add agent-wise appointment value** (today one global `apptCost`) |
| 4 | Value | How Emily compares to industry | Coming soon | **Remove** |
| 5 | Value | Before / after vs human baseline | Coming soon | **Remove** |
| 6 | Performance | Headline — Leads attempted / qualified / Appts / ABR | Live | **Add SMS numbers** |
| 7 | Performance | Secondary — Total calls / Total SMS / Turn rate | Live | ✓ |
| 8 | Performance | Call breakdown — During/After hours / Connected / Qualified | Live | ✓ |
| 9 | Performance | Day-on-day line chart | Live | **Totals incorrect** — `dayOnDay.appts` derived, doesn't reconcile |
| 10 | Conversations | Call & intent flow (Sankey) | Live | ✓ |
| 11 | Conversations | Query resolution rate | Live | ✓ |
| 12 | Conversations | Top objections | Coming soon | no backing card |
| 13 | Inbound ops | Leads by source table | Live | ✓ |
| 14 | Inbound ops | Speed to lead card | Live | **"0m" avg bug** — `median_hours` formatter collapses sub-minute |
| 15 | Inbound ops | Upcoming appointments | Coming soon | needs action-item store |
| 16 | Inbound ops | Priority follow-ups | Coming soon | needs action-item store |
| 17 | Inbound ops | Multi-day reply effectiveness | Live | ✓ |
| 18 | Inbound ops | Channel mix | Live | ✓ |
| 19 | Quality & trend | Quality health strip | Mixed | 4th cell (Transfer success) is coming-soon; rest live |
| 20 | Quality & trend | Time-of-day distribution | Live | ✓ |
| 21 | Quality & trend | 7-day trend (Calls handled) | Live | ✓ |
| 22 | Quality & trend | Highlights & missed opportunities | Coming soon | needs action-item store |
| 23 | Quality & trend | Calls by reason | Coming soon | no backing card |

### Open change requests (consolidated)

- **Remove:** #4 industry compare, #5 before/after baseline (the `benchmarks` / `compare` story blocks).
- **Relabel:** #1 tiles "Calls" → "Leads Handled".
- **Add:** #3 agent-wise appointment value; #6 SMS numbers in headline.
- **Fix:** #2 agent name source; #9 day-on-day totals; #14 "0m" speed-to-lead formatter.
- **Clarify:** #19 quality strip is Mixed because "Transfer success" has no card yet.

---

## Metabase cards (the 20 live sources)

| ID | Title | Section | Agent-scoped |
|----|-------|---------|--------------|
| 12193 | Bottom line | Performance | yes |
| 12194 | Performance table | Performance | yes |
| 12195 | Qualified — SMS + outbound-task paths | Performance | no |
| 12196 | Day-by-day trend | Performance | yes |
| 12197 | Funnel stages | Conversion | yes |
| 12198 | Qualified intents | Conversion | yes |
| 12199 | Non-qualified intents | Conversion | yes |
| 12200 | Resolution rate by topic | Conversion | yes |
| 12201 | Top outcomes — inbound | Conversion | yes |
| 12202 | Top outcomes — outbound tasks | Conversion | no |
| 12203 | Channel mix | Operations | no |
| 12204 | During vs after hours | Operations | yes |
| 12205 | Time of day | Operations | yes |
| 12206 | Multi-day SMS follow-up | Operations | no |
| 12207 | Appointment source (direct / indirect / CRM-bdc) | Revenue | no |
| 12208 | STL & leads by source | Revenue | no |
| 12209 | Speed to lead | Revenue | yes |
| 12210 | Quality health | Quality | yes |
| 12211 | Quality score + frustrated | Quality | yes |
| 12212 | SMS opt-outs | Quality | no |

**Never live (always mock — no backing card):** `revenue`, `cost`, `deals`, `showed`,
and the human-baseline `benchmarks` / `compare` story.

> **after hours** = inbound calls the agent captured outside the dealership's normal
> business hours (demand that used to go to voicemail). Inbound agents only; comes from
> the *"During vs after hours"* card (`12204`).
