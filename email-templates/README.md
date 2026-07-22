# Retail Suite — access-request emails

Two transactional email designs (**Vini for Sales** + **Vini for Service**) in the *Retail Suite by
Spyne* design language, fired when a dealer submits **Request access** from the Retail Suite preview.

> **This folder is self-contained and inert.** Nothing in `reporting-vini` imports it, so it does
> **not** change the live product-interest mail flow in [`src/lib/mail.ts`](../src/lib/mail.ts). It's
> here so a separate codebase can copy the files (or import them straight from this folder).

## Files

| File | What it is |
|------|-----------|
| `retailSuiteInterest.mjs` | Portable builder — **no deps, no repo imports**. Copy anywhere. |
| `build-samples.mjs` | Regenerates the sample payloads below. |
| `samples/{sales,service}.payload.json` | Ready-to-send `mail.spyne.ai` request bodies. |
| `samples/{sales,service}.html` | Rendered email HTML — open in a browser to preview. |

## Use it in the other codebase

```js
import { buildSendPayload } from "./retailSuiteInterest.mjs";

const payload = buildSendPayload({
  lead: {
    product: "sales",              // "sales" | "service"
    name: "Daksh Sharma",
    email: "daksh@luckimazda.com",
    phone: "(330) 555-0147",       // optional
    bestTime: "Morning",           // optional
    note: "…",                     // optional
    accountName: "Lucki Mazda of Wooster",
    enterpriseName: "C.A.R. Automotive", // optional
    teamId: "49a06313cf",          // optional
    at: new Date().toISOString(),  // optional (defaults to now)
  },
  to: "product@spyne.ai",
  cc: ["devansh.hasija@spyne.ai", "mehul.kamra@spyne.ai"],
});

await fetch("https://mail.spyne.ai/api/v1/send-template-email", {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: process.env.SPYNE_MAIL_COOKIE },
  body: JSON.stringify(payload),
});
```

`buildInterestEmailHTML(lead)` is also exported if you only want the HTML string.

## Send with curl

The sample payloads send **only to `devansh.hasija@spyne.ai`** so a test send is safe. Set your
session cookie in the environment first (never paste it inline):

```sh
export SPYNE_MAIL_COOKIE='<your mail.spyne.ai session cookie>'
```

**Sales:**

```sh
curl -X POST https://mail.spyne.ai/api/v1/send-template-email \
  -H "Content-Type: application/json" \
  -H "Cookie: $SPYNE_MAIL_COOKIE" \
  --data @email-templates/samples/sales.payload.json
```

**Service:**

```sh
curl -X POST https://mail.spyne.ai/api/v1/send-template-email \
  -H "Content-Type: application/json" \
  -H "Cookie: $SPYNE_MAIL_COOKIE" \
  --data @email-templates/samples/service.payload.json
```

To send to the real recipients, edit `to` / `cc` in the payload JSON (production =
`product@spyne.ai` + `devansh.hasija@spyne.ai` + `mehul.kamra@spyne.ai`), or regenerate with your
own values via `buildSendPayload(...)`.
