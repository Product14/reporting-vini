# reporting-vini — One Pager

## What this is

An **embeddable reporting surface** for the Spyne AI-agent product. It was extracted
from the main `Agent-Workflow` app so it can be hosted standalone and **iframed** into
the host product's "Reports" tab. There's no global chrome (no sidebar/header) — just
the report itself.

The host scopes the report to a single rooftop (dealership) by passing a `team_id` on
the iframe URL:

```
<iframe src="https://<host>/reports?team_id=<TEAM_ID>" />
```

`team_id` is read once on load (`ScenarioProvider`) and drives every data query. A bare
`/` redirects to `/reports`, preserving `team_id`.

## The product: four AI agents

The report covers one rooftop's four AI agents and rolls them up into a fleet view:

| ID | Name | Persona | Direction | Headline metric |
|----|------|---------|-----------|-----------------|
| `sales_ib`   | Sales Inbound    | Emily | Inbound  | Calls handled    |
| `sales_ob`   | Sales Outbound   | Jenny | Outbound | Calls dispatched |
| `service_ib` | Service Inbound  | Mia   | Inbound  | Calls handled    |
| `service_ob` | Service Outbound | Theo  | Outbound | Calls dispatched |

## Routes

| Path                 | Page                                          |
| -------------------- | --------------------------------------------- |
| `/reports`           | **Overview** — daily control-tower report     |
| `/reports/agents`    | **Per-agent** report + agent upsell           |
| `/reports/v2`        | **Reporting v2** — story-first dashboard       |
| `/reports/campaigns` | Campaign run history (in-memory only, demo)   |

## How the data flows (the core work)

The reports tab **no longer fetches Metabase live** (that was ~84 requests per load).
It now reads from a materialized aggregate in Supabase:

```
Metabase Q12227 (raw events, ~401k rows / 382 MB)
   → scripts/backfill.ts  (aggregates: raw rows → daily facts)
   → Supabase  (agent_daily, agent_daily_breakdown, + detail tables)
   → GET /api/reports?team_id&start&end
   → fetchAgents() in liveData.ts  (ONE request)
   → report pages
```

Key pieces:

- **`src/lib/reports/aggregate.ts`** — pure transform of Q12227 rows → daily facts +
  breakdown rows (testable without Supabase).
- **`src/lib/reports/build.ts`** — turns a date range of facts into `AgentData[]`.
  Uses mock agents **only for identity** (name/icon/persona); **every metric is live or
  zeroed — no fabricated numbers** in the live path.
- **`src/app/api/sync/route.ts`** — the write path; pulls Q12227 and replaces a
  trailing window in Supabase.
- **`scripts/backfill.ts`** — the same aggregation run from a script instead of the
  route, used for the heavy backfill/reconcile (the 382 MB full pull is too big for
  Vercel's serverless cap).
- **Supabase** project `qludnojfibguobgeeujw`; migrations `0001_agent_facts.sql`
  (scalar daily facts + breakdown + sync bookkeeping) and `0002_report_detail.sql`
  (appointments, callbacks, campaigns detail tables).

## Backend & data management

The backend is a set of **Next.js route handlers** (server-only, `runtime = "nodejs"`)
over a Supabase Postgres database. The two that carry the materialized aggregate are a
classic write-path / read-path split:

### Write path — `POST|GET /api/sync` (the ingestion engine)
- Pulls Q12227 (event-level raw data) from Metabase, runs `aggregate()`, then
  **delete-then-insert replaces a trailing window** (`SYNC_WINDOW_DAYS`, default 3).
  Query overrides: `?days=N`, `?since=YYYY-MM-DD`, `?full=1` (rebuild everything).
- **Two pull modes:** if `METABASE_RAW_DATE_PARAM` is set, it pulls **one day at a
  time** (~3 MB each, scoped server-side); otherwise it does the full-table pull
  (~382 MB) and filters `activity_day` client-side.
- **Safety rails:** never runs open (requires `CRON_SECRET` via `Bearer` header or
  `?key=`); **aborts before deleting** if a pull returns 0 rows across the whole window
  (a failed pull must never wipe good data); writes go in 500-row chunks; every run
  records status/rows/error to the singleton `sync_state` row for observability.

### Read path — `GET /api/reports?team_id&start&end` (the serving layer)
- A **single round-trip** (`Promise.all`) reads the current window's facts, its
  breakdowns, and an equal-length **prior window** (the basis for period deltas), then
  `buildResult()` reshapes them into the exact `FetchResult` the UI already consumed —
  replacing the old ~84 live Metabase calls.
- **Degrade-never-crash:** missing Supabase config → mock-shaped result; a read error
  is retried once, then degrades to the same empty-but-valid result with an
  `X-Reports-Degraded` header (a read failure must never blank the report); the
  rooftop-detail tables are each read in a `try/catch` so a not-yet-migrated table
  falls back to an empty list independently.
- Responses set `Cache-Control: s-maxage=60, stale-while-revalidate=120` for CDN reuse.

### Other API routes
- **`GET /api/metabase/embed`** — signs a short-lived (10 min) Metabase static-embed
  iframe token server-side, so the embedding secret never reaches the browser. The
  legacy "live" path, still used by the v2 dashboard.
- **`GET /api/metabase/data`** — returns a card's **rows as JSON** (via the same signed
  token) so they can render in our own widgets instead of an iframe.
