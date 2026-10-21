/* The rooftop's service scheduler by name, for the appointments popup: past appointments whose status never
 * moved read "Status not updated in Xtime" instead of "Status not available".
 *
 * The name is Om's /service-metrics/appointment/show-rate `provider`: lower(providerName) of the rooftop's
 * service-scheduler integration. The names below are every provider on prod (ClickHouse, 21-Oct-2026);
 * anything new is title-cased, and no name at all reads "the scheduler". */

// A Map, not an object, so a provider like "constructor" can never hit Object.prototype.
const NAMES = new Map<string, string>([
  ["xtime", "Xtime"],
  ["xtime-cox", "Xtime"],
  ["tekion", "Tekion"],
  ["cdk", "CDK"],
  ["dealerfx", "DealerFX"],
  ["pbs", "PBS"],
  ["updatepromise", "UpdatePromise"],
  ["mykaarma", "myKaarma"],
  ["evenflow", "Evenflow"],
]);

/** True when the provider has a display name of its own, not a title-cased guess (the sanity check's test). */
export function isKnownScheduler(provider: string | null | undefined): boolean {
  return NAMES.has((provider ?? "").trim().toLowerCase());
}

/** The scheduler's display name; null when the rooftop has none or it isn't known yet. */
export function schedulerName(provider: string | null | undefined): string | null {
  const p = (provider ?? "").trim().toLowerCase();
  if (!p) return null;
  return NAMES.get(p) ?? p.split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** The popup's label for the "other" group (and its rows). */
export function notUpdatedLabel(name: string | null | undefined): string {
  return `Status not updated in ${name || "the scheduler"}`;
}
