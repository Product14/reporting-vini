"use client";

import React from "react";

/* ─────────────────────────────────────────────────────────────────────────────
 * TEMP — full-surface "Coming soon" gate for the reporting iframe.
 * Shown across the whole /reports surface while the live numbers are being
 * validated. Mounted by reports/layout.tsx behind the REPORTING_COMING_SOON flag
 * (NEXT_PUBLIC_REPORTING_COMING_SOON). Safe to delete once reporting is ungated.
 * ───────────────────────────────────────────────────────────────────────────── */
export function ReportingComingSoon() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#fafafa] px-6 py-16">
      <div className="w-full max-w-[560px] overflow-hidden rounded-[28px] border border-[#ddd0fb] bg-gradient-to-br from-[#1c1033] via-[#2a1656] to-[#3a1d6e] text-white shadow-[0_20px_60px_-24px_rgba(58,29,110,0.7)]">
        <div className="flex flex-col items-center px-10 py-14 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-[34px] ring-1 ring-white/15">
            📊
          </span>
          <p className="mt-6 text-[10.5px] font-bold uppercase tracking-[0.18em] text-[#c4b5fd]">Reports</p>
          <h1 className="mt-2 text-[30px] font-black leading-[1.05] tracking-[-0.02em]">Reporting is coming soon</h1>
          <p className="mt-3 max-w-[420px] text-[14px] leading-snug text-[#d6cdf0]">
            We&apos;re putting the finishing touches on your dashboard and validating every number, so the figures you
            see are accurate from day one. Your full reporting suite goes live right here shortly.
          </p>
          <span className="mt-7 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-[12px] font-semibold text-white backdrop-blur-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#5eead4] opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#5eead4]" />
            </span>
            Validating data
          </span>
        </div>
      </div>
    </div>
  );
}
