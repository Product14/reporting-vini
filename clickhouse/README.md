# ClickHouse-native reporting fact

`conversation_fact_canonical.sql` is **generated**, never hand-edited:

```bash
npx tsx scripts/gen-conversation-fact-mv.ts --out=clickhouse/conversation_fact_canonical.sql
```

It emits a refreshable materialized view built directly from `src/lib/reports/agentBaseFact.sql`, so
the reporting fact table and the canonical spine cannot drift apart. Regenerate after ANY change to
the spine and re-apply.

## Why this exists

The reporting console currently reads a Supabase aggregate filled by `scripts/backfill.ts` running in
GitHub Actions. That path has three problems, all of which this removes:

1. **Staleness.** The workflow is scheduled hourly but GitHub fires it every 1.4-5.5h in practice.
   Dealers saw appointment counts hours behind the appointments console, which reads the live API.
2. **Delete-then-insert.** `syncChunk()` DELETEs a day range before INSERTing. A failed insert leaves
   the window empty. This cost four months of reporting data on 2026-08-21.
3. **Unapplied DDL.** Migrations live in `supabase/migrations/` and are applied by nobody on deploy.

A `REFRESH ... TO <target>` view computes into a temp table and swaps: a failed refresh leaves the
previous contents intact, and the schema IS the SELECT, so there is no second system holding DDL.

## Applying it

Our credential is `dev_readonly_role`, so this needs a **write-capable ClickHouse credential** — hand
the file to whoever owns the cluster. The generator itself is read-only (it uses DESCRIBE to resolve
column types, which also proves the SELECT parses and analyzes).

It builds under `conversation_fact_canonical` / `rmv_conversation_fact_canonical`, deliberately
distinct from the existing `vini_reporting.conversation_fact`, so the two can be diffed side by side
before any cutover.

## Do not read the existing `vini_reporting.conversation_fact`

It refreshes every 30 minutes and therefore looks current, but it was frozen from an older spine and
has silently drifted. Measured 2026-09-09 against the current spine it is missing:

| Canonical rule | live `conversation_fact` | generated |
|---|---|---|
| `meta.source='warm_transfer'` appointment exclusion | absent | present |
| callback -> outbound re-attribution | absent | present |
| Sales Outbound campaign-outcome qualified rule | absent | present |
| 25-label buying-intent vocabulary | absent | present |
| web chat channel (`is_chat`, `qualified_via_chat`) | absent | present |

Concretely, on Heiser Chevrolet (`team_id=b7184697be`, service, 30d) it reports **44** AI-booked
appointments where only **36** such meetings exist and the canonical spine returns **32** — it is
counting warm-transfer rows the dealer never booked.
