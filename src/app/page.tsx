import { redirect } from "next/navigation";

// The embeddable surface lives at /reports. Hitting the root just forwards there,
// preserving any ?team_id=… so a bare iframe src still lands on the scoped report.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const teamId = typeof sp.team_id === "string" ? sp.team_id : "";
  redirect(teamId ? `/reports?team_id=${encodeURIComponent(teamId)}` : "/reports");
}
