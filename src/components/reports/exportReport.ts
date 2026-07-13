/* Client-side report export — CSV (dependency-free) and XLSX (SheetJS, dynamically imported so the
 * ~1MB parser/writer only loads into the bundle when a user actually clicks "Download XLSX"). Both
 * formats are built from the SAME sheet data, so the two exports never drift apart.
 *
 * CSV has no concept of multiple sheets, so downloadCSV renders every sheet as its own labeled block
 * in one file (section header + rows, blank line between blocks) rather than dropping the extra data. */

export interface ExportSheet {
  name: string; // sheet tab name (XLSX) / section header (CSV)
  rows: (string | number)[][]; // first row is the header row
}

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

/** Filesystem-safe filename stem shared by both formats, e.g. "Covina Kia - Jul 1-14 2026". */
export function exportFilenameStem(accountName: string, periodLabel: string): string {
  return `${accountName || "report"} - ${periodLabel}`.replace(/[/\\?%*:|"<>]/g, "-");
}
