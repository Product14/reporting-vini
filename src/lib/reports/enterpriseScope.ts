/* WHICH ENTERPRISES COUNT AS REAL ROOFTOPS FOR REPORTING — the reseller exemption lives here only.
 *
 * Every reporting read starts from the same "real rooftops only" screen on eventila.enterprise_details:
 * not a test account, not a test/demo/sandbox name, and NOT A RESELLER. That last clause was written to
 * keep partner sandboxes out of fleet numbers, but `reseller_id` does not separate a sandbox from a
 * paying rooftop sold through a channel partner — it only records that a partner owns the relationship.
 * So genuine rooftops were being filtered out of the pipeline entirely: no leads reached lead_canonical,
 * nothing landed in agent_daily, and the console showed "<name>'s report is on its way" forever while
 * ClickHouse held hundreds of real calls for them.
 *
 * The exemption is an ALLOWLIST rather than a removal of the clause on purpose. ~40 reseller enterprises
 * are hidden today and they are genuinely mixed — real dealer groups sit alongside `c360-demo`,
 * `Vincue-Demo`, `Netlook Ext QA` and `kartik dealer 1`. Dropping the clause outright would pour those
 * into every fleet report and into /api/reports/bulk. Add a reseller enterprise here only once someone
 * has confirmed it is a paying customer whose numbers should count.
 *
 * ONE SOURCE OF TRUTH. The predicate below is consumed by:
 *   • src/lib/reports/agentBaseFact.sql via the {RESELLER_SCOPE} placeholder (substituted in
 *     spineSql.ts, alongside {START}/{END}) — the conversation spine the ETL and the generated
 *     ClickHouse MV both run.
 *   • src/lib/reports/detailQueries.ts — the four drill-down queries.
 * Unblocking the spine alone is not enough: the spine decides whether a rooftop has numbers, the detail
 * queries decide whether its drill-downs have rows, and they have to move together or the report loads
 * with populated tiles and empty lists.
 *
 * NOT wired to this module (hardcoded, with a pointer back here):
 *   • clickhouse/sales_qualification_warm_hot.sql — a standalone extract that must stay paste-runnable
 *     under `ch`/`ch-pack`, so it cannot carry a TS-substituted placeholder.
 *   • clickhouse/conversation_fact_canonical.sql — GENERATED from the spine; regenerate, never edit:
 *         npx tsx scripts/gen-conversation-fact-mv.ts
 *
 * Adding an enterprise here changes who appears in reporting but writes nothing by itself. The pipeline
 * is watermark-incremental, so a newly-allowlisted enterprise needs a backfill over the history you
 * want visible before its report stops reading "on its way".
 */

/** Reseller-owned enterprises that ARE real paying rooftops and must not be screened out. */
export const RESELLER_ALLOWLIST: readonly string[] = [
  "62f962c8e", // CallSource Auto — 11 rooftops (Toyota of Poway, Michael Hohl Chevrolet GMC, …)
];

const quoted = (ids: readonly string[]) => ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");

/** SQL: enterprise is not reseller-owned, OR is an allowlisted reseller. `alias` is the
 *  eventila.enterprise_details alias in the calling query (every current caller uses `ed`).
 *  With an empty allowlist this collapses to the original reseller screen. */
export function resellerScope(alias = "ed"): string {
  const base = `${alias}.reseller_id IS NULL OR ${alias}.reseller_id = ''`;
  return RESELLER_ALLOWLIST.length
    ? `(${base} OR ${alias}.enterprise_id IN (${quoted(RESELLER_ALLOWLIST)}))`
    : `(${base})`;
}
