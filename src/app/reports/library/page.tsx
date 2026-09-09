"use client";

/* Standalone route for the report library.
 *
 * The library's real home is INSIDE /reports/agents — that is the route the console's Reports tab
 * iframes (parentNav.ts: reports → /reports/agents), so a dealer only ever reaches it there. This route
 * exists so the library can be opened on its own during development and review, and it renders the very
 * same panel rather than a second copy that could drift. */

import { Suspense } from "react";
import { ReportTopBar, DateFilter } from "@/components/reports/kit";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, useDept, reportNavQuery } from "@/components/reports/dateRange";
import { ReportLibraryPanel } from "@/components/reports/libraryPanel";

export default function ReportLibraryPage() {
  return (
    <Suspense fallback={null}>
      <LibraryRoute />
    </Suspense>
  );
}

function LibraryRoute() {
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept, locked } = useDept();
  const { teamId } = useScenario();
  const navQuery = reportNavQuery(teamId, bucket, custom, dept, locked);

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">
        <ReportTopBar
          title="Reports"
          subtitle="Ready-made reports on your live data — pick one to open it."
          active="library"
          teamId={teamId}
          query={navQuery}
          right={<DateFilter bucket={bucket} custom={custom} onPreset={setPreset} onCustom={setCustom} />}
        />
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 pb-28 pt-7 sm:px-6 lg:px-10">
          <ReportLibraryPanel navQuery={navQuery} />
        </main>
      </div>
    </div>
  );
}
