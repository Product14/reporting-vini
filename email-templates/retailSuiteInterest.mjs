// Portable "Retail Suite — access request" email builder.
//
// Self-contained ESM module. NO dependencies and NO imports from this repo, so it can be copied
// verbatim into any other codebase (or imported straight from this folder). It does NOT touch or
// import reporting-vini's live mail flow (src/lib/mail.ts) — dropping this in changes nothing that
// currently sends.
//
// Two products, one layout system: buildInterestEmailHTML() returns a full, email-client-safe HTML
// document (inline styles, table layout) matching the "Retail Suite by Spyne" design language.
// buildSendPayload() wraps it in the mail.spyne.ai send-template-email API body.
//
// API contract (same as the proven Vini senders):
//   POST https://mail.spyne.ai/api/v1/send-template-email
//   headers: Content-Type: application/json, Cookie: <session cookie>
//   body: { to, cc?, bcc?, subject, template, templateData: { HTMLdata } }

/** @typedef {"sales"|"service"} Product */

/**
 * @typedef {Object} InterestLead
 * @property {Product} product          which product was requested
 * @property {string}  name             requester's name
 * @property {string}  email            requester's work email
 * @property {string} [phone]           optional phone
 * @property {string} [bestTime]        "Best time to talk" (Morning/Afternoon/Evening)
 * @property {string} [note]            free-text "anything we should know"
 * @property {string} [accountName]     rooftop name
 * @property {string} [enterpriseName]  parent group name
 * @property {string} [teamId]          Spyne team id
 * @property {string} [at]              ISO timestamp; defaults to now
 */

export const DEFAULT_TEMPLATE = "email-control-tower-report"; // generic shell that injects HTMLdata

