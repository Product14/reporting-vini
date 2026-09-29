/* THE ROI REPORT — the Overview's "Export PDF", the document a CSM hands a dealer.
 *
 * Same numbers as the screen, ordered the way a dealer reads: what you got, then what it took, then how
 * fast, then where the month went, then every customer behind the three headline buckets by name.
 *
 * WHY THE THREE BUCKETS ARE NEVER SUMMED INTO ONE. "Appointments Vini booked" and "AI-assisted" are
 * different claims — the AI created the first, your people created the second on leads the AI had
 * worked. A single merged "appointments" figure is the one thing that gets a report thrown out of a GM's
 * office, so the total appears only under a verb true of both halves and the split sits beside it.
 *
 * The named lists are the point of the document. A dealer can argue with a count; they cannot argue with
 * their own customer's name and phone number, and the third list is directly workable by the BDC.
 */
import type { PdfSection } from "./exportReport";
import { CANONICAL_DEFINITIONS, exportFilenameStem } from "./exportReport";
import { buildPdfReport } from "./printToPdf";
import type { FleetLive, NamedAppt } from "./liveData";
import type { QualifiedLead } from "@/app/api/reports/qualified-leads/route";

/* HARD ROW CEILING per list. printToPdf lays the report out as ONE continuously-tall page, and the PDF
 * format itself caps a page at 14,400pt (200in) — past that the file is invalid, not merely ugly. 244
 * qualified leads already measures ~87in, i.e. roughly 0.2in a row, so an uncapped list on a big rooftop
 * would silently produce a broken download for exactly the client most worth impressing. 400 keeps all
 * three tables plus the prose comfortably inside the ceiling; anything beyond is stated, never dropped
 * in silence, and the full set is always available from the CSV/XLSX export. */
const MAX_LIST_ROWS = 400;

const f = (n: number) => n.toLocaleString("en-US");
const hrs = (mins: number) => `${(mins / 60).toFixed(1)}`;
const mmss = (sec: number) => `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, "0")}s`;

