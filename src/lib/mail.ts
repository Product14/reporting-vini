// Server-only client for Spyne's internal email API (mail.spyne.ai).
// Sends a "new product interest" notification whenever a rooftop clicks an "I'm interested" /
// CTA anywhere in the reports surface (all of which POST to /api/agent-interest).
//
// API contract (proven by the Vini Control Tower senders):
//   POST https://mail.spyne.ai/api/v1/send-template-email
//   headers: Content-Type: application/json, Cookie: <SPYNE_MAIL_COOKIE>
//   body: { to, cc?, bcc?, subject, template, templateData: { HTMLdata } }
// The template is a generic shell that injects HTMLdata, so we build the whole body here.
//
// Env:
//   SPYNE_MAIL_COOKIE     session cookie from a logged-in mail.spyne.ai account (service account preferred)
//   SPYNE_MAIL_TEMPLATE   template name; defaults to the known generic shell
//   PRODUCT_INTEREST_TO   comma-separated recipients; defaults to product + Devansh + Mehul
// When SPYNE_MAIL_COOKIE is unset the send is skipped (the lead is still logged by the route).

const MAIL_URL = "https://mail.spyne.ai/api/v1/send-template-email";
const DEFAULT_TEMPLATE = "email-control-tower-report"; // generic shell that injects HTMLdata; verified live
const DEFAULT_RECIPIENTS = ["product@spyne.ai", "devansh.hasija@spyne.ai", "mehul.kamra@spyne.ai"];

export interface InterestLead {
  teamId: string;
  accountName: string;
  agentId: string;
  agentName: string;
  name: string;
  email: string;
  phone: string;
  note: string;
  at: string; // ISO timestamp
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function recipients(): string[] {
  const raw = (process.env.PRODUCT_INTEREST_TO ?? "").trim();
  if (!raw) return DEFAULT_RECIPIENTS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/* ── the small email design — a single product-interest lead card ── */
function buildInterestEmail(lead: InterestLead): string {
  const product = lead.agentName || "a Spyne agent";
  const account = lead.accountName || "a rooftop";
  const when = new Date(lead.at).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const row = (label: string, value: string, isLink?: "mailto" | "tel") => {
    const v = isLink === "mailto"
      ? `<a href="mailto:${esc(lead.email)}" style="color:#813fed;text-decoration:none;">${esc(value)}</a>`
      : isLink === "tel"
      ? `<a href="tel:${esc(lead.phone)}" style="color:#813fed;text-decoration:none;">${esc(value)}</a>`
      : esc(value);
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #f0eef7;color:#8b8794;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;width:130px;vertical-align:top;">${esc(label)}</td>
        <td style="padding:10px 0;border-bottom:1px solid #f0eef7;color:#1a1430;font-size:14px;vertical-align:top;">${v}</td>
      </tr>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f2fa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2fa;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 12px 36px -18px rgba(58,29,110,0.45);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

        <!-- header band -->
        <tr><td style="background:#813fed;background-image:linear-gradient(135deg,#6d28d9,#813fed);padding:26px 32px;">
          <p style="margin:0;color:#e9defc;font-size:11px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;">Spyne · Product interest</p>
          <h1 style="margin:6px 0 0;color:#ffffff;font-size:21px;font-weight:800;letter-spacing:-0.01em;line-height:1.25;">🚀 New interest in ${esc(product)}</h1>
          <p style="margin:8px 0 0;color:#e9defc;font-size:13px;line-height:1.4;">A buyer clicked “I’m interested” for <strong style="color:#ffffff;">${esc(account)}</strong>.</p>
        </td></tr>

        <!-- details -->
        <tr><td style="padding:24px 32px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${row("Contact", lead.name || "—")}
            ${row("Email", lead.email || "—", lead.email ? "mailto" : undefined)}
            ${lead.phone ? row("Phone", lead.phone, "tel") : ""}
            ${row("Product", product)}
            ${row("Rooftop", account)}
            ${lead.teamId ? row("Team ID", lead.teamId) : ""}
            ${lead.note ? row("Note", lead.note) : ""}
            ${row("Submitted", when + " IST")}
          </table>
        </td></tr>

        <!-- CTA -->
        <tr><td style="padding:8px 32px 28px;">
          <a href="mailto:${esc(lead.email)}" style="display:inline-block;background:#813fed;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:11px;">Reply to ${esc(lead.name || "the buyer")} →</a>
        </td></tr>

        <!-- footer -->
        <tr><td style="padding:16px 32px;background:#faf9fe;border-top:1px solid #f0eef7;">
          <p style="margin:0;color:#9b96a8;font-size:11px;line-height:1.5;">Sent automatically from the Spyne Reports upsell flow. Reply directly to the buyer above to follow up.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Fire the product-interest notification email. Never throws — on any failure it logs and
 * returns false so the caller (the user's submission) is never blocked. Returns true on a
 * confirmed 2xx send, false if skipped (no cookie) or failed.
 */
export async function sendInterestEmail(lead: InterestLead): Promise<boolean> {
  const cookie = process.env.SPYNE_MAIL_COOKIE;
  if (!cookie) {
    console.log("[agent-interest] SPYNE_MAIL_COOKIE unset — email skipped (lead still logged).");
    return false;
  }

  const to = recipients();
  const payload = {
    to: to[0],
    cc: to.slice(1),
    subject: `🚀 Product interest — ${lead.agentName || "Spyne agent"} for ${lead.accountName || "a rooftop"}`,
    template: process.env.SPYNE_MAIL_TEMPLATE || DEFAULT_TEMPLATE,
    templateData: { HTMLdata: buildInterestEmail(lead) },
  };

  try {
    const res = await fetch(MAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[agent-interest] email API HTTP ${res.status}: ${text.slice(0, 300)}`);
      return false;
    }
    console.log(`[agent-interest] interest email sent to ${to.join(", ")}`);
    return true;
  } catch (e) {
    console.error("[agent-interest] email send failed:", (e as Error).message);
    return false;
  }
}