- **`POST /api/agent-interest`** — captures "I'm interested in this agent" submissions
  from the per-agent upsell flow. Always logs the lead server-side; if
  `AGENT_INTEREST_WEBHOOK_URL` is set, also forwards a message to a Slack-compatible
  webhook.
- **`GET /api/meetings?team_id&serviceType&scope&{start,end|bucket}`** — proxies the Spyne
  product API (`leads/dealer/v3/meetings`) server-side (token never reaches the browser),
  returning normalized `Meeting` rows (customer / vehicle / time / status / phone). Powers
  the **"Upcoming appointments"** card (`scope=upcoming`, rooftop-wide) and the **drill-down
  behind any appointment count** (`scope=window` → the leads behind "N appts" for the shown
  window). `enterpriseId` comes from the iframe URL (`?enterprise_id=`, forwarded by
  `ScenarioProvider`), falling back to decoding it from the token; `serviceType=both` merges
  sales + service. Degrades to an empty list — never blanks the card. See `src/lib/spyne/meetings.ts`.
  NOTE: locally the single `SPYNE_API_TOKEN` authenticates, but the data is scoped by the
  `enterprise_id`/`team_id` on the URL — so pass both to drill into any rooftop the token can read.

### Data model (Supabase / Postgres)
| Table | Grain | Role |
| ----- | ----- | ---- |
| `agent_daily` | one **summable** row per (`activity_day`, `team_id`, `agent_type`) | scalar daily facts — ratios are never stored, the API sums then divides |
| `agent_daily_breakdown` | tall rows: (`dim`, `dim_value`) | distributions: intent / source / hour / reply_offset / outcome |
| `report_appointments` / `report_callbacks` / `report_campaigns` | per-row, rooftop-level (keyed by `team_id`) | detail lists the daily aggregate can't hold; campaigns are `agent_type`-tagged |
| `sync_state` | singleton (`id = 1`) | last run / status / rows / error bookkeeping |

Design choices that matter: **store summable facts, compute ratios at read time** (so
any date range just sums); **snake_case columns map 1:1 to Postgres**; fractional
`talk_seconds`/`quality_score` are rounded before insert (the `bigint` columns reject
decimals); quality and speed-to-lead are stored as **accumulator pairs** (sum + basis)
so the API can take a correct weighted mean across the window.

### Data-accuracy caveats (Q12227 quirks)
The raw source has unpopulated/ambiguous columns the aggregate works around — these
shape what the numbers mean:
- The `connected` and `reached_person` columns are **all-zero**, so "connected" is
  derived from `talk_seconds > 0` (matches the funnel card within ~0.3%).
- `appointments` = **distinct booked leads**, not a flag-sum; summing distinct-lead
  counts across a range slightly **overcounts** the true window-distinct value (~3%).
- **No `csat` / `sentiment` source** → those quality KPIs stay zeroed/"coming soon".
- Residual ~0.5–1% gaps vs the Metabase cards come from **timezone day-bucketing** (the
  cards apply a TZ param; the raw aggregate buckets on `activity_day`).
- See [AGENT_FIELDS.md](AGENT_FIELDS.md) for the field-by-field source-of-truth (every
  metric, its meaning, and whether it's live).

### Metabase integration (`src/lib/metabase.ts`)
- **Static embedding** — the embed `SECRET` both signs the iframe JWT (hand-rolled
  HS256, no dependency) *and* authenticates the JSON data endpoint, so no separate API
  key is needed. An `ALLOWED_QUESTIONS` allowlist stops the routes signing arbitrary
  embeds.
- The 382 MB pull uses an **undici dispatcher with header/body timeouts disabled** —
  the default 300 s timeout fired while Metabase was still running the query and
  silently truncated the body into a parse failure.

### Spyne API enrichment — timezone + onboarded agents (`src/lib/spyne/`)
Two facts Q12227 can't give us are pulled from the Spyne product API (`api.spyne.ai`) and
degrade gracefully when unavailable:
- **`working-hours`** → the rooftop's IANA **timezone** (+ per-day sales/service hours).
  `/api/reports` resolves it and computes the "Today/last7/last30" window in the
  **store's timezone** instead of UTC, then passes those store-local dates into the
  query — so a Pacific rooftop's day boundaries are Pacific midnight. (Root cause of the
  "Service shows data but isn't open yet" ticket: a UTC day = ~5pm prior-day → ~5pm
  Pacific, so it bled the previous evening into "Today.")
- **`onboarded-agents`** → which of the four slots the dealer has actually onboarded
  (`isOnboarded`). `build.ts` **gates** the report to those slots (personas unchanged);
  unknown list → all four shown (previous behavior).

**Auth** (admin-scoped token; the working-hours route is an admin-tools endpoint):
- **Prod** — the host forwards the token per-request to `/api/reports` (Authorization
  header, or `?spyne_token=` / `?token=` on the report URL → read by `ScenarioProvider`,
  forwarded by `fetchAgents`).
