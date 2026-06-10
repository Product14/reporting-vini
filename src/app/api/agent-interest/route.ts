// Captures "I'm interested in this agent" submissions from the Agents report upsell flow.
// Always logs the lead server-side so it's never lost; if AGENT_INTEREST_WEBHOOK_URL is set
// (Slack-compatible incoming webhook), it also forwards a human-readable message.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InterestBody {
  teamId?: string;
  accountName?: string;
  agentId?: string;
  agentName?: string;
  name?: string;
  email?: string;
  phone?: string;
  note?: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(request: Request): Promise<Response> {
  let body: InterestBody;
  try {
    body = (await request.json()) as InterestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim();
  if (name.length < 2 || !EMAIL_RE.test(email)) {
    return Response.json({ error: "A name and a valid email are required." }, { status: 422 });
  }

  const lead = {
    type: "agent-upsell-interest",
    teamId: (body.teamId ?? "").trim(),
    accountName: (body.accountName ?? "").trim(),
    agentId: (body.agentId ?? "").trim(),
    agentName: (body.agentName ?? "").trim(),
    name,
    email,
    phone: (body.phone ?? "").trim(),
    note: (body.note ?? "").trim(),
    at: new Date().toISOString(),
  };

  // Captured regardless of whether a downstream destination is wired yet.
  console.log("[agent-interest]", JSON.stringify(lead));

  const hook = process.env.AGENT_INTEREST_WEBHOOK_URL;
  if (hook) {
    const text =
      `🚀 *Agent interest* — ${lead.agentName || "agent"} for *${lead.accountName || "rooftop"}*` +
      ` (team \`${lead.teamId || "—"}\`)\n` +
      `${lead.name} <${lead.email}>${lead.phone ? ` · ${lead.phone}` : ""}` +
      (lead.note ? `\n> ${lead.note}` : "");
    try {
      await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (e) {
      // Don't fail the user's submission if the webhook is down — the lead is already logged.
      console.error("[agent-interest] webhook forward failed:", (e as Error).message);
    }
  }

  return Response.json({ ok: true });
}
