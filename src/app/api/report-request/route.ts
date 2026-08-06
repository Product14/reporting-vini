/* Custom report requests from the report library.
 *
 *   POST /api/report-request  { teamId, accountName, name, email, title, description, cadence }
 *
 * The dealer describes the report they want; we log it server-side (so a request is never lost even if
 * every side-channel is down) and best-effort forward it to the product team by email and, when
 * REPORT_REQUEST_WEBHOOK_URL is set, to Slack. Mirrors /api/agent-interest — same contract, same
 * fail-open behaviour: a side-channel error never fails the dealer's submission.
 *
 * Deliberately unauthenticated like agent-interest: it accepts no data back out, only a message in. */
import { sendInterestEmail } from "@/lib/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RequestBody {
  teamId?: string;
  accountName?: string;
  name?: string;
  email?: string;
  title?: string;
  description?: string;
  cadence?: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clip = (s: string, n: number) => s.slice(0, n);

export async function POST(request: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim();
  const description = (body.description ?? "").trim();
  if (name.length < 2 || !EMAIL_RE.test(email)) {
    return Response.json({ error: "A name and a valid email are required." }, { status: 422 });
  }
  if (description.length < 10) {
    return Response.json({ error: "Please describe the report you'd like — a sentence is plenty." }, { status: 422 });
  }

  const req = {
    type: "custom-report-request",
    teamId: clip((body.teamId ?? "").trim(), 64),
    accountName: clip((body.accountName ?? "").trim(), 120),
    name: clip(name, 120),
    email: clip(email, 200),
    title: clip((body.title ?? "").trim(), 200),
    description: clip(description, 4000),
    cadence: clip((body.cadence ?? "").trim(), 40),
    at: new Date().toISOString(),
  };

  // Always logged first — this is the durable record; the two side-channels below are conveniences.
  console.log(`[report-request] ${JSON.stringify(req)}`);

  await Promise.allSettled([
    // Reuses the existing interest-email plumbing rather than adding a second mail path: the request
    // maps onto the same lead shape, with the ask carried in `note`.
    sendInterestEmail({
      teamId: req.teamId,
      accountName: req.accountName,
      agentId: "custom-report",
      agentName: `Custom report: ${req.title || "(untitled)"}`,
      name: req.name,
      email: req.email,
      phone: "",
      note: `${req.description}${req.cadence ? `\n\nHow often: ${req.cadence}` : ""}`,
      at: req.at,
    }).catch(() => undefined),
    (async () => {
      const hook = process.env.REPORT_REQUEST_WEBHOOK_URL;
      if (!hook) return;
      await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `*Custom report request* — ${req.accountName || req.teamId}\n*${req.title || "(untitled)"}* (${req.cadence || "no cadence"})\n${req.description}\n_${req.name} <${req.email}>_`,
        }),
      }).catch(() => undefined);
    })(),
  ]);

  return Response.json({ ok: true });
}
