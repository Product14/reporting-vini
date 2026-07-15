/* Client-side "Print / Save as PDF" that doesn't depend on window.print() / the browser's native print
 * dialog. The parent console iframes this app with a sandbox attribute that's missing 'allow-modals' —
 * window.print() is silently ignored there (no exception, nothing we can even detect), and per spec a
 * popup opened from a sandboxed frame inherits the same restriction unless the opener grants
 * 'allow-popups-to-escape-sandbox', which we don't control. So instead: screenshot the report with
 * html2canvas, lay the image into a real multi-page PDF with jsPDF, and trigger a normal file download
 * (Blob + <a download>) — the same mechanism the CSV/XLSX export already uses, which isn't gated by
 * 'allow-modals' (only by 'allow-downloads', a far more commonly granted sandbox flag). */

export interface PrintToPdfOpts {
  filename: string;
  title?: string;
  subtitle?: string;
}

export async function printToPdf(element: HTMLElement, opts: PrintToPdfOpts): Promise<void> {
  // html2canvas-pro, not the original html2canvas: Tailwind v4's generated stylesheet uses modern CSS
  // color functions (oklch/lab) for its default palette, which the original html2canvas's color parser
  // throws on ("Attempting to parse an unsupported color function"), aborting the whole capture. The
  // -pro fork adds support for those.
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas-pro"), import("jspdf")]);

  // .no-print elements (interactive chrome, live "synced Xm ago" labels that would be misleading on a
  // saved document) are hidden for window.print() via @media print, which html2canvas never sees — it
  // screenshots the DOM as currently rendered, not through the print pipeline. Hide them for real,
  // capture, then restore, so a failure in between never leaves the live page stuck hidden.
  const hidden = Array.from(element.querySelectorAll<HTMLElement>(".no-print"));
  const prevDisplay = hidden.map((el) => el.style.display);
  hidden.forEach((el) => { el.style.display = "none"; });

  let canvas: HTMLCanvasElement;
  try {
    // scale: 1.5 is plenty for a report full of flat color + text (no photos) — scale: 2 produced
    // 70MB+ PDFs (way past what anyone can email) for barely any visible sharpness gain.
    canvas = await html2canvas(element, { scale: 1.5, backgroundColor: "#ffffff", useCORS: true });
  } finally {
    hidden.forEach((el, i) => { el.style.display = prevDisplay[i]; });
  }

  // The captured element's own bottom padding (breathing room for on-screen scrolling) shows up as a
  // large blank strip at the end of the canvas — enough, once paginated, to spill into a wasted fully
  // blank trailing page. Trim trailing all-white rows before paginating instead of assuming any fixed
  // padding amount, so this holds regardless of which page/section is being captured.
  const contentHeight = trimTrailingWhitespace(canvas);

  const pdf = new jsPDF({ orientation: "landscape", unit: "in", format: "letter" });
  const pageWidthIn = pdf.internal.pageSize.getWidth();
  const pageHeightIn = pdf.internal.pageSize.getHeight();
  const marginIn = 0.35;
  const usableWidthIn = pageWidthIn - marginIn * 2;

  // Title/subtitle are drawn directly (not captured) — the on-screen "print header" is CSS-hidden
  // (shown only under real @media print), so a DOM screenshot taken outside that pipeline never sees it.
  let topOffsetIn = marginIn;
  if (opts.title) {
    pdf.setFont("helvetica", "bold").setFontSize(16).setTextColor(17, 17, 17);
    pdf.text(opts.title, marginIn, topOffsetIn + 0.15);
    topOffsetIn += 0.3;
  }
  if (opts.subtitle) {
    pdf.setFont("helvetica", "normal").setFontSize(10).setTextColor(107, 114, 128);
    pdf.text(opts.subtitle, marginIn, topOffsetIn + 0.1);
    topOffsetIn += 0.25;
  }

  // canvas px → PDF inches, scaled to fill the usable page width; sliced into page-height chunks so a
  // tall report becomes several pages instead of one unreadable, endlessly-shrunk page.
  const pxPerIn = canvas.width / usableWidthIn;
  const usableHeightFirstPageIn = pageHeightIn - topOffsetIn - marginIn;
  const usableHeightOtherPagesIn = pageHeightIn - marginIn * 2;

  let renderedPx = 0;
  let pageIndex = 0;
  while (renderedPx < contentHeight) {
    const usableHeightIn = pageIndex === 0 ? usableHeightFirstPageIn : usableHeightOtherPagesIn;
    const sliceHeightPx = Math.min(Math.round(usableHeightIn * pxPerIn), contentHeight - renderedPx);
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = sliceHeightPx;
    slice.getContext("2d")!.drawImage(canvas, 0, renderedPx, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);

    if (pageIndex > 0) pdf.addPage();
    const yIn = pageIndex === 0 ? topOffsetIn : marginIn;
    // JPEG, not PNG — PNG's lossless compression handled this screenshot-like content badly (a 5-page
    // report ran 70MB+); JPEG at high quality is visually indistinguishable here and a fraction of the size.
    pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", marginIn, yIn, usableWidthIn, sliceHeightPx / pxPerIn);

    renderedPx += sliceHeightPx;
    pageIndex += 1;
  }

  pdf.save(opts.filename);
}

// Scans up from the bottom in coarse steps (this only needs to find "roughly where content ends," not
// a pixel-perfect edge) for the first row that isn't pure white, and returns the height just past it.
function trimTrailingWhitespace(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas.height;
  const step = 8;
  for (let y = canvas.height - 1; y >= 0; y -= step) {
    const row = ctx.getImageData(0, y, canvas.width, 1).data;
    for (let x = 0; x < row.length; x += 4) {
      if (row[x] !== 255 || row[x + 1] !== 255 || row[x + 2] !== 255) {
        return Math.min(canvas.height, y + step);
      }
    }
  }
  return canvas.height;
}
