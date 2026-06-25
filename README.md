# reporting-vini

Embeddable **reporting surface** for the Spyne agent product, extracted from the main
app to be hosted standalone and **iframed** into the host product's "Reports" tab.
No global chrome (no Sidebar/Header) — just the report.

## How it's scoped: `team_id`

The report is scoped to a rooftop via a `team_id` query param. The host passes it on
the iframe URL:

```
<iframe src="https://<host>/reports?team_id=<TEAM_ID>" />
```

`?team_id=` is read once on load (`ScenarioProvider` in
`src/components/reports/scenario.tsx`) and drives the live `/api/reports` query (served from the
Supabase aggregate). A bare `/` also forwards to `/reports`, preserving `team_id`.

> Known team IDs live in `src/components/reports/accounts.ts` (from the CSM tracker).
> A `team_id` not in that list falls back to the default rooftop for display naming,
> but live queries still use the team_id passed in the URL.

## Routes

| Path                  | Page                                  |
| --------------------- | ------------------------------------- |
| `/reports`            | Overview (daily control-tower report) |
| `/reports/agents`     | Per-agent report + agent upsell       |
| `/reports/v2`         | Reporting v2 (story-first dashboard)  |
| `/reports/campaigns`  | Campaign run history (in-memory only) |

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in SUPABASE_* (and CLICKHOUSE_* if running the sync locally)
npm run dev                  # http://localhost:3000/reports?team_id=<id>
```

The reports read the **Supabase** aggregate; the app never touches ClickHouse at request time. The
aggregate is materialized by `scripts/backfill.ts`, which runs the ClickHouse conversation spine
(`src/lib/reports/agentBaseFact.sql`) + detail queries directly (watermark-incremental). That ETL runs
in GitHub Actions (`.github/workflows/sync-reports.yml`); prod Vercel has no ClickHouse access.

## Environment

| Var                          | Required | Purpose                                                        |
| ---------------------------- | -------- | -------------------------------------------------------------- |
| `SUPABASE_URL`               | yes      | Backing store for the materialized reporting aggregate (read)  |
| `SUPABASE_SERVICE_ROLE_KEY`  | yes      | Server-only service-role key for the aggregate                 |
| `CLICKHOUSE_HOST/PORT/USER/PASSWORD` | sync only | Read-only prod ClickHouse — used by `scripts/backfill.ts` (the ETL), not the web app |
| `AGENT_INTEREST_WEBHOOK_URL` | no       | Slack-compatible webhook for agent-upsell interest leads       |

Without `SUPABASE_*`, `/api/reports` returns mock-shaped data so the UI still renders.

## Notes / limitations

- The **campaigns** page reads from in-memory context only (no campaigns exist in a
  fresh standalone deploy), so it shows an empty state. Its "build a campaign" links
  are no-ops here since the campaign builder is not part of this app.
- Extracted from the `Agent-Workflow` repo. Header/Sidebar were intentionally removed
  for iframe embedding.
