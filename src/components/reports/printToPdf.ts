/* A real, native PDF report — not a screenshot. Earlier this rendered the live page with html2canvas
 * and stitched the image across several landscape pages; dealers download this file, and that read as
 * "a screenshot," not a report — rasterized text, an arbitrary page break wherever the image ran out of
 * room, and a 70MB+ file at high enough resolution to stay legible. This instead draws the SAME data the
 * CSV/XLSX export uses directly with jsPDF (+ autotable for the tables) — real selectable text, a small
 * file, and laid out as ONE continuously-tall page sized exactly to the content (no mid-table page
 * breaks), the way a purpose-built report reads rather than a printed webpage.
 *
 * Two-pass sizing: PDF page dimensions are fixed at creation time, so the exact height needed isn't
 * known until everything is drawn. Pass 1 draws onto a generously tall placeholder page purely to
 * measure how far the content actually reaches; pass 2 creates the real page at that height and draws
 * the identical content again. (PDF pages are capped at 14,400pt/200in by the format itself — comfortably
 * more than this ever needs, since long lists are capped to a readable preview; see each page's export
 * builder for the "see the CSV/XLSX for the complete list" notes.) */

import type { jsPDF } from "jspdf";
import type { UserOptions, HookData } from "jspdf-autotable";
import type { PdfBlock, PdfSection } from "./exportReport";

export interface PdfReportOpts {
  filename: string;
  title: string;
  subtitle?: string;
}

const PAGE_WIDTH = 720; // pt (10in) — a single wide column, generous enough for a 6-7 column table
const MARGIN_X = 40;
const MARGIN_TOP = 44;
const MARGIN_BOTTOM = 40;
const PLACEHOLDER_HEIGHT = 14000; // pt — under the 14,400pt PDF format ceiling; only used for measuring

const INK = [17, 17, 17] as const;
const MUTED = [107, 114, 128] as const;
const BRAND = [129, 63, 237] as const;
const BRAND_TINT = [246, 241, 255] as const;

export async function buildPdfReport(sections: PdfSection[], opts: PdfReportOpts): Promise<void> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const contentWidth = PAGE_WIDTH - MARGIN_X * 2;

  // Draws the full document top-to-bottom and returns the final Y — the same function runs once to
  // measure (pass 1) and once for real (pass 2), so there's exactly one place that knows how to lay
  // this out.
  const render = (doc: jsPDF): number => {
    let y = MARGIN_TOP;

    doc.setFont("helvetica", "bold").setFontSize(19).setTextColor(...INK);
    doc.text(opts.title, MARGIN_X, y);
    y += 20;
    if (opts.subtitle) {
      doc.setFont("helvetica", "normal").setFontSize(10.5).setTextColor(...MUTED);
      doc.text(opts.subtitle, MARGIN_X, y);
      y += 14;
    }
    y += 10;
    doc.setDrawColor(...BRAND).setLineWidth(1.4);
    doc.line(MARGIN_X, y, PAGE_WIDTH - MARGIN_X, y);
    y += 22;

    for (const section of sections) {
      doc.setFont("helvetica", "bold").setFontSize(12.5).setTextColor(...BRAND);
      doc.text(section.heading.toUpperCase(), MARGIN_X, y);
      y += 16;

      for (const block of section.blocks) {
        y = renderBlock(doc, autoTable, block, y, contentWidth);
      }
      y += 12; // space between sections
    }

    return y;
  };

  // jsPDF's default orientation ("portrait") silently SWAPS width/height whenever width > height, to
  // enforce its own height-must-be-≥-width convention — a real, verified issue: a short (sparse-content)
  // report came out 533×720 instead of the intended 720-wide page, squeezing every table into a much
  // narrower column than they were laid out for. Picking orientation based on our own actual dimensions
  // (landscape when height < width) satisfies that same convention on its own terms, so the swap never
  // triggers and [width, height] always comes out exactly as given.
  const measure = new jsPDF({ unit: "pt", format: [PAGE_WIDTH, PLACEHOLDER_HEIGHT], orientation: "portrait" });
  const measuredHeight = render(measure);

  const finalHeight = Math.min(PLACEHOLDER_HEIGHT, Math.ceil(measuredHeight) + MARGIN_BOTTOM);
  const orientation = finalHeight >= PAGE_WIDTH ? "portrait" : "landscape";
  const doc = new jsPDF({ unit: "pt", format: [PAGE_WIDTH, finalHeight], orientation });
  render(doc);

  doc.save(opts.filename);
}

function renderBlock(
  doc: jsPDF,
  autoTable: (d: jsPDF, opts: UserOptions) => void,
  block: PdfBlock,
  startY: number,
  contentWidth: number,
): number {
  let y = startY;

  if (block.kind === "note") {
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...MUTED);
    const lines: string[] = doc.splitTextToSize(block.text, contentWidth);
    doc.text(lines, MARGIN_X, y);
    return y + lines.length * 10.5 + 4;
  }

  if (!block.rows.length) return y;

  if (block.title) {
    doc.setFont("helvetica", "bold").setFontSize(9.5).setTextColor(55, 65, 81);
    doc.text(block.title, MARGIN_X, y);
    y += 12;
  }

  let cursor = y;
  if (block.columns) {
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN_X, right: MARGIN_X },
      head: [block.columns],
      body: block.rows.map((r) => r.map((c) => String(c))),
      theme: "striped",
      styles: { fontSize: 8.5, textColor: [30, 30, 30], cellPadding: 4 },
      headStyles: { fillColor: BRAND as unknown as [number, number, number], textColor: 255, fontStyle: "bold", fontSize: 9 },
      alternateRowStyles: { fillColor: BRAND_TINT as unknown as [number, number, number] },
      didDrawPage: (data: HookData) => { cursor = data.cursor?.y ?? cursor; },
    });
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN_X, right: MARGIN_X },
      body: block.rows.map((r) => r.map((c) => String(c))),
      theme: "plain",
      styles: { fontSize: 9.5, cellPadding: { top: 2.5, bottom: 2.5, left: 0, right: 10 } },
      columnStyles: {
        0: { textColor: MUTED as unknown as [number, number, number] },
        1: { fontStyle: "bold", textColor: INK as unknown as [number, number, number] },
      },
      didDrawPage: (data: HookData) => { cursor = data.cursor?.y ?? cursor; },
    });
  }
  return cursor + 10;
}
