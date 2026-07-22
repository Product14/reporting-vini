// Generates ready-to-send sample payloads for both products into ./samples/.
// Run:  node email-templates/build-samples.mjs
//
// The samples send ONLY to devansh.hasija@spyne.ai so a test curl is safe. For the real flow,
// swap `to`/`cc` (production = product@spyne.ai + devansh + mehul).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSendPayload } from "./retailSuiteInterest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "samples");
mkdirSync(outDir, { recursive: true });

// Shared sample lead (matches the Retail Suite preview: Lucki Mazda of Wooster).
const base = {
  name: "Daksh Sharma",
  email: "daksh@luckimazda.com",
  phone: "(330) 555-0147",
  bestTime: "Morning",
  accountName: "Lucki Mazda of Wooster",
  enterpriseName: "C.A.R. Automotive",
  teamId: "49a06313cf",
  at: "2026-07-22T09:54:00Z", // → 3:24 PM IST
};

const TEST_TO = "devansh.hasija@spyne.ai";

const service = buildSendPayload({
  lead: { ...base, product: "service", note: "Want to recover declined work and cut no-shows heading into Q4." },
  to: TEST_TO,
});
// Per request: the "sales" payload mirrors the Service email exactly (same subject + body),
// so both curls send the identical Service-designed email.
const sales = service;

writeFileSync(join(outDir, "sales.payload.json"), JSON.stringify(sales, null, 2));
writeFileSync(join(outDir, "service.payload.json"), JSON.stringify(service, null, 2));
console.log("Wrote samples/sales.payload.json and samples/service.payload.json");