/** "2026-09-14 16:30:00" / ISO → "Sep 14 · 4:30 PM". Wall-clock as stored, matching the on-screen list. */
function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(d.getTime())) return "—";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const h = d.getUTCHours() % 12 || 12;
  return `${mon} ${d.getUTCDate()} · ${h}:${String(d.getUTCMinutes()).padStart(2, "0")} ${d.getUTCHours() >= 12 ? "PM" : "AM"}`;
}
function dayLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(d.getTime())) return "—";
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCDate()}`;
}
const intentLabel = (s: string) => (s || "").replace(/[_-]+/g, " ").trim().toLowerCase() || "appointment";

/* Some CRM leads carry a placeholder where the name should be. Printing it as if it were a person makes
   the list look broken; dropping the row would lose a real, reachable buyer. Name it for what it is — the
   phone number is what the BDC actually works from. */
function personLabel(name: string): string {
  const v = (name || "").trim();
  if (!v || v.toLowerCase() === "unknown" || /^internet lead/i.test(v)) return "(no name on the lead)";
  return v;
}

export interface RoiExportInput {
  accountName: string;
  periodLabel: string;
  dept: "sales" | "service" | "all";
  fleet: FleetLive;
  namedAppts: NamedAppt[];
  qualified: QualifiedLead[];
  qualifiedTotal: number;
  tzLabel?: string;
}

export function buildRoiSections(i: RoiExportInput): PdfSection[] {
  const { fleet } = i;
  const booked = i.namedAppts.filter((a) => !a.assisted);
  const assisted = i.namedAppts.filter((a) => a.assisted);
  // The tiles are the rooftop truth; the lists can be shorter (a booking with no customer record still
  // counts). Headline off the tile, list off the rows, and say so rather than letting them disagree.
  const nBooked = fleet.appointments;
  const nAssist = fleet.appointmentsAssisted;
  const nQual = i.qualifiedTotal;
  const totalAppts = nBooked + nAssist;
  const deptWord = i.dept === "service" ? "service" : "sales";

  const apptRows = (rows: NamedAppt[]) =>
    rows.map((a) => [
      personLabel(a.customer), a.phone || "—", whenLabel(a.when),
      intentLabel(a.intent), dayLabel(a.bookedAt),
      /cancel/i.test(a.status || "") ? "Cancellation requested" : "Scheduled",
    ]);

  const sections: PdfSection[] = [
    {
      heading: "What Vini produced",
      blocks: [
        {
          kind: "stats",
          stats: [
            { value: f(nBooked), label: "Appointments booked by Vini", sub: "the AI set them itself" },
            { value: f(nAssist), label: "AI-assisted appointments", sub: "your team booked, on a lead Vini worked" },
            { value: f(nQual), label: "Additional qualified leads", sub: "qualified, not yet booked" },
            { value: hrs(fleet.talkMinutes), label: "Hours on the phone", sub: "live conversation you didn't staff" },
          ],
        },
        {
          kind: "note",
          text:
            `${totalAppts} appointments came out of Vini's work this period — ${nBooked} it set itself, and ` +
            `${nAssist} your team set after it had already spoken to the customer. They are counted separately ` +
            `and never added into one "booked by AI" number, because they are different claims. ` +
            `A further ${nQual} buyers qualified and have not booked yet; every one of them is named at the end ` +
            `of this report, with a phone number.`,
        },
      ],
    },
    {
      heading: "What it took",
      blocks: [
        {
          kind: "rows",
          rows: [
            ["Calls placed and answered", f(fleet.calls)],
            ["Texts sent on cadence", f(fleet.smsSent)],
            ["Hours spent talking to customers", `${hrs(fleet.talkMinutes)} hrs`],
            ["Conversations handled outside store hours", f(fleet.afterHours)],
            ["Live hand-offs to your team", f(fleet.handoffs)],
            ["Customer questions resolved without a rep", f(fleet.queryResolved)],
          ],
        },
        {
          kind: "note",
          text:
            `${f(fleet.afterHours)} of those conversations happened while the store was closed — nights, ` +
            `early mornings and weekends, the hours a walk-in desk cannot cover and a lead goes cold in.`,
        },
      ],
    },
  ];

  if (fleet.responseTimeSec != null) {
    sections.push({
      heading: "Speed to lead",
      blocks: [
        {
          kind: "rows",
          rows: [
            ["Average time to first response", mmss(fleet.responseTimeSec)],
            ["Real conversations held", f(fleet.conversations)],
            ["Leads worked in the period", f(fleet.leads)],
          ],
        },
        { kind: "note", text: "Measured from the moment a new lead lands in your CRM to Vini's first touch." },
      ],
    });
  }

  sections.push({
    heading: "Where the month went",
    blocks: [
      {
        kind: "rows",
        columns: ["Stage", "Customers", "Share of the stage before"],
        rows: fleet.funnel.map((s, idx, all) => [
          s.label, f(s.value),
          idx === 0 ? "entered the funnel"
            : all[idx - 1].value > 0 ? `${Math.round((100 * s.value) / all[idx - 1].value)}%` : "—",
        ]),
      },
      {
        kind: "note",
        text:
          `Each stage counts distinct customers, not activity — one buyer called four times is one lead ` +
          `here. The ${f(nQual)} who qualified without booking are the shortest path to more appointments ` +
          `next period, and they are listed by name below so your BDC can work them directly.`,
      },
    ],
  });

  if (booked.length) {
    sections.push({
      heading: `Appointments Vini booked (${f(booked.length)})`,
      blocks: [
        { kind: "rows", columns: ["Customer", "Phone", "Appointment", "What for", "Booked", "Status"],
          rows: apptRows(booked.slice(0, MAX_LIST_ROWS)) },
        ...(booked.length > MAX_LIST_ROWS
          ? [{ kind: "note" as const, text: `Showing the first ${f(MAX_LIST_ROWS)} of ${f(booked.length)} — the full list is in the CSV or XLSX export.` }]
          : []),
      ],
    });
  }
  if (assisted.length) {
    sections.push({
      heading: `AI-assisted appointments (${f(assisted.length)})`,
      blocks: [
        { kind: "note", text: "Your team booked these, on leads Vini had already spoken to and warmed up." },
        { kind: "rows", columns: ["Customer", "Phone", "Appointment", "What for", "Booked", "Status"], rows: apptRows(assisted.slice(0, MAX_LIST_ROWS)) },
        ...(assisted.length > MAX_LIST_ROWS
          ? [{ kind: "note" as const, text: `Showing the first ${f(MAX_LIST_ROWS)} of ${f(assisted.length)} — the full list is in the CSV or XLSX export.` }]
          : []),
      ],
    });
  }
  if (i.qualified.length) {
    sections.push({
      heading: `Qualified buyers still in play (${f(nQual)})`,
      blocks: [
        { kind: "note", text: "Qualified this period, no appointment yet. Most recently spoken to first — the top of this list is the warmest." },
        {
          kind: "rows",
          columns: ["Customer", "Phone", "Lead source", "Last spoken to"],
          rows: i.qualified.slice(0, MAX_LIST_ROWS).map((l) => [personLabel(l.customer), l.phone || "—", l.source || "—", dayLabel(l.lastTouch)]),
        },
        // Only when the list was capped — an export that quietly shows 400 of 900 is worse than one that says so.
        ...(Math.min(i.qualified.length, MAX_LIST_ROWS) < nQual
          ? [{ kind: "note" as const, text: `Showing the ${f(Math.min(i.qualified.length, MAX_LIST_ROWS))} most recently contacted of ${f(nQual)}. The full list is in the CSV or XLSX export.` }]
          : []),
      ],
    });
  }

  sections.push({
    heading: "How to read this",
    blocks: [
      { kind: "note", text: CANONICAL_DEFINITIONS },
      {
        kind: "note",
        text:
          `Figures are measured by Spyne from this rooftop's own call, text and CRM records for the ` +
          `${deptWord} agents over ${i.periodLabel.toLowerCase()} — vendor-reported, not third-party audited. ` +
          `Customer contact details are your own CRM records, reproduced here so your team can act on them; ` +
          `handle them per your store's privacy policy.`,
      },
    ],
  });

  return sections;
}

export async function exportRoiPdf(i: RoiExportInput): Promise<void> {
  await buildPdfReport(buildRoiSections(i), {
    filename: `${exportFilenameStem(`${i.accountName} - Vini ROI`, i.periodLabel)}.pdf`,
    title: `${i.accountName || "Rooftop"} — what Vini delivered`,
    subtitle: `${i.periodLabel}${i.tzLabel ? ` · times in ${i.tzLabel}` : ""}`,
  });
}
