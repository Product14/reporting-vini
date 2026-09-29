/* THE ROI REPORT, drawn to the Spyne success-story design — dark hero, floating stat card, numbered
 * section eyebrows, navy tables. This is the document a CSM emails a dealer, so it has to look like
 * something the company published, not like a data dump.
 *
 * WHY THIS IS NOT printToPdf. That renderer is deliberately plain and lays everything on one
 * continuously-tall page; it is right for "download the numbers behind this tab" and wrong for a
 * client-facing report. This draws real Letter pages with jsPDF primitives instead, which keeps the
 * download one click (no browser print dialog) and the text selectable, with no headless Chrome.
 *
 * WHAT WAS CUT AS REDUNDANT, versus the HTML original:
 *   - the three big "what each bucket is" cards, which repeated the stat card directly above them;
 *   - the separate "How to read this" definition cards, which repeated those same descriptions a third
 *     time. Each bucket is now defined once, in the sub-line under its own stat.
 */
import type { UserOptions } from "jspdf-autotable";
import type { FleetLive, NamedAppt } from "./liveData";
import type { QualifiedLead } from "@/app/api/reports/qualified-leads/route";
import { exportFilenameStem } from "./exportReport";

const W = 612, H = 792, M = 44;            // Letter, in points
const NAVY: RGB = [14, 29, 51];
const CYAN: RGB = [34, 211, 238];
const EMERALD: RGB = [16, 185, 129];
const BLUE: RGB = [37, 99, 235];
const ORANGE: RGB = [194, 65, 12];
const INK: RGB = [15, 23, 42];
const MUTED: RGB = [100, 116, 139];
const LINE: RGB = [229, 231, 235];
const WASH: RGB = [248, 250, 252];
type RGB = [number, number, number];

