/* Client-side report export — CSV/XLSX (dependency-free download + SheetJS) and a native, single-page
 * PDF (jsPDF + autotable — see printToPdf.ts). All three read from the SAME data the page already
 * computed, so the numbers can never drift between formats; only the presentation differs. These are
 * downloaded directly by dealers, not just internal reviewers — wording matters (see DEFINITIONS below,
 * shared across all three formats and worded the same as the canonical on-screen footer). */

export interface ExportSheet {
  name: string; // sheet tab name (XLSX) / section header (CSV)
  rows: (string | number)[][]; // first row is the header row
}

// A block inside a PDF section: a plain 2-column label/value list (omit `columns`), a proper data table
// (with `columns` as the header row), or a freeform wrapped paragraph (`note`). `title` is an optional
// sub-label drawn above just this block (e.g. two tables — "Wins" and "Missed" — inside one section).
export type PdfBlock =
  | { kind: "rows"; title?: string; columns?: string[]; rows: (string | number)[][] }
  | { kind: "note"; text: string };
export interface PdfSection {
  heading: string;
  blocks: PdfBlock[];
}

// The same glossary shown on-screen (DefinitionsFooter in kitV3.tsx) — verbatim, so a dealer reading the
// downloaded file without the live report open still gets the exact same definitions.
export const CANONICAL_DEFINITIONS =
  "Real conversation = the customer actually spoke on a non-voicemail call, or replied to a text " +
  "(voicemail excluded). Qualified = concrete buying intent (vehicle / availability / price / financing " +
  "/ trade-in / test-drive / booking) — same rule for calls and texts; a bare reply counts as Engaged, " +
  "not Qualified. Appointments — AI-booked = the AI created the meeting record; AI-assisted (CRM) = " +
  "booked in your CRM on a lead the AI worked, shown separately and never folded into that total. " +
  "Hand-offs = completed transfers plus requested callbacks; failed transfers are reported separately. " +
  "Turn rate = qualified leads ÷ real conversations. Close rate = AI-booked appointments ÷ qualified leads.\n\n" +
  "All figures are de-duplicated and consistent with the live report, the Vini console, and your " +
  "scorecard/email reports.";

function csvEscape(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadCSV(filename: string, sheets: ExportSheet[]): void {
  const lines: string[] = [];
  sheets.forEach((sheet, i) => {
    if (i > 0) lines.push("");
    lines.push(csvEscape(sheet.name));
    sheet.rows.forEach((row) => lines.push(row.map(csvEscape).join(",")));
  });
  // BOM so Excel opens the UTF-8 file without mangling non-ASCII characters.
  triggerDownload(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" }), filename);
}

export async function downloadXLSX(filename: string, sheets: ExportSheet[]): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31)); // Excel caps sheet names at 31 chars
  }
  XLSX.writeFile(wb, filename);
}

/** Filesystem-safe filename stem shared by every format, e.g. "Covina Kia - Jul 1-14 2026". */
export function exportFilenameStem(accountName: string, periodLabel: string): string {
  return `${accountName || "report"} - ${periodLabel}`.replace(/[/\\?%*:|"<>]/g, "-");
}
