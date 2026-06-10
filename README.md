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
`src/components/reports/scenario.tsx`) and drives every live Metabase query. A bare
`/` also forwards to `/reports`, preserving `team_id`.

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
cp .env.example .env.local   # fill in METABASE_* values
npm run dev                  # http://localhost:3000/reports?team_id=<id>
```

## Environment

| Var                          | Required | Purpose                                                        |
| ---------------------------- | -------- | -------------------------------------------------------------- |
| `METABASE_SITE_URL`          | yes      | Metabase host for static embedding                             |
| `METABASE_SECRET_KEY`        | yes      | Signs embed tokens + authenticates the JSON data endpoint      |
| `AGENT_INTEREST_WEBHOOK_URL` | no       | Slack-compatible webhook for agent-upsell interest leads       |

Without the Metabase vars, the API routes return `503` and the UI shows the
"being wired up / no live data" states rather than crashing.

## Notes / limitations

- The **campaigns** page reads from in-memory context only (no campaigns exist in a
  fresh standalone deploy), so it shows an empty state. Its "build a campaign" links
  are no-ops here since the campaign builder is not part of this app.
- Extracted from the `Agent-Workflow` repo. Header/Sidebar were intentionally removed
  for iframe embedding.