const f = (n: number) => n.toLocaleString("en-US");
const hrs = (mins: number) => (mins / 60).toFixed(1);
const mmss = (sec: number) => `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, "0")}s`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}
function whenLabel(iso: string | null | undefined): string {
  const d = parse(iso); if (!d) return "—";
  const h = d.getUTCHours() % 12 || 12;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} · ${h}:${String(d.getUTCMinutes()).padStart(2, "0")} ${d.getUTCHours() >= 12 ? "PM" : "AM"}`;
}
function dayLabel(iso: string | null | undefined): string {
  const d = parse(iso); if (!d) return "—";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
const intentLabel = (s: string) => (s || "").replace(/[_-]+/g, " ").trim().toLowerCase() || "appointment";
function personLabel(name: string): string {
  const v = (name || "").trim();
  if (!v || v.toLowerCase() === "unknown" || /^internet lead/i.test(v)) return "(no name on the lead)";
  return v;
}

export interface RoiPdfInput {
  accountName: string;
  periodLabel: string;
  dept: "sales" | "service" | "all";
  fleet: FleetLive;
  namedAppts: NamedAppt[];
  qualified: QualifiedLead[];
  qualifiedTotal: number;
  tzLabel?: string;
}

/* Rows per table. autoTable paginates properly here (unlike the single-page renderer), so this is about
   the reader, not the format: past a few hundred names a printed list stops being worked and starts being
   scrolled. Anything beyond is stated and still available in the CSV/XLSX export. */
const MAX_ROWS = 400;

export async function exportRoiPdf(i: RoiPdfInput): Promise<void> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });

  const { fleet } = i;
  const booked = i.namedAppts.filter((a) => !a.assisted);
  const assisted = i.namedAppts.filter((a) => a.assisted);
  const nBooked = fleet.appointments;
  const nAssist = fleet.appointmentsAssisted;
  const nQual = i.qualifiedTotal;
  const totalAppts = nBooked + nAssist;
  const deptWord = i.dept === "service" ? "service" : "sales";

  let y = 0;
  let page = 1;

  const setFill = (c: RGB) => doc.setFillColor(c[0], c[1], c[2]);
  const setText = (c: RGB) => doc.setTextColor(c[0], c[1], c[2]);
  const setDraw = (c: RGB) => doc.setDrawColor(c[0], c[1], c[2]);

  /** Letter-spaced small caps — the deck's section eyebrows. jsPDF has no tracking, so draw per glyph. */
  function tracked(text: string, x: number, yy: number, gap = 1.1) {
    let cx = x;
    for (const ch of text) { doc.text(ch, cx, yy); cx += doc.getTextWidth(ch) + gap; }
    return cx - x;
  }

  function runningHeader() {
    const name = i.accountName || "Rooftop";
    doc.setFont("helvetica", "bold").setFontSize(7.5); setText([71, 85, 105]);
    doc.text(name, M, 34);
    const nameW = doc.getTextWidth(name); // measured in the face it was drawn in, not the next one
    doc.setFont("helvetica", "normal"); setText([148, 163, 184]);
    doc.text(`  ·  Vini ${deptWord} performance`, M + nameW, 34);
    doc.text(i.periodLabel, W - M, 34, { align: "right" });
  }

  function newPage() {
    doc.addPage(); page += 1; runningHeader(); y = 62;
  }
  /** Reserve vertical room; break the page when the block would run off the bottom. */
  function need(h: number) { if (y + h > H - 54) newPage(); }

  // ── page 1: the hero ────────────────────────────────────────────────────────────────────────────
  setFill(NAVY); doc.rect(0, 0, W, 322, "F");

  setFill(BLUE); doc.roundedRect(M, 40, 15, 15, 4, 4, "F");
  doc.setFont("helvetica", "bold").setFontSize(12); setText([255, 255, 255]);
  doc.text("Spyne", M + 21, 51.5);

  // period pill, right
  const pill = i.periodLabel.toUpperCase();
  doc.setFont("helvetica", "bold").setFontSize(7);
  const pillW = doc.getTextWidth(pill) + 34;
  setDraw([30, 58, 95]); doc.setLineWidth(0.7);
  doc.roundedRect(W - M - pillW, 39, pillW, 17, 8.5, 8.5, "S");
  setFill(EMERALD); doc.roundedRect(W - M - pillW + 11, 45, 5, 5, 1.5, 1.5, "F");
  setText([167, 243, 208]); doc.text(pill, W - M - pillW + 21, 50.5);

  doc.setFont("helvetica", "bold").setFontSize(7.5); setText(CYAN);
  tracked(`VINI · ${deptWord.toUpperCase()} PERFORMANCE REVIEW`, M, 104, 1.5);

  doc.setFont("helvetica", "bold").setFontSize(25); setText([255, 255, 255]);
  const nameLines: string[] = doc.splitTextToSize(i.accountName || "Your rooftop", W - M * 2);
  doc.text(nameLines, M, 138);
  let hy = 138 + nameLines.length * 28;

  setText(CYAN);
  const punch = `${f(totalAppts)} appointment${totalAppts === 1 ? "" : "s"}. ${f(nQual)} buyer${nQual === 1 ? "" : "s"} still in play.`;
  const punchLines: string[] = doc.splitTextToSize(punch, W - M * 2);
  doc.text(punchLines, M, hy);
  hy += punchLines.length * 28 + 6;

  doc.setFont("helvetica", "normal").setFontSize(9.5); setText([148, 163, 184]);
  const lede =
    `Over ${i.periodLabel.toLowerCase()}, Vini worked every ${deptWord} lead in your CRM — calling, texting and ` +
    `following up on a multi-day cadence — and put ${f(totalAppts)} appointments on your board. Another ` +
    `${f(nQual)} qualified buyers are in your pipeline right now, named and reachable at the back of this report.`;
  doc.text(doc.splitTextToSize(lede, 430) as string[], M, hy, { lineHeightFactor: 1.5 });

  // ── the floating stat card, straddling the hero's lower edge ────────────────────────────────────
  const CARD_Y = 268, CARD_H = 86;
  setFill([255, 255, 255]); setDraw(LINE); doc.setLineWidth(0.7);
  doc.roundedRect(M, CARD_Y, W - M * 2, CARD_H, 9, 9, "FD");
  const stats: { v: string; l: string; s: string; c: RGB }[] = [
    { v: f(nBooked), l: "Appointments booked by Vini", s: "the AI set them itself", c: EMERALD },
    { v: f(nAssist), l: "AI-assisted appointments", s: "you booked, after Vini worked the lead", c: BLUE },
    { v: f(nQual), l: "Additional qualified leads", s: "qualified, not yet booked", c: ORANGE },
    { v: hrs(fleet.talkMinutes), l: "Hours on the phone", s: "conversation you didn't staff", c: NAVY },
  ];
  const colW = (W - M * 2) / stats.length;
  stats.forEach((st, idx) => {
    const x = M + idx * colW + 14;
    doc.setFont("helvetica", "bold").setFontSize(19); setText(st.c);
    doc.text(st.v, x, CARD_Y + 30);
    doc.setFont("helvetica", "bold").setFontSize(7.6); setText(INK);
    const l: string[] = doc.splitTextToSize(st.l, colW - 26);
    doc.text(l, x, CARD_Y + 45);
    doc.setFont("helvetica", "normal").setFontSize(6.8); setText(MUTED);
    doc.text(doc.splitTextToSize(st.s, colW - 26) as string[], x, CARD_Y + 45 + l.length * 8.5 + 2);
    if (idx) { setDraw(LINE); doc.line(M + idx * colW, CARD_Y + 14, M + idx * colW, CARD_Y + CARD_H - 14); }
  });
  y = CARD_Y + CARD_H + 30;

  // ── building blocks ─────────────────────────────────────────────────────────────────────────────
  let sectionNo = 0;
  /* Sections are separated by a RULE and a numbered chip, not by whitespace alone. Spacing on its own
     read as one continuous document — the eye had nothing to catch on, so "What it took", "Speed to
     lead" and "Where the month went" ran together. The rule gives a hard edge, the filled chip gives the
     number weight, and the leading space above is larger than any gap inside a section so the hierarchy
     is unambiguous. */
  function section(kicker: string, title: string, sub?: string) {
    sectionNo += 1;
    /* Reserve room for the heading AND the block that follows it, not just the heading. Reserving only
       the heading let "02 Speed to lead" render at the foot of page 1 while its stat strip broke to
       page 2 — an orphaned title, which in a document a dealer is handed reads as a printing fault. */
    need(190);
    y += 10;
    setDraw(LINE); doc.setLineWidth(0.8); doc.line(M, y, W - M, y);
    y += 20;
    const n = String(sectionNo).padStart(2, "0");
    doc.setFont("helvetica", "bold").setFontSize(7.2);
    const chipW = doc.getTextWidth(n) + 11;
    setFill(CYAN); doc.roundedRect(M, y - 8.5, chipW, 12.5, 3, 3, "F");
    setText(NAVY); doc.text(n, M + 5.5, y);
    setText(MUTED); tracked(kicker.toUpperCase(), M + chipW + 8, y, 1.3);
    y += 18;
    doc.setFont("helvetica", "bold").setFontSize(15); setText(INK);
    const t: string[] = doc.splitTextToSize(title, W - M * 2);
    doc.text(t, M, y); y += t.length * 17 + 2;
    if (sub) {
      doc.setFont("helvetica", "normal").setFontSize(9); setText(MUTED);
      const s: string[] = doc.splitTextToSize(sub, W - M * 2 - 40);
      doc.text(s, M, y, { lineHeightFactor: 1.45 }); y += s.length * 12 + 4;
    }
    y += 6;
  }

  function strip(items: { n: string; l: string }[]) {
    const h = 58;
    need(h + 10);
    setFill([255, 255, 255]); setDraw(LINE); doc.setLineWidth(0.7);
    doc.roundedRect(M, y, W - M * 2, h, 8, 8, "FD");
    const cw = (W - M * 2) / items.length;
    items.forEach((it, idx) => {
      const x = M + idx * cw + 12;
      doc.setFont("helvetica", "bold").setFontSize(13.5); setText(INK);
      doc.text(it.n, x, y + 26);
      doc.setFont("helvetica", "normal").setFontSize(7.4); setText(MUTED);
      doc.text(doc.splitTextToSize(it.l, cw - 22) as string[], x, y + 39);
      if (idx) { setDraw(LINE); doc.line(M + idx * cw, y + 11, M + idx * cw, y + h - 11); }
    });
    y += h + 14;
  }

  /* The lead clause is bold and the rest is muted. They are drawn as two STACKED runs, never overlaid:
     wrapping the combined string and then re-drawing the bold part on top of line 1 put two different
     sets of glyph metrics in the same place and produced visible double text. */
  function note(bold: string, rest: string) {
    const width = W - M * 2 - 26;
    doc.setFontSize(8.5).setFont("helvetica", "bold");
    const bLines: string[] = doc.splitTextToSize(bold, width);
    doc.setFont("helvetica", "normal");
    const rLines: string[] = doc.splitTextToSize(rest, width);
    const lh = 11.2;
    const h = (bLines.length + rLines.length) * lh + 16;
    need(h + 8);
    setFill(WASH); setDraw(LINE); doc.setLineWidth(0.7);
    doc.roundedRect(M, y, W - M * 2, h, 6, 6, "FD");
    setFill(CYAN); doc.rect(M, y + 1, 2.6, h - 2, "F");
    doc.setFont("helvetica", "bold"); setText(INK);
    doc.text(bLines, M + 14, y + 13, { lineHeightFactor: 1.32 });
    doc.setFont("helvetica", "normal"); setText([51, 65, 85]);
    doc.text(rLines, M + 14, y + 13 + bLines.length * lh, { lineHeightFactor: 1.32 });
    y += h + 16;
  }

  function table(head: string[], body: (string | number)[][], widths?: Record<number, number>) {
    need(70);
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M, top: 62 },
      head: [head],
      body: body.map((r) => r.map(String)),
      theme: "striped",
      styles: { fontSize: 7.8, cellPadding: 4.2, textColor: [30, 41, 59], lineColor: [241, 245, 249], lineWidth: 0.4 },
      headStyles: { fillColor: NAVY, textColor: 255, fontStyle: "bold", fontSize: 7.2, cellPadding: 5 },
      alternateRowStyles: { fillColor: [250, 251, 253] },
      columnStyles: widths ? Object.fromEntries(Object.entries(widths).map(([k, v]) => [k, { cellWidth: v }])) : undefined,
      didDrawPage: () => { if (doc.getNumberOfPages() > page) { page = doc.getNumberOfPages(); runningHeader(); } },
    } as UserOptions);
    // @ts-expect-error autotable stamps this on the doc
    y = (doc.lastAutoTable?.finalY ?? y) + 22;
  }

  const apptRows = (rows: NamedAppt[]) =>
    rows.slice(0, MAX_ROWS).map((a) => [
      personLabel(a.customer), a.phone || "—", whenLabel(a.when),
      intentLabel(a.intent), dayLabel(a.bookedAt),
      /cancel/i.test(a.status || "") ? "Cancellation requested" : "Scheduled",
    ]);

  // ── 01 what it took ─────────────────────────────────────────────────────────────────────────────
  section("What it took", "The work your floor didn't have to absorb.",
    "Every one of these is a customer interaction Vini handled end to end.");
  strip([
    { n: f(fleet.calls), l: "Calls placed & answered" },
    { n: f(fleet.smsSent), l: "Texts sent on cadence" },
    { n: hrs(fleet.talkMinutes), l: "Hours talking to customers" },
    { n: f(fleet.afterHours), l: "After-hours conversations" },
    { n: f(fleet.handoffs), l: "Live hand-offs to your team" },
  ]);
  note(`${f(fleet.afterHours)} of those conversations happened while the store was closed.`,
    "Nights, early mornings and weekends — the hours a walk-in desk cannot cover and a lead goes cold in.");

  // ── 02 speed to lead (only when the rooftop actually runs it) ───────────────────────────────────
  if (fleet.responseTimeSec != null) {
    section("Speed to lead", `Average first response: ${mmss(fleet.responseTimeSec)}.`,
      "Measured from the moment a new lead lands in your CRM to Vini's first touch.");
    strip([
      { n: mmss(fleet.responseTimeSec), l: "Average time to first response" },
      { n: f(fleet.conversations), l: "Real conversations held" },
      { n: f(fleet.leads), l: "Leads worked in the period" },
      { n: f(fleet.queryResolved), l: "Questions resolved without a rep" },
    ]);
  }

  // ── 03 the funnel ───────────────────────────────────────────────────────────────────────────────
  section("Where the month went", `From ${f(fleet.leads)} leads worked to ${f(nBooked)} appointments set.`,
    "Each stage counts distinct customers, not activity — one buyer called four times is one lead here.");
  table(["Stage", "Customers", "Share of the stage before"],
    fleet.funnel.map((s, idx, all) => [
      s.label, f(s.value),
      idx === 0 ? "entered the funnel"
        : all[idx - 1].value > 0 ? `${Math.round((100 * s.value) / all[idx - 1].value)}%` : "—",
    ]), { 1: 90, 2: 150 });
  note(`The ${f(nQual)} who qualified without booking are the opportunity.`,
    `They cleared qualification — a real conversation, a real buying signal — and have not booked. They are ` +
    `the shortest path to more appointments next period, and every one is named at the back of this report ` +
    `so your team can work them directly.`);

  // ── 04+ the named lists ─────────────────────────────────────────────────────────────────────────
  const APPT_HEAD = ["Customer", "Phone", "Appointment", "What for", "Booked", "Status"];
  const APPT_W = { 1: 78, 2: 86, 4: 46, 5: 82 };

  if (booked.length) {
    section("The customers", `Appointments Vini booked (${f(booked.length)})`,
      "Every appointment the AI set itself, with the time it set and what the customer asked for.");
    table(APPT_HEAD, apptRows(booked), APPT_W);
    if (booked.length > MAX_ROWS) note(`Showing the first ${f(MAX_ROWS)} of ${f(booked.length)}.`, "The full list is in the CSV or XLSX export.");
  }
  if (assisted.length) {
    section("The customers", `AI-assisted appointments (${f(assisted.length)})`,
      "Your team booked these. Vini had already spoken to the customer and warmed the lead up.");
    table(APPT_HEAD, apptRows(assisted), APPT_W);
    if (assisted.length > MAX_ROWS) note(`Showing the first ${f(MAX_ROWS)} of ${f(assisted.length)}.`, "The full list is in the CSV or XLSX export.");
  }
  if (i.qualified.length) {
    section("The opportunity", `Qualified buyers still in play (${f(nQual)})`,
      "Qualified this period, no appointment yet. Most recently spoken to first — the top of this list is the warmest.");
    table(["Customer", "Phone", "Lead source", "Last spoken to"],
      i.qualified.slice(0, MAX_ROWS).map((l) => [personLabel(l.customer), l.phone || "—", l.source || "—", dayLabel(l.lastTouch)]),
      { 1: 86, 3: 86 });
    const shown = Math.min(i.qualified.length, MAX_ROWS);
    if (shown < nQual) note(`Showing the ${f(shown)} most recently contacted of ${f(nQual)}.`, "The full list is in the CSV or XLSX export.");
  }

  // ── method footer ───────────────────────────────────────────────────────────────────────────────
  need(96);
  setDraw(LINE); doc.setLineWidth(0.7); doc.line(M, y, W - M, y); y += 14;
  doc.setFontSize(7.4);
  const foot: [string, string][] = [
    ["Source.", `Spyne platform data for ${i.accountName}, ${i.periodLabel.toLowerCase()}, ${deptWord} agents only. Figures are measured by Spyne from your own call, text and CRM records — they are vendor-reported, not third-party audited.`],
    ["Counting.", `Appointments are counted on the day they were booked${i.tzLabel ? `, in ${i.tzLabel}` : ""}. Funnel stages count distinct customers. An appointment your team booked is only called AI-assisted when Vini had a recorded conversation with that customer in the 90 days before it — the two are never added into one number.`],
    ["Customer details", "are your own CRM records, reproduced here so your team can act on them. Handle them per your store's privacy policy."],
  ];
  for (const [b, rest] of foot) {
    doc.setFontSize(7.4).setFont("helvetica", "normal");
    need(doc.splitTextToSize(`${b} ${rest}`, W - M * 2).length * 10.5 + 10);
    doc.setFont("helvetica", "bold"); setText([51, 65, 85]);
    doc.text(b, M, y);
    const bw = doc.getTextWidth(b);
    doc.setFont("helvetica", "normal"); setText(MUTED);
    // first line sits after the bold label, the remainder wraps full-width beneath it
    const first: string[] = doc.splitTextToSize(rest, W - M * 2 - bw - 4);
    doc.text(first[0] ?? "", M + bw + 4, y);
    const tail: string[] = doc.splitTextToSize(rest.slice((first[0] ?? "").length).trim(), W - M * 2);
    if (tail.length && tail[0]) doc.text(tail, M, y + 10.5, { lineHeightFactor: 1.4 });
    y += (1 + (tail[0] ? tail.length : 0)) * 10.5 + 6;
  }

  // page numbers, once the total is known
  const total = doc.getNumberOfPages();
  for (let p = 2; p <= total; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal").setFontSize(7.4); setText([148, 163, 184]);
    doc.text(`${p} / ${total}`, W - M, H - 30, { align: "right" });
  }

  doc.save(`${exportFilenameStem(`${i.accountName} - Vini ROI`, i.periodLabel)}.pdf`);
}
