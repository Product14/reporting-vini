/* D1/D2 — enterprise resolution. A CRON_SECRET caller with no dealer token must NEVER get the env
 * SPYNE_API_TOKEN's enterprise: that pairing is what made dealer-leads return zeros (audit A2 F1). */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveRequestEnterprise, serviceEnterprise } from "@/lib/reports/enterprise";
import { isServiceRequest, spyneTokenFrom, readBearer } from "@/lib/reports/auth";

const SECRET = "test-cron-secret";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64");
const ENV_TOKEN = b64({ authKey: "k", deviceId: "d", enterprise_id: "ENVENT", team_id: "envteam" });
const DEALER_TOKEN = b64({ authKey: "k", deviceId: "d", enterprise_id: "dealerent", team_id: "team42" });

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.SPYNE_API_TOKEN = ENV_TOKEN;
  process.env.SPYNE_ENTERPRISE_ID = "ENVENT2";
});

const req = (qs: string, headers: Record<string, string> = {}) => new Request(`https://x.test/api/reports?team_id=team42${qs}`, { headers });
const cron = (qs = "", extra: Record<string, string> = {}) => req(qs, { authorization: `Bearer ${SECRET}`, ...extra });
const map = (ids: string[] | null) => async () => ids;
const NEVER_ENV = (id: string | null) => assert.ok(id !== "ENVENT" && id !== "ENVENT2", `env enterprise leaked: ${id}`);

test("serviceEnterprise: param must match the team's enterprise; no map → nothing", () => {
  assert.deepEqual(serviceEnterprise("entA", ["entA"]), { enterpriseId: "entA", source: "param" });
  assert.equal(serviceEnterprise("entB", ["entA"]).enterpriseId, null);
  assert.deepEqual(serviceEnterprise(null, ["entA"]), { enterpriseId: "entA", source: "team-map" });
  assert.equal(serviceEnterprise(null, ["entA", "entB"]).enterpriseId, null);
  assert.equal(serviceEnterprise("entA", null).enterpriseId, null);
  assert.equal(serviceEnterprise("entA", []).enterpriseId, null);
});

test("cron caller, no token: the team's own enterprise, never the env token's", async () => {
  const r = cron();
  assert.equal(isServiceRequest(r), true);
  assert.equal(spyneTokenFrom(r), null);
  const d = await resolveRequestEnterprise(r, "team42", null, { lookup: map(["entA"]) });
  assert.deepEqual(d, { enterpriseId: "entA", source: "team-map" });
});

test("cron caller with ?enterprise_id=: validated against the team", async () => {
  assert.equal((await resolveRequestEnterprise(cron("&enterprise_id=entA"), "team42", null, { lookup: map(["entA"]) })).enterpriseId, "entA");
  const bad = await resolveRequestEnterprise(cron("&enterprise_id=entZ"), "team42", null, { lookup: map(["entA"]) });
  assert.equal(bad.enterpriseId, null);
  assert.equal(bad.reason, "enterprise_id does not match team_id");
});

test("cron caller, id map unavailable: null — not the env token, not SPYNE_ENTERPRISE_ID", async () => {
  for (const qs of ["", "&enterprise_id=entA"]) {
    const d = await resolveRequestEnterprise(cron(qs), "team42", null, { lookup: map(null) });
    assert.equal(d.enterpriseId, null);
    NEVER_ENV(d.enterpriseId);
  }
  // ?key=<secret> is the same service caller.
  const viaKey = req(`&key=${SECRET}`);
  assert.equal(isServiceRequest(viaKey), true);
  NEVER_ENV((await resolveRequestEnterprise(viaKey, "team42", null, { lookup: map(null) })).enterpriseId);
});

test("cron caller forwarding a token, map unavailable: that token's enterprise (or the meetings param), never env", async () => {
  const r = cron("", { "x-spyne-token": DEALER_TOKEN });
  const tok = spyneTokenFrom(r);
  assert.equal(tok, DEALER_TOKEN, "X-Spyne-Token is read as the Spyne token");
  assert.equal(readBearer(r), SECRET, "the Authorization header still authorizes");
  assert.equal((await resolveRequestEnterprise(r, "team42", tok, { lookup: map(null) })).enterpriseId, "dealerent");
  const m = cron("&enterprise_id=entA", { "x-spyne-token": DEALER_TOKEN });
  assert.equal((await resolveRequestEnterprise(m, "team42", tok, { preferParam: true, lookup: map(null) })).enterpriseId, "entA");
  // A WORKING map that disagrees with the param still wins over the token.
  assert.equal((await resolveRequestEnterprise(m, "team42", tok, { preferParam: true, lookup: map(["entB"]) })).enterpriseId, null);
});

test("dealer token: unchanged — the token's own enterprise (meetings: an explicit param wins)", async () => {
  const r = req("&enterprise_id=entA", { authorization: `Bearer ${DEALER_TOKEN}` });
  assert.equal(isServiceRequest(r), false);
  const tok = spyneTokenFrom(r);
  let looked = false;
  const lookup = async () => { looked = true; return ["entA"]; };
  assert.deepEqual(await resolveRequestEnterprise(r, "team42", tok, { lookup }), { enterpriseId: "dealerent", source: "token" });
  assert.deepEqual(await resolveRequestEnterprise(r, "team42", tok, { preferParam: true, lookup }), { enterpriseId: "entA", source: "param" });
  assert.equal(looked, false, "no ClickHouse lookup on the dealer path");
});

test("no credential (local dev only): the env fallback, as before", async () => {
  const d = await resolveRequestEnterprise(req(""), "team42", null, { lookup: map(["entA"]) });
  assert.deepEqual(d, { enterpriseId: "ENVENT", source: "env-dev" });
});
