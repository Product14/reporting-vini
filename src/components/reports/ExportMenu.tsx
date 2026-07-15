"use client";

import { useEffect, useRef, useState } from "react";

// Small "Download ▾" dropdown offering CSV and XLSX — styled to match DateFilter's popover in kit.tsx.
// Kept generic (just callbacks) so any report tab can drop it in next to its own data.
export function ExportMenu({ onCSV, onXLSX }: { onCSV: () => void; onXLSX: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClickAway);
    return () => window.removeEventListener("mousedown", onClickAway);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-[38px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#e5e7eb] bg-white px-3.5 text-[12px] font-bold text-[#111] transition-colors hover:bg-[#faf8ff]"
      >
        Download
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={open ? "rotate-180 transition-transform" : "transition-transform"}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 flex min-w-[160px] flex-col gap-0.5 rounded-xl border border-[#e5e7eb] bg-white p-1.5 shadow-[0_10px_30px_rgba(16,24,40,0.15)]">
          <button
            onClick={() => { setOpen(false); onCSV(); }}
            className="rounded-lg px-3 py-2 text-left text-[12.5px] font-semibold text-[#111] transition-colors hover:bg-[#faf8ff] hover:text-[#813fed]"
          >
            Download CSV
          </button>
          <button
            onClick={() => { setOpen(false); onXLSX(); }}
            className="rounded-lg px-3 py-2 text-left text-[12.5px] font-semibold text-[#111] transition-colors hover:bg-[#faf8ff] hover:text-[#813fed]"
          >
            Download XLSX
          </button>
        </div>
      )}
    </div>
  );
}