- **Local dev** — `SPYNE_API_TOKEN` in `.env.local` (the request-token fallback).
- **No token** → calls no-op and the report falls back to UTC windows + all agents.

**Sync re-bucket (for "Today/Yesterday" precision).** `scripts/backfill.ts` resolves
every rooftop's tz via `fetchTzMap()` and passes `tzOf` to `aggregate.ts`, which buckets
`activity_day` by store-local day from `activity_ts` (incremental widens the pull one day
and filters the re-bucketed output; UTC path unchanged when no token). Gated on
`SPYNE_API_TOKEN` being set in the GitHub Action secrets. **Caveat:** until that re-bucket
runs against history (the daily `--full` reconcile does this), the store-local *window* is
matched against still-UTC daily rows, so last7/last30 are correct but "Today/Yesterday"
can still bleed ~the prior evening.

### Scheduling & freshness
- **Primary:** a **GitHub Action** (`.github/workflows/sync-reports.yml`) runs
  `backfill.ts` — **incremental per-day every 30 min** (~1 min total) plus a **daily
  04:17 UTC full reconcile** (one 382 MB pull catches edits to older rows). Runs on a
  7 GB / no-cap runner because the full pull can't finish inside Vercel's 300 s cap.
- **Alternative (provisioned, not active):** a `pg_cron` + `pg_net` job in migration
  0001 can ping `/api/sync` every few minutes for free — unblocked once Q12227 exposes
  the `activity_day` embedding param.
- **Migrations** are applied via `scripts/apply-migration.ts` over the Supabase session
  pooler (needs `SUPABASE_DB_URL`), or pasted into the SQL editor.

## Frontend

The UI is ~3,600 lines of client components under `src/components/reports/`:

- **`kit.tsx`** — the in-house widget/chip library (cards, charts, funnels, chips) every
  page is built from. The bulk of the rendering code.
- **`data.ts`** — the `AgentData` model + the mock fleet used for identity and for the
  deferred-mock surfaces. **`liveData.ts`** is the live overlay (`fetchAgents()` calls
  `/api/reports`). **`v2data.ts`** backs the story-first v2 dashboard.
- **`upsell.tsx`** — the "interested in this agent" capture flow that posts to
  `/api/agent-interest`. **`MetabasePanel.tsx` / `MetabaseData.tsx`** render the legacy
  iframe / JSON-card path.

### Lifecycle & scenarios (`scenario.tsx`)
The report has no in-app rooftop switching — the team is whatever the host scoped via
`?team_id=`. `ScenarioProvider` resolves that id against the CSM tracker
(`accounts.ts`) for display name / agent set / lifecycle **stage**, synthesizing a
minimal account if the id is unknown so *any* `team_id` still renders. Stage drives the
UI: `In_Ob` → onboarding (importing, not live yet), `Live` → live report, `Churned` →
live report too (churn is never surfaced to the account). Scenarios
(`first_time` / `onboarding` / `recently_live` / `repeat`) pick first-time ghost
previews vs. the full report.

### The "Coming soon" gate
`ComingSoonGate.tsx` wraps the surface and, **when `NEXT_PUBLIC_REPORTING_COMING_SOON`
is on (the default), shows a coming-soon screen everywhere**. Set it to `0`/`false`/`off`
to reveal the real reports (locally or on a Vercel preview) while validating numbers.
This is a temporary gate to be removed once reporting ships — worth knowing before
deploying, since a fresh deploy shows the gate, not the report.

## What's live vs. coming-soon

- **Live:** call/SMS volume, connections, qualified leads, appointments, outbound
  outcomes mix, per-rooftop appointments / callbacks / campaigns (campaigns are
  agent-type-split: Sales OB vs Service OB), Overview "Top campaigns".
- **Zeroed / "coming soon":** metrics Q12227 has no source for — `showed/deals/
  revenue/cost`, `csat/sentiment`, and agent health/RAG badges (these were removed
  from the UI since there's no real source).
- Still on mock (intentional, deferred): the Impact (v2) tab + first-time ghost previews.

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind v4 · Supabase (`@supabase/supabase-js` +
`pg`) · deployed on Vercel · data source = Metabase static embedding.

## Required env

`METABASE_SITE_URL`, `METABASE_SECRET_KEY` (embed + JSON endpoint), `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`. Optional: `AGENT_INTEREST_WEBHOOK_URL`
(upsell-interest leads), `SUPABASE_DB_URL` (running migrations), `METABASE_RAW_DATE_PARAM`,
`SYNC_WINDOW_DAYS`, `NEXT_PUBLIC_REPORTING_COMING_SOON` (on by default — gates the whole
surface; set `0`/`false`/`off` to show the real report). Without the Metabase/Supabase
vars the API degrades gracefully (503 / "being wired up" states) instead of crashing.

## Known limitations

- The **campaigns** page reads in-memory context only — empty in a fresh standalone
  deploy; its "build a campaign" links are no-ops (the builder isn't part of this app).
- The lightweight `pg_cron → Vercel` sync path is blocked until Q12227 gets an
  `activity_day` embedding param; until then refresh runs via the GitHub Action.