// Per-product identity — the only things that differ between the two emails.
const PRODUCTS = {
  sales: {
    label: "Vini for Sales",
    icon: "🚗",
    title: "New request — Vini for Sales",
    sub: "A dealer just asked to turn on Sales. Reach out to walk them through pricing — they can be live within a day.",
    hero: "linear-gradient(135deg,#4f22e0 0%,#6d28d9 55%,#813fed 100%)",
    subjectEmoji: "🚀",
    // headline stats from the Retail Suite preview page (static product value props)
    stats: [
      { big: "3.2&times;", cap: "more appointments vs. manual BDC" },
      { big: "&lt;60s", cap: "average speed-to-lead" },
      { big: "24/7", cap: "coverage, nights &amp; weekends" },
    ],
  },
  service: {
    label: "Vini for Service",
    icon: "🔧",
    title: "New request — Vini for Service",
    sub: "A dealer just asked to turn on Service. Reach out to get their bays booking — setup takes minutes.",
    hero: "linear-gradient(135deg,#5a1fd0 0%,#7326d6 55%,#9152f0 100%)",
    subjectEmoji: "🔧",
    stats: [
      { big: "+18%", cap: "service appointment show rate" },
      { big: "24/7", cap: "online booking &amp; confirmation" },
      { big: "$210k", cap: "deferred work recovered / quarter" },
    ],
  },
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtWhen(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return (
    d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " IST"
  );
}

function detailRow(label, valueHtml) {
  return `
        <tr>
          <td style="padding:11px 0;border-bottom:1px solid #f0eef7;color:#8b8794;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;width:132px;vertical-align:top;">${esc(label)}</td>
          <td style="padding:11px 0;border-bottom:1px solid #f0eef7;color:#1a1430;font-size:14px;line-height:1.45;vertical-align:top;">${valueHtml}</td>
        </tr>`;
}

function statCell(s) {
  return `
            <td style="width:33.33%;text-align:center;padding:14px 8px;vertical-align:top;">
              <div style="font-size:26px;font-weight:800;color:#813fed;letter-spacing:-0.02em;line-height:1;">${s.big}</div>
              <div style="margin-top:8px;font-size:11px;line-height:1.35;color:#6b6577;">${s.cap}</div>
            </td>`;
}

/**
 * Build the full HTML document for an access-request email.
 * @param {InterestLead} lead
 * @returns {string} complete email-client-safe HTML
 */
export function buildInterestEmailHTML(lead) {
  const p = PRODUCTS[lead.product];
  if (!p) throw new Error(`Unknown product "${lead.product}" — expected "sales" or "service".`);

  const account = lead.accountName || "a rooftop";
  const rooftopLine = lead.enterpriseName
    ? `${esc(lead.accountName || "—")} <span style="color:#9b96a8;">· ${esc(lead.enterpriseName)}</span>`
    : esc(lead.accountName || "—");

  const rows = [
    detailRow("Requested by", esc(lead.name || "—")),
    detailRow(
      "Work email",
      lead.email ? `<a href="mailto:${esc(lead.email)}" style="color:#813fed;text-decoration:none;">${esc(lead.email)}</a>` : "—",
    ),
    lead.phone ? detailRow("Phone", `<a href="tel:${esc(lead.phone)}" style="color:#813fed;text-decoration:none;">${esc(lead.phone)}</a>`) : "",
    lead.bestTime ? detailRow("Best time to talk", esc(lead.bestTime)) : "",
    detailRow("Rooftop", rooftopLine),
    lead.teamId ? detailRow("Team ID", `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:#5b3fb0;">${esc(lead.teamId)}</span>`) : "",
    lead.note ? detailRow("Note", `<span style="color:#4a4458;font-style:italic;">“${esc(lead.note)}”</span>`) : "",
    detailRow("Submitted", esc(fmtWhen(lead.at))),
  ].join("");

  const stats = p.stats.map(statCell).join("");
  const replySubject = encodeURIComponent(`${p.label} — let’s get you live`);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f2fa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2fa;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 14px 40px -20px rgba(58,29,110,0.5);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

        <!-- hero -->
        <tr><td style="background:#6d28d9;background-image:${p.hero};padding:28px 32px 26px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:40px;height:40px;background:rgba(255,255,255,0.18);border-radius:12px;text-align:center;font-size:20px;line-height:40px;">${p.icon}</td>
            <td style="padding-left:12px;color:#e4d7fb;font-size:11px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;">Spyne · Retail Suite</td>
          </tr></table>
          <h1 style="margin:10px 0 0;color:#ffffff;font-size:22px;line-height:1.22;font-weight:800;letter-spacing:-0.01em;">${esc(p.title)}</h1>
          <p style="margin:9px 0 0;color:#e9defc;font-size:13.5px;line-height:1.5;">${esc(p.sub)}</p>
          <span style="display:inline-block;margin-top:16px;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,0.16);color:#ffffff;font-size:11px;font-weight:700;">Rooftop · <b style="font-weight:800;">${esc(account)}</b></span>
        </td></tr>

        <!-- details -->
        <tr><td style="padding:22px 32px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
          </table>
        </td></tr>

        <!-- value strip -->
        <tr><td style="padding:8px 24px 6px;">
          <div style="padding:0 8px 12px;font-size:10.5px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#9b96a8;">What they’re signing up for</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${stats}
          </tr></table>
        </td></tr>

        <!-- CTA -->
        <tr><td style="padding:20px 32px 26px;">
          <a href="mailto:${esc(lead.email)}?subject=${replySubject}" style="display:inline-block;background:#813fed;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:11px;">Reply to ${esc((lead.name || "the dealer").split(" ")[0])} →</a>
          <p style="margin:12px 0 0;color:#8b8794;font-size:12px;">Reply directly to the contact above to follow up.</p>
        </td></tr>

        <!-- footer -->
        <tr><td style="padding:16px 32px;background:#faf9fe;border-top:1px solid #f0eef7;">
          <p style="margin:0;color:#9b96a8;font-size:11px;line-height:1.5;">Sent automatically when a dealer requests access from the Retail Suite preview.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Build the mail.spyne.ai send-template-email request body.
 * @param {Object} opts
 * @param {InterestLead} opts.lead
 * @param {string}   opts.to                 primary recipient
 * @param {string[]} [opts.cc]               cc recipients
 * @param {string}   [opts.template]         template name (defaults to the generic shell)
 * @returns {{to:string,cc:string[],subject:string,template:string,templateData:{HTMLdata:string}}}
 */
export function buildSendPayload({ lead, to, cc = [], template = DEFAULT_TEMPLATE }) {
  const p = PRODUCTS[lead.product];
  if (!p) throw new Error(`Unknown product "${lead.product}".`);
  return {
    to,
    cc,
    subject: `${p.subjectEmoji} ${p.label} — access requested · ${lead.accountName || "a rooftop"}`,
    template,
    templateData: { HTMLdata: buildInterestEmailHTML(lead) },
  };
}
